-- =====================================================================
-- Migration 10 – saisie des drafts sur le site (page Drafts)
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (après la migration 09 ; peut être relancée sans risque)
--
-- En scrim, la draft se fait sur drafter.lol puis on picke à l'aveugle
-- dans le client : la game enregistrée n'a ni bans ni ordre. Un admin
-- saisit donc la draft sur le site (page draft.html), en même temps que
-- sur drafter. Elle est :
--   * annoncée dans le post Discord de la session (par le site) ;
--   * rattachée à la game de même numéro (game 1 ↔ draft 1…), que la
--     draft soit saisie avant ou après la game : ses bans et son ordre
--     arrivent ainsi dans la page Statistiques.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Drafts saisies
-- ---------------------------------------------------------------------

create table if not exists public.event_drafts (
  event_id           bigint   not null references public.events (id) on delete cascade,
  game_number        smallint not null check (game_number between 1 and 9),
  our_side           text     not null check (our_side in ('blue', 'red')),
  -- Même format que games.draft, plus l'ordre et les cases saisies :
  -- {"source": "site", "first_pick", "fearless", "blue": {"bans", "picks"},
  --  "red": {...}, "order": [{"type", "side", "champion", "phase"}…], "slots": {...}}
  draft              jsonb    not null,
  discord_message_id text,     -- récap posté dans le post de la session
  updated_by         bigint   references public.players (id) on delete set null
                              default public.current_player_id(),
  updated_at         timestamptz not null default now(),
  primary key (event_id, game_number)
);

alter table public.event_drafts enable row level security;

drop policy if exists "membres : lecture des drafts" on public.event_drafts;
create policy "membres : lecture des drafts"
  on public.event_drafts for select to authenticated
  using (public.is_member());

drop policy if exists "admins : saisissent les drafts" on public.event_drafts;
create policy "admins : saisissent les drafts"
  on public.event_drafts for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- ---------------------------------------------------------------------
-- 2. Rattachement d'une draft à sa game
-- ---------------------------------------------------------------------

-- Échange blue et red dans une draft (si nos côtés diffèrent entre la
-- draft et le lobby, c'est le côté réel de la game qui fait foi).
create or replace function public.swap_draft_sides(p_draft jsonb)
returns jsonb
language sql immutable
set search_path = ''
as $$
  select p_draft || jsonb_build_object(
    'blue', p_draft -> 'red',
    'red',  p_draft -> 'blue',
    'first_pick', case p_draft ->> 'first_pick' when 'red' then 'blue' else 'red' end,
    'order', coalesce((
      select jsonb_agg(a || jsonb_build_object('side', case a ->> 'side' when 'blue' then 'red' else 'blue' end)
                       order by i)
        from jsonb_array_elements(coalesce(p_draft -> 'order', '[]'::jsonb)) with ordinality as t(a, i)
    ), '[]'::jsonb),
    'slots', jsonb_build_object('blue', p_draft #> '{slots,red}', 'red', p_draft #> '{slots,blue}')
  )
$$;

-- Copie la draft saisie dans la game N de la session (N-ième game, dans
-- l'ordre où elles ont été jouées). Seulement si la game n'a pas de bans
-- venant du client, ou si sa draft venait déjà du site.
create or replace function public.apply_event_draft(p_event_id bigint, p_game_number smallint)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_draft public.event_drafts;
  v_game  public.games;
begin
  select d.* into v_draft from public.event_drafts d
   where d.event_id = p_event_id and d.game_number = p_game_number;
  if v_draft.event_id is null then
    return;
  end if;

  select g.* into v_game from public.games g
   where g.event_id = p_event_id
   order by g.started_at
   offset p_game_number - 1
   limit 1;
  if v_game.id is null then
    return;   -- game pas encore jouée : la draft sera reprise à son enregistrement
  end if;

  if coalesce(v_game.draft ->> 'source', '') = 'site'
     or (coalesce(jsonb_array_length(v_game.draft #> '{blue,bans}'), 0) = 0
         and coalesce(jsonb_array_length(v_game.draft #> '{red,bans}'), 0) = 0) then
    update public.games g
       set draft = case when g.our_side is not null and g.our_side <> v_draft.our_side
                        then public.swap_draft_sides(v_draft.draft)
                        else v_draft.draft end
     where g.id = v_game.id;
  end if;
end;
$$;
revoke execute on function public.apply_event_draft(bigint, smallint) from public, anon, authenticated;

-- Draft saisie ou corrigée après la game : on la reporte tout de suite
create or replace function public.event_drafts_after_save()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform public.apply_event_draft(new.event_id, new.game_number);
  return null;
end;
$$;

drop trigger if exists event_drafts_touch on public.event_drafts;
-- Date de mise à jour (même fonction que pour les tier lists, migration 01)
create trigger event_drafts_touch
  before update on public.event_drafts
  for each row execute function public.touch_updated_at();

drop trigger if exists event_drafts_to_game on public.event_drafts;
create trigger event_drafts_to_game
  after insert or update of draft, our_side on public.event_drafts
  for each row execute function public.event_drafts_after_save();


-- ---------------------------------------------------------------------
-- 3. Enregistrement des games : reprise de la draft saisie
--    Même fonction que dans la migration 09, avec un bloc en plus
--    (« Draft saisie sur le site pour cette game »).
-- ---------------------------------------------------------------------

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
          -- Flex OU normale : rattachée à la session "Flex" en cours (une
          -- normale y est jouée quand on n'est que 4 et que la flex est impossible)
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

  -- Draft saisie sur le site pour cette game (game N de la session ↔ draft N) :
  -- on la reprend si la game n'a pas de bans (picks à l'aveugle dans le client)
  if v_created and v_event.id is not null then
    perform public.apply_event_draft(
      v_event.id,
      (select count(*) from public.games g
        where g.event_id = v_event.id and g.started_at <= v_game.started_at)::smallint);
    select g.* into v_game from public.games g where g.id = v_game.id;
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

commit;
