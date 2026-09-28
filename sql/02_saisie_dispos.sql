-- =====================================================================
-- Migration 02 – saisie des dispos depuis le site
-- À exécuter dans : Supabase > SQL Editor > New query > Run
--
-- Pourquoi une fonction plutôt que plusieurs requêtes depuis le site ?
-- Enregistrer une semaine, c'est trois opérations : effacer les anciennes
-- dispos, insérer les nouvelles, marquer la semaine comme remplie.
-- Dans une fonction, les trois se font dans UNE transaction : si l'une
-- échoue, rien n'est modifié, et on ne se retrouve jamais avec une
-- semaine à moitié enregistrée.
--
-- La fonction est "security invoker" (le défaut) : elle s'exécute avec
-- les droits de la personne connectée, donc les règles RLS s'appliquent
-- et personne ne peut modifier les dispos de quelqu'un d'autre.
-- =====================================================================

create or replace function public.set_my_availability(
  p_week_start date,
  p_slots      jsonb,           -- ex. [{"day": "2026-09-28", "hour": 20}, ...]
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

  -- 1. On repart de zéro pour cette semaine
  delete from public.availabilities
   where player_id = v_player
     and day >= p_week_start
     and day <  p_week_start + 7;

  -- 2. On insère les créneaux cochés (en ignorant ceux hors de la semaine)
  insert into public.availabilities (player_id, day, hour)
  select v_player,
         (slot ->> 'day')::date,
         (slot ->> 'hour')::smallint
    from jsonb_array_elements(p_slots) as slot
   where (slot ->> 'day')::date >= p_week_start
     and (slot ->> 'day')::date <  p_week_start + 7
  on conflict do nothing;

  -- 3. On marque la semaine comme remplie (ou on met à jour le commentaire)
  insert into public.availability_submissions (player_id, week_start, comment, submitted_at)
  values (v_player, p_week_start, nullif(trim(p_comment), ''), now())
  on conflict (player_id, week_start)
  do update set comment      = excluded.comment,
                submitted_at = excluded.submitted_at;
end;
$$;
