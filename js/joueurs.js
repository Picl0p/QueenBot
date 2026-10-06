"use strict";

// =====================================================================
// joueurs.js – page « Joueurs » : classement et pool récent de chacun
//
// Le but : que le coach voie ce que chaque joueur travaille de son côté
// (soloQ, flex, normales, seul ou à plusieurs). Les scrims et les
// tournois n'y sont pas : ils ont leur page (Statistiques).
//
// Les données viennent de l'API de Riot, mais pas depuis cette page :
// le script scripts/riot_sync.py (lancé toutes les heures par GitHub)
// range le classement et les dernières games de chaque compte dans les
// tables riot_accounts et soloq_games. Ici, on ne fait que lire.
//
// Organisation du fichier :
//   1. État, champions et rangs (noms, icônes)
//   2. Calculs
//   3. Affichage d'un joueur
//   4. Chargement
//   5. Synchronisation à la demande, puis démarrage
// =====================================================================


// ---------------------------------------------------------------------
// 1. État, champions et rangs
// ---------------------------------------------------------------------

Object.assign(state, {
  players: [],
  accounts: [],     // comptes LoL (principal et smurfs) avec leur classement
  games: [],        // games récentes de tous les comptes, de la plus récente à la plus ancienne
  period: 30,       // filtre : nombre de jours
  queue: "tout",    // filtre : type de game
});

const PERIODS = [[15, "15 jours"], [30, "30 jours"], [60, "60 jours"]];
const QUEUE_FILTERS = [["tout", "Tout"], ["solo", "SoloQ"], ["flex", "Flex"], ["normal", "Normales"]];

// Numéro de file de Riot → type de game (mêmes numéros que dans riot_sync.py)
const QUEUE_TYPE = { 420: "solo", 440: "flex", 400: "normal", 430: "normal", 490: "normal" };
const QUEUE_LABEL = { solo: "SoloQ", flex: "Flex", normal: "Normale" };
const queueType = (game) => QUEUE_TYPE[game.queue_id ?? 420] || "normal";

const DDRAGON = "https://ddragon.leagueoflegends.com";
const champions = new Map();   // identifiant Riot simplifié → { name, icon }
let ddragonVersion = null;

// "Kai'Sa" → "kaisa", "MonkeyKing" → "monkeyking"
const champKey = (name) => String(name || "").normalize("NFD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

// Noms français et icônes (Data Dragon, le site d'images officiel de Riot).
// En cas d'échec, la page s'affiche quand même, avec les noms bruts.
async function loadChampions() {
  try {
    const versions = await (await fetch(`${DDRAGON}/api/versions.json`)).json();
    ddragonVersion = versions[0];
    const list = await (await fetch(`${DDRAGON}/cdn/${ddragonVersion}/data/fr_FR/champion.json`)).json();
    for (const c of Object.values(list.data)) {
      // Riot donne l'identifiant du champion ("MonkeyKing"), pas son nom affiché
      champions.set(champKey(c.id), { name: c.name, icon: `${DDRAGON}/cdn/${ddragonVersion}/img/champion/${c.image.full}` });
    }
  } catch (err) {
    console.warn("Icônes des champions indisponibles :", err);
  }
}

const championOf = (id) => champions.get(champKey(id)) || { name: id, icon: null };

const TIER_NAMES = {
  IRON: "Fer", BRONZE: "Bronze", SILVER: "Argent", GOLD: "Or", PLATINUM: "Platine", EMERALD: "Émeraude",
  DIAMOND: "Diamant", MASTER: "Maître", GRANDMASTER: "Grand Maître", CHALLENGER: "Challenger",
};
// À partir de Maître, il n'y a plus de division (I à IV)
const NO_DIVISION = ["MASTER", "GRANDMASTER", "CHALLENGER"];

const ROLE_ORDER = ["top", "jungle", "mid", "adc", "support"];
const ROLE_NAMES = { top: "Top", jungle: "Jungle", mid: "Mid", adc: "ADC", support: "Support" };
const STATUS_NAMES = { remplacant: "Remplaçant", coach: "Coach" };


// ---------------------------------------------------------------------
// 2. Calculs
// ---------------------------------------------------------------------

const pct = (wins, games) => `${Math.round((wins / games) * 100)} %`;
const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

// "Diamant III · 63 LP", ou "Non classé"
function rankText(tier, division, lp) {
  if (!tier) return "Non classé";
  const name = TIER_NAMES[tier] || tier;
  return `${name}${NO_DIVISION.includes(tier) ? "" : ` ${division}`} · ${lp} LP`;
}

// Games d'un joueur (tous ses comptes) qui passent les filtres de la page
function filteredGames(playerId, games, period, queue, now = Date.now()) {
  const since = now - period * 24 * 3600 * 1000;
  return games.filter((g) => g.player_id === playerId
    && new Date(g.started_at).getTime() >= since
    && (queue === "tout" || queueType(g) === queue));
}

// Pool : les champions joués sur ces games, du plus joué au moins joué,
// avec le détail par type de game
function championPool(games) {
  const map = new Map();
  for (const g of games) {
    const key = champKey(g.champion);
    if (!map.has(key)) map.set(key, { champion: g.champion, games: 0, wins: 0, byQueue: { solo: 0, flex: 0, normal: 0 } });
    const entry = map.get(key);
    entry.games++;
    if (g.win) entry.wins++;
    entry.byQueue[queueType(g)]++;
  }
  return [...map.values()].sort((a, b) => b.games - a.games || b.wins - a.wins);
}

// "il y a 3 h", "il y a 2 j"
function ago(date) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 60) return `il y a ${minutes} min`;
  if (minutes < 48 * 60) return `il y a ${Math.round(minutes / 60)} h`;
  return `il y a ${Math.round(minutes / 1440)} j`;
}


