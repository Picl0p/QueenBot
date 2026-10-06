"use strict";

// =====================================================================
// draft.js – page Drafts : saisie des drafts de scrim
//
// En scrim, la draft se fait sur drafter.lol, puis on picke à l'aveugle
// dans le client : la game enregistrée par le companion n'a donc ni bans
// ni ordre. Un admin saisit la draft ici, en même temps que sur drafter :
//   * elle est rangée dans la table event_drafts ;
//   * la base la recopie dans la game de même numéro (game 1 ↔ draft 1),
//     d'où les bans et l'ordre sur la page Statistiques ;
//   * le bouton « poster » envoie le récap dans le post Discord de la session.
//
// Organisation du fichier :
//   1. État, champions et ordre d'une draft
//   2. Draft en cours : lecture, écriture, conversions
//   3. Affichage (liste des sessions, plateau, ordre)
//   4. Saisie au clavier
//   5. Enregistrement, image et récap Discord
//   6. Chargement, branchements et démarrage
// =====================================================================


// ---------------------------------------------------------------------
// 1. État, champions et ordre d'une draft
// ---------------------------------------------------------------------

const TEAM_NAME = "Queen's Gambit";
const DDRAGON = "https://ddragon.leagueoflegends.com";

Object.assign(state, {
  champions: [],          // [{ name, icon, keys }] triés par nom (en français)
  event: null,            // session affichée
  drafts: new Map(),      // numéro de game → ligne de event_drafts
  game: 1,                // game affichée
  form: null,             // draft en cours de saisie (voir newForm)
  active: 0,              // étape en cours, de 0 à 19
  dirty: false,           // modifications pas encore enregistrées
  highlighted: 0,         // suggestion surlignée
});

const isAdmin = () => Boolean(state.player?.is_admin);
const other = (side) => (side === "blue" ? "red" : "blue");
const SIDE_LABEL = { blue: "Blue side", red: "Red side" };

