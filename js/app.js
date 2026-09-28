"use strict";

// =====================================================================
// app.js – logique du site Queen's Gambit
//
// Organisation du fichier :
//   1. Petits utilitaires (sélection d'éléments, dates, création de HTML)
//   2. Connexion à Supabase
//   3. Gestion de la session (connecté / pas membre / pas connecté)
//   4. Chargement et affichage des rendez-vous
//   5. Échiquier des dispos (consultation et saisie)
//   6. Branchement des boutons, puis démarrage
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

// --- Dates ---
// Attention : on travaille en heure LOCALE. On évite toISOString(),
// qui convertit en UTC et peut décaler la date d'un jour.

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (d.getDay() + 6) % 7; // lundi = 0 … dimanche = 6
  d.setDate(d.getDate() - offset);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// Date → "2026-09-28" (format attendu par Postgres pour le type date)
function toISODate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const JOURS_COURTS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
const JOURS_LONGS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

const TYPE_LABELS = {
  entrainement: "Entraînement",
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

// État de la page, centralisé ici
const state = {
  userId: null,        // id Supabase de la personne connectée
  player: null,        // sa ligne dans la table players
  players: [],         // tous les joueurs de la team
  weekStart: mondayOf(new Date()),

  // Échiquier
  heat: [],              // résultat de availability_heatmap
  heatMap: new Map(),    // même chose, indexé par "jour|heure"
  missing: [],           // joueurs qui n'ont pas répondu
  submissions: [],       // semaines validées (avec commentaires)
  mySubmission: null,    // ma validation pour la semaine affichée
  savedSlots: new Map(), // mes créneaux enregistrés : "jour|heure" → statut
  mySlots: new Map(),    // mes créneaux pendant la saisie (copie de travail)
  editing: false,        // mode saisie actif ?
  brush: "dispo",        // statut appliqué en cliquant : dispo, a_eviter, pas_dispo
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

  await loadPlayers();
  await Promise.all([loadEvents(), loadBoard()]);
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


// ---------------------------------------------------------------------
// 4. Rendez-vous (table events)
// ---------------------------------------------------------------------

async function loadPlayers() {
  const { data, error } = await db.from("players").select("id, pseudo, status").order("pseudo");
  if (error) return showError(`Impossible de charger les joueurs : ${error.message}`);
  state.players = data;
}

async function loadEvents() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data, error } = await db
    .from("events")
    .select("id, title, type, starts_at, ends_at, opponent, notes")
    .gte("starts_at", today.toISOString())
    .order("starts_at")
    .limit(8);

  if (error) return showError(`Impossible de charger le planning : ${error.message}`);
  renderEvents(data);
}

function renderEvents(events) {
  const list = $("#events-list");
  list.replaceChildren();

  if (events.length === 0) {
    list.append(el("li", { class: "event event-empty", text: "Aucun rendez-vous prévu pour l'instant." }));
    return;
  }

  const fmtDay = { weekday: "long", day: "numeric", month: "long" };
  const fmtTime = { hour: "2-digit", minute: "2-digit" };

  for (const ev of events) {
    const start = new Date(ev.starts_at);
    const end = ev.ends_at ? new Date(ev.ends_at) : null;
    const time = start.toLocaleTimeString("fr-FR", fmtTime) + (end ? ` à ${end.toLocaleTimeString("fr-FR", fmtTime)}` : "");

    list.append(
      el("li", { class: `event type-${ev.type}` },
        el("time", { class: "event-date", datetime: ev.starts_at, text: start.toLocaleDateString("fr-FR", fmtDay) }),
        el("span", { class: "event-time", text: time }),
        el("p", { class: "event-title", text: ev.title }),
        el("p", { class: "event-meta" },
          el("span", { class: "event-type", text: TYPE_LABELS[ev.type] || ev.type }),
          ev.opponent ? el("span", { class: "event-opponent", text: `contre ${ev.opponent}` }) : null
        ),
        ev.notes ? el("p", { class: "event-notes", text: ev.notes }) : null
      )
    );
  }
}


