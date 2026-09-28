-- =====================================================================
-- Schéma Supabase – site de la team LoL
-- À exécuter en une seule fois dans : Supabase > SQL Editor > New query
--
-- Principe d'accès :
--   * `players` sert de LISTE BLANCHE : seules les personnes dont le
--     discord_id y figure deviennent "membres" en se connectant avec Discord.
--   * Quelqu'un d'extérieur peut techniquement se connecter, mais ne voit
--     et ne peut modifier RIEN (toutes les règles RLS exigent d'être membre).
--   * Les heures de dispo sont en heure locale (Europe/Paris).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Types énumérés
-- ---------------------------------------------------------------------
create type public.lol_role      as enum ('top', 'jungle', 'mid', 'adc', 'support');
create type public.player_status as enum ('titulaire', 'remplacant', 'coach');
create type public.event_type    as enum ('entrainement', 'scrim', 'match_officiel', 'review', 'autre');
create type public.tier          as enum ('S', 'A', 'B', 'C', 'D');


-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------

-- Joueurs (= liste blanche). user_id est rempli automatiquement
-- à la première connexion Discord (voir triggers plus bas).
create table public.players (
  id          bigint generated always as identity primary key,
  discord_id  text not null unique,
  user_id     uuid unique references auth.users (id) on delete set null,
  pseudo      text not null,
  main_role   public.lol_role,
  status      public.player_status not null default 'titulaire',
  is_admin    boolean not null default false,   -- capitaine / coach : gère le planning
  created_at  timestamptz not null default now()
);

-- Dispos : une ligne par heure où le joueur est disponible.
create table public.availabilities (
  player_id  bigint   not null references public.players (id) on delete cascade,
  day        date     not null,
  hour       smallint not null check (hour between 0 and 23),
  primary key (player_id, day, hour)
);

-- "J'ai rempli ma semaine" : permet de distinguer
-- "pas dispo du tout" (soumis, zéro créneau) de "n'a pas encore répondu".
create table public.availability_submissions (
  player_id    bigint not null references public.players (id) on delete cascade,
  week_start   date   not null check (extract(isodow from week_start) = 1),  -- toujours un lundi
  comment      text,
  submitted_at timestamptz not null default now(),
  primary key (player_id, week_start)
);

-- Planning de l'équipe.
create table public.events (
  id          bigint generated always as identity primary key,
  title       text not null,
  type        public.event_type not null default 'entrainement',
  starts_at   timestamptz not null,
  ends_at     timestamptz,
  opponent    text,
  notes       text,
  created_by  bigint references public.players (id) on delete set null,
  created_at  timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
create index events_starts_at_idx on public.events (starts_at);

-- Tier lists (une par joueur, éventuellement par rôle et par patch).
create table public.tierlists (
  id          bigint generated always as identity primary key,
  author_id   bigint not null references public.players (id) on delete cascade,
  title       text not null,
  patch       text,               -- ex. '16.19'
  role        public.lol_role,    -- null = tous rôles confondus
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.tierlist_entries (
  tierlist_id  bigint not null references public.tierlists (id) on delete cascade,
  champion_id  text   not null,   -- identifiant Data Dragon, ex. 'MonkeyKing' pour Wukong
  tier         public.tier not null,
  position     smallint not null default 0,  -- ordre à l'intérieur d'un tier
  primary key (tierlist_id, champion_id)
);


-- ---------------------------------------------------------------------
-- 3. Fonctions utilitaires pour les règles d'accès
--    `security definer` : elles lisent `players` sans être bloquées par
--    la RLS de `players` elle-même (évite une récursion infinie).
-- ---------------------------------------------------------------------
create function public.current_player_id()
returns bigint
language sql stable security definer
set search_path = ''
as $$
  select id from public.players where user_id = auth.uid()
$$;

create function public.is_member()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.players where user_id = auth.uid())
$$;

create function public.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.players where user_id = auth.uid() and is_admin)
$$;

-- Remplissage automatique de l'auteur côté base :
-- le site n'a pas besoin d'envoyer l'id du joueur.
alter table public.events    alter column created_by set default public.current_player_id();
alter table public.tierlists alter column author_id  set default public.current_player_id();


-- ---------------------------------------------------------------------
-- 4. Liaison compte Discord <-> joueur
--    Fonctionne dans les deux sens :
--      a) le joueur est ajouté à `players`, PUIS se connecte ;
--      b) la personne s'est déjà connectée, PUIS est ajoutée à `players`.
-- ---------------------------------------------------------------------

-- a) À la création d'une identité Discord
create function public.link_player_from_identity()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.provider = 'discord' then
    update public.players
       set user_id = new.user_id
     where discord_id = new.provider_id
       and user_id is null;
  end if;
  return new;
end;
$$;

create trigger on_discord_identity_created
  after insert on auth.identities
  for each row execute function public.link_player_from_identity();

-- b) À l'ajout d'un joueur
create function public.link_identity_to_player()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.user_id is null then
    select i.user_id into new.user_id
      from auth.identities i
     where i.provider = 'discord'
       and i.provider_id = new.discord_id
     limit 1;
  end if;
  return new;
end;
$$;

create trigger on_player_inserted
  before insert on public.players
  for each row execute function public.link_identity_to_player();