// "Kai'Sa" → "kaisa", "Maître Yi" → "maitreyi" : accents, espaces et ponctuation ne comptent pas
const champKey = (name) => String(name || "").normalize("NFD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

// Liste des champions (Data Dragon, le site officiel de Riot). Les noms
// sont en français ; on les retrouve aussi en tapant le nom anglais.
async function loadChampions() {
  const versions = await (await fetch(`${DDRAGON}/api/versions.json`)).json();
  const version = versions[0];
  const [fr, en] = await Promise.all(["fr_FR", "en_US"].map(async (locale) =>
    (await fetch(`${DDRAGON}/cdn/${version}/data/${locale}/champion.json`)).json()));
  state.champions = Object.values(fr.data).map((c) => ({
    name: c.name,
    icon: `${DDRAGON}/cdn/${version}/img/champion/${c.image.full}`,
    keys: [champKey(c.name), champKey(en.data[c.id]?.name), champKey(c.id)],
  })).sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

const championByName = (name) => state.champions.find((c) => c.name === name) || null;

// Ordre d'une draft de tournoi. "F" = l'équipe qui a le first pick,
// "S" = l'autre ; celle qui picke en premier banne aussi en premier.
const ORDER = [
  ["F", "ban", 1], ["S", "ban", 1], ["F", "ban", 2], ["S", "ban", 2], ["F", "ban", 3], ["S", "ban", 3],
  ["F", "pick", 1], ["S", "pick", 1], ["S", "pick", 2], ["F", "pick", 2], ["F", "pick", 3], ["S", "pick", 3],
  ["S", "ban", 4], ["F", "ban", 4], ["S", "ban", 5], ["F", "ban", 5],
  ["S", "pick", 4], ["F", "pick", 4], ["F", "pick", 5], ["S", "pick", 5],
];

// Les 20 étapes, pour un first pick donné : { side, type, n, phase }
function steps(firstPick) {
  return ORDER.map(([who, type, n], index) => ({
    side: who === "F" ? firstPick : other(firstPick),
    type,
    n,
    phase: index < 12 ? 1 : 2,
  }));
}

// Étiquette courte d'une étape : "B1" (ban 1 du blue side), "R3"…
const stepCode = (step) => `${step.side === "blue" ? "B" : "R"}${step.n}`;
const stepText = (step) =>
  `${step.type === "ban" ? "Ban" : "Pick"} ${step.n} · ${SIDE_LABEL[step.side]}`
  + ` (${step.side === state.form.ourSide ? TEAM_NAME : opponentName()})`;

const opponentName = () => state.event?.opponent || "Adversaire";
const teamName = (side) => (side === state.form.ourSide ? TEAM_NAME : opponentName());


// ---------------------------------------------------------------------
// 2. Draft en cours
//
// Chaque case vaut null (vide), "" (pas de ban) ou le nom d'un champion.
// ---------------------------------------------------------------------

const emptySlots = () => ({
  blue: { ban: Array(5).fill(null), pick: Array(5).fill(null) },
  red: { ban: Array(5).fill(null), pick: Array(5).fill(null) },
});

// Côté de la team d'après le champ "Side" du rendez-vous ("Blue side", "rouge"…)
function sideFromText(text) {
  if (/blue|bleu/i.test(text || "")) return "blue";
  if (/red|rouge/i.test(text || "")) return "red";
  return null;
}

function newForm(game) {
  const previous = state.drafts.get(game - 1);
  return {
    ourSide: previous?.our_side || sideFromText(state.event.side) || "blue",
    firstPick: "blue",
    fearless: /fearless/i.test(state.event.format || "") || Boolean(previous?.draft?.fearless),
    slots: emptySlots(),
  };
}

function formFromRow(row) {
  const draft = row.draft || {};
  const slots = emptySlots();
  for (const side of ["blue", "red"]) {
    for (const type of ["ban", "pick"]) {
      const saved = draft.slots?.[side]?.[type];
      if (saved) slots[side][type] = [0, 1, 2, 3, 4].map((i) => (saved[i] === undefined ? null : saved[i]));
    }
  }
  return { ourSide: row.our_side, firstPick: draft.first_pick || "blue", fearless: Boolean(draft.fearless), slots };
}

const slotOf = (step) => state.form.slots[step.side][step.type][step.n - 1];
const currentSteps = () => steps(state.form.firstPick);

// La draft au format de la base (même format que games.draft, pour les stats)
function toDraft(form) {
  const filled = (side, type) => form.slots[side][type].filter(Boolean);
  return {
    source: "site",
    first_pick: form.firstPick,
    fearless: form.fearless,
    blue: { bans: filled("blue", "ban"), picks: filled("blue", "pick") },
    red: { bans: filled("red", "ban"), picks: filled("red", "pick") },
    order: steps(form.firstPick)
      .map((step) => ({ type: step.type, side: step.side, champion: form.slots[step.side][step.type][step.n - 1], phase: step.phase }))
      .filter((action) => action.champion),
    slots: form.slots,
  };
}

const pickCount = (form) => ["blue", "red"].reduce((n, side) => n + form.slots[side].pick.filter(Boolean).length, 0);

// Fearless : champions joués (pickés) dans les games précédentes de la série → numéro de la game
function fearlessUsed() {
  const used = new Map();
  if (!state.form.fearless) return used;
  for (const [game, row] of state.drafts) {
    if (game >= state.game) continue;
    for (const side of ["blue", "red"]) {
      for (const name of row.draft?.[side]?.picks || []) if (!used.has(name)) used.set(name, game);
    }
  }
  return used;
}

// Pourquoi un champion n'est pas disponible à cette étape (ou null)
function unavailable(name) {
  for (const side of ["blue", "red"]) {
    for (const type of ["ban", "pick"]) {
      if (state.form.slots[side][type].includes(name)) return "déjà dans cette draft";
    }
  }
  const game = fearlessUsed().get(name);
  return game ? `joué en game ${game}` : null;
}

// Prochaine étape vide après `from` (en revenant au début si besoin)
function nextEmpty(from) {
  const all = currentSteps();
  for (let i = 1; i <= all.length; i++) {
    const index = (from + i) % all.length;
    if (slotOf(all[index]) === null) return index;
  }
  return from;
}

function setStep(index, value) {
  const step = currentSteps()[index];
  state.form.slots[step.side][step.type][step.n - 1] = value;
  state.dirty = true;
}


// ---------------------------------------------------------------------
// 3. Affichage
// ---------------------------------------------------------------------

// Image d'un champion, ou une case vide
function champImage(name, size) {
  const champion = name ? championByName(name) : null;
  return champion
    ? el("img", { src: champion.icon, alt: "", width: String(size), height: String(size), loading: "lazy" })
    : null;
}

function renderSessionList(events, counts) {
  $("#session-list").hidden = false;
  $("#editor").hidden = true;
  const fmt = { weekday: "short", day: "numeric", month: "short" };
  $("#sessions").replaceChildren(...(events.length ? events.map((ev) => {
    const n = counts.get(ev.id) || 0;
    return el("li", {},
      el("a", { class: "draft-session", href: `draft.html?event=${ev.id}` },
        el("span", { class: "session-date", text: new Date(ev.starts_at).toLocaleDateString("fr-FR", fmt) }),
        el("span", { class: "session-title", text: ev.opponent ? `${TYPE_LABELS[ev.type]} contre ${ev.opponent}` : ev.title }),
        el("span", { class: "session-score", text: n ? `${n} draft${n > 1 ? "s" : ""}` : "aucune draft" })));
  }) : [el("li", { class: "stat-empty", text: "Aucun scrim ni match officiel récent." })]));
}

// Boutons à choix unique (game, côté, first pick)
function segs(selector, options, current, onPick, disabled = false) {
  $(selector).replaceChildren(...options.map(([value, label]) => el("button", {
    type: "button", class: "seg", role: "radio", disabled,
    "aria-checked": String(value === current), text: label, onclick: () => onPick(value),
  })));
}

function gameCount() {
  // "BO3", "3 games fearless"… : nombre de games annoncé dans le format
  const announced = Number((state.event.format || "").match(/\d+/)?.[0]) || 1;
  const saved = Math.max(0, ...state.drafts.keys());
  return Math.min(9, Math.max(announced, saved + (isAdmin() ? 1 : 0), state.game, 1));
}

function renderEditor() {
  const ev = state.event;
  const admin = isAdmin();
  $("#session-list").hidden = true;
  $("#editor").hidden = false;
  $("#editor-title").textContent = ev.opponent ? `Draft contre ${ev.opponent}` : `Draft · ${ev.title}`;
  const day = new Date(ev.starts_at).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  $("#editor-subtitle").textContent = [TYPE_LABELS[ev.type], day, ev.format].filter(Boolean).join(" · ");

  segs("#games", Array.from({ length: gameCount() }, (_, i) => [i + 1, `Game ${i + 1}${state.drafts.has(i + 1) ? " ✓" : ""}`]),
    state.game, selectGame);
  segs("#our-side", [["blue", "Blue side"], ["red", "Red side"]], state.form.ourSide, (side) => {
    state.form.ourSide = side;
    state.dirty = true;
    renderEditor();
  }, !admin);
  segs("#first-pick", [["blue", "Blue side"], ["red", "Red side"]], state.form.firstPick, (side) => {
    // Le first pick change l'ordre des étapes, pas les cases déjà remplies
    state.form.firstPick = side;
    state.dirty = true;
    state.active = nextEmpty(-1);
    renderEditor();
  }, !admin);
  const fearless = $("#fearless");
  fearless.checked = state.form.fearless;
  fearless.disabled = !admin;

  renderBoard();
  renderStatus();
  for (const id of ["#entry", "#save-draft-btn", "#post-draft-btn", "#clear-draft-btn"]) $(id).hidden = !admin;
}

// Plateau : une colonne par équipe (bans en haut, picks dessous), et l'ordre
function renderBoard() {
  const all = currentSteps();
  const indexOf = (side, type, n) => all.findIndex((s) => s.side === side && s.type === type && s.n === n);

  const slotButton = (side, type, n) => {
    const index = indexOf(side, type, n);
    const value = state.form.slots[side][type][n - 1];
    const size = type === "ban" ? 36 : 56;
    return el("button", {
      type: "button",
      class: `draft-slot is-${type}${index === state.active && isAdmin() ? " is-active" : ""}${value === "" ? " is-skipped" : ""}`,
      title: `${stepText(all[index])}${value ? ` : ${value}` : value === "" ? " : pas de ban" : ""}`,
      disabled: !isAdmin(),
      onclick: () => { state.active = index; renderBoard(); $("#champ-input").focus(); },
    },
      champImage(value, size) || el("span", { class: "draft-slot-code", text: value === "" ? "∅" : stepCode(all[index]) }),
      type === "pick" ? el("span", { class: "draft-slot-name", text: value || "" }) : null);
  };

  for (const side of ["blue", "red"]) {
    $(`#team-${side}`).replaceChildren(
      el("p", { class: "draft-team-name" },
        el("strong", { text: teamName(side) }),
        el("span", { text: ` · ${SIDE_LABEL[side]}` })),
      el("div", { class: "draft-bans" }, ...[1, 2, 3, 4, 5].map((n) => slotButton(side, "ban", n))),
      el("div", { class: "draft-picks" }, ...[1, 2, 3, 4, 5].map((n) => slotButton(side, "pick", n))));
  }

  // Ordre complet, de gauche à droite
  $("#order").replaceChildren(...all.map((step, index) => {
    const value = slotOf(step);
    return el("li", {
      class: `draft-order-item side-${step.side} is-${step.type}${index === state.active && isAdmin() ? " is-active" : ""}`,
      title: `${stepText(step)}${value ? ` : ${value}` : ""}`,
      onclick: isAdmin() ? () => { state.active = index; renderBoard(); $("#champ-input").focus(); } : null,
    },
      champImage(value, step.type === "ban" ? 24 : 32) || el("span", { text: value === "" ? "∅" : stepCode(step) }));
  }));

  const step = all[state.active];
  const complete = all.every((s) => slotOf(s) !== null);
  $("#step-label").textContent = slotOf(step) === null ? `À saisir : ${stepText(step)}`
    : complete ? "Draft complète ✓ Clique sur une case pour la corriger."
    : `Correction : ${stepText(step)}`;
  $("#no-ban-btn").hidden = step.type !== "ban";
  renderSuggestions();
}

function renderStatus() {
  const row = state.drafts.get(state.game);
  const parts = [];
  if (state.dirty) parts.push("Modifications non enregistrées.");
  else if (row) parts.push(`Enregistrée le ${new Date(row.updated_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}.`);
  if (row?.discord_message_id) parts.push("Récap posté sur Discord (le reposter met à jour le message).");
  else if (!state.event.discord_thread_id) parts.push("Ce rendez-vous n'a pas de post Discord : la draft ne peut pas y être annoncée.");
  if (pickCount(state.form) < 10) parts.push(`${pickCount(state.form)} picks sur 10.`);
  $("#draft-status").textContent = parts.join(" ");
  $("#post-draft-btn").disabled = pickCount(state.form) < 10 || !state.event.discord_thread_id;
}


// ---------------------------------------------------------------------
// 4. Saisie au clavier
// ---------------------------------------------------------------------

// Champions qui correspondent à ce qui est tapé : ceux qui commencent
// par le texte d'abord, puis ceux qui le contiennent
function matches(query) {
  const q = champKey(query);
  if (!q) return [];
  const starts = state.champions.filter((c) => c.keys.some((k) => k.startsWith(q)));
  const contains = state.champions.filter((c) => !starts.includes(c) && c.keys.some((k) => k.includes(q)));
  return [...starts, ...contains].slice(0, 8);
}

function renderSuggestions() {
  const input = $("#champ-input");
  const list = matches(input.value);
  const firstFree = list.findIndex((c) => !unavailable(c.name));
  if (state.highlighted >= list.length || unavailable(list[state.highlighted]?.name || "")) {
    state.highlighted = Math.max(firstFree, 0);
  }
  $("#suggestions").replaceChildren(...list.map((c, i) => {
    const reason = unavailable(c.name);
    return el("li", {
      role: "option",
      class: `${i === state.highlighted ? "is-highlighted" : ""}${reason ? " is-unavailable" : ""}`,
      "aria-selected": String(i === state.highlighted),
      "aria-disabled": reason ? "true" : null,
      onmousedown: (e) => { e.preventDefault(); if (!reason) choose(c.name); },
    },
      el("img", { src: c.icon, alt: "", width: "28", height: "28" }),
      el("span", { text: c.name }),
      reason ? el("span", { class: "draft-suggestion-why", text: reason }) : null);
  }));
  input.setAttribute("aria-expanded", String(list.length > 0));
  return list;
}

function choose(value) {
  setStep(state.active, value);
  state.active = nextEmpty(state.active);
  $("#champ-input").value = "";
  state.highlighted = 0;
  renderEditor();
  $("#champ-input").focus();
}

// Annule la dernière case remplie (dans l'ordre de la draft)
function undo() {
  const all = currentSteps();
  for (let i = all.length - 1; i >= 0; i--) {
    if (slotOf(all[i]) !== null) {
      setStep(i, null);
      state.active = i;
      renderEditor();
      return;
    }
  }
}

function onInputKey(e) {
  const list = matches(e.target.value);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!list.length) return;
    const delta = e.key === "ArrowDown" ? 1 : -1;
    state.highlighted = (state.highlighted + delta + list.length) % list.length;
    renderSuggestions();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const champion = list[state.highlighted];
    if (champion && !unavailable(champion.name)) choose(champion.name);
  } else if (e.key === "Escape") {
    e.target.value = "";
    renderSuggestions();
  } else if (e.key === "Backspace" && !e.target.value) {
    e.preventDefault();
    undo();
  }
}