// ---------------------------------------------------------------------
// 5. Échiquier des dispos
//
// L'échiquier a deux modes :
//   * consultation : chaque case montre combien de joueurs sont dispo
//                    (et combien l'ont marquée "à éviter") ;
//   * saisie       : chaque case montre MON statut, et je peux le changer
//                    avec le pinceau choisi (clic ou glisser).
//
// Trois statuts : "dispo", "a_eviter", "pas_dispo".
// "pas_dispo" n'est jamais stocké : c'est l'absence de ligne en base.
// ---------------------------------------------------------------------

const STATUS_MARK = { dispo: "✓", a_eviter: "!", pas_dispo: "✕" };
const STATUS_TEXT = { dispo: "dispo", a_eviter: "à éviter", pas_dispo: "pas dispo" };

// Nombre de joueurs pris en compte (les coachs sont exclus)
const teamSize = () => state.players.filter((p) => p.status !== "coach").length;

// Une semaine est "passée" si son lundi est avant le lundi de cette semaine
const isPastWeek = () => state.weekStart < mondayOf(new Date());

const plural = (n, word) => `${n} ${word}${n > 1 ? "x" : ""}`;

async function loadBoard() {
  const week = toISODate(state.weekStart);
  const weekEnd = toISODate(addDays(state.weekStart, 7));
  renderWeekLabel();

  // Quatre requêtes indépendantes, lancées en parallèle
  const [heat, missing, mine, submissions] = await Promise.all([
    db.rpc("availability_heatmap", { p_week_start: week }),
    db.rpc("players_missing_availability", { p_week_start: week }),
    db.from("availabilities")
      .select("day, hour, status")
      .eq("player_id", state.player.id)
      .gte("day", week)
      .lt("day", weekEnd),
    // players(pseudo) : Supabase fait la jointure grâce à la clé étrangère
    db.from("availability_submissions")
      .select("player_id, comment, submitted_at, players(pseudo)")
      .eq("week_start", week),
  ]);

  for (const res of [heat, missing, mine, submissions]) {
    if (res.error) return showError(`Impossible de charger les dispos : ${res.error.message}`);
  }

  state.heat = heat.data;
  state.missing = missing.data;
  // Map "jour|heure" → statut ("dispo" ou "a_eviter")
  state.savedSlots = new Map(mine.data.map((s) => [`${s.day}|${s.hour}`, s.status]));
  state.submissions = submissions.data;
  state.mySubmission = submissions.data.find((s) => s.player_id === state.player.id) || null;

  renderAll();
}

// Redessine tout ce qui dépend de la semaine affichée
function renderAll() {
  $("#board-panel").classList.toggle("is-editing", state.editing);
  $("#edit-panel").hidden = !state.editing;
  $("#brushes").hidden = !state.editing;
  $("#view-extras").hidden = state.editing;
  $("#board-help").hidden = !state.editing;
  $("#board-help").textContent = "Choisis ce que tu veux indiquer, puis clique sur les cases ou fais glisser pour en remplir plusieurs d'un coup. Recliquer sur une case la remet en « pas dispo ».";

  renderMyStatus();
  renderBrushes();
  renderBoard();

  if (state.editing) {
    renderEditCount();
  } else {
    renderMissing();
    renderComments();
  }
}

function renderWeekLabel() {
  const label = state.weekStart.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
  $("#week-label").textContent = `Semaine du ${label}`;
}

// Compte les créneaux par statut dans une Map "jour|heure" → statut
function countByStatus(slots) {
  let dispo = 0, maybe = 0;
  for (const status of slots.values()) status === "dispo" ? dispo++ : maybe++;
  return { dispo, maybe };
}

function describeCounts({ dispo, maybe }) {
  const parts = [];
  if (dispo) parts.push(`${plural(dispo, "créneau")} dispo`);
  if (maybe) parts.push(`${plural(maybe, "créneau")} à éviter`);
  return parts.join(" et ");
}

function renderMyStatus() {
  const button = $("#edit-btn");
  $("#board-actions").hidden = state.editing || isPastWeek();
  button.textContent = state.mySubmission ? "Modifier mes dispos" : "Indiquer mes dispos";
}

// Petit message qui s'affiche quelques secondes en bas de l'écran
let toastTimer;
function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3000);
}

