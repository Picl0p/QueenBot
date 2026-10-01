"use strict";

// =====================================================================
// common.js – ce que toutes les pages du site partagent
//
//   1. Petits utilitaires (sélection d'éléments, création de HTML)
//   2. Connexion à Supabase
//   3. Gestion de la session (connecté / pas membre / pas connecté)
//
// Chaque page charge config.js, puis ce fichier, puis son propre script
// (app.js pour le planning, stats.js pour les statistiques), qui termine
// par startSession(…) pour dire quoi charger une fois le membre reconnu.
// =====================================================================


// ---------------------------------------------------------------------
// 1. Utilitaires
// ---------------------------------------------------------------------

// Raccourci : $("#id") équivaut à document.querySelector("#id")
const $ = (selector) => document.querySelector(selector);

// Crée un élément HTML. Exemple :
//   el("p", { class: "note", text: "Bonjour" })  →  <p class="note">Bonjour</p>
// On passe TOUJOURS le texte via `text` (textContent) et jamais via innerHTML :
// les données viennent de la base, donc des joueurs. Avec innerHTML,
// un pseudo contenant du HTML serait interprété (faille XSS).
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== ""));
  return node;
}

const TYPE_LABELS = {
  flex: "Flex",
  scrim: "Scrim",
  match_officiel: "Match officiel",
  review: "Review",
  autre: "Autre",
};

// Affiche une vue et masque les autres
const VIEWS = ["loading", "login", "denied", "app"];
function show(view) {
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
}

function showError(message) {
  const box = $("#error");
  box.textContent = message;
  box.hidden = false;
}


// ---------------------------------------------------------------------
// 2. Connexion à Supabase
// ---------------------------------------------------------------------

if (typeof window.supabase === "undefined") {
  show("loading");
  showError("La librairie Supabase n'a pas pu être chargée. Vérifie ta connexion internet, puis recharge la page.");
  throw new Error("supabase-js non chargé");
}
if (SUPABASE_URL.includes("XXXX") || SUPABASE_ANON_KEY.startsWith("colle-")) {
  show("loading");
  showError("Le site n'est pas encore configuré : renseigne SUPABASE_URL et SUPABASE_ANON_KEY dans js/config.js.");
  throw new Error("config.js non renseigné");
}

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Qui est connecté. Chaque page peut y ajouter son propre état.
const state = {
  userId: null,        // id Supabase de la personne connectée
  player: null,        // sa ligne dans la table players
};


// ---------------------------------------------------------------------
// 3. Session
// ---------------------------------------------------------------------

// Infos Discord stockées par Supabase à la connexion
function discordInfo(user) {
  const meta = user.user_metadata || {};
  return {
    id: meta.provider_id || meta.sub || "",
    name: meta.custom_claims?.global_name || meta.full_name || meta.name || "Joueur",
    avatar: meta.avatar_url || "",
  };
}

function renderUserZone(user, pseudo) {
  const zone = $("#user-zone");
  if (!user) {
    zone.hidden = true;
    return;
  }
  const info = discordInfo(user);
  $("#user-name").textContent = pseudo || info.name;
  const avatar = $("#user-avatar");
  if (info.avatar) {
    avatar.src = info.avatar;
    avatar.hidden = false;
  } else {
    avatar.hidden = true;
  }
  zone.hidden = false;
}

async function handleSession(session) {
  // Pas connecté
  if (!session) {
    state.userId = null;
    state.player = null;
    renderUserZone(null);
    show("login");
    return;
  }

  // Déjà chargé pour cet utilisateur (Supabase renvoie parfois l'événement deux fois)
  if (state.userId === session.user.id) return;
  state.userId = session.user.id;

  // Nettoie l'URL après le retour de Discord (#access_token=…)
  if (location.hash.includes("access_token")) {
    history.replaceState(null, "", location.pathname + location.search);
  }

  // Cherche la ligne du joueur. Grâce à la RLS, un non-membre ne voit
  // aucune ligne : data vaut alors null.
  const { data: player, error } = await db
    .from("players")
    .select("id, pseudo, main_role, status, is_admin, user_id, discord_id")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (error) {
    showError(`Impossible de vérifier ton accès : ${error.message}`);
    return;
  }

  if (!player) {
    renderUserZone(session.user);
    $("#denied-discord-id").textContent = discordInfo(session.user).id || "(identifiant introuvable)";
    show("denied");
    return;
  }

  state.player = player;
  renderUserZone(session.user, player.pseudo);
  show("app");

  // La suite dépend de la page : voir startSession
  await onMemberReady();
}

async function login() {
  const { error } = await db.auth.signInWithOAuth({
    provider: "discord",
    // Revient sur cette même page après l'autorisation Discord
    options: { redirectTo: location.origin + location.pathname },
  });
  if (error) showError(`Connexion impossible : ${error.message}`);
}

async function logout() {
  await db.auth.signOut();
  // La suite est gérée par onAuthStateChange (événement SIGNED_OUT)
}


// Ce que la page charge une fois le membre reconnu (fourni à startSession)
let onMemberReady = async () => {};

// À appeler à la fin du script de chaque page.
function startSession(onReady) {
  onMemberReady = onReady;

  $("#login-btn").addEventListener("click", login);
  $("#logout-btn").addEventListener("click", logout);
  $("#denied-logout-btn").addEventListener("click", logout);

  // Supabase prévient à chaque changement de session (au chargement,
  // après la connexion, à la déconnexion). Le setTimeout est recommandé
  // par Supabase : on ne doit pas appeler la base directement dans ce callback.
  db.auth.onAuthStateChange((event, session) => {
    if (["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT"].includes(event)) {
      setTimeout(() => handleSession(session), 0);
    }
  });
}
