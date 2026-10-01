-- =====================================================================
-- Migration 05 – posts Discord des sessions + récupération des games
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (AVANT de mettre en ligne la nouvelle version du site.)
--
-- 1. Les rendez-vous gagnent les infos du "message type" des scrims :
--    statut, format, side, lien de draft, infos sur l'adversaire.
--    Ils retiennent aussi le post créé dans le forum Discord.
-- 2. Une table de réglages SECRETS (webhook du forum, jeton du companion).
--    Personne ne peut la lire depuis le site : seules les fonctions
--    ci-dessous y accèdent, après avoir vérifié qui les appelle.
-- 3. Deux tables pour les games récupérées par le companion LCU
--    (scripts/lcu_companion.py) : `games` et `game_participants`.
--
-- Après l'exécution, il reste DEUX réglages à faire à la main :
-- voir la section 5 tout en bas.
--
-- Tout se fait dans une transaction : en cas d'erreur, rien n'est modifié.
-- Le fichier peut être relancé sans risque : ce qui existe déjà est
-- laissé tel quel (le jeton du companion, notamment, ne change pas).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Rendez-vous : infos de session et post Discord
-- ---------------------------------------------------------------------

-- "create type" n'a pas de "if not exists" : on teste à la main
do $$
begin
  if to_regtype('public.event_status') is null then
    create type public.event_status as enum ('confirme', 'en_attente', 'annule');
  end if;
end;
$$;

alter table public.events
  add column if not exists status             public.event_status not null default 'confirme',
  add column if not exists format             text,    -- ex. '3 games fearless', 'BO3'
  add column if not exists side               text,    -- vide = pas encore choisi
  add column if not exists draft_url          text,    -- ex. lien drafter.lol
  add column if not exists opponent_opgg      text,    -- lien multi OP.GG de l'adversaire
  add column if not exists opponent_roster    jsonb,   -- {"top": "...", "jungle": "...", "mid": "...", "adc": "...", "support": "..."}
  add column if not exists opponent_contact   text,    -- pseudo Discord du contact
  add column if not exists discord_thread_id  text,    -- post du forum (rempli par le site)
  add column if not exists discord_message_id text,    -- premier message du post
  add column if not exists discord_thread_url text;    -- lien vers le post


-- ---------------------------------------------------------------------
-- 2. Réglages secrets
--    RLS activée SANS aucune règle : ni les visiteurs ni les membres ne
--    peuvent lire ou écrire cette table via l'API.
-- ---------------------------------------------------------------------