// ---------------------------------------------------------------------
// 3. Affichage d'un joueur
// ---------------------------------------------------------------------

function champImg(id, size) {
  const c = championOf(id);
  return c.icon
    ? el("img", { class: "champ-icon", src: c.icon, alt: c.name, title: c.name, loading: "lazy", width: String(size), height: String(size) })
    : el("span", { class: "chip", text: c.name });
}

// Bloc du rang : emblème, palier, victoires et défaites
function rankBlock(account) {
  const tier = account.solo_tier;
  const games = (account.solo_wins || 0) + (account.solo_losses || 0);
  return el("div", { class: "rank" },
    tier
      ? el("img", { class: "rank-emblem", src: `assets/ranks/${tier.toLowerCase()}.png`, alt: "", width: "64", height: "64" })
      : el("span", { class: "rank-emblem rank-none", "aria-hidden": "true", text: "–" }),
    el("div", {},
      el("p", { class: "rank-name", text: rankText(tier, account.solo_division, account.solo_lp) }),
      el("p", { class: "rank-record", text: games
        ? `SoloQ · ${account.solo_wins} V – ${account.solo_losses} D · ${pct(account.solo_wins, games)}`
        : "SoloQ · aucune game classée cette saison" }),
      account.flex_tier
        ? el("p", { class: "rank-record", text: `Flex · ${rankText(account.flex_tier, account.flex_division, account.flex_lp)}` })
        : null));
}

// Pool récent : une ligne par champion. Les 6 premiers sont visibles,
// le reste se déplie.
const POOL_VISIBLE = 6;

function poolBlock(games) {
  const pool = championPool(games);
  const row = (c) => {
    const name = championOf(c.champion).name;
    const detail = Object.entries(c.byQueue).filter(([, n]) => n).map(([type, n]) => `${n} ${QUEUE_LABEL[type].toLowerCase()}`).join(", ");
    return el("li", { class: "pool-row", title: `${name} : ${plural(c.games, "game")} (${detail}), ${pct(c.wins, c.games)} de victoires` },
      champImg(c.champion, 28),
      el("span", { class: "pool-champ", text: name }),
      el("span", { class: "pool-games", text: String(c.games) }),
      el("span", { class: "pool-winrate", text: pct(c.wins, c.games) }));
  };
  const rest = pool.slice(POOL_VISIBLE);

  return el("div", { class: "pool" },
    el("h3", { class: "stat-subtitle" },
      "Pool récent ",
      el("span", { class: "optional", text: pool.length ? `(${plural(pool.length, "champion")}, ${plural(games.length, "game")})` : "" })),
    pool.length
      ? el("ul", { class: "pool-list" }, ...pool.slice(0, POOL_VISIBLE).map(row))
      : el("p", { class: "stat-empty", text: "Aucune game sur cette période." }),
    rest.length
      ? el("details", { class: "pool-more" },
        el("summary", { text: `Voir les ${rest.length} autre${rest.length > 1 ? "s" : ""}` }),
        el("ul", { class: "pool-list" }, ...rest.map(row)))
      : null);
}

