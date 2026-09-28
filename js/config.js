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
const BOARD_START_HOUR = 18;
const BOARD_END_HOUR = 24;
