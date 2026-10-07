-- =====================================================================
-- Migration 11 – page « Mon profil » et comptes secondaires (smurfs)
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (après la migration 06 ; peut être relancée sans risque)
--
-- Chaque joueur peut maintenant modifier lui-même, depuis le site :
--   * son pseudo et son rôle (c'était déjà permis par la base) ;
--   * son Riot ID principal (jusqu'ici, seulement via le dashboard) ;
--   * ses comptes secondaires (smurfs), 5 au maximum.
--
-- Une game jouée sur un smurf est reconnue comme une game du joueur :
--   * par le companion (qui garde les games où au moins 4 comptes de la
--     team sont dans la même équipe) : la fonction team_riot_ids renvoie
--     maintenant aussi les smurfs ;
--   * par la page Statistiques, qui regroupe tous les comptes d'un joueur.
-- =====================================================================

begin;

-- La colonne riot_id existe déjà dans la base (ajoutée à la main) :
-- "if not exists" ne fait rien dans ce cas.
alter table public.players
  add column if not exists riot_id text,                          -- compte principal, "Pseudo#TAG"
  add column if not exists smurfs  text[] not null default '{}';  -- comptes secondaires, "Pseudo#TAG"

alter table public.players drop constraint if exists players_smurfs_max;
alter table public.players add constraint players_smurfs_max check (cardinality(smurfs) <= 5);

-- Un joueur peut modifier ces colonnes sur SA ligne (règle "joueur :
-- modifie son propre profil" de la migration 01). Le statut et le droit
-- d'admin restent réservés au dashboard Supabase.
grant update (pseudo, main_role, riot_id, smurfs) on public.players to authenticated;


-- Liste des Riot ID de la team pour le companion : comptes principaux ET
-- smurfs. Comme avant, elle exige le jeton partagé.
create or replace function public.team_riot_ids(p_token text)
returns text[]
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform public.check_ingest_token(p_token);
  return coalesce(
    -- "account" et pas "id" : players a déjà une colonne id, Postgres refuserait
    -- de choisir entre les deux (corrigé après coup, voir la migration 15)
    (select array_agg(distinct trim(a.account))
       from public.players p
      cross join lateral unnest(array[p.riot_id] || p.smurfs) as a(account)
      where nullif(trim(a.account), '') is not null),
    '{}'
  );
end;
$$;

grant execute on function public.team_riot_ids(text) to anon, authenticated;

commit;

-- Pour vérifier ce que le companion verra :
-- select pseudo, status, riot_id, smurfs from public.players order by pseudo;