// ---------------------------------------------------------------------
// 5. Enregistrement, image et récap Discord
// ---------------------------------------------------------------------

async function saveDraft() {
  const { data, error } = await db.from("event_drafts")
    .upsert({
      event_id: state.event.id,
      game_number: state.game,
      our_side: state.form.ourSide,
      draft: toDraft(state.form),
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  state.drafts.set(state.game, data);
  state.dirty = false;
  return data;
}

// Image de la draft dans l'ordre : une ligne par phase, bans (petits, en
// gris) puis picks (grands), chacun encadré de la couleur de l'équipe.
const SIDE_RGB = { blue: "#4FC3DC", red: "#F0607A" };

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";   // sinon le navigateur interdit d'exporter l'image
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function draftImage(draft) {
  const PICK = 72, BAN = 40, GAP = 8, PAD = 16;
  const phases = [1, 2].map((p) => draft.order.filter((a) => a.phase === p)).filter((p) => p.length);
  if (!phases.length) return null;
  const count = (phase, type) => phase.filter((a) => a.type === type).length;
  const picksX = PAD + Math.max(...phases.map((p) => count(p, "ban"))) * (BAN + GAP) + 3 * GAP;

  const canvas = document.createElement("canvas");
  canvas.width = picksX + Math.max(...phases.map((p) => count(p, "pick"))) * (PICK + GAP) + PAD;
  canvas.height = PAD * 2 + phases.length * PICK + (phases.length - 1) * 3 * GAP;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#1A1720";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const images = new Map(await Promise.all(draft.order.map(async (a) =>
    [a.champion, await loadImage(championByName(a.champion)?.icon || "")])));

  phases.forEach((phase, row) => {
    const top = PAD + row * (PICK + 3 * GAP);
    const x = { ban: PAD, pick: picksX };
    for (const action of phase) {
      const size = action.type === "ban" ? BAN : PICK;
      const border = action.type === "ban" ? 2 : 3;
      const left = x[action.type];
      const y = top + (PICK - size) / 2;
      ctx.fillStyle = SIDE_RGB[action.side];
      ctx.fillRect(left - border, y - border, size + 2 * border, size + 2 * border);
      const img = images.get(action.champion);
      if (img) {
        ctx.filter = action.type === "ban" ? "grayscale(1) brightness(0.6)" : "none";
        ctx.drawImage(img, left, y, size, size);
        ctx.filter = "none";
      } else {
        ctx.fillStyle = "#1A1720";
        ctx.fillRect(left, y, size, size);
      }
      x[action.type] += size + GAP;
    }
  });

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// Même présentation que le récap de game du companion
function draftMessage(draft, withImage) {
  const names = { blue: teamName("blue"), red: teamName("red") };
  const icon = { blue: "🔵", red: "🔴" };
  const line = (actions) => actions.map((a) => `${icon[a.side]} ${a.champion}`).join(" · ") || "–";

  const details = [`First pick : ${icon[draft.first_pick]} ${mdEscape(names[draft.first_pick])}`];
  if (draft.fearless) details.push("🔥 Fearless");
  if (state.event.format) details.push(mdEscape(state.event.format));

  const fields = [];
  for (const phase of [1, 2]) {
    for (const [type, label] of [["ban", "🚫 Bans"], ["pick", "✅ Picks"]]) {
      const actions = draft.order.filter((a) => a.phase === phase && a.type === type);
      if (actions.length) fields.push({ name: `${label} · phase ${phase}`, value: line(actions).slice(0, 1024), inline: false });
    }
  }
  for (const side of ["blue", "red"]) {
    fields.push({ name: `${icon[side]} ${names[side]}`.slice(0, 256), value: draft[side].picks.join("\n") || "–", inline: true });
  }

  const embed = {
    title: `📋 Draft · Game ${state.game}`,
    description: [`${icon.blue} **${mdEscape(names.blue)}**  vs  ${icon.red} **${mdEscape(names.red)}**`, details.join(" · ")].join("\n"),
    color: 0xEFE2C6,
    fields,
    footer: { text: TEAM_NAME },
  };
  if (withImage) embed.image = { url: "attachment://draft.png" };
  return { username: TEAM_NAME, embeds: [embed], allowed_mentions: { parse: [] },
           attachments: withImage ? [{ id: 0, filename: "draft.png" }] : [] };
}