// Les dernières games, une par ligne, avec leur type
function gamesList(games) {
  if (!games.length) return el("p", { class: "stat-empty", text: "Aucune game sur cette période." });
  return el("ul", { class: "soloq-games" }, ...games.map((g) => {
    const c = championOf(g.champion);
    const type = QUEUE_LABEL[queueType(g)];
    return el("li", { class: "soloq-game", title: `${c.name} · ${type} · ${g.win ? "victoire" : "défaite"} · ${ago(g.started_at)}` },
      el("span", { class: `form-chip ${g.win ? "is-win" : "is-loss"}`, title: g.win ? "Victoire" : "Défaite", text: g.win ? "V" : "D" }),
      champImg(g.champion, 28),
      el("span", { class: "soloq-champ" },
        el("span", { text: c.name }),
        el("span", { class: "soloq-queue", text: type })),
      el("span", { class: "soloq-kda", text: `${g.kills} / ${g.deaths} / ${g.assists}` }),
      el("span", { class: "soloq-when", text: ago(g.started_at) }));
  }));
}

// Forme récente en une ligne, pour les smurfs
function formRow(games) {
  return el("span", { class: "form" }, ...games.map((g) =>
    el("span", { class: `form-chip ${g.win ? "is-win" : "is-loss"}`, title: `${championOf(g.champion).name} · ${QUEUE_LABEL[queueType(g)]} · ${g.win ? "victoire" : "défaite"}`, text: g.win ? "V" : "D" })));
}

function playerCard(player) {
  const accounts = state.accounts.filter((a) => a.player_id === player.id);
  const main = accounts.find((a) => a.is_main) || null;
  const smurfs = accounts.filter((a) => !a.is_main);
  // Tous les comptes du joueur ensemble : ce qu'il travaille, peu importe sur lequel
  const games = filteredGames(player.id, state.games, state.period, state.queue);
  const role = [ROLE_NAMES[player.main_role], STATUS_NAMES[player.status]].filter(Boolean).join(" · ");

  const card = el("section", { class: "stat-block player-card" },
    el("header", { class: "player-head" },
      main?.profile_icon != null && ddragonVersion
        ? el("img", { class: "player-avatar", src: `${DDRAGON}/cdn/${ddragonVersion}/img/profileicon/${main.profile_icon}.png`, alt: "", width: "48", height: "48" })
        : null,
      el("div", {},
        el("h2", { text: player.pseudo }),
        el("p", { class: "player-sub", text: [role, main?.game_name ? `${main.game_name}#${main.tag_line}` : null].filter(Boolean).join(" · ") }))));

  if (!main) {
    card.append(el("p", { class: "stat-empty" },
      player.riot_id
        ? "Classement pas encore récupéré : il arrive à la prochaine mise à jour (toutes les heures environ)."
        : "Aucun compte League of Legends renseigné.",
      player.id === state.player.id ? el("a", { href: "profil.html", text: " Ouvrir mon profil" }) : null));
    return card;
  }
  if (main.error) {
    card.append(el("p", { class: "edit-error", text: main.error }));
    return card;
  }

  card.append(
    rankBlock(main),
    poolBlock(games),
    el("h3", { class: "stat-subtitle", text: "Dernières games" }),
    gamesList(games.slice(0, 8)));

  if (smurfs.length) {
    card.append(el("details", { class: "smurf-list" },
      el("summary", { text: `Comptes secondaires (${smurfs.length})` }),
      ...smurfs.map((s) => el("div", { class: "smurf-account" },
        el("p", { class: "smurf-name" },
          el("strong", { text: s.game_name ? `${s.game_name}#${s.tag_line}` : s.riot_id }),
          el("span", { text: s.error ? ` · ${s.error}` : ` · ${rankText(s.solo_tier, s.solo_division, s.solo_lp)}` })),
        s.error ? null : formRow(games.filter((g) => g.puuid === s.puuid).slice(0, 10))))));
  }

  card.append(el("p", { class: "player-updated", text: `Mis à jour ${ago(main.updated_at)}` }));
  return card;
}

function renderFilters() {
  const group = (selector, options, current, onPick) => {
    $(selector).replaceChildren(...options.map(([value, label]) => el("button", {
      type: "button", class: "seg", role: "radio", "aria-checked": String(value === current), text: label,
      onclick: () => onPick(value),
    })));
  };
  group("#filter-period", PERIODS, state.period, (value) => { state.period = value; render(); });
  group("#filter-queue", QUEUE_FILTERS, state.queue, (value) => { state.queue = value; render(); });
}

function render() {
  renderFilters();
  // Du top au support, puis ceux sans rôle (le coach en dernier)
  const rank = (p) => (p.status === "coach" ? 99 : ROLE_ORDER.includes(p.main_role) ? ROLE_ORDER.indexOf(p.main_role) : 50);
  const sorted = [...state.players].sort((a, b) => rank(a) - rank(b) || a.pseudo.localeCompare(b.pseudo, "fr"));
  $("#players").replaceChildren(...sorted.map(playerCard));
  $("#players-empty").hidden = state.accounts.length > 0;
}


