-- =====================================================================
-- Migration 16 – le champ « Side » d'un rendez-vous est du texte libre
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- (peut être relancée sans risque)
--
-- La colonne events.side existait déjà dans la base avant la migration
-- 05, avec une règle (events_side_check) qui n'acceptait que quelques
-- valeurs précises. La migration 05 ne l'a donc pas recréée, et la règle
-- est restée. Or le formulaire du site envoie du texte libre (« Blue
-- side », « Blue side en game 1, puis alterné »…), d'où l'erreur :
--   new row for relation "events" violates check constraint "events_side_check"
--
-- On retire la règle : le side redevient un simple texte, comme prévu.
-- Les valeurs déjà enregistrées ne sont pas modifiées.
-- =====================================================================

alter table public.events drop constraint if exists events_side_check;

-- Pour voir s'il reste d'autres règles héritées sur les rendez-vous
-- (seules celles sur starts_at / ends_at sont attendues) :
--
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--  where conrelid = 'public.events'::regclass and contype = 'c';