// Poste le récap (ou met à jour le message déjà posté pour cette game)
async function postDraft() {
  const row = await saveDraft();
  const config = await discordConfig();
  if (!config) throw new Error("Le webhook Discord n'est pas configuré (voir sql/05_sessions_discord_games.sql).");

  const draft = toDraft(state.form);
  let image = null;
  try {
    image = await draftImage(draft);
  } catch (err) {
    console.warn("Image de la draft impossible :", err);
  }

  const send = (method, url) => {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(draftMessage(draft, Boolean(image))));
    if (image) form.append("files[0]", image, "draft.png");
    return fetch(url, { method, body: form });
  };

  const thread = state.event.discord_thread_id;
  let res = row.discord_message_id
    ? await send("PATCH", `${config.webhook}/messages/${row.discord_message_id}?thread_id=${thread}`)
    : null;
  // Pas encore posté, ou message supprimé entre-temps : nouveau message
  if (!res || res.status === 404) res = await send("POST", `${config.webhook}?wait=true&thread_id=${thread}`);
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(`Discord ${res.status}${detail?.message ? ` : ${detail.message}` : ""}`);
  }
  const message = await res.json();

  const { data, error } = await db.from("event_drafts")
    .update({ discord_message_id: message.id })
    .eq("event_id", state.event.id).eq("game_number", state.game)
    .select().single();
  if (error) throw new Error(error.message);
  state.drafts.set(state.game, data);
}

