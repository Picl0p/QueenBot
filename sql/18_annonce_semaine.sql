-- =====================================================================
-- Migration 18 – bouton « Annoncer la semaine » de la page Planning
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (après les migrations 14 et 17 ; peut être relancée sans risque)
--
-- Une fois les rendez-vous de la semaine préparés, un admin clique sur
-- le bouton : un message récapitule sur Discord les jours où l'on joue,
-- dans le même salon que le planning du midi. L'admin peut y ajouter un
-- petit mot (remarques sur le planning), 500 caractères au plus.
--
-- Ce salon n'est connu que de GitHub (secret DISCORD_WEBHOOK_URL) : la
-- base demande donc à GitHub de lancer la tâche des notifications en
-- mode « semaine », comme le bouton « Synchroniser » de la page Joueurs
-- (même jeton GitHub, rien de plus à configurer).
--
-- Garde-fous : réservé aux admins, et au plus une annonce toutes les
-- 2 minutes (pour éviter les doubles clics qui posteraient deux fois).
-- =====================================================================

-- Requêtes web depuis la base (déjà là depuis la migration 14)
create extension if not exists pg_net;

begin;

insert into public.app_settings (key, value) values
  ('github_notify_workflow', 'notifications.yml')
on conflict (key) do nothing;


-- Demande l'annonce de la semaine qui commence le lundi p_week_start,
-- avec le mot de l'admin p_note (facultatif).
-- Renvoie {"ok": true} si la demande est partie, ou
-- {"ok": false, "message": "…"} avec la raison.
create or replace function public.request_week_announcement(p_week_start date, p_note text default null)
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
  if not public.is_admin() then
    raise exception 'Réservé aux admins de la team';
  end if;
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception 'La semaine doit commencer un lundi';
  end if;
  if char_length(p_note) > 500 then
    return jsonb_build_object('ok', false, 'message', 'Le message est trop long (500 caractères au plus).');
  end if;

  select value into v_token  from public.app_settings where key = 'github_token';
  select value into v_repo   from public.app_settings where key = 'github_repo';
  select value into v_branch from public.app_settings where key = 'github_branch';
  select value into v_file   from public.app_settings where key = 'github_notify_workflow';
  if nullif(trim(v_token), '') is null then
    return jsonb_build_object('ok', false, 'message',
      'Le jeton GitHub n''est pas configuré (voir sql/14_bouton_synchroniser.sql, section 3).');
  end if;

  select value::timestamptz into v_last from public.app_settings where key = 'notify_semaine_requested_at';
  if v_last is not null and v_last > now() - interval '2 minutes' then
    return jsonb_build_object('ok', false, 'message',
      'Une annonce vient déjà de partir. Attends deux minutes avant d''en envoyer une autre.');
  end if;

  select net.http_post(
    url     := format('https://api.github.com/repos/%s/actions/workflows/%s/dispatches', v_repo, v_file),
    body    := jsonb_build_object(
      'ref', v_branch,
      'inputs', jsonb_build_object('mode', 'semaine', 'week', p_week_start::text,
                                   'note', coalesce(trim(p_note), ''), 'dry_run', 'false')
    ),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || trim(v_token),
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'User-Agent', 'QueenBot'          -- GitHub refuse les requêtes sans User-Agent
    )
  ) into v_request;

  insert into public.app_settings (key, value) values
    ('notify_semaine_requested_at', now()::text),
    ('notify_semaine_request_id',   v_request::text)
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('ok', true);
end;
$$;

-- Réponse de GitHub à la dernière demande :
--   {"status": 204}                  demande acceptée, le message part
--   {"status": 401, "detail": "…"}   jeton refusé, tâche introuvable…
--   {"status": null}                 pas encore de réponse
create or replace function public.week_announcement_status()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_request bigint;
  v_status  integer;
  v_detail  text;
begin
  if not public.is_admin() then
    raise exception 'Réservé aux admins de la team';
  end if;

  select value::bigint into v_request from public.app_settings where key = 'notify_semaine_request_id';
  select r.status_code, coalesce(r.error_msg, left(r.content, 300))
    into v_status, v_detail
    from net._http_response r
   where r.id = v_request;

  return jsonb_build_object('status', v_status, 'detail', case when v_status = 204 then null else v_detail end);
end;
$$;

revoke execute on function public.request_week_announcement(date, text) from public, anon;
revoke execute on function public.week_announcement_status()            from public, anon;
grant  execute on function public.request_week_announcement(date, text) to authenticated;
grant  execute on function public.week_announcement_status()            to authenticated;

commit;
