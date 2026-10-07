-- =====================================================================
-- Migration 15 – correctif : le companion n'enregistrait plus les games
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (peut être relancée sans risque)
--
-- La fonction team_riot_ids de la migration 11 (smurfs) contenait une
-- faute : elle nommait « id » la liste des comptes, alors que la table
-- players a déjà une colonne « id ». Postgres refusait donc de choisir
-- entre les deux (« column reference "id" is ambiguous »), et le
-- companion, qui appelle cette fonction avant chaque envoi, ne pouvait
-- plus enregistrer aucune game.
--
-- Même fonction, avec un nom sans ambiguïté (« account »).
-- =====================================================================

create or replace function public.team_riot_ids(p_token text)
returns text[]
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform public.check_ingest_token(p_token);
  return coalesce(
    (select array_agg(distinct trim(a.account))
       from public.players p
      cross join lateral unnest(array[p.riot_id] || p.smurfs) as a(account)
      where nullif(trim(a.account), '') is not null),
    '{}'
  );
end;
$$;

grant execute on function public.team_riot_ids(text) to anon, authenticated;

-- Pour vérifier (doit renvoyer une ligne par compte, sans erreur) :
-- select p.pseudo, a.account
--   from public.players p
--  cross join lateral unnest(array[p.riot_id] || p.smurfs) as a(account)
--  where nullif(trim(a.account), '') is not null
--  order by p.pseudo;