-- Mise à jour automatique de tierlists.updated_at
create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tierlists_touch_updated_at
  before update on public.tierlists
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------
-- 5. Row Level Security
--    Sans règle explicite, tout est refusé. Le rôle `anon`
--    (visiteur non connecté) n'a aucune règle : il ne voit rien.
-- ---------------------------------------------------------------------
alter table public.players                  enable row level security;
alter table public.availabilities           enable row level security;
alter table public.availability_submissions enable row level security;
alter table public.events                   enable row level security;
alter table public.tierlists                enable row level security;
alter table public.tierlist_entries         enable row level security;

-- players ------------------------------------------------------------
create policy "membres : lecture des joueurs"
  on public.players for select to authenticated
  using (public.is_member());

create policy "joueur : modifie son propre profil"
  on public.players for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Un joueur ne peut modifier QUE son pseudo et son rôle
-- (sinon il pourrait se passer is_admin = true lui-même).
-- Ajouts, suppressions et changements de statut/admin : via le dashboard Supabase.
revoke update on public.players from anon, authenticated;
grant  update (pseudo, main_role) on public.players to authenticated;

-- availabilities -----------------------------------------------------
create policy "membres : lecture des dispos"
  on public.availabilities for select to authenticated
  using (public.is_member());

create policy "joueur : gère ses propres dispos"
  on public.availabilities for all to authenticated
  using (player_id = public.current_player_id())
  with check (player_id = public.current_player_id());

-- availability_submissions -------------------------------------------
create policy "membres : lecture des soumissions"
  on public.availability_submissions for select to authenticated
  using (public.is_member());

create policy "joueur : gère ses propres soumissions"
  on public.availability_submissions for all to authenticated
  using (player_id = public.current_player_id())
  with check (player_id = public.current_player_id());

-- events -------------------------------------------------------------
create policy "membres : lecture du planning"
  on public.events for select to authenticated
  using (public.is_member());

create policy "admins : gèrent le planning"
  on public.events for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- tierlists ----------------------------------------------------------
create policy "membres : lecture des tier lists"
  on public.tierlists for select to authenticated
  using (public.is_member());

create policy "joueur : crée ses tier lists"
  on public.tierlists for insert to authenticated
  with check (author_id = public.current_player_id());

create policy "auteur ou admin : modifie"
  on public.tierlists for update to authenticated
  using (author_id = public.current_player_id() or public.is_admin())
  with check (author_id = public.current_player_id() or public.is_admin());

create policy "auteur ou admin : supprime"
  on public.tierlists for delete to authenticated
  using (author_id = public.current_player_id() or public.is_admin());

-- tierlist_entries ---------------------------------------------------
create policy "membres : lecture des entrées"
  on public.tierlist_entries for select to authenticated
  using (public.is_member());

create policy "auteur : gère les entrées de ses tier lists"
  on public.tierlist_entries for all to authenticated
  using (exists (
    select 1 from public.tierlists t
     where t.id = tierlist_entries.tierlist_id
       and t.author_id = public.current_player_id()
  ))
  with check (exists (
    select 1 from public.tierlists t
     where t.id = tierlist_entries.tierlist_id
       and t.author_id = public.current_player_id()
  ));


-- ---------------------------------------------------------------------
-- 6. Fonctions de requête (appelables depuis le site et le script Python)
--    Elles sont `security invoker` (par défaut) : la RLS s'applique,
--    donc un non-membre obtient un résultat vide.
--    Le script Python utilisera la clé service_role, qui contourne la RLS.
-- ---------------------------------------------------------------------

-- Carte de chaleur : combien de joueurs dispo par jour et par heure.
create function public.availability_heatmap(p_week_start date)
returns table (day date, hour smallint, n_available bigint, pseudos text[])
language sql stable
set search_path = ''
as $$
  select a.day,
         a.hour,
         count(*)                               as n_available,
         array_agg(p.pseudo order by p.pseudo)  as pseudos
    from public.availabilities a
    join public.players p on p.id = a.player_id
   where a.day >= p_week_start
     and a.day <  p_week_start + 7
   group by a.day, a.hour
   order by a.day, a.hour
$$;

-- Qui n'a pas encore rempli ses dispos pour une semaine donnée
-- (les coachs sont exclus de la relance).
create function public.players_missing_availability(p_week_start date)
returns table (discord_id text, pseudo text)
language sql stable
set search_path = ''
as $$
  select p.discord_id, p.pseudo
    from public.players p
   where p.status <> 'coach'
     and not exists (
       select 1 from public.availability_submissions s
        where s.player_id = p.id
          and s.week_start = p_week_start
     )
   order by p.pseudo
$$;


-- ---------------------------------------------------------------------
-- 7. Ajout des membres (à adapter, puis exécuter)
--    Discord ID : Paramètres Discord > Avancés > Mode développeur,
--    puis clic droit sur un pseudo > "Copier l'identifiant".
-- ---------------------------------------------------------------------
-- insert into public.players (discord_id, pseudo, main_role, status, is_admin) values
--   ('000000000000000000', 'TonPseudo',  'mid',     'titulaire', true),
--   ('111111111111111111', 'Coequipier', 'jungle',  'titulaire', false),
--   ('222222222222222222', 'Coach',      null,      'coach',     true);
