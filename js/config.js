// =====================================================================
// Configuration du site
// Valeurs à récupérer dans Supabase : Project Settings > API
// (ou "API Keys" selon la version du tableau de bord).
//
// La clé "anon" (ou "publishable") est FAITE pour être publique :
// la sécurité repose sur les règles RLS écrites en SQL.
// Ne mets JAMAIS la clé "service_role" (ou "secret") ici.
// =====================================================================

const SUPABASE_URL = "https://nivltpimngoukjibdwyg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Zgu7a_136TbcNHA9EPxE8A_BSUMOYb8";

// Plage horaire affichée sur l'échiquier (heure de fin exclue).
// En semaine on commence le soir ; le samedi et le dimanche, dès le matin.
const BOARD_START_HOUR = 18;
const BOARD_WEEKEND_START_HOUR = 10;
const BOARD_END_HOUR = 24;

// Petite icône affichée sur les cases où le coach est là
const COACH_ICON = "♚";

// Page Statistiques : date de début du filtre "Saison" (à changer à chaque saison)
const STATS_SEASON_START = "2026-01-08";

// Types de rendez-vous pour lesquels un post est créé dans le forum Discord.
// Retire un type de la liste pour ne plus créer de post (ex. "review").
// Le webhook du forum, lui, n'est PAS ici : il est secret et rangé dans
// Supabase (voir sql/05_sessions_discord_games.sql, section 5).
const DISCORD_POST_TYPES = ["flex", "scrim", "match_officiel", "review", "autre"];