// ---------------------------------------------------------------------
// 4. Chargement
// ---------------------------------------------------------------------

// Supabase renvoie au plus 1000 lignes par requête : on lit par paquets
async function fetchGames(since) {
  const PAGE = 1000;
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("soloq_games").select("*")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < PAGE) return all;
  }
}

// Lit les joueurs, leurs comptes et leurs games dans la base
async function loadData() {
  // La période la plus longue proposée par les filtres
  const since = new Date(Date.now() - Math.max(...PERIODS.map(([days]) => days)) * 24 * 3600 * 1000).toISOString();
  const [players, accounts, games] = await Promise.all([
    db.from("players").select("*"),
    db.from("riot_accounts").select("*"),
    fetchGames(since),
  ]);
  for (const res of [players, accounts]) {
    if (res.error) throw new Error(res.error.message);
  }
  state.players = players.data;
  state.accounts = accounts.data;
  state.games = games;
}

async function loadPlayers() {
  try {
    await Promise.all([loadData(), loadChampions()]);
  } catch (err) {
    return showError(`Impossible de charger les joueurs : ${err.message}`);
  }
  render();
}


// ---------------------------------------------------------------------
// 5. Synchronisation à la demande
//
// Le bouton demande à la base de lancer la tâche GitHub qui interroge
// Riot (fonction request_riot_sync, voir sql/14_bouton_synchroniser.sql).
// La tâche met une à deux minutes : en attendant, la page relit la base
// régulièrement et se met à jour dès que de nouvelles données arrivent.
// ---------------------------------------------------------------------

const SYNC_POLL_MS = 15 * 1000;         // relecture de la base toutes les 15 s
const SYNC_MAX_MS = 6 * 60 * 1000;      // au-delà, on arrête d'attendre

// Date de la donnée la plus récente (0 s'il n'y en a aucune)
const lastUpdate = () => Math.max(0, ...state.accounts.map((a) => new Date(a.updated_at).getTime()));

function syncStatus(text) {
  $("#sync-status").textContent = text;
}

async function requestSync() {
  const button = $("#sync-btn");
  button.disabled = true;
  const before = lastUpdate();

  try {
    const { data, error } = await db.rpc("request_riot_sync");
    if (error) throw new Error(error.message);
    if (!data.ok) {
      syncStatus(data.message);
      button.disabled = false;
      return;
    }
  } catch (err) {
    syncStatus(`Synchronisation impossible : ${err.message}`);
    button.disabled = false;
    return;
  }

  syncStatus("Synchronisation lancée : les nouvelles données arrivent dans une à deux minutes…");
  const started = Date.now();
  let accepted = false;   // GitHub a-t-il confirmé la demande ?
  let seen = before;      // dernière donnée vue
  let quiet = 0;          // relectures sans nouveauté depuis la première arrivée

  const stop = (message) => {
    clearInterval(timer);
    syncStatus(message);
    button.disabled = false;
  };

  const timer = setInterval(async () => {
    try {
      // 1. GitHub a-t-il accepté ? (204 = oui ; autre chose = jeton refusé, dépôt introuvable…)
      if (!accepted) {
        const { data: answer } = await db.rpc("riot_sync_status");
        if (answer?.status === 204) accepted = true;
        else if (answer?.status != null) {
          return stop(`GitHub a refusé la demande (${answer.status}) : vérifie le jeton GitHub (sql/14_bouton_synchroniser.sql, section 3).`);
        }
      }

      // 2. De nouvelles données ? La tâche met les comptes à jour un par un :
      //    on attend deux relectures sans nouveauté avant de dire que c'est fini.
      await loadData();
      const latest = lastUpdate();
      if (latest > seen) {
        seen = latest;
        quiet = 0;
        render();
        syncStatus("Mise à jour en cours : les joueurs arrivent un par un…");
      } else if (seen > before && ++quiet >= 2) {
        return stop("Données à jour.");
      }
      if (Date.now() - started > SYNC_MAX_MS) {
        stop(seen > before ? "Données à jour." : "La synchronisation prend plus de temps que prévu. Recharge la page dans quelques minutes.");
      }
    } catch (err) {
      stop(`Impossible de relire les données : ${err.message}`);
    }
  }, SYNC_POLL_MS);
}

$("#sync-btn").addEventListener("click", requestSync);

startSession(loadPlayers);
