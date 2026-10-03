-- =====================================================================
-- Migration 08 – les games normales sont récupérées aussi
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (après la migration 05 ; peut être relancée sans risque)
--
-- Le companion envoie maintenant les games normales (draft, aveugle,
-- partie rapide) en plus des games perso et des flex. La colonne
-- `queue_id` de la table `games` existe déjà : rien à ajouter côté tables.
--
-- Seul changement : une game normale n'est JAMAIS rattachée à un
-- rendez-vous. Sans ça, une normale jouée pendant un rendez-vous "Flex"
-- serait comptée dans sa série et annoncée dans son post Discord.
-- Sur la page Statistiques, elle apparaît sous le type "Normal".
--
-- La fonction est la même que dans la migration 05, à la règle de
-- rattachement près (variable v_normal).
-- =====================================================================

create or replace function public.ingest_game(p_token text, p_game jsonb)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_riot_id  bigint      := (p_game ->> 'riot_game_id')::bigint;
  v_started  timestamptz := (p_game ->> 'started_at')::timestamptz;
  v_custom   boolean     := coalesce((p_game ->> 'is_custom')::boolean, false);
  -- Files normales : 400 = draft, 430 = aveugle, 490 = partie rapide
  v_normal   boolean     := coalesce((p_game ->> 'queue_id')::integer, -1) in (400, 430, 490);
  v_event    public.events;
  v_game     public.games;
  v_created  boolean := false;
  v_notify   boolean := false;
begin
  perform public.check_ingest_token(p_token);

  if v_riot_id is null or v_started is null then
    raise exception 'Game incomplète (riot_game_id et started_at sont obligatoires)';
  end if;

  select e.* into v_event
    from public.events e
   where e.status <> 'annule'
     and ((v_custom and e.type in ('scrim', 'match_officiel'))
          or (not v_custom and not v_normal and e.type = 'flex'))
     and v_started >= e.starts_at - interval '1 hour'
     and v_started <= coalesce(e.ends_at, e.starts_at + interval '4 hours') + interval '1 hour'
   order by (v_started >= e.starts_at
             and v_started <= coalesce(e.ends_at, e.starts_at + interval '4 hours')) desc,
            abs(extract(epoch from (v_started - e.starts_at)))
   limit 1;

  insert into public.games (riot_game_id, event_id, started_at, duration_s, game_version,
                            queue_id, is_custom, our_side, winner, draft, teams, raw, reported_by)
  values (v_riot_id, v_event.id, v_started,
          coalesce((p_game ->> 'duration_s')::integer, 0),
          p_game ->> 'game_version',
          (p_game ->> 'queue_id')::integer,
          v_custom,
          p_game ->> 'our_side',
          p_game ->> 'winner',
          p_game -> 'draft',
          p_game -> 'teams',
          p_game -> 'raw',
          p_game ->> 'reported_by')
  on conflict (riot_game_id) do nothing
  returning * into v_game;

  if v_game.id is not null then
    v_created := true;

    insert into public.game_participants (game_id, side, slot, riot_id, puuid, champion_id, champion,
                                          kills, deaths, assists, cs, gold, damage, vision_score, level)
    select v_game.id,
           p ->> 'side',
           (p ->> 'slot')::smallint,
           p ->> 'riot_id',
           p ->> 'puuid',
           (p ->> 'champion_id')::integer,
           p ->> 'champion',
           (p ->> 'kills')::integer,
           (p ->> 'deaths')::integer,
           (p ->> 'assists')::integer,
           (p ->> 'cs')::integer,
           (p ->> 'gold')::integer,
           (p ->> 'damage')::integer,
           (p ->> 'vision_score')::integer,
           (p ->> 'level')::integer
      from jsonb_array_elements(coalesce(p_game -> 'participants', '[]'::jsonb)) as p;
  else
    -- Game déjà connue : on complète ce que le premier envoi ignorait
    -- (notre côté, ou la draft dans l'ordre si quelqu'un a vu le champ select).
    update public.games g
       set our_side = coalesce(g.our_side, p_game ->> 'our_side'),
           draft    = case
                        when p_game #>> '{draft,source}' = 'champ_select'
                             and coalesce(g.draft ->> 'source', '') <> 'champ_select'
                        then p_game -> 'draft'
                        else g.draft
                      end
     where g.riot_game_id = v_riot_id
    returning * into v_game;

    select e.* into v_event from public.events e where e.id = v_game.event_id;
  end if;

  -- Réserve l'annonce Discord (un seul companion à la fois)
  if v_event.discord_thread_id is not null then
    update public.games g
       set notify_claimed_at = now()
     where g.id = v_game.id
       and g.discord_message_id is null
       and (g.notify_claimed_at is null or g.notify_claimed_at < now() - interval '2 minutes')
    returning true into v_notify;
  end if;

  return jsonb_build_object(
    'created', v_created,
    'notify',  coalesce(v_notify, false),
    'draft',   v_game.draft,
    'our_side', v_game.our_side,
    -- Numéro de la game dans la session, et score de la série
    'game_number', (select count(*) from public.games g
                     where g.event_id = v_game.event_id and g.started_at <= v_game.started_at),
    'wins',   (select count(*) from public.games g
                where g.event_id = v_game.event_id and g.winner = g.our_side),
    'losses', (select count(*) from public.games g
                where g.event_id = v_game.event_id and g.winner <> g.our_side),
    'event', case when v_event.id is null then null else jsonb_build_object(
               'id', v_event.id,
               'title', v_event.title,
               'type', v_event.type,
               'opponent', v_event.opponent,
               'thread_id', v_event.discord_thread_id
             ) end,
    'webhook_url', case when coalesce(v_notify, false)
                        then (select value from public.app_settings where key = 'discord_forum_webhook')
                   end
  );
end;
$$;
