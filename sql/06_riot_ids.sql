-- =====================================================================
-- Migration 06 – le companion lit les Riot ID de la team
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (après la migration 05 ; peut être relancée sans risque)
--
-- Le companion (scripts/lcu_companion.py) n'envoie une game que si au
-- moins 4 joueurs de la team sont dans la même équipe. Pour les
-- reconnaître, il lit la colonne `riot_id` ("Pseudo#TAG") de la table
-- `players`, qui existe déjà : cette migration n'ajoute qu'une fonction.
--
-- Majuscules et espaces n'ont pas d'importance dans la comparaison.
-- =====================================================================

-- Liste des Riot ID de la team, pour le companion.
-- Comme ingest_game, elle exige le jeton partagé.
create or replace function public.team_riot_ids(p_token text)
returns text[]
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform public.check_ingest_token(p_token);
  return coalesce(
    (select array_agg(p.riot_id)
       from public.players p
      where nullif(trim(p.riot_id), '') is not null),
    '{}'
  );
end;
$$;

grant execute on function public.team_riot_ids(text) to anon, authenticated;

-- Pour vérifier ce que le companion verra :
-- select pseudo, status, riot_id from public.players order by pseudo;
