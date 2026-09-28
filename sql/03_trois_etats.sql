-- =====================================================================
-- Migration 03 – trois états : dispo / à éviter / pas dispo
-- À exécuter dans : Supabase > SQL Editor > New query > Run
--
-- Choix de modélisation : "pas dispo" n'est PAS stocké. Une heure sans
-- ligne dans `availabilities` veut dire "pas dispo" (c'est déjà le cas
-- aujourd'hui). On ajoute seulement une colonne `status` pour distinguer
-- "dispo" de "à éviter". Les dispos déjà saisies deviennent "dispo".
-- =====================================================================

-- 1. Nouveau type et nouvelle colonne
create type public.availability_status as enum ('dispo', 'a_eviter');

alter table public.availabilities
  add column status public.availability_status not null default 'dispo';


-- 2. La carte de chaleur renvoie maintenant les deux comptes.
--    Changer le type de retour d'une fonction impose de la supprimer
--    puis de la recréer (create or replace ne suffit pas).
drop function public.availability_heatmap(date);

create function public.availability_heatmap(p_week_start date)
returns table (
  day            date,
  hour           smallint,
  n_available    bigint,   -- joueurs "dispo"
  n_maybe        bigint,   -- joueurs "à éviter"
  pseudos        text[],   -- pseudos "dispo"
  pseudos_maybe  text[]    -- pseudos "à éviter"
)
language sql stable
set search_path = ''
as $$
  select a.day,
         a.hour,
         count(*) filter (where a.status = 'dispo'),
         count(*) filter (where a.status = 'a_eviter'),
         coalesce(array_agg(p.pseudo order by p.pseudo) filter (where a.status = 'dispo'),    '{}'),
         coalesce(array_agg(p.pseudo order by p.pseudo) filter (where a.status = 'a_eviter'), '{}')
    from public.availabilities a
    join public.players p on p.id = a.player_id
   where a.day >= p_week_start
     and a.day <  p_week_start + 7
   group by a.day, a.hour
   order by a.day, a.hour
$$;


-- 3. L'enregistrement accepte un statut par créneau.
--    Même signature qu'avant : create or replace suffit.
create or replace function public.set_my_availability(
  p_week_start date,
  p_slots      jsonb,           -- ex. [{"day": "2026-09-28", "hour": 20, "status": "a_eviter"}, ...]
  p_comment    text default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_player bigint := public.current_player_id();
begin
  if v_player is null then
    raise exception 'Accès réservé aux membres de la team';
  end if;

  if extract(isodow from p_week_start) <> 1 then
    raise exception 'La semaine doit commencer un lundi';
  end if;

  if p_week_start < date_trunc('week', current_date)::date then
    raise exception 'Impossible de modifier une semaine passée';
  end if;

  delete from public.availabilities
   where player_id = v_player
     and day >= p_week_start
     and day <  p_week_start + 7;

  insert into public.availabilities (player_id, day, hour, status)
  select v_player,
         (slot ->> 'day')::date,
         (slot ->> 'hour')::smallint,
         coalesce((slot ->> 'status')::public.availability_status, 'dispo')
    from jsonb_array_elements(p_slots) as slot
   where (slot ->> 'day')::date >= p_week_start
     and (slot ->> 'day')::date <  p_week_start + 7
  on conflict do nothing;

  insert into public.availability_submissions (player_id, week_start, comment, submitted_at)
  values (v_player, p_week_start, nullif(trim(p_comment), ''), now())
  on conflict (player_id, week_start)
  do update set comment      = excluded.comment,
                submitted_at = excluded.submitted_at;
end;
$$;
