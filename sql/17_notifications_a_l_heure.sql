-- =====================================================================
-- Migration 17 – notifications Discord envoyées à l'heure
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (après la migration 14 ; peut être relancée sans risque)
--
-- Jusqu'ici, c'est GitHub qui choisissait l'heure de lancement des
-- notifications (les "cron" de .github/workflows/notifications.yml).
-- Mais GitHub lance ces tâches automatiques avec des heures de retard
-- (souvent 6 à 13 h) : le script voyait qu'il était trop tard et
-- s'arrêtait sans rien envoyer. La tâche était verte, mais rien
-- n'arrivait sur Discord.
--
-- Maintenant c'est la base qui donne l'heure : l'extension pg_cron
-- (fournie par Supabase) se réveille à l'heure pile et demande à GitHub
-- de lancer la tâche tout de suite, comme le bouton « Run workflow ».
-- Un lancement demandé ainsi démarre en moins d'une minute.
--
-- Rien de plus à configurer : la demande utilise le jeton GitHub déjà
-- rangé pour le bouton « Synchroniser » (migration 14).
--
-- Horaires (heure de Paris, été comme hiver) :
--   * planning du jour : tous les jours à 11h47 ;
--   * relance des dispos : le vendredi et le dimanche à 19h47.
-- Pour les changer : modifier la section 2 et relancer ce fichier.
-- =====================================================================

-- Tâches planifiées dans la base (fournie par Supabase)
create extension if not exists pg_cron;
-- Requêtes web depuis la base (déjà là depuis la migration 14)
create extension if not exists pg_net;

begin;

insert into public.app_settings (key, value) values
  ('github_notify_workflow', 'notifications.yml')
on conflict (key) do nothing;


-- ---------------------------------------------------------------------
-- 1. Demande à GitHub de lancer une notification
-- ---------------------------------------------------------------------
-- pg_cron ne connaît que l'heure UTC, sans heure d'été : chaque
-- notification est donc planifiée à deux heures UTC (été et hiver), et
-- la fonction ne fait la demande que si c'est la bonne heure à Paris.
create or replace function public.dispatch_notification(p_mode text, p_paris_hour integer)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_token   text;
  v_repo    text;
  v_branch  text;
  v_file    text;
  v_request bigint;
begin
  if extract(hour from (now() at time zone 'Europe/Paris')) <> p_paris_hour then
    return;   -- l'autre horaire (été / hiver) est le bon
  end if;

  select value into v_token  from public.app_settings where key = 'github_token';
  select value into v_repo   from public.app_settings where key = 'github_repo';
  select value into v_branch from public.app_settings where key = 'github_branch';
  select value into v_file   from public.app_settings where key = 'github_notify_workflow';
  if nullif(trim(v_token), '') is null then
    raise exception 'Le jeton GitHub n''est pas configuré (voir sql/14_bouton_synchroniser.sql, section 3)';
  end if;

  -- Comme le bouton « Run workflow », avec « Test » décoché
  select net.http_post(
    url     := format('https://api.github.com/repos/%s/actions/workflows/%s/dispatches', v_repo, v_file),
    body    := jsonb_build_object(
      'ref', v_branch,
      'inputs', jsonb_build_object('mode', p_mode, 'dry_run', 'false')
    ),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || trim(v_token),
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'User-Agent', 'QueenBot'          -- GitHub refuse les requêtes sans User-Agent
    )
  ) into v_request;

  -- Pour savoir après coup si GitHub a accepté (voir la section 3)
  insert into public.app_settings (key, value) values
    ('notify_' || p_mode || '_requested_at', now()::text),
    ('notify_' || p_mode || '_request_id',   v_request::text)
  on conflict (key) do update set value = excluded.value;
end;
$$;

-- Appelée seulement par pg_cron, jamais par le site
revoke execute on function public.dispatch_notification(text, integer) from public, anon, authenticated;

commit;


-- ---------------------------------------------------------------------
-- 2. Horaires (en UTC : Paris = UTC+2 l'été, UTC+1 l'hiver)
--    Relancer ce fichier remplace les horaires du même nom.
-- ---------------------------------------------------------------------
select cron.schedule('notif-planning', '47 9,10 * * *',
                     $$select public.dispatch_notification('planning', 11)$$);
select cron.schedule('notif-relance', '47 17,18 * * 0,5',
                     $$select public.dispatch_notification('relance', 19)$$);


-- ---------------------------------------------------------------------
-- 3. Pour vérifier (à lancer à la main, quand tu veux)
-- ---------------------------------------------------------------------
-- Les horaires enregistrés :
--   select jobname, schedule, active from cron.job;
--
-- Les derniers réveils (status = succeeded attendu) :
--   select j.jobname, d.start_time, d.status, d.return_message
--     from cron.job_run_details d join cron.job j using (jobid)
--    order by d.start_time desc limit 10;
--
-- La réponse de GitHub à la dernière demande (204 = acceptée ; gardée 6 h) :
--   select r.status_code, r.content
--     from net._http_response r
--    where r.id = (select value::bigint from public.app_settings
--                   where key = 'notify_planning_request_id');
--
-- Pour tout arrêter :
--   select cron.unschedule('notif-planning');
--   select cron.unschedule('notif-relance');
