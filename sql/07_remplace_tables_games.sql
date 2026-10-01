-- =====================================================================
-- Migration 07 – remplace les anciennes tables des games
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (après la migration 05 ; peut être relancée sans risque)
--
-- Les tables `games` et `game_participants` existaient déjà dans la base
-- avant la migration 05, avec une autre structure (sans draft, sans côté,
-- sans objectifs). La migration 05 ne les a donc pas recréées, et ni le
-- companion ni la page Statistiques ne peuvent s'en servir.
--
-- Cette migration supprime les anciennes tables et crée les nouvelles.
-- Garde-fou : elle refuse de s'exécuter si elles contiennent des games.
-- Si quelque chose d'autre dépend des anciennes tables (une vue, par
-- exemple), Supabase affichera une erreur et rien ne sera modifié.
-- =====================================================================

begin;

do $$
begin
  -- Déjà la bonne structure (migration déjà passée, ou base neuve) : rien à faire
  if to_regclass('public.games') is null
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'games'
                   and column_name = 'riot_game_id') then
    raise notice 'Tables des games déjà à jour : rien à remplacer.';
    return;
  end if;

  if exists (select 1 from public.games) or exists (select 1 from public.game_participants) then
    raise exception 'Les anciennes tables contiennent des games : migration annulée, rien n''est supprimé.';
  end if;

  drop table public.game_participants;
  drop table public.games;
end;
$$;

-- Mêmes définitions que dans la migration 05
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

commit;
