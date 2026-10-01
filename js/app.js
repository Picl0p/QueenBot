"use strict";

// =====================================================================
// app.js – logique du site Queen's Gambit
//
// La connexion à Supabase, la session Discord et les petits outils
// communs à toutes les pages sont dans common.js (chargé juste avant).
//
// Organisation du fichier :
//   1. Utilitaires de dates et de créneaux, état de la page
//   4. Rendez-vous : affichage et planification (admins)
//      4 bis. Post Discord de chaque rendez-vous (forum)
//   5. Échiquier des dispos (consultation et saisie)
//   6. Branchement des boutons, puis démarrage
// =====================================================================


// ---------------------------------------------------------------------
// 1. Utilitaires
// ---------------------------------------------------------------------

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

// --- Créneaux d'une demi-heure ---
// Un créneau est repéré par sa clé "2026-09-28|20|30" (jour|heure|minute).

const slotKey = (day, hour, minute) => `${day}|${hour}|${minute}`;

// 20, 0 → "20h" ; 20, 30 → "20h30"
const slotLabel = (hour, minute) => (minute ? `${hour}h${minute}` : `${hour}h`);

// Tous les créneaux d'une journée : un par demi-heure, depuis l'heure de
// début la plus tôt (celle du week-end) jusqu'à la fin de plage.
function boardSlots() {
  const slots = [];
  const first = Math.min(BOARD_START_HOUR, BOARD_WEEKEND_START_HOUR);
  for (let hour = first; hour < BOARD_END_HOUR; hour++) {
    slots.push({ hour, minute: 0 }, { hour, minute: 30 });
  }
  return slots;
}

// Le créneau existe-t-il ce jour-là ? (dayIndex : lundi = 0 … dimanche = 6)
// Les créneaux d'avant 18h n'existent que le samedi et le dimanche.
function slotOpen(dayIndex, hour) {
  return hour >= (dayIndex >= 5 ? BOARD_WEEKEND_START_HOUR : BOARD_START_HOUR);
}

const JOURS_COURTS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
const JOURS_LONGS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];



// État de la page, centralisé ici. `state` est créé par common.js
// (userId et player) : on y ajoute ce qui est propre à cette page.
Object.assign(state, {
  players: [],         // tous les joueurs de la team
  weekStart: mondayOf(new Date()),

  // Échiquier
  heat: [],              // résultat de availability_heatmap
  heatMap: new Map(),    // même chose, indexé par "jour|heure|minute"
  missing: [],           // joueurs qui n'ont pas répondu
  submissions: [],       // semaines validées (avec commentaires)
  mySubmission: null,    // ma validation pour la semaine affichée
  savedSlots: new Map(), // mes créneaux enregistrés : "jour|heure|minute" → statut
  mySlots: new Map(),    // mes créneaux pendant la saisie (copie de travail)
  editing: false,        // mode saisie actif ?
  brush: "dispo",        // statut appliqué en cliquant : dispo, a_eviter, pas_dispo

  // Rendez-vous
  weekEvents: [],        // rendez-vous de la semaine affichée
  eventMap: new Map(),   // "jour|heure|minute" → rendez-vous qui occupent la case
  editingEvent: null,    // rendez-vous ouvert dans le formulaire (null = création)
});


// ---------------------------------------------------------------------
// 4. Rendez-vous (table events) et planification
//
// Tout le monde voit les rendez-vous. Les admins peuvent en ajouter,
// modifier et supprimer : les boutons n'apparaissent que pour eux, et
// surtout la RLS (règles SQL) refuse l'écriture aux autres.
// ---------------------------------------------------------------------

const isAdmin = () => Boolean(state.player?.is_admin);

// Types pour lesquels les infos de session (adversaire, format, draft…) ont un sens
const TYPES_AVEC_ADVERSAIRE = ["scrim", "match_officiel"];

// Colonnes d'un rendez-vous dont le formulaire et le post Discord ont besoin
const EVENT_COLUMNS = "id, title, type, starts_at, ends_at, opponent, notes, status, format, side, "
  + "draft_url, opponent_opgg, opponent_roster, opponent_contact, "
  + "discord_thread_id, discord_message_id, discord_thread_url";

const STATUS_LABELS = { confirme: "Confirmé ✅", en_attente: "En attente ⏳", annule: "Annulé ❌" };

// Rôles du roster adverse : clé en base → libellé affiché
const ROSTER_ROLES = [["top", "Top"], ["jungle", "Jungle"], ["mid", "Mid"], ["adc", "ADC"], ["support", "Supp"]];

// Date → "20:30" (heure locale)
function toHHMM(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function loadPlayers() {
  const { data, error } = await db.from("players").select("id, pseudo, status, main_role").order("pseudo");
  if (error) return showError(`Impossible de charger les joueurs : ${error.message}`);
  state.players = data;
}

async function loadEvents() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data, error } = await db
    .from("events")
    .select(EVENT_COLUMNS)
    .gte("starts_at", today.toISOString())
    .order("starts_at")
    .limit(8);

  if (error) return showError(`Impossible de charger le planning : ${error.message}`);
  renderEvents(data);
}