function renderBrushes() {
  document.querySelectorAll(".brush").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.brush === state.brush));
  });
}

function renderBoard() {
  const total = teamSize();
  state.heatMap = new Map(state.heat.map((row) => [`${row.day}|${row.hour}`, row]));

  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  const todayIso = toISODate(new Date());

  // En-tête : une colonne par jour
  const headRow = el("tr", {}, el("th", { scope: "col" }));
  days.forEach((d, i) => {
    headRow.append(
      el("th", { scope: "col", class: toISODate(d) === todayIso ? "today" : "" },
        el("span", { class: "day-name", text: JOURS_COURTS[i] }),
        el("span", { class: "day-num", text: String(d.getDate()) })
      )
    );
  });

  // Corps : une ligne par heure
  const body = el("tbody");
  for (let hour = BOARD_START_HOUR; hour < BOARD_END_HOUR; hour++) {
    const row = el("tr", {}, el("th", { scope: "row", text: `${hour}h` }));

    days.forEach((d, i) => {
      const key = `${toISODate(d)}|${hour}`;
      const button = state.editing
        ? editCell(key, i, hour)
        : viewCell(key, i, hour, total);
      button.dataset.key = key;
      button.dataset.dayIndex = String(i);
      button.dataset.hour = String(hour);
      row.append(el("td", {}, button));
    });

    body.append(row);
  }

  $("#board").replaceChildren(el("thead", {}, headRow), body);

  if (!state.editing) {
    $("#slot-detail").textContent = state.heat.length
      ? "Touche une case pour voir qui est dispo."
      : "Personne n'a encore indiqué de dispo pour cette semaine.";
  }
}

// Case en mode consultation
function viewCell(key, dayIndex, hour, total) {
  const slot = state.heatMap.get(key);
  const n = slot ? Number(slot.n_available) : 0;
  const m = slot ? Number(slot.n_maybe) : 0;

  // Alternance des cases, comme sur un vrai échiquier
  const classes = ["sq", (dayIndex + hour) % 2 ? "sq-light" : "sq-dark"];
  // Personne de dispo : croix, mais seulement si au moins un joueur a
  // répondu cette semaine (sinon la case est vide faute d'info, pas "non")
  const nobody = n === 0 && m === 0;
  if (nobody) classes.push(state.submissions.length ? "is-no" : "is-empty");
  if (total && n >= total) classes.push("is-full");
  else if (total && n + m >= total) classes.push("is-possible");

  let label = `${JOURS_LONGS[dayIndex]} ${hour}h : ${n} dispo`;
  if (m) label += `, ${m} à éviter`;
  if (total && n >= total) label += ", toute l'équipe";

  const button = el("button", {
    type: "button",
    class: classes.join(" "),
    "aria-label": label,
    "aria-pressed": "false",
  },
    nobody && state.submissions.length ? "✕" : null,
    n > 0 ? el("span", { class: "sq-count", text: String(n) }) : null,
    m > 0 ? el("span", { class: "sq-maybe", text: `+${m}` }) : null
  );

  // Intensité du violet proportionnelle au nombre de joueurs dispo
  const ratio = total ? Math.min(n / total, 1) : 0;
  button.style.setProperty("--fill", n ? (0.2 + 0.7 * ratio).toFixed(2) : "0");
  return button;
}

// Case en mode saisie
function editCell(key, dayIndex, hour) {
  const button = el("button", {
    type: "button",
    class: `sq ${(dayIndex + hour) % 2 ? "sq-light" : "sq-dark"}`,
    "aria-label": `${JOURS_LONGS[dayIndex]} ${hour}h`,
  });
  button.dataset.key = key;
  refreshCell(button);
  return button;
}