// Lance une action d'enregistrement en bloquant les boutons pendant ce temps
async function run(button, action, success) {
  const buttons = ["#save-draft-btn", "#post-draft-btn"].map((id) => $(id));
  buttons.forEach((b) => { b.disabled = true; });
  const label = button.textContent;
  button.textContent = "Envoi…";
  try {
    await action();
    showToast(success);
  } catch (err) {
    showError(`${label} : échec (${err.message})`);
  } finally {
    button.textContent = label;
    buttons.forEach((b) => { b.disabled = false; });
    renderEditor();
  }
}


// ---------------------------------------------------------------------
// 6. Chargement et démarrage
// ---------------------------------------------------------------------

function selectGame(game) {
  if (game === state.game) return;
  if (state.dirty && !confirm("La draft de cette game n'est pas enregistrée. Changer de game quand même ?")) return;
  state.game = game;
  const row = state.drafts.get(game);
  state.form = row ? formFromRow(row) : newForm(game);
  state.dirty = false;
  state.active = nextEmpty(-1);
  $("#champ-input").value = "";
  renderEditor();
}

// Session demandée : ?event= dans l'adresse. Après la connexion Discord,
// l'adresse revient sans ce paramètre : on l'a gardé de côté au clic.
function requestedEventId() {
  const fromUrl = new URLSearchParams(location.search).get("event");
  if (fromUrl) return Number(fromUrl);
  try {
    const kept = sessionStorage.getItem("draft-event");
    sessionStorage.removeItem("draft-event");
    if (kept) history.replaceState(null, "", `${location.pathname}?event=${kept}`);
    return kept ? Number(kept) : null;
  } catch {
    return null;
  }
}

