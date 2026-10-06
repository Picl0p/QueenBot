-- =====================================================================
-- Migration 14 – bouton « Synchroniser » de la page Joueurs
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (après la migration 05 ; peut être relancée sans risque)
--
-- Le bouton lance tout de suite la tâche GitHub qui met à jour le
-- classement et les games (.github/workflows/riot.yml), sans attendre le
-- passage automatique de chaque heure (qui reste en place).
--
-- Pour lancer une tâche GitHub, il faut un jeton GitHub. Il ne peut pas
-- être dans le code du site (tout le monde pourrait le lire) : il est
-- rangé ici, dans app_settings, et c'est la base qui appelle GitHub, via
-- l'extension pg_net (requêtes web depuis la base).
--
-- Garde-fous : réservé aux membres, et au plus une demande toutes les
-- 5 minutes (la clé Riot a une limite d'appels).
--
-- À faire à la main après cette migration : voir la section 3 en bas.
-- =====================================================================

-- Requêtes web depuis la base (fournie par Supabase)
create extension if not exists pg_net;

begin;

-- ---------------------------------------------------------------------
-- 1. Réglages (pas secrets) : quel dépôt, quelle branche, quelle tâche
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('github_repo',     'Picl0p/QueenBot'),
  ('github_branch',   'main'),
  ('github_workflow', 'riot.yml')
on conflict (key) do nothing;


-- ---------------------------------------------------------------------
-- 2. Fonctions appelées par le site
-- ---------------------------------------------------------------------

-- Demande une synchronisation. Renvoie {"ok": true} si la demande est
-- partie, ou {"ok": false, "message": "…"} avec la raison.
create or replace function public.request_riot_sync()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_token   text;
  v_repo    text;
  v_branch  text;
  v_file    text;
  v_last    timestamptz;
  v_request bigint;
begin
  if not public.is_member() then
    raise exception 'Accès réservé aux membres de la team';
  end if;

  select value into v_token  from public.app_settings where key = 'github_token';
  select value into v_repo   from public.app_settings where key = 'github_repo';
  select value into v_branch from public.app_settings where key = 'github_branch';
  select value into v_file   from public.app_settings where key = 'github_workflow';
  if nullif(trim(v_token), '') is null then
    return jsonb_build_object('ok', false, 'message',
      'Le jeton GitHub n''est pas configuré (voir sql/14_bouton_synchroniser.sql, section 3).');
  end if;

  -- Au plus une demande toutes les 5 minutes
  select value::timestamptz into v_last from public.app_settings where key = 'riot_sync_requested_at';
  if v_last is not null and v_last > now() - interval '5 minutes' then
    return jsonb_build_object('ok', false, 'message',
      format('Une synchronisation a déjà été lancée il y a %s min. Réessaie dans quelques minutes.',
             greatest(1, round(extract(epoch from (now() - v_last)) / 60))));
  end if;

  -- La requête part après la fin de cette fonction (pg_net est asynchrone) :
  -- riot_sync_status() dira ensuite si GitHub l'a acceptée.
  select net.http_post(
    url     := format('https://api.github.com/repos/%s/actions/workflows/%s/dispatches', v_repo, v_file),
    body    := jsonb_build_object('ref', v_branch),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || trim(v_token),
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'User-Agent', 'QueenBot'          -- GitHub refuse les requêtes sans User-Agent
    )
  ) into v_request;

  insert into public.app_settings (key, value) values
    ('riot_sync_requested_at', now()::text),
    ('riot_sync_request_id',   v_request::text)
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('ok', true);
end;
$$;

-- Réponse de GitHub à la dernière demande :
--   {"status": 204}                      demande acceptée, la tâche démarre
--   {"status": 401, "detail": "…"}       jeton refusé, dépôt introuvable…
--   {"status": null}                     pas encore de réponse
create or replace function public.riot_sync_status()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_request bigint;
  v_status  integer;
  v_detail  text;
begin
  if not public.is_member() then
    raise exception 'Accès réservé aux membres de la team';
  end if;

  select value::bigint into v_request from public.app_settings where key = 'riot_sync_request_id';
  select r.status_code, coalesce(r.error_msg, left(r.content, 300))
    into v_status, v_detail
    from net._http_response r
   where r.id = v_request;

  return jsonb_build_object('status', v_status, 'detail', case when v_status = 204 then null else v_detail end);
end;
$$;

revoke execute on function public.request_riot_sync() from public, anon;
revoke execute on function public.riot_sync_status()  from public, anon;
grant  execute on function public.request_riot_sync() to authenticated;
grant  execute on function public.riot_sync_status()  to authenticated;

commit;


-- ---------------------------------------------------------------------
-- 3. À faire à la main (une seule fois)
--    ⚠️ Ne mets PAS le jeton dans ce fichier (il est publié sur GitHub).
-- ---------------------------------------------------------------------

-- a) Créer un jeton GitHub qui ne peut QUE lancer les tâches de ce dépôt :
--    GitHub > ta photo > Settings > Developer settings > Personal access
--    tokens > Fine-grained tokens > Generate new token
--      * Repository access : « Only select repositories » > QueenBot
--      * Permissions > Repository permissions > Actions : « Read and write »
--      * Expiration : celle que tu veux (à renouveler ensuite ici)
--
-- b) Le ranger dans la base (SQL Editor) :
--
-- insert into public.app_settings (key, value)
-- values ('github_token', 'github_pat_…')
-- on conflict (key) do update set value = excluded.value;