// Mode consultation : affiche qui est dispo sur la case cliquée
function showSlot(cell) {
  document.querySelectorAll(".sq[aria-pressed='true']").forEach((b) => b.setAttribute("aria-pressed", "false"));
  cell.setAttribute("aria-pressed", "true");

  const dayIndex = Number(cell.dataset.dayIndex);
  const hour = cell.dataset.hour;
  const date = addDays(state.weekStart, dayIndex);
  const slot = state.heatMap.get(cell.dataset.key);
  const n = slot ? Number(slot.n_available) : 0;
  const m = slot ? Number(slot.n_maybe) : 0;

  const when = `${JOURS_LONGS[dayIndex]} ${date.getDate()} à ${hour}h`;
  if (n === 0 && m === 0) {
    $("#slot-detail").textContent = `Personne n'est dispo ${when}.`;
    return;
  }
  let text = `${when.charAt(0).toUpperCase() + when.slice(1)} : ${n} sur ${teamSize()} dispo`;
  if (n) text += ` (${slot.pseudos.join(", ")})`;
  if (m) text += `, à éviter pour ${slot.pseudos_maybe.join(", ")}`;
  $("#slot-detail").textContent = text + ".";
}

function renderMissing() {
  $("#missing").textContent = state.missing.length === 0
    ? "Tout le monde a donné ses dispos pour cette semaine."
    : `Pas encore répondu : ${state.missing.map((p) => p.pseudo).join(", ")}.`;
}

function renderComments() {
  const withComment = state.submissions.filter((s) => s.comment);
  $("#comments-block").hidden = withComment.length === 0;
  $("#comments").replaceChildren(
    ...withComment.map((s) =>
      el("li", {},
        el("span", { class: "comment-author", text: s.players?.pseudo || "?" }),
        el("span", { class: "comment-text", text: s.comment })
      )
    )
  );
}


// ---------------------------------------------------------------------
// 5 bis. Mode saisie
// ---------------------------------------------------------------------

function enterEdit() {
  state.editing = true;
  state.brush = "dispo";
  state.mySlots = new Map(state.savedSlots);           // copie de travail
  $("#week-comment").value = state.mySubmission?.comment || "";
  $("#edit-error").hidden = true;
  renderAll();
}

function exitEdit() {
  state.editing = false;
  renderAll();
}

// Y a-t-il des modifications non enregistrées ?
function hasChanges() {
  if (!state.editing) return false;
  const a = state.mySlots, b = state.savedSlots;
  const sameSlots = a.size === b.size && [...a].every(([key, status]) => b.get(key) === status);
  const sameComment = $("#week-comment").value.trim() === (state.mySubmission?.comment || "");
  return !(sameSlots && sameComment);
}

function confirmLeaveEdit() {
  return !hasChanges() || confirm("Tes modifications ne sont pas enregistrées. Les abandonner ?");
}

function renderEditCount() {
  $("#edit-count").textContent = state.mySlots.size === 0
    ? "Rien de coché : la team verra que tu n'es pas dispo cette semaine."
    : `${describeCounts(countByStatus(state.mySlots))}.`.replace(/^./, (c) => c.toUpperCase());
}

// Met à jour l'apparence d'une case en mode saisie
function refreshCell(cell) {
  const status = state.mySlots.get(cell.dataset.key) || "pas_dispo";
  cell.classList.toggle("is-mine", status === "dispo");
  cell.classList.toggle("is-maybe", status === "a_eviter");
  cell.classList.toggle("is-no", status === "pas_dispo");
  cell.textContent = STATUS_MARK[status];
  const base = cell.getAttribute("aria-label").split(" : ")[0];
  cell.setAttribute("aria-label", `${base} : ${STATUS_TEXT[status]}`);
}

function setSlot(cell, status) {
  if (status === "pas_dispo") state.mySlots.delete(cell.dataset.key);
  else state.mySlots.set(cell.dataset.key, status);
  refreshCell(cell);
  renderEditCount();
}

// Statut à appliquer quand on touche une case : le pinceau choisi,
// sauf si la case l'a déjà, auquel cas on la remet en "pas dispo".
function targetStatus(cell) {
  const current = state.mySlots.get(cell.dataset.key) || "pas_dispo";
  return current === state.brush ? "pas_dispo" : state.brush;
}

// "Peinture" au glisser : la première case touchée décide du statut
// appliqué, puis toutes les cases survolées prennent le même.
// elementFromPoint permet que ça marche aussi au doigt sur mobile.
const paint = { active: false, value: "dispo", lastKey: null };