async function loadPage() {
  const eventId = requestedEventId();
  try {
    if (!eventId) {
      // Liste : scrims et matchs officiels des 30 derniers jours et des 2 semaines à venir
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const until = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
      const { data: events, error } = await db.from("events")
        .select("id, title, type, opponent, starts_at")
        .in("type", ["scrim", "match_officiel"])
        .gte("starts_at", since).lte("starts_at", until)
        .order("starts_at", { ascending: false });
      if (error) throw new Error(error.message);
      const { data: drafts, error: draftsError } = await db.from("event_drafts")
        .select("event_id").in("event_id", events.map((e) => e.id));
      if (draftsError) throw new Error(draftsError.message);
      const counts = new Map();
      for (const d of drafts) counts.set(d.event_id, (counts.get(d.event_id) || 0) + 1);
      return renderSessionList(events, counts);
    }

    const [eventRes, draftsRes] = await Promise.all([
      db.from("events")
        .select("id, title, type, opponent, starts_at, format, side, discord_thread_id")
        .eq("id", eventId).maybeSingle(),
      db.from("event_drafts").select("*").eq("event_id", eventId).order("game_number"),
      loadChampions(),
    ]);
    if (eventRes.error) throw new Error(eventRes.error.message);
    if (draftsRes.error) throw new Error(draftsRes.error.message);
    if (!eventRes.data) throw new Error("rendez-vous introuvable");

    state.event = eventRes.data;
    state.drafts = new Map(draftsRes.data.map((row) => [row.game_number, row]));
    // On ouvre la première game sans draft (ou la dernière si tout est saisi)
    const saved = [...state.drafts.keys()];
    state.game = Math.min(gameCount(), saved.length ? Math.max(...saved) + (isAdmin() ? 1 : 0) : 1) || 1;
    const row = state.drafts.get(state.game);
    state.form = row ? formFromRow(row) : newForm(state.game);
    state.active = nextEmpty(-1);
    renderEditor();
  } catch (err) {
    showError(`Impossible de charger la draft : ${err.message}`);
  }
}