function renderEvents(events) {
  $("#add-event-btn").hidden = !isAdmin();
  const list = $("#events-list");
  list.replaceChildren();

  if (events.length === 0) {
    list.append(el("li", { class: "event event-empty", text: "Aucun rendez-vous prévu pour l'instant." }));
    return;
  }

  const fmtDay = { weekday: "long", day: "numeric", month: "long" };

  for (const ev of events) {
    const start = new Date(ev.starts_at);
    const end = ev.ends_at ? new Date(ev.ends_at) : null;
    const time = toHHMM(start) + (end ? ` à ${toHHMM(end)}` : "");

    list.append(
      el("li", { class: `event type-${ev.type}${ev.status === "annule" ? " is-cancelled" : ""}` },
        el("time", { class: "event-date", datetime: ev.starts_at, text: start.toLocaleDateString("fr-FR", fmtDay) }),
        el("span", { class: "event-time", text: time }),
        el("p", { class: "event-title", text: ev.title }),
        el("p", { class: "event-meta" },
          el("span", { class: "event-type", text: TYPE_LABELS[ev.type] || ev.type }),
          ev.opponent ? el("span", { class: "event-opponent", text: `contre ${ev.opponent}` }) : null,
          // "Confirmé" est le cas normal : on n'affiche le statut que s'il est différent
          ev.status !== "confirme" ? el("span", { class: "event-status", text: STATUS_LABELS[ev.status] }) : null,
          ev.discord_thread_url
            ? el("a", { class: "event-discord", href: ev.discord_thread_url, target: "_blank", rel: "noopener", text: "Post Discord" })
            : null
        ),
        ev.notes ? el("p", { class: "event-notes", text: ev.notes }) : null,
        isAdmin()
          ? el("button", { type: "button", class: "event-edit", text: "Modifier", onclick: () => openEventDialog(ev) })
          : null
      )
    );
  }
}

// --- Formulaire (fenêtre <dialog>) ---

// ev : rendez-vous à modifier (ou null pour en créer un)
// preset : { date: Date, hour: 20, minute: 30 } pour pré-remplir depuis l'échiquier
function openEventDialog(ev = null, preset = null) {
  state.editingEvent = ev;
  $("#ev-error").hidden = true;

  if (ev) {
    const start = new Date(ev.starts_at);
    const end = ev.ends_at ? new Date(ev.ends_at) : null;
    $("#ev-type").value = ev.type;
    $("#ev-title").value = ev.title;
    $("#ev-date").value = toISODate(start);
    $("#ev-start").value = toHHMM(start);
    $("#ev-end").value = end ? toHHMM(end) : "";
    $("#ev-opponent").value = ev.opponent || "";
    $("#ev-notes").value = ev.notes || "";
    $("#ev-status").value = ev.status || "confirme";
    $("#ev-format").value = ev.format || "";
    $("#ev-side").value = ev.side || "";
    $("#ev-draft-url").value = ev.draft_url || "";
    $("#ev-opgg").value = ev.opponent_opgg || "";
    $("#ev-contact").value = ev.opponent_contact || "";
    for (const [role] of ROSTER_ROLES) $(`#ev-roster-${role}`).value = ev.opponent_roster?.[role] || "";
  } else {
    const date = preset?.date || new Date();
    const hour = preset?.hour ?? 20;
    const mm = String(preset?.minute ?? 0).padStart(2, "0");
    $("#ev-type").value = "flex";
    $("#ev-title").value = "";
    $("#ev-date").value = toISODate(date);
    $("#ev-start").value = `${String(hour).padStart(2, "0")}:${mm}`;
    $("#ev-end").value = `${String((hour + 2) % 24).padStart(2, "0")}:${mm}`;
    $("#ev-opponent").value = "";
    $("#ev-notes").value = "";
    $("#ev-status").value = "confirme";
    for (const id of ["format", "side", "draft-url", "opgg", "contact"]) $(`#ev-${id}`).value = "";
    for (const [role] of ROSTER_ROLES) $(`#ev-roster-${role}`).value = "";
  }

  $("#event-dialog-title").textContent = ev ? "Modifier le rendez-vous" : "Nouveau rendez-vous";
  $("#ev-save").textContent = ev ? "Enregistrer" : "Ajouter";
  $("#ev-delete").hidden = !ev;
  updateTitlePlaceholder();
  $("#event-dialog").showModal();
}

// Le titre est facultatif : par défaut, on reprend le type (ex. "Scrim")
function updateTitlePlaceholder() {
  const type = $("#ev-type").value;
  $("#ev-title").placeholder = TYPE_LABELS[type];
  $("#ev-session-fields").hidden = !TYPES_AVEC_ADVERSAIRE.includes(type);
}

