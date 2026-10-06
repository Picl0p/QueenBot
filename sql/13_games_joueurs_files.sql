-- =====================================================================
-- Migration 13 – page Joueurs : flex et normales en plus de la soloQ
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (après la migration 12 ; peut être relancée sans risque)
--
-- Le pool de champions de la page Joueurs montre ce que chacun joue de
-- son côté : soloQ, flex et normales (seul, à 2-3 ou en team). Les
-- scrims et les tournois n'y sont pas : ce sont des parties
-- personnalisées, absentes de l'historique public de Riot, et elles ont
-- déjà leur page (Statistiques).
--
-- La table soloq_games garde son nom, mais contient maintenant ces trois
-- types de games : on y ajoute le numéro de la file.
--   420 = soloQ · 440 = flex · 400 = normale draft · 430 = aveugle · 490 = partie rapide
-- Les games déjà enregistrées sont toutes de la soloQ (420).
-- =====================================================================

alter table public.soloq_games
  add column if not exists queue_id integer not null default 420;

comment on table public.soloq_games is
  'Games classées et normales de chaque compte (soloQ, flex, normales). Le nom date de la première version, qui ne gardait que la soloQ.';
