-- =====================================================================
-- Migration 12 – page « Joueurs » : classement et games soloQ
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (après la migration 11 ; peut être relancée sans risque)
--
-- Le script scripts/riot_sync.py (lancé par GitHub Actions) interroge
-- l'API de Riot pour chaque compte de la team (principal et smurfs) et
-- range ici le classement et les dernières games soloQ. La page Joueurs
-- ne fait que lire ces tables : aucun appel à Riot depuis le site.
--
-- Écriture : uniquement par le script, avec la clé service_role (qui
-- contourne la RLS). Les membres n'ont que le droit de lire.
-- =====================================================================

begin;

-- Un compte LoL d'un joueur : classement soloQ et flex.
create table if not exists public.riot_accounts (
  player_id     bigint  not null references public.players (id) on delete cascade,
  riot_id       text    not null,            -- tel que saisi dans le profil, "Pseudo#TAG"
  is_main       boolean not null default false,
  puuid         text,                        -- identifiant du compte chez Riot
  game_name     text,                        -- pseudo actuel chez Riot (peut différer de la saisie)
  tag_line      text,
  profile_icon  integer,
  level         integer,
  -- SoloQ (null = non classé)
  solo_tier     text,                        -- 'GOLD', 'DIAMOND'…
  solo_division text,                        -- 'I' à 'IV' (vide à partir de Master)
  solo_lp       integer,
  solo_wins     integer,
  solo_losses   integer,
  -- Flex
  flex_tier     text,
  flex_division text,
  flex_lp       integer,
  flex_wins     integer,
  flex_losses   integer,
  error         text,                        -- ex. "compte introuvable" (Riot ID mal saisi)
  updated_at    timestamptz not null default now(),
  primary key (player_id, riot_id)
);

-- Une game soloQ d'un compte (une ligne par game et par compte).
create table if not exists public.soloq_games (
  match_id     text    not null,             -- identifiant Riot, ex. 'EUW1_7123456789'
  puuid        text    not null,
  player_id    bigint  not null references public.players (id) on delete cascade,
  started_at   timestamptz not null,
  duration_s   integer not null,
  champion     text    not null,             -- identifiant Riot du champion, ex. 'MonkeyKing'
  champion_id  integer,
  position     text,                         -- 'TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'
  win          boolean not null,
  kills        integer not null default 0,
  deaths       integer not null default 0,
  assists      integer not null default 0,
  cs           integer not null default 0,
  primary key (match_id, puuid)
);
create index if not exists soloq_games_player_idx on public.soloq_games (player_id, started_at desc);

alter table public.riot_accounts enable row level security;
alter table public.soloq_games   enable row level security;

drop policy if exists "membres : lecture des comptes" on public.riot_accounts;
create policy "membres : lecture des comptes"
  on public.riot_accounts for select to authenticated
  using (public.is_member());

drop policy if exists "membres : lecture des games soloQ" on public.soloq_games;
create policy "membres : lecture des games soloQ"
  on public.soloq_games for select to authenticated
  using (public.is_member());

commit;