// Lien multi OP.GG → liste des pseudos, dans l'ordre du lien.
//   ".../multisearch/euw?summoners=thay%2388685%2CRGA+Spik0%231176"  →  ["thay", "RGA Spik0"]
// Marche aussi avec les sites qui mettent les pseudos dans le chemin
// (".../euw/Pseudo-TAG,Autre-TAG").
function parseMultiLink(link) {
  let url;
  try { url = new URL(link); } catch { return []; }

  // searchParams décode déjà %23 (#), %2C (,) et + (espace)
  let raw = url.searchParams.get("summoners") || "";
  let tagSeparator = /#.*$/;
  if (!raw) {
    const segment = url.pathname.split("/").find((part) => part.includes(",") || part.includes("%2C"));
    if (!segment) return [];
    try { raw = decodeURIComponent(segment); } catch { return []; }
    tagSeparator = /[#-][^#-]*$/;
  }
  return raw.split(",")
    .map((name) => name.trim().replace(tagSeparator, "").trim())
    .filter(Boolean)
    .slice(0, ROSTER_ROLES.length);
}

// Quand on colle le lien OP.GG, remplit le roster… sauf si quelqu'un a
// déjà commencé à le saisir (on n'écrase jamais ce qui a été tapé).
function fillRosterFromLink() {
  const inputs = ROSTER_ROLES.map(([role]) => $(`#ev-roster-${role}`));
  if (inputs.some((input) => input.value.trim())) return;
  parseMultiLink($("#ev-opgg").value.trim()).forEach((name, i) => { inputs[i].value = name; });
}

// Le lien n'est pas toujours dans l'ordre top → supp : les flèches à côté
// de chaque joueur l'échangent avec son voisin du dessus ou du dessous.
function swapRoster(i, j) {
  const a = $(`#ev-roster-${ROSTER_ROLES[i][0]}`);
  const b = $(`#ev-roster-${ROSTER_ROLES[j][0]}`);
  [a.value, b.value] = [b.value, a.value];
}

// Ajoute les flèches ↑ ↓ après chaque champ du roster (une fois, au démarrage)
function addRosterArrows() {
  const last = ROSTER_ROLES.length - 1;
  ROSTER_ROLES.forEach(([role, label], i) => {
    const arrow = (text, target, action) => el("button", {
      type: "button",
      // Pas de ↑ sur la première ligne ni de ↓ sur la dernière (place gardée pour l'alignement)
      class: `roster-arrow${target < 0 || target > last ? " is-hidden" : ""}`,
      "aria-label": `${action} le joueur ${label}`,
      disabled: target < 0 || target > last,
      text,
      onclick: () => swapRoster(i, target),
    });
    $(`#ev-roster-${role}`).after(
      el("div", { class: "roster-arrows" }, arrow("↑", i - 1, "Monter"), arrow("↓", i + 1, "Descendre"))
    );
  });
}

// Lien facultatif : null si vide, erreur si ça ne ressemble pas à un lien
function readUrlField(selector, label) {
  const value = $(selector).value.trim();
  if (!value) return null;
  if (!/^https?:\/\/\S+$/i.test(value)) throw new Error(`${label} : colle un lien complet (qui commence par https://).`);
  return value;
}

function eventFormError(message) {
  const box = $("#ev-error");
  box.textContent = message;
  box.hidden = false;
}

async function saveEvent(e) {
  e.preventDefault();   // empêche le rechargement de la page par le formulaire

  const type = $("#ev-type").value;
  const date = $("#ev-date").value;
  const startTime = $("#ev-start").value;
  const endTime = $("#ev-end").value;

  if (!date || !startTime) return eventFormError("Indique au moins une date et une heure de début.");

  // "2026-10-02" + "20:30" → Date en heure locale
  const start = new Date(`${date}T${startTime}`);
  let end = null;
  if (endTime) {
    end = new Date(`${date}T${endTime}`);
    // Fin avant le début (ex. 23h → 1h) : ça se termine le lendemain
    if (end <= start) end.setDate(end.getDate() + 1);
  }

  // Infos de session : seulement pour les scrims et matchs officiels
  const session = TYPES_AVEC_ADVERSAIRE.includes(type);
  const text = (selector) => (session ? $(selector).value.trim() || null : null);

  let draftUrl = null, opggUrl = null;
  if (session) {
    try {
      draftUrl = readUrlField("#ev-draft-url", "Lien draft");
      opggUrl = readUrlField("#ev-opgg", "Lien OP.GG");
    } catch (err) {
      return eventFormError(err.message);
    }
  }

  // { top: "Thay (sub)", jungle: "Spik0", … } en ne gardant que les rôles remplis
  const roster = {};
  for (const [role] of ROSTER_ROLES) {
    const name = text(`#ev-roster-${role}`);
    if (name) roster[role] = name;
  }

  const payload = {
    type,
    title: $("#ev-title").value.trim() || TYPE_LABELS[type],
    starts_at: start.toISOString(),   // stocké en UTC dans la base
    ends_at: end ? end.toISOString() : null,
    opponent: text("#ev-opponent"),
    notes: $("#ev-notes").value.trim() || null,
    status: session ? $("#ev-status").value : "confirme",
    format: text("#ev-format"),
    side: text("#ev-side"),
    draft_url: draftUrl,
    opponent_opgg: opggUrl,
    opponent_roster: Object.keys(roster).length ? roster : null,
    opponent_contact: text("#ev-contact"),
  };

  const button = $("#ev-save");
  button.disabled = true;

  // .select().single() : la base renvoie le rendez-vous enregistré
  const previous = state.editingEvent;
  const { data: saved, error } = previous
    ? await db.from("events").update(payload).eq("id", previous.id).select(EVENT_COLUMNS).single()
    : await db.from("events").insert(payload).select(EVENT_COLUMNS).single();

  if (error) {
    button.disabled = false;
    return eventFormError(`L'enregistrement a échoué : ${error.message}`);
  }

  // Le rendez-vous est enregistré : un souci côté Discord ne doit pas
  // faire croire le contraire, on le signale juste par un message.
  let message;
  try {
    message = await syncDiscordPost(saved, previous);
  } catch (err) {
    console.error(err);
    message = `Rendez-vous enregistré, mais le post Discord a échoué (${err.message})`;
  }
  button.disabled = false;

  $("#event-dialog").close();
  await Promise.all([loadEvents(), loadBoard()]);
  if (message) showToast(message);
}

async function deleteEvent() {
  const ev = state.editingEvent;
  if (!ev || !confirm(`Supprimer « ${ev.title} » ?`)) return;

  const { error } = await db.from("events").delete().eq("id", ev.id);
  if (error) return eventFormError(`La suppression a échoué : ${error.message}`);

  // Prévient dans le post Discord (qui, lui, reste en place)
  try {
    await announceDeletion(ev);
  } catch (err) {
    console.error(err);
  }

  $("#event-dialog").close();
  await Promise.all([loadEvents(), loadBoard()]);
}


// ---------------------------------------------------------------------
// 4 bis. Post Discord de chaque rendez-vous
//
// À chaque rendez-vous correspond un post dans le forum Discord :
//   * créé à l'ajout du rendez-vous ;
//   * son premier message est réécrit à chaque modification (pratique
//     quand on n'apprend l'adversaire qu'à la dernière minute), et un
//     petit message dans le post signale ce qui a changé ;
//   * les résultats des games y sont ensuite postés par le companion
//     (scripts/lcu_companion.py).
//
// On passe par un webhook Discord, appelé directement depuis le
// navigateur de l'admin. Son URL est secrète : elle n'est pas dans le
// code, la base ne la donne qu'aux admins (fonction discord_forum_config).
// ---------------------------------------------------------------------

// Demandée une seule fois par chargement de page
let discordConfigPromise = null;

function discordConfig() {
  discordConfigPromise ??= (async () => {
    const { data, error } = await db.rpc("discord_forum_config");
    if (error) throw new Error(error.message);
    if (!data?.webhook_url) return null;
    return {
      // Sans paramètres ni "/" final, pour pouvoir y ajouter les nôtres
      webhook: data.webhook_url.trim().split("?")[0].replace(/\/+$/, ""),
      roleId: data.role_id || null,
    };
  })();
  // En cas d'échec, on réessaiera au prochain enregistrement
  discordConfigPromise.catch(() => { discordConfigPromise = null; });
  return discordConfigPromise;
}

async function discordRequest(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const err = new Error(`Discord ${res.status}${detail?.message ? ` : ${detail.message}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// Neutralise la mise en forme Discord dans un texte saisi (un pseudo
// comme "xX_Dark_Xx" passerait sinon en italique).
const mdEscape = (text) => String(text).replace(/([\\*_~`|>\[\]])/g, "\\$1");

// 21:00 → "21h00"
const heureDiscord = (d) => `${d.getHours()}h${String(d.getMinutes()).padStart(2, "0")}`;

// Titre du post (100 caractères max chez Discord).
// ⚠️ Un webhook ne peut pas renommer un post : le titre garde la date et
// l'adversaire connus à la création. Ensuite, c'est à renommer à la main.
function discordPostTitle(ev) {
  const start = new Date(ev.starts_at);
  const day = start.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  const versus = ev.opponent ? ` vs ${ev.opponent}` : "";
  return `${ev.title}${versus} · ${day} ${heureDiscord(start)}`.slice(0, 100);
}

// Premier message du post
function discordPostContent(ev, roleId) {
  const start = new Date(ev.starts_at);
  const end = ev.ends_at ? new Date(ev.ends_at) : null;
  const date = start.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const lines = [];

  if (TYPES_AVEC_ADVERSAIRE.includes(ev.type)) {
    lines.push(
      `Statut : ${STATUS_LABELS[ev.status]}`,
      `Date : ${date}`,
      `Heure de la draft : ${heureDiscord(start)}`,
      `Format : ${ev.format ? mdEscape(ev.format) : "à définir"}`,
      `Side : ${ev.side ? mdEscape(ev.side) : "Personne n'a choisi le side pour le moment"}`,
      `Lien draft : ${ev.draft_url || "à venir"}`,
      "",
      "**Infos Adversaires**"
    );

    const name = ev.opponent ? mdEscape(ev.opponent) : null;
    if (ev.opponent_opgg) lines.push(`Nom et OP.GG : [${name || "OP.GG"}](${ev.opponent_opgg})`);
    else lines.push(`Nom : ${name || "à confirmer"}`);

    for (const [role, label] of ROSTER_ROLES) {
      const player = ev.opponent_roster?.[role];
      if (player) lines.push(`> ${label} : ${mdEscape(player)}`);
    }
    if (ev.opponent_contact) lines.push(`Contact : \`\`${ev.opponent_contact.replaceAll("`", "")}\`\``);
  } else {
    lines.push(
      `Date : ${date}`,
      `Heure : ${heureDiscord(start)}${end ? ` – ${heureDiscord(end)}` : ""}`
    );
  }

  if (ev.notes) lines.push("", ev.notes);
  if (roleId) lines.push("", `<@&${roleId}>`);
  return lines.join("\n").slice(0, 2000);   // limite de Discord
}

// Ce qui a changé entre deux versions d'un rendez-vous, en clair
function describeChanges(before, after) {
  const changes = [];
  if (before.status !== after.status) changes.push(`statut → ${STATUS_LABELS[after.status]}`);
  if (before.starts_at !== after.starts_at) changes.push("date / heure");

  const fields = [
    ["format", "format"], ["side", "side"], ["draft_url", "lien draft"],
    ["opponent", "adversaire"], ["opponent_opgg", "lien OP.GG"],
    ["opponent_contact", "contact"], ["notes", "notes"],
  ];
  for (const [key, label] of fields) {
    if ((before[key] || "") !== (after[key] || "")) changes.push(label);
  }
  if (ROSTER_ROLES.some(([role]) => (before.opponent_roster?.[role] || "") !== (after.opponent_roster?.[role] || ""))) {
    changes.push("roster adverse");
  }
  return changes;
}

// Crée le post du rendez-vous, ou le met à jour s'il existe déjà.
// Renvoie le message à afficher à l'admin (ou rien).
async function syncDiscordPost(ev, previous) {
  const hasPost = Boolean(ev.discord_thread_id && ev.discord_message_id);
  if (!hasPost) {
    if (!DISCORD_POST_TYPES.includes(ev.type) || ev.status === "annule") return;
    // Pas de post pour un rendez-vous déjà passé (ex. correction après coup)
    if (new Date(ev.ends_at || ev.starts_at) < Date.now() - 6 * 3600 * 1000) return;
  }

  const config = await discordConfig();
  if (!config) return "Rendez-vous enregistré (pas de post Discord : le webhook du forum n'est pas configuré)";

  const message = {
    content: discordPostContent(ev, config.roleId),
    // Seul le rôle de la team peut être mentionné, jamais @everyone
    allowed_mentions: { parse: [], roles: config.roleId ? [config.roleId] : [] },
    flags: 4,   // pas d'aperçu des liens (OP.GG, drafter)
  };

  if (hasPost) {
    try {
      await discordRequest("PATCH",
        `${config.webhook}/messages/${ev.discord_message_id}?thread_id=${ev.discord_thread_id}`, message);
    } catch (err) {
      if (err.status !== 404) throw err;
      // Le post a été supprimé dans Discord : on en recrée un
      return createDiscordPost(ev, config, message);
    }
    const changes = previous ? describeChanges(previous, ev) : [];
    if (changes.length) {
      await discordRequest("POST", `${config.webhook}?thread_id=${ev.discord_thread_id}`, {
        content: `📝 Infos mises à jour : ${changes.join(", ")}.`,
        allowed_mentions: { parse: [] },
      });
    }
    return "Rendez-vous et post Discord mis à jour";
  }

  return createDiscordPost(ev, config, message);
}

async function createDiscordPost(ev, config, message) {
  // wait=true : Discord renvoie le message créé (donc l'identifiant du post)
  const created = await discordRequest("POST", `${config.webhook}?wait=true`, {
    ...message,
    thread_name: discordPostTitle(ev),
  });

  // Pour le lien "Post Discord", il faut l'identifiant du serveur
  config.guildId ??= (await discordRequest("GET", config.webhook)).guild_id;

  const { error } = await db.from("events").update({
    discord_thread_id: created.channel_id,
    discord_message_id: created.id,
    discord_thread_url: `https://discord.com/channels/${config.guildId}/${created.channel_id}`,
  }).eq("id", ev.id);
  if (error) throw new Error(`post créé mais non rattaché au rendez-vous : ${error.message}`);

  return "Rendez-vous enregistré, post Discord créé";
}

async function announceDeletion(ev) {
  if (!ev.discord_thread_id) return;
  const config = await discordConfig();
  if (!config) return;
  await discordRequest("POST", `${config.webhook}?thread_id=${ev.discord_thread_id}`, {
    content: "❌ Ce rendez-vous a été retiré du planning.",
    allowed_mentions: { parse: [] },
  });
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

  // Bornes de la semaine en heure locale, pour filtrer les rendez-vous
  const weekStartTs = new Date(state.weekStart).toISOString();
  const weekEndTs = addDays(state.weekStart, 7).toISOString();

  // Cinq requêtes indépendantes, lancées en parallèle
  const [heat, missing, mine, submissions, weekEvents] = await Promise.all([
    db.rpc("availability_heatmap", { p_week_start: week }),
    db.rpc("players_missing_availability", { p_week_start: week }),
    db.from("availabilities")
      .select("day, hour, minute, status")
      .eq("player_id", state.player.id)
      .gte("day", week)
      .lt("day", weekEnd),
    // players(pseudo) : Supabase fait la jointure grâce à la clé étrangère
    db.from("availability_submissions")
      .select("player_id, comment, submitted_at, players(pseudo)")
      .eq("week_start", week),
    db.from("events")
      .select("id, title, type, starts_at, ends_at, opponent")
      .gte("starts_at", weekStartTs)
      .lt("starts_at", weekEndTs),
  ]);

  for (const res of [heat, missing, mine, submissions, weekEvents]) {
    if (res.error) return showError(`Impossible de charger les dispos : ${res.error.message}`);
  }

  state.heat = heat.data;
  state.missing = missing.data;
  // Map "jour|heure|minute" → statut ("dispo" ou "a_eviter")
  state.savedSlots = new Map(mine.data.map((s) => [slotKey(s.day, s.hour, s.minute), s.status]));
  state.submissions = submissions.data;
  state.mySubmission = submissions.data.find((s) => s.player_id === state.player.id) || null;
  state.weekEvents = weekEvents.data;

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
  $("#plan-slot-btn").hidden = true;

  renderMyStatus();
  renderBrushes();
  renderBoard();

  if (state.editing) {
    renderEditCount();
  } else {
    renderMissing();
    renderComments();
  }
  renderBestSlots();
}

// Deux versions du libellé : la courte ("29 sept.") remplace la longue sur
// petit écran, pour que la semaine tienne à côté du bouton (voir le CSS)
function renderWeekLabel() {
  const long = state.weekStart.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
  const short = state.weekStart.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  const el = $("#week-label");
  el.replaceChildren();
  for (const [cls, text] of [["week-long", `Semaine du ${long}`], ["week-short", short]]) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    el.append(span);
  }
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
  button.hidden = state.editing || isPastWeek();
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

// La base compte tout le monde, coach compris. Ici on le met à part : il
// n'entre ni dans le nombre de dispos ni dans la liste des pseudos, et
// la case l'indique par une petite icône.
function splitCoaches(row, coaches) {
  const pseudos = row.pseudos.filter((p) => !coaches.has(p));
  const pseudosMaybe = row.pseudos_maybe.filter((p) => !coaches.has(p));
  return {
    ...row,
    pseudos,
    pseudos_maybe: pseudosMaybe,
    n_available: pseudos.length,
    n_maybe: pseudosMaybe.length,
    coaches: row.pseudos.filter((p) => coaches.has(p)),
    coaches_maybe: row.pseudos_maybe.filter((p) => coaches.has(p)),
  };
}

// Coach présent sur un créneau : "Pseudo", "Pseudo (à éviter)", ou "" s'il n'est pas là
function coachNote(slot) {
  if (slot?.coaches.length) return slot.coaches.join(", ");
  if (slot?.coaches_maybe.length) return `${slot.coaches_maybe.join(", ")} (à éviter)`;
  return "";
}

function renderBoard() {
  const total = teamSize();
  const coaches = new Set(state.players.filter((p) => p.status === "coach").map((p) => p.pseudo));
  state.heatMap = new Map(state.heat.map((row) =>
    [slotKey(row.day, row.hour, row.minute), splitCoaches(row, coaches)]));
  state.eventMap = buildEventMap(state.weekEvents);

  // Deux plateaux : le soir pour toute la semaine, et la journée pour le
  // seul week-end (inutile d'afficher des lignes vides du lundi au vendredi).
  const evening = boardSlots().filter((s) => s.hour >= BOARD_START_HOUR);
  const daytime = boardSlots().filter((s) => s.hour < BOARD_START_HOUR);
  buildBoard($("#board"), [0, 1, 2, 3, 4, 5, 6], evening, total);
  buildBoard($("#board-weekend"), [5, 6], daytime, total);
  $("#weekend-block").hidden = daytime.length === 0;

  if (!state.editing) {
    $("#slot-detail").textContent = state.heat.length
      ? `Touche une case pour voir qui est dispo. ${COACH_ICON} : le coach est là.`
      : "Personne n'a encore indiqué de dispo pour cette semaine.";
  }
}

// Remplit un plateau : une colonne par jour (dayIndexes : lundi = 0 …
// dimanche = 6), une ligne par demi-heure.
function buildBoard(table, dayIndexes, slots, total) {
  const todayIso = toISODate(new Date());

  // En-tête : une colonne par jour
  const headRow = el("tr", {}, el("th", { scope: "col" }));
  for (const i of dayIndexes) {
    const d = addDays(state.weekStart, i);
    headRow.append(
      el("th", { scope: "col", class: toISODate(d) === todayIso ? "today" : "" },
        el("span", { class: "day-name", text: JOURS_COURTS[i] }),
        el("span", { class: "day-num", text: String(d.getDate()) })
      )
    );
  }

  // Corps : une ligne par demi-heure
  const body = el("tbody");
  slots.forEach(({ hour, minute }, rowIndex) => {
    const label = slotLabel(hour, minute);
    const row = el("tr", { class: minute ? "half-hour" : "" }, el("th", { scope: "row", text: label }));

    for (const i of dayIndexes) {
      const key = slotKey(toISODate(addDays(state.weekStart, i)), hour, minute);
      // Alternance des cases, comme sur un vrai échiquier
      const shade = (i + rowIndex) % 2 ? "sq-light" : "sq-dark";
      const button = state.editing
        ? editCell(key, i, label, shade)
        : viewCell(key, i, label, shade, total);
      button.dataset.key = key;
      button.dataset.dayIndex = String(i);
      button.dataset.hour = String(hour);
      button.dataset.minute = String(minute);
      if (state.eventMap.has(key)) button.classList.add("has-event");
      row.append(el("td", {}, button));
    }

    body.append(row);
  });

  table.replaceChildren(el("thead", {}, headRow), body);
}

// Associe chaque case "jour|heure|minute" aux rendez-vous qui l'occupent.
// Un rendez-vous de 20h à 21h occupe les cases 20h et 20h30 ;
// sans heure de fin, seulement la case de début.
function buildEventMap(events) {
  const map = new Map();
  for (const ev of events) {
    const start = new Date(ev.starts_at);
    const end = ev.ends_at ? new Date(ev.ends_at) : new Date(start.getTime() + 1);
    const cursor = new Date(start);
    cursor.setMinutes(cursor.getMinutes() < 30 ? 0 : 30, 0, 0);
    while (cursor < end) {
      const key = slotKey(toISODate(cursor), cursor.getHours(), cursor.getMinutes());
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ev);
      cursor.setMinutes(cursor.getMinutes() + 30);
    }
  }
  return map;
}

// Case en mode consultation
function viewCell(key, dayIndex, label, shade, total) {
  const slot = state.heatMap.get(key);
  const n = slot ? Number(slot.n_available) : 0;
  const m = slot ? Number(slot.n_maybe) : 0;

  const classes = ["sq", shade];
  // Personne de dispo : croix, mais seulement si au moins un joueur a
  // répondu cette semaine (sinon la case est vide faute d'info, pas "non")
  const nobody = n === 0 && m === 0;
  if (nobody) classes.push(state.submissions.length ? "is-no" : "is-empty");
  if (total && n >= total) classes.push("is-full");
  else if (total && n + m >= total) classes.push("is-possible");

  let ariaLabel = `${JOURS_LONGS[dayIndex]} ${label} : ${n} dispo`;
  if (m) ariaLabel += `, ${m} à éviter`;
  if (total && n >= total) ariaLabel += ", toute l'équipe";

  // Coach : icône à côté des chiffres, plus pâle s'il a marqué le créneau "à éviter"
  const coach = coachNote(slot);
  if (coach) ariaLabel += `, coach ${coach}`;

  const button = el("button", {
    type: "button",
    class: classes.join(" "),
    "aria-label": ariaLabel,
    "aria-pressed": "false",
  },
    nobody && state.submissions.length ? "✕" : null,
    n > 0 ? el("span", { class: "sq-count", text: String(n) }) : null,
    m > 0 ? el("span", { class: "sq-maybe", text: `+${m}` }) : null,
    coach
      ? el("span", { class: `sq-coach${slot.coaches.length ? "" : " is-maybe"}`, "aria-hidden": "true", text: COACH_ICON })
      : null
  );

  // Intensité du violet proportionnelle au nombre de joueurs dispo
  const ratio = total ? Math.min(n / total, 1) : 0;
  button.style.setProperty("--fill", n ? (0.2 + 0.7 * ratio).toFixed(2) : "0");
  return button;
}

// Case en mode saisie
function editCell(key, dayIndex, label, shade) {
  const button = el("button", {
    type: "button",
    class: `sq ${shade}`,
    "aria-label": `${JOURS_LONGS[dayIndex]} ${label}`,
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
  const hour = Number(cell.dataset.hour);
  const minute = Number(cell.dataset.minute);
  const date = addDays(state.weekStart, dayIndex);
  const slot = state.heatMap.get(cell.dataset.key);
  const n = slot ? Number(slot.n_available) : 0;
  const m = slot ? Number(slot.n_maybe) : 0;

  const when = `${JOURS_LONGS[dayIndex]} ${date.getDate()} à ${slotLabel(hour, minute)}`;
  let text;
  const coach = coachNote(slot);
  if (n === 0 && m === 0) {
    text = `Aucun joueur n'est dispo ${when}${coach ? ` (${coach} seulement)` : ""}.`;
  } else {
    text = `${when.charAt(0).toUpperCase() + when.slice(1)} : ${n} sur ${teamSize()} dispo`;
    if (n) text += ` (${slot.pseudos.join(", ")})`;
    if (coach) text += ` + ${coach}`;
    if (m) text += `, à éviter pour ${slot.pseudos_maybe.join(", ")}`;
    text += ".";
  }

  const events = state.eventMap.get(cell.dataset.key) || [];
  if (events.length) {
    text += " Prévu : " + events.map((ev) => ev.title + (ev.opponent ? ` contre ${ev.opponent}` : "")).join(", ") + ".";
  }
  $("#slot-detail").textContent = text;

  // Raccourci admin : planifier directement sur ce créneau
  const planBtn = $("#plan-slot-btn");
  planBtn.hidden = !isAdmin() || isPastWeek() || events.length > 0;
  planBtn.onclick = () => openEventDialog(null, { date, hour, minute });
}

function renderMissing() {
  $("#missing").textContent = state.missing.length === 0
    ? "Tout le monde a donné ses dispos pour cette semaine."
    : `Pas encore répondu : ${state.missing.map((p) => p.pseudo).join(", ")}.`;
}

// --- Meilleurs créneaux de la semaine ---

const ROLE_LABELS = { top: "top", jungle: "jungle", mid: "mid", adc: "ADC", support: "support" };
const BEST_MIN_SLOTS = 4;   // durée minimale d'un créneau : 4 demi-heures = 2h

// Cherche les plages d'au moins 2h où tous les TITULAIRES sont dispo, ou bien
// où il ne manque qu'UN seul et même titulaire du début à la fin (on sait alors
// quel rôle remplacer). Les créneaux déjà passés sont ignorés.
// Renvoie au plus `count` plages qui ne se chevauchent pas, triées :
// d'abord "tout le monde", puis les plus longues, puis les plus tôt.
function findBestSlots(heatMap, players, weekStart, now, count = 2) {
  // Seuls les titulaires comptent (ni remplaçants ni coachs)
  const team = players.filter((p) => p.status === "titulaire");
  const total = team.length;
  if (total === 0) return [];
  const teamPseudos = new Set(team.map((p) => p.pseudo));
  const slots = boardSlots();
  const candidates = [];

  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const date = addDays(weekStart, dayIndex);
    const day = toISODate(date);

    // Titulaires "dispo" sur chaque demi-heure de la journée
    const present = slots.map(({ hour, minute }) => {
      const start = new Date(date);
      start.setHours(hour, minute, 0, 0);
      if (start < now || !slotOpen(dayIndex, hour)) return new Set();
      const row = heatMap.get(slotKey(day, hour, minute));
      return new Set((row?.pseudos || []).filter((p) => teamPseudos.has(p)));
    });

    // Deux exigences : tous les titulaires, puis tous sauf un
    const needs = total > 1 ? [total, total - 1] : [total];
    for (const need of needs) {
      for (let i = 0; i < slots.length; i++) {
        // On prolonge la plage tant que les MÊMES joueurs restent dispo
        let common = present[i];
        if (common.size < need) continue;
        let j = i;
        while (j + 1 < slots.length) {
          const next = new Set([...common].filter((p) => present[j + 1].has(p)));
          if (next.size < need) break;
          common = next;
          j++;
        }
        if (j - i + 1 < BEST_MIN_SLOTS) continue;
        candidates.push({
          dayIndex, date, first: i, last: j,
          full: common.size === total,
          missing: team.filter((p) => !common.has(p.pseudo)),
        });
      }
    }
  }

  candidates.sort((a, b) =>
    (b.full - a.full) ||
    ((b.last - b.first) - (a.last - a.first)) ||
    (a.dayIndex - b.dayIndex) ||
    (a.first - b.first)
  );

  const best = [];
  for (const c of candidates) {
    const overlaps = best.some((b) => b.dayIndex === c.dayIndex && c.first <= b.last && b.first <= c.last);
    if (!overlaps) best.push(c);
    if (best.length === count) break;
  }
  return best.map((c) => ({
    ...c,
    start: slots[c.first],
    // Fin = début de la dernière demi-heure + 30 min
    end: slots[c.last].minute
      ? { hour: (slots[c.last].hour + 1) % 24, minute: 0 }
      : { hour: slots[c.last].hour, minute: 30 },
  }));
}

function renderBestSlots() {
  const box = $("#best-slots");
  box.hidden = state.editing || isPastWeek();
  if (box.hidden) return;

  const best = findBestSlots(state.heatMap, state.players, state.weekStart, new Date());
  const list = $("#best-slots-list");

  if (best.length === 0) {
    list.replaceChildren(el("li", {
      class: "best-slot-empty",
      text: "Pas encore de créneau d'au moins 2h où tous les titulaires (ou presque) sont dispo.",
    }));
    return;
  }

  list.replaceChildren(...best.map((b) => {
    const dayName = JOURS_LONGS[b.dayIndex];
    const when = `${dayName.charAt(0).toUpperCase() + dayName.slice(1)} ${b.date.getDate()} · `
      + `${slotLabel(b.start.hour, b.start.minute)} – ${slotLabel(b.end.hour, b.end.minute)}`;

    let tag;
    if (b.full) {
      tag = el("span", { class: "best-tag is-full", text: "Tout le monde est là" });
    } else {
      const absent = b.missing[0];
      const role = ROLE_LABELS[absent.main_role];
      tag = el("span", {
        class: "best-tag is-sub",
        text: `Prévoir un sub${role ? ` ${role}` : ""} (sans ${absent.pseudo})`,
      });
    }
    return el("li", { class: "best-slot" }, el("span", { class: "best-when", text: when }), tag);
  }));
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
  if (!cell || !$("#boards").contains(cell) || cell.dataset.key === paint.lastKey) return;
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

// Recopie mes dispos de la semaine précédente (mêmes jours, mêmes horaires)
// dans la saisie en cours. Rien n'est enregistré tant qu'on ne valide pas.
async function copyLastWeek() {
  const button = $("#copy-last-week-btn");
  const box = $("#edit-error");
  box.hidden = true;
  button.disabled = true;

  const prevStart = addDays(state.weekStart, -7);
  const { data, error } = await db.from("availabilities")
    .select("day, hour, minute, status")
    .eq("player_id", state.player.id)
    .gte("day", toISODate(prevStart))
    .lt("day", toISODate(state.weekStart));

  button.disabled = false;
  if (error || data.length === 0) {
    box.textContent = error
      ? `Impossible de récupérer la semaine dernière : ${error.message}`
      : "Rien à reprendre : tu n'avais rien coché la semaine dernière.";
    box.hidden = false;
    return;
  }

  // "2026-09-21|20|30" → "2026-09-28|20|30" (même créneau, 7 jours plus tard)
  state.mySlots = new Map(data.map((s) => {
    const day = toISODate(addDays(new Date(`${s.day}T00:00`), 7));
    return [slotKey(day, s.hour, s.minute), s.status];
  }));
  document.querySelectorAll("#boards .sq").forEach(refreshCell);
  renderEditCount();
  showToast("Semaine dernière reprise : ajuste si besoin, puis enregistre");
}

async function saveWeek() {
  const button = $("#save-btn");
  button.disabled = true;
  button.textContent = "Enregistrement…";
  $("#edit-error").hidden = true;

  // "2026-09-28|20|30" + "a_eviter" → { day: "2026-09-28", hour: 20, minute: 30, status: "a_eviter" }
  const slots = [...state.mySlots].map(([key, status]) => {
    const [day, hour, minute] = key.split("|");
    return { day, hour: Number(hour), minute: Number(minute), status };
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

$("#prev-week").addEventListener("click", () => changeWeek(-1));
$("#next-week").addEventListener("click", () => changeWeek(1));

// Échiquier : un seul écouteur pour les deux plateaux (délégation
// d'événements), qui continue de fonctionner quand les cases sont redessinées.
$("#boards").addEventListener("pointerdown", onBoardPointerDown);
$("#boards").addEventListener("click", onBoardClick);
document.addEventListener("pointermove", (e) => { if (paint.active) paintAt(e.clientX, e.clientY); });
document.addEventListener("pointerup", () => { paint.active = false; });
document.addEventListener("pointercancel", () => { paint.active = false; });

// Saisie des dispos
$("#edit-btn").addEventListener("click", enterEdit);
$("#save-btn").addEventListener("click", saveWeek);
$("#cancel-btn").addEventListener("click", () => { if (confirmLeaveEdit()) exitEdit(); });
$("#copy-last-week-btn").addEventListener("click", copyLastWeek);
$("#clear-btn").addEventListener("click", () => {
  state.mySlots.clear();
  document.querySelectorAll("#boards .sq").forEach(refreshCell);
  renderEditCount();
});
document.querySelectorAll(".brush").forEach((b) => {
  b.addEventListener("click", () => {
    state.brush = b.dataset.brush;
    renderBrushes();
  });
});

// Rendez-vous (admins)
$("#add-event-btn").addEventListener("click", () => openEventDialog());
$("#event-form").addEventListener("submit", saveEvent);
$("#ev-cancel").addEventListener("click", () => $("#event-dialog").close());
$("#ev-delete").addEventListener("click", deleteEvent);
$("#ev-type").addEventListener("change", updateTitlePlaceholder);
$("#ev-opgg").addEventListener("change", fillRosterFromLink);
addRosterArrows();

// Prévient si on ferme l'onglet avec des modifications non enregistrées
window.addEventListener("beforeunload", (e) => {
  if (hasChanges()) e.preventDefault();
});

// Démarrage : une fois la personne reconnue comme membre (voir common.js)
startSession(async () => {
  await loadPlayers();
  await Promise.all([loadEvents(), loadBoard()]);
});
