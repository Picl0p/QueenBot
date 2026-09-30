-- =====================================================================
-- Migration 04 – créneaux d'une demi-heure + type "Flex"
-- À exécuter dans : Supabase > SQL Editor > New query > Run
--
-- 1. Les dispos passent de l'heure à la demi-heure : on ajoute une
--    colonne `minute` (0 ou 30) à côté de `hour`. 20h30 = hour 20, minute 30.
--    Les dispos déjà saisies (une ligne par heure) sont dupliquées sur
--    la demi-heure suivante : "dispo à 20h" devient "dispo à 20h et 20h30",
--    ce qui correspond exactement à ce qui avait été coché.
-- 2. Le type de rendez-vous "entrainement" est renommé en "flex".
--    Les rendez-vous existants de ce type deviennent automatiquement "flex".
--
-- Tout se fait dans une transaction : en cas d'erreur, rien n'est modifié.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Demi-heures
-- ---------------------------------------------------------------------

alter table public.availabilities
  add column minute smallint not null default 0 check (minute in (0, 30));

-- La clé primaire inclut maintenant la minute
alter table public.availabilities drop constraint availabilities_pkey;
alter table public.availabilities add primary key (player_id, day, hour, minute);

-- Les heures déjà cochées couvrent aussi leur deuxième demi-heure
insert into public.availabilities (player_id, day, hour, minute, status)
select player_id, day, hour, 30, status
  from public.availabilities
 where minute = 0
on conflict do nothing;


-- La carte de chaleur renvoie la minute : changement du type de retour,
-- donc suppression puis recréation.
drop function public.availability_heatmap(date);

create function public.availability_heatmap(p_week_start date)
returns table (
  day            date,
  hour           smallint,
  minute         smallint,
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
         a.minute,
         count(*) filter (where a.status = 'dispo'),
         count(*) filter (where a.status = 'a_eviter'),
         coalesce(array_agg(p.pseudo order by p.pseudo) filter (where a.status = 'dispo'),    '{}'),
         coalesce(array_agg(p.pseudo order by p.pseudo) filter (where a.status = 'a_eviter'), '{}')
    from public.availabilities a
    join public.players p on p.id = a.player_id
   where a.day >= p_week_start
     and a.day <  p_week_start + 7
   group by a.day, a.hour, a.minute
   order by a.day, a.hour, a.minute
$$;


-- L'enregistrement lit la minute de chaque créneau (0 si absente).
-- Même signature qu'avant : create or replace suffit.
create or replace function public.set_my_availability(
  p_week_start date,
  p_slots      jsonb,           -- ex. [{"day": "2026-09-28", "hour": 20, "minute": 30, "status": "a_eviter"}, ...]
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

  insert into public.availabilities (player_id, day, hour, minute, status)
  select v_player,
         (slot ->> 'day')::date,
         (slot ->> 'hour')::smallint,
         coalesce((slot ->> 'minute')::smallint, 0),
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


-- ---------------------------------------------------------------------
-- 2. "Entraînement" devient "Flex"
-- ---------------------------------------------------------------------

alter type public.event_type rename value 'entrainement' to 'flex';
alter table public.events alter column type set default 'flex';

commit;
