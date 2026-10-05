-- =====================================================================
-- Migration 09 – une normale jouée pendant une session "Flex" compte pour elle
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (après la migration 08 ; peut être relancée sans risque)
--
-- Quand on n'est que 4, la flex est impossible : on joue en normale à la
-- place. Ces games doivent quand même compter pour la session prévue.
--
-- Nouvelle règle de rattachement :
--   * game perso      → scrim ou match officiel en cours (inchangé) ;
--   * flex OU normale → session "Flex" en cours (de 1h avant le début à
--     1h après la fin) : elle compte dans la série et son résultat est
--     annoncé dans le post Discord de la session ;
--   * normale jouée hors de toute session → rattachée à rien, pas d'annonce.
--
-- La fonction est la même que dans la migration 08, sans l'exception des
-- normales. En bas : les normales déjà enregistrées sont rattachées à la
-- session Flex pendant laquelle elles ont été jouées (sans annonce Discord
-- après coup).
-- =====================================================================

begin;

create or replace function public.ingest_game(p_token text, p_game jsonb)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_riot_id  bigint      := (p_game ->> 'riot_game_id')::bigint;
  v_started  timestamptz := (p_game ->> 'started_at')::timestamptz;
  v_custom   boolean     := coalesce((p_game ->> 'is_custom')::boolean, false);
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
          -- Flex OU normale : rattachée à la session "Flex" en cours (une
          -- normale y est jouée quand on n'est que 4 et que la flex est impossible)
          or (not v_custom and e.type = 'flex'))
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

-- Rattrapage : normales déjà enregistrées, jouées pendant une session Flex
update public.games g
   set event_id = (
         select e.id
           from public.events e
          where e.status <> 'annule'
            and e.type = 'flex'
            and g.started_at >= e.starts_at - interval '1 hour'
            and g.started_at <= coalesce(e.ends_at, e.starts_at + interval '4 hours') + interval '1 hour'
          order by (g.started_at >= e.starts_at
                    and g.started_at <= coalesce(e.ends_at, e.starts_at + interval '4 hours')) desc,
                   abs(extract(epoch from (g.started_at - e.starts_at)))
          limit 1)
 where g.event_id is null
   and not g.is_custom
   and g.queue_id in (400, 430, 490);

commit;