$("#champ-input").addEventListener("input", () => { state.highlighted = 0; renderSuggestions(); });
$("#champ-input").addEventListener("keydown", onInputKey);
$("#no-ban-btn").addEventListener("click", () => choose(""));
$("#undo-btn").addEventListener("click", undo);
$("#fearless").addEventListener("change", (e) => { state.form.fearless = e.target.checked; state.dirty = true; renderEditor(); });
$("#save-draft-btn").addEventListener("click", (e) => run(e.currentTarget, saveDraft, "Draft enregistrée"));
$("#post-draft-btn").addEventListener("click", (e) => run(e.currentTarget, postDraft, "Draft postée sur Discord"));
$("#clear-draft-btn").addEventListener("click", () => {
  if (!confirm(`Effacer toute la draft de la game ${state.game} ?`)) return;
  state.form.slots = emptySlots();
  state.dirty = true;
  state.active = 0;
  renderEditor();
});
// Garde la session demandée pendant l'aller-retour de la connexion Discord
$("#login-btn").addEventListener("click", () => {
  const id = new URLSearchParams(location.search).get("event");
  try { if (id) sessionStorage.setItem("draft-event", id); } catch { /* navigation privée */ }
});
window.addEventListener("beforeunload", (e) => { if (state.dirty) e.preventDefault(); });

startSession(loadPage);