function paintAt(x, y) {
  const cell = document.elementFromPoint(x, y)?.closest(".sq");
  if (!cell || !$("#board").contains(cell) || cell.dataset.key === paint.lastKey) return;
  paint.lastKey = cell.dataset.key;
  setSlot(cell, paint.value);
}

function onBoardPointerDown(e) {
  if (!state.editing) return;
  const cell = e.target.closest(".sq");
  if (!cell) return;
  e.preventDefault();
  paint.active = true;
  paint.lastKey = null;
  paint.value = targetStatus(cell);
  paintAt(e.clientX, e.clientY);
}

function onBoardClick(e) {
  const cell = e.target.closest(".sq");
  if (!cell) return;
  if (state.editing) {
    // e.detail === 0 : "clic" déclenché au clavier (Entrée / Espace).
    // Les clics souris et tactiles sont déjà gérés par la peinture.
    if (e.detail === 0) setSlot(cell, targetStatus(cell));
  } else {
    showSlot(cell);
  }
}

async function saveWeek() {
  const button = $("#save-btn");
  button.disabled = true;
  button.textContent = "Enregistrement…";
  $("#edit-error").hidden = true;

  // "2026-09-28|20" + "a_eviter" → { day: "2026-09-28", hour: 20, status: "a_eviter" }
  const slots = [...state.mySlots].map(([key, status]) => {
    const [day, hour] = key.split("|");
    return { day, hour: Number(hour), status };
  });

  const { error } = await db.rpc("set_my_availability", {
    p_week_start: toISODate(state.weekStart),
    p_slots: slots,
    p_comment: $("#week-comment").value,
  });

  button.disabled = false;
  button.textContent = "Enregistrer ma semaine";

  if (error) {
    const box = $("#edit-error");
    box.textContent = `L'enregistrement a échoué : ${error.message}`;
    box.hidden = false;
    return;
  }

  state.editing = false;
  await loadBoard();
  showToast("Disponibilités sauvegardées");
}

function changeWeek(delta) {
  if (!confirmLeaveEdit()) return;
  state.editing = false;
  state.weekStart = addDays(state.weekStart, 7 * delta);
  loadBoard();
}


// ---------------------------------------------------------------------
// 6. Branchements et démarrage
// ---------------------------------------------------------------------

$("#login-btn").addEventListener("click", login);
$("#logout-btn").addEventListener("click", logout);
$("#denied-logout-btn").addEventListener("click", logout);
$("#prev-week").addEventListener("click", () => changeWeek(-1));
$("#next-week").addEventListener("click", () => changeWeek(1));

// Échiquier : un seul écouteur sur le tableau (délégation d'événements),
// qui continue de fonctionner quand les cases sont redessinées.
$("#board").addEventListener("pointerdown", onBoardPointerDown);
$("#board").addEventListener("click", onBoardClick);
document.addEventListener("pointermove", (e) => { if (paint.active) paintAt(e.clientX, e.clientY); });
document.addEventListener("pointerup", () => { paint.active = false; });
document.addEventListener("pointercancel", () => { paint.active = false; });

// Saisie des dispos
$("#edit-btn").addEventListener("click", enterEdit);
$("#save-btn").addEventListener("click", saveWeek);
$("#cancel-btn").addEventListener("click", () => { if (confirmLeaveEdit()) exitEdit(); });
$("#clear-btn").addEventListener("click", () => {
  state.mySlots.clear();
  document.querySelectorAll("#board .sq").forEach(refreshCell);
  renderEditCount();
});
document.querySelectorAll(".brush").forEach((b) => {
  b.addEventListener("click", () => {
    state.brush = b.dataset.brush;
    renderBrushes();
  });
});

// Prévient si on ferme l'onglet avec des modifications non enregistrées
window.addEventListener("beforeunload", (e) => {
  if (hasChanges()) e.preventDefault();
});

// Supabase prévient à chaque changement de session (au chargement,
// après la connexion, à la déconnexion). Le setTimeout est recommandé
// par Supabase : on ne doit pas appeler la base directement dans ce callback.
db.auth.onAuthStateChange((event, session) => {
  if (["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT"].includes(event)) {
    setTimeout(() => handleSession(session), 0);
  }
});