create table if not exists public.app_settings (
  key    text primary key,
  value  text not null
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

-- Jeton du companion, tiré au hasard. Pour le lire : voir section 5.
insert into public.app_settings (key, value)
values ('ingest_token', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- Le site demande le webhook du forum au moment de créer / modifier un
-- post. Seuls les admins l'obtiennent.
create or replace function public.discord_forum_config()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Réservé aux admins';
  end if;
  return jsonb_build_object(
    'webhook_url', (select value from public.app_settings where key = 'discord_forum_webhook'),
    'role_id',     (select value from public.app_settings where key = 'discord_role_id')
  );
end;
$$;

revoke execute on function public.discord_forum_config() from public, anon;
grant  execute on function public.discord_forum_config() to authenticated;


-- ---------------------------------------------------------------------
-- 3. Games
-- ---------------------------------------------------------------------

create table if not exists public.games (
  id                 bigint generated always as identity primary key,
  riot_game_id       bigint not null unique,           -- identifiant de la game chez Riot
  event_id           bigint references public.events (id) on delete set null,
  started_at         timestamptz not null,
  duration_s         integer not null,
  game_version       text,                             -- ex. '16.19.1'
  queue_id           integer,                          -- 0 = perso, 440 = flex
  is_custom          boolean not null default false,
  our_side           text check (our_side in ('blue', 'red')),   -- null = inconnu
  winner             text check (winner   in ('blue', 'red')),
  draft              jsonb,   -- {"source", "blue": {"bans", "picks"}, "red": {...}, "order": [...]}
  teams              jsonb,   -- {"blue": {"kills", "gold", "towers", ...}, "red": {...}}
  raw                jsonb,   -- réponse brute du client LoL, au cas où
  reported_by        text,    -- Riot ID de la personne dont le companion a envoyé la game
  discord_message_id text,    -- message de résultat posté dans le post de la session
  notify_claimed_at  timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists games_event_id_idx   on public.games (event_id);
create index if not exists games_started_at_idx on public.games (started_at);

-- Une ligne par joueur et par game (10 lignes pour une game en 5v5).
create table if not exists public.game_participants (
  game_id       bigint   not null references public.games (id) on delete cascade,
  side          text     not null check (side in ('blue', 'red')),
  slot          smallint not null,   -- ordre dans l'équipe (0 à 4)
  riot_id       text,                -- 'Pseudo#TAG'
  puuid         text,
  champion_id   integer,
  champion      text,
  kills         integer,
  deaths        integer,
  assists       integer,
  cs            integer,
  gold          integer,
  damage        integer,             -- dégâts aux champions
  vision_score  integer,
  level         integer,
  primary key (game_id, side, slot)
);

alter table public.games             enable row level security;
alter table public.game_participants enable row level security;

-- Lecture pour les membres. Aucune règle d'écriture : les games
-- n'entrent que par la fonction ingest_game ci-dessous.
drop policy if exists "membres : lecture des games" on public.games;
create policy "membres : lecture des games"
  on public.games for select to authenticated
  using (public.is_member());

drop policy if exists "membres : lecture des stats de game" on public.game_participants;
create policy "membres : lecture des stats de game"
  on public.game_participants for select to authenticated
  using (public.is_member());


-- ---------------------------------------------------------------------
-- 4. Fonctions appelées par le companion LCU
--    Le companion n'a PAS de compte : il s'identifie avec le jeton
--    partagé (ingest_token). Sans le bon jeton, rien ne se passe.
-- ---------------------------------------------------------------------

create or replace function public.check_ingest_token(p_token text)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  select value into v_token from public.app_settings where key = 'ingest_token';
  if v_token is null or p_token is null or p_token <> v_token then
    raise exception 'Jeton du companion invalide';
  end if;
end;
$$;
revoke execute on function public.check_ingest_token(text) from public, anon, authenticated;

-- Enregistre une game et dit au companion s'il doit l'annoncer sur Discord.
--
-- * La même game peut être envoyée par plusieurs joueurs (chacun a le
--   companion) : elle n'est enregistrée qu'une fois (riot_game_id unique).
-- * La game est rattachée au rendez-vous en cours : game perso → scrim ou
--   match officiel ; game de flex → rendez-vous "Flex". On accepte de
--   1h avant le début à 1h après la fin (ou début + 4h sans heure de fin).
-- * "notify" n'est vrai que pour UN seul companion à la fois, pour ne pas
--   poster le résultat en double. S'il plante avant d'avoir posté, un
--   autre pourra réessayer 2 minutes plus tard.
create or replace function public.ingest_game(p_token text, p_game jsonb)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_riot_id  bigint      := (p_game ->> 'riot_game_id')::bigint;
  v_started  timestamptz := (p_game ->> 'started_at')::timestamptz;
  v_custom   boolean     := coalesce((p_game ->> 'is_custom')::boolean, false);
  v_event    public.events;
  v_game     public.games;
  v_created  boolean := false;
  v_notify   boolean := false;
begin
  perform public.check_ingest_token(p_token);

  if v_riot_id is null or v_started is null then
    raise exception 'Game incomplète (riot_game_id et started_at sont obligatoires)';
  end if;

  select e.* into v_event
    from public.events e
   where e.status <> 'annule'
     and ((v_custom and e.type in ('scrim', 'match_officiel'))
          or (not v_custom and e.type = 'flex'))
     and v_started >= e.starts_at - interval '1 hour'
     and v_started <= coalesce(e.ends_at, e.starts_at + interval '4 hours') + interval '1 hour'
   order by (v_started >= e.starts_at
             and v_started <= coalesce(e.ends_at, e.starts_at + interval '4 hours')) desc,
            abs(extract(epoch from (v_started - e.starts_at)))
   limit 1;

  insert into public.games (riot_game_id, event_id, started_at, duration_s, game_version,
                            queue_id, is_custom, our_side, winner, draft, teams, raw, reported_by)
  values (v_riot_id, v_event.id, v_started,
          coalesce((p_game ->> 'duration_s')::integer, 0),
          p_game ->> 'game_version',
          (p_game ->> 'queue_id')::integer,
          v_custom,
          p_game ->> 'our_side',
          p_game ->> 'winner',
          p_game -> 'draft',
          p_game -> 'teams',
          p_game -> 'raw',
          p_game ->> 'reported_by')
  on conflict (riot_game_id) do nothing
  returning * into v_game;

  if v_game.id is not null then
    v_created := true;

    insert into public.game_participants (game_id, side, slot, riot_id, puuid, champion_id, champion,
                                          kills, deaths, assists, cs, gold, damage, vision_score, level)
    select v_game.id,
           p ->> 'side',
           (p ->> 'slot')::smallint,
           p ->> 'riot_id',
           p ->> 'puuid',
           (p ->> 'champion_id')::integer,
           p ->> 'champion',
           (p ->> 'kills')::integer,
           (p ->> 'deaths')::integer,
           (p ->> 'assists')::integer,
           (p ->> 'cs')::integer,
           (p ->> 'gold')::integer,
           (p ->> 'damage')::integer,
           (p ->> 'vision_score')::integer,
           (p ->> 'level')::integer
      from jsonb_array_elements(coalesce(p_game -> 'participants', '[]'::jsonb)) as p;
  else
    -- Game déjà connue : on complète ce que le premier envoi ignorait
    -- (notre côté, ou la draft dans l'ordre si quelqu'un a vu le champ select).
    update public.games g
       set our_side = coalesce(g.our_side, p_game ->> 'our_side'),
           draft    = case
                        when p_game #>> '{draft,source}' = 'champ_select'
                             and coalesce(g.draft ->> 'source', '') <> 'champ_select'
                        then p_game -> 'draft'
                        else g.draft
                      end
     where g.riot_game_id = v_riot_id
    returning * into v_game;

    select e.* into v_event from public.events e where e.id = v_game.event_id;
  end if;

  -- Réserve l'annonce Discord (un seul companion à la fois)
  if v_event.discord_thread_id is not null then
    update public.games g
       set notify_claimed_at = now()
     where g.id = v_game.id
       and g.discord_message_id is null
       and (g.notify_claimed_at is null or g.notify_claimed_at < now() - interval '2 minutes')
    returning true into v_notify;
  end if;

  return jsonb_build_object(
    'created', v_created,
    'notify',  coalesce(v_notify, false),
    'draft',   v_game.draft,
    'our_side', v_game.our_side,
    -- Numéro de la game dans la session, et score de la série
    'game_number', (select count(*) from public.games g
                     where g.event_id = v_game.event_id and g.started_at <= v_game.started_at),
    'wins',   (select count(*) from public.games g
                where g.event_id = v_game.event_id and g.winner = g.our_side),
    'losses', (select count(*) from public.games g
                where g.event_id = v_game.event_id and g.winner <> g.our_side),
    'event', case when v_event.id is null then null else jsonb_build_object(
               'id', v_event.id,
               'title', v_event.title,
               'type', v_event.type,
               'opponent', v_event.opponent,
               'thread_id', v_event.discord_thread_id
             ) end,
    'webhook_url', case when coalesce(v_notify, false)
                        then (select value from public.app_settings where key = 'discord_forum_webhook')
                   end
  );
end;
$$;

-- Le companion confirme que le résultat est bien posté sur Discord.
create or replace function public.mark_game_notified(p_token text, p_riot_game_id bigint, p_message_id text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  perform public.check_ingest_token(p_token);
  update public.games
     set discord_message_id = p_message_id
   where riot_game_id = p_riot_game_id;
end;
$$;

-- "anon" : le companion utilise la clé publique du site, sans compte.
grant execute on function public.ingest_game(text, jsonb)                to anon, authenticated;
grant execute on function public.mark_game_notified(text, bigint, text) to anon, authenticated;

commit;


-- ---------------------------------------------------------------------
-- 5. Réglages à faire à la main (une seule fois)
--
--    ⚠️ Ne mets PAS ces valeurs dans ce fichier (il est publié sur GitHub).
--    Tape-les directement dans le SQL Editor de Supabase.
-- ---------------------------------------------------------------------

-- a) Webhook du FORUM Discord (obligatoire pour les posts).
--    Discord > clic droit sur le salon forum > Modifier le salon >
--    Intégrations > Webhooks > Nouveau webhook > Copier l'URL.
--
-- insert into public.app_settings (key, value)
-- values ('discord_forum_webhook', 'https://discord.com/api/webhooks/…')
-- on conflict (key) do update set value = excluded.value;

-- b) Rôle à mentionner à la création d'un post (facultatif).
--
-- insert into public.app_settings (key, value)
-- values ('discord_role_id', '123456789012345678')
-- on conflict (key) do update set value = excluded.value;

-- c) Lire le jeton à donner au companion (scripts/lcu_companion.py) :
--
-- select value from public.app_settings where key = 'ingest_token';
