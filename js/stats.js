"use strict";

// =====================================================================
// stats.js – page Statistiques de la team
//
// Les games viennent du companion (scripts/lcu_companion.py), qui les
// range dans les tables games et game_participants. Cette page les lit
// toutes une fois, puis calcule tout dans le navigateur : changer un
// filtre ne refait donc aucune requête.
//
// Organisation du fichier :
//   1. État et filtres
//   2. Calculs (fonctions pures : des games en entrée, des chiffres en sortie)
//   3. Petits outils d'affichage (formats, tableaux, jauges)
//   4. Affichage des cinq blocs
//   5. Chargement, branchements et démarrage
// =====================================================================


// ---------------------------------------------------------------------
// 1. État et filtres
// ---------------------------------------------------------------------

Object.assign(state, {
  players: [],     // joueurs de la team (pour relier les stats aux pseudos)
  games: [],       // toutes les games, de la plus récente à la plus ancienne
  period: "30j",   // filtre de période
  type: "tout",    // filtre de type de game
});

const PERIODS = [["30j", "30 derniers jours"], ["saison", "Saison"], ["tout", "Tout"]];
const GAME_TYPES = [["tout", "Tout"], ["scrim", "Scrims"], ["match_officiel", "Matchs officiels"], ["flex", "Flex"]];

const ROLE_ORDER = ["top", "jungle", "mid", "adc", "support"];
const ROLE_NAMES = { top: "Top", jungle: "Jungle", mid: "Mid", adc: "ADC", support: "Support" };

// En dessous de ce nombre de games, un duo, une compo ou un adversaire
// n'est pas affiché : une seule game ne dit rien.
const MIN_GAMES = 2;


// ---------------------------------------------------------------------
// 2. Calculs
// ---------------------------------------------------------------------

// "Queen Isa#EUW" → "queenisa#euw" : majuscules et espaces ne comptent pas
const normId = (riotId) => (riotId || "").replace(/\s+/g, "").toLowerCase();

// Type d'une game : celui de son rendez-vous. Une game jouée hors de
// tout rendez-vous compte comme de la flex, même si c'est une game perso.
function gameType(game) {
  return game.events?.type || "flex";
}

const isWin = (game) => game.winner === game.our_side;
const otherSide = (side) => (side === "blue" ? "red" : "blue");

// Les 5 joueurs d'un côté, dans l'ordre de l'équipe
function sidePlayers(game, side) {
  return game.game_participants.filter((p) => p.side === side).sort((a, b) => a.slot - b.slot);
}
const ourPlayers = (game) => sidePlayers(game, game.our_side);

function filterGames(games, period, type, now = new Date()) {
  let since = null;
  if (period === "30j") since = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  if (period === "saison") since = new Date(`${STATS_SEASON_START}T00:00`);
  return games.filter((g) =>
    (!since || new Date(g.started_at) >= since) && (type === "tout" || gameType(g) === type));
}

// Compte une game (et une victoire éventuelle) pour une clé dans une Map.
// `extra` initialise les champs en plus du compteur (ex. le nom affiché).
function tally(map, key, win, extra = {}) {
  if (!map.has(key)) map.set(key, { games: 0, wins: 0, ...extra });
  const entry = map.get(key);
  entry.games++;
  if (win) entry.wins++;
  return entry;
}

// Tri habituel des classements : le plus joué d'abord, puis le meilleur winrate
const byGames = (a, b) => b.games - a.games || b.wins - a.wins;
// Pour les duos et compos : le meilleur winrate d'abord, puis le plus joué
const byWinrate = (a, b) => b.wins / b.games - a.wins / a.games || b.games - a.games;

// Bloc 1 : bilan général
function summary(games) {
  const sides = { blue: { games: 0, wins: 0 }, red: { games: 0, wins: 0 } };
  let wins = 0, duration = 0;
  for (const g of games) {
    const win = isWin(g);
    if (win) wins++;
    sides[g.our_side].games++;
    if (win) sides[g.our_side].wins++;
    duration += g.duration_s;
  }
  return {
    games: games.length,
    wins,
    losses: games.length - wins,
    sides,
    avgDuration: games.length ? duration / games.length : 0,
    form: games.slice(0, 10),   // les 10 plus récentes
  };
}

// Bloc 2 : nos champions, avec winrate et KDA
function championStats(games) {
  const map = new Map();
  for (const g of games) {
    for (const p of ourPlayers(g)) {
      const entry = tally(map, p.champion, isWin(g), { champion: p.champion, kills: 0, deaths: 0, assists: 0 });
      entry.kills += p.kills;
      entry.deaths += p.deaths;
      entry.assists += p.assists;
    }
  }
  return [...map.values()].sort(byGames);
}

// Bloc 2 : duos de champions joués ensemble (toutes les paires de la compo)
function duoStats(games) {
  const map = new Map();
  for (const g of games) {
    const champions = ourPlayers(g).map((p) => p.champion).sort();
    for (let i = 0; i < champions.length; i++) {
      for (let j = i + 1; j < champions.length; j++) {
        const pair = [champions[i], champions[j]];
        tally(map, pair.join("|"), isWin(g), { champions: pair });
      }
    }
  }
  return [...map.values()].filter((d) => d.games >= MIN_GAMES).sort(byWinrate);
}

// Bloc 2 : compos complètes (les 5 mêmes champions), dans l'ordre de l'équipe
function compStats(games) {
  const map = new Map();
  for (const g of games) {
    const champions = ourPlayers(g).map((p) => p.champion);
    if (champions.length !== 5) continue;
    tally(map, [...champions].sort().join("|"), isWin(g), { champions });
  }
  return [...map.values()].filter((c) => c.games >= MIN_GAMES).sort(byWinrate);
}

// Bloc 3 : bans des deux côtés, et champions adverses qui nous battent le plus
function draftStats(games) {
  const ourBans = new Map(), theirBans = new Map(), against = new Map();
  for (const g of games) {
    const win = isWin(g);
    // En flex, on joue contre des inconnus : les bans ne disent rien de notre
    // draft ni de celle qu'on prépare contre nous, on ne les compte pas.
    if (gameType(g) !== "flex") {
      for (const champion of g.draft?.[g.our_side]?.bans || []) tally(ourBans, champion, win, { champion });
      for (const champion of g.draft?.[otherSide(g.our_side)]?.bans || []) tally(theirBans, champion, win, { champion });
    }
    for (const p of sidePlayers(g, otherSide(g.our_side))) tally(against, p.champion, win, { champion: p.champion });
  }
  return {
    ourBans: [...ourBans.values()].sort(byGames),
    theirBans: [...theirBans.values()].sort(byGames),
    // "wins" = NOS victoires : on trie par nombre de défaites contre le champion
    nemesis: [...against.values()]
      .filter((c) => c.games >= MIN_GAMES && c.wins < c.games)
      .sort((a, b) => (b.games - b.wins) - (a.games - a.wins) || a.wins / a.games - b.wins / b.games),
  };
}

// Bloc 4 : stats par joueur. On relie chaque participant de notre côté à
// un joueur de la team grâce à son Riot ID ; ceux qu'on ne reconnaît pas
// (remplaçant sans Riot ID renseigné) apparaissent sous leur pseudo en jeu.
function playerStats(games, players) {
  const byRiotId = new Map();
  for (const player of players) {
    const id = normId(player.riot_id);
    if (id) byRiotId.set(id, player);
  }
  // Un Riot ID enregistré sans "#TAG" est comparé sur le pseudo seul
  const findPlayer = (riotId) => {
    const id = normId(riotId);
    return byRiotId.get(id) || byRiotId.get(id.split("#")[0]) || null;
  };

  const map = new Map();
  for (const g of games) {
    const team = ourPlayers(g);
    const teamDamage = team.reduce((sum, p) => sum + p.damage, 0);
    for (const p of team) {
      const player = findPlayer(p.riot_id);
      const name = (p.riot_id || "Inconnu").split("#")[0];
      const entry = tally(map, player ? `p${player.id}` : `r${normId(p.riot_id)}`, isWin(g), {
        pseudo: player ? player.pseudo : name,
        role: player?.main_role || null,
        linked: Boolean(player),
        kills: 0, deaths: 0, assists: 0, cs: 0, damage: 0, seconds: 0, damageShare: 0,
        champions: new Map(),
      });
      entry.kills += p.kills;
      entry.deaths += p.deaths;
      entry.assists += p.assists;
      entry.cs += p.cs;
      entry.damage += p.damage;
      entry.seconds += g.duration_s;
      entry.damageShare += teamDamage ? p.damage / teamDamage : 0;
      tally(entry.champions, p.champion, isWin(g), { champion: p.champion });
    }
  }

  const roleRank = (entry) => (entry.role ? ROLE_ORDER.indexOf(entry.role) : ROLE_ORDER.length);
  return [...map.values()]
    .map((entry) => ({ ...entry, champions: [...entry.champions.values()].sort(byGames) }))
    // Les joueurs de la team d'abord, du top au support ; puis les autres
    .sort((a, b) => b.linked - a.linked || roleRank(a) - roleRank(b) || b.games - a.games);
}

// Bloc 5 : games regroupées par session (rendez-vous), de la plus récente à
// la plus ancienne. Les games sans rendez-vous sont regroupées par jour.
function sessionList(games) {
  const map = new Map();
  for (const g of games) {
    const start = new Date(g.started_at);
    const key = g.event_id ? `e${g.event_id}` : `d${start.toDateString()}`;
    if (!map.has(key)) {
      const label = TYPE_LABELS[gameType(g)];
      map.set(key, {
        date: start,
        title: g.events
          ? (g.events.opponent ? `${label} contre ${g.events.opponent}` : g.events.title)
          : `${label} hors planning`,
        wins: 0, losses: 0, games: [],
      });
    }
    const session = map.get(key);
    session.games.unshift(g);   // dans l'ordre où elles ont été jouées
    if (isWin(g)) session.wins++; else session.losses++;
  }
  return [...map.values()];
}


// ---------------------------------------------------------------------
// 3. Outils d'affichage
// ---------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

// 0.6 → "60 %"
const pct = (ratio) => `${Math.round(ratio * 100)} %`;

// 3.456 → "3,5"
const decimal = (n) => n.toFixed(1).replace(".", ",");

// 23412 → "23,4k"
const thousands = (n) => `${decimal(n / 1000)}k`;

// 1934 secondes → "32:14"
function duration(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// (kills + assists) / morts ; "Parfait" si aucune mort
function kda(kills, deaths, assists) {
  return deaths ? decimal((kills + assists) / deaths) : "Parfait";
}

// Winrate : une jauge et le pourcentage, toujours avec le nombre de games
// à côté dans le tableau (60 % sur 5 games ne vaut pas 60 % sur 50).
function winrateCell(entry) {
  const ratio = entry.wins / entry.games;
  return el("span", { class: "winrate" },
    el("span", { class: "meter", "aria-hidden": "true" },
      el("span", { class: "meter-fill", style: `width: ${Math.round(ratio * 100)}%` })),
    el("span", { class: "winrate-value", text: pct(ratio) })
  );
}

// Construit un tableau. columns : [{ label, num: true si chiffre, cell: (ligne) => texte ou élément }]
function statTable(columns, rows) {
  const head = el("tr", {}, ...columns.map((c) => el("th", { scope: "col", class: c.num ? "num" : "", text: c.label })));
  const body = rows.map((row) =>
    el("tr", {}, ...columns.map((c) => el("td", { class: c.num ? "num" : "" }, c.cell(row)))));
  return el("div", { class: "table-scroll" },
    el("table", { class: "stat-table" }, el("thead", {}, head), el("tbody", {}, ...body)));
}

// Remplace le contenu d'un bloc par un tableau, ou par un message s'il est vide
function fill(selector, rows, emptyMessage, build) {
  $(selector).replaceChildren(rows.length ? build(rows) : el("p", { class: "stat-empty", text: emptyMessage }));
}

const COL_GAMES = { label: "Games", num: true, cell: (r) => String(r.games) };
const COL_WINRATE = { label: "Winrate", cell: winrateCell };


// ---------------------------------------------------------------------
// 4. Affichage des cinq blocs
// ---------------------------------------------------------------------

function renderFilters() {
  const group = (selector, options, current, onPick) => {
    $(selector).replaceChildren(...options.map(([value, label]) => el("button", {
      type: "button",
      class: "seg",
      role: "radio",
      "aria-checked": String(value === current),
      text: label,
      onclick: () => onPick(value),
    })));
  };
  group("#filter-period", PERIODS, state.period, (value) => { state.period = value; render(); });
  group("#filter-type", GAME_TYPES, state.type, (value) => { state.type = value; render(); });
}

function tile(label, value, detail) {
  return el("div", { class: "tile" },
    el("span", { class: "tile-label", text: label }),
    el("span", { class: "tile-value", text: value }),
    detail ? el("span", { class: "tile-detail", text: detail }) : null
  );
}

function renderSummary(games) {
  const s = summary(games);
  const side = (name) => {
    const { games: n, wins } = s.sides[name];
    return n ? [pct(wins / n), `${wins} V – ${n - wins} D`] : ["–", "aucune game"];
  };

  $("#summary-tiles").replaceChildren(
    el("div", { class: "tile tile-hero" },
      el("span", { class: "tile-label", text: "Winrate" }),
      el("span", { class: "tile-value", text: pct(s.wins / s.games) }),
      el("span", { class: "tile-detail", text: `${s.wins} V – ${s.losses} D sur ${plural(s.games, "game")}` })
    ),
    tile("Côté bleu", ...side("blue")),
    tile("Côté rouge", ...side("red")),
    tile("Durée moyenne", duration(s.avgDuration))
  );

  // Forme : la plus récente à gauche. La lettre porte l'info, pas la couleur seule.
  $("#form").replaceChildren(...s.form.map((g) => {
    const win = isWin(g);
    const when = new Date(g.started_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
    const versus = g.events?.opponent ? ` contre ${g.events.opponent}` : "";
    const label = `${win ? "Victoire" : "Défaite"} le ${when}${versus}`;
    return el("li", { class: `form-chip ${win ? "is-win" : "is-loss"}`, title: label, "aria-label": label, text: win ? "V" : "D" });
  }));
}

function renderChampions(games) {
  fill("#champions", championStats(games).slice(0, 15), "Aucun champion joué.", (rows) => statTable([
    { label: "Champion", cell: (r) => r.champion },
    COL_GAMES,
    COL_WINRATE,
    { label: "KDA", num: true, cell: (r) => kda(r.kills, r.deaths, r.assists) },
  ], rows));

  fill("#duos", duoStats(games).slice(0, 10),
    `Aucun duo joué au moins ${MIN_GAMES} fois pour l'instant.`, (rows) => statTable([
      { label: "Duo", cell: (r) => r.champions.join(" + ") },
      COL_GAMES,
      COL_WINRATE,
    ], rows));

  fill("#comps", compStats(games).slice(0, 10),
    `Aucune compo complète jouée au moins ${MIN_GAMES} fois pour l'instant.`, (rows) => statTable([
      { label: "Compo", cell: (r) => r.champions.join(" · ") },
      COL_GAMES,
      COL_WINRATE,
    ], rows));
}

function renderDraft(games) {
  const d = draftStats(games);
  const banColumns = [{ label: "Champion", cell: (r) => r.champion }, { label: "Bans", num: true, cell: (r) => String(r.games) }];

  const noBans = "Aucun ban relevé en scrim ou en match officiel (les bans de flex ne sont pas comptés).";
  fill("#our-bans", d.ourBans.slice(0, 8), noBans, (rows) => statTable(banColumns, rows));
  fill("#their-bans", d.theirBans.slice(0, 8), noBans, (rows) => statTable(banColumns, rows));
  fill("#nemesis", d.nemesis.slice(0, 8),
    `Aucun champion adverse ne nous a battus sur au moins ${MIN_GAMES} games.`, (rows) => statTable([
      { label: "Champion adverse", cell: (r) => r.champion },
      { label: "Games contre", num: true, cell: (r) => String(r.games) },
      { label: "Défaites", num: true, cell: (r) => String(r.games - r.wins) },
      { label: "Notre winrate", cell: winrateCell },
    ], rows));
}

function renderPlayers(games) {
  fill("#players", playerStats(games, state.players), "Aucun joueur.", (rows) => statTable([
    {
      label: "Joueur",
      cell: (r) => el("span", {},
        el("span", { class: "player-name", text: r.pseudo }),
        el("span", { class: "player-role", text: r.linked ? (ROLE_NAMES[r.role] || "") : "Riot ID non relié" })),
    },
    COL_GAMES,
    COL_WINRATE,
    { label: "KDA", num: true, cell: (r) => kda(r.kills, r.deaths, r.assists) },
    { label: "CS / min", num: true, cell: (r) => decimal(r.cs / (r.seconds / 60)) },
    { label: "Dégâts / min", num: true, cell: (r) => String(Math.round(r.damage / (r.seconds / 60))) },
    { label: "Part des dégâts", num: true, cell: (r) => pct(r.damageShare / r.games) },
    {
      label: "Champions",
      cell: (r) => el("span", { class: "chips" }, ...r.champions.slice(0, 4).map((c) =>
        el("span", { class: "chip", title: `${plural(c.games, "game")}, ${pct(c.wins / c.games)} de victoires`, text: `${c.champion} ${c.games}` }))),
    },
  ], rows));
}

// Détail d'une game : draft des deux côtés, puis tableau des scores
function gameDetail(game, number) {
  const win = isWin(game);
  const sides = [game.our_side, otherSide(game.our_side)];
  const sideName = (side) => `${side === game.our_side ? "Nous" : "Adversaire"} (côté ${side === "blue" ? "bleu" : "rouge"})`;

  const draft = el("dl", { class: "draft" });
  for (const side of sides) {
    const part = game.draft?.[side] || {};
    draft.append(
      el("dt", { text: sideName(side) }),
      el("dd", {},
        part.bans?.length ? el("span", { class: "draft-line", text: `Bans : ${part.bans.join(" · ")}` }) : null,
        el("span", { class: "draft-line", text: `Picks : ${(part.picks || []).join(" · ")}` }))
    );
  }

  const columns = [
    { label: "Champion", cell: (p) => p.champion },
    { label: "Joueur", cell: (p) => (p.riot_id || "").split("#")[0] },
    { label: "K / D / A", num: true, cell: (p) => `${p.kills} / ${p.deaths} / ${p.assists}` },
    { label: "CS", num: true, cell: (p) => String(p.cs) },
    { label: "Dégâts", num: true, cell: (p) => thousands(p.damage) },
    { label: "Or", num: true, cell: (p) => thousands(p.gold) },
  ];
  const boards = sides.map((side) => {
    const team = game.teams?.[side] || {};
    const recap = [plural(team.kills || 0, "kill"), `${thousands(team.gold || 0)} or`, plural(team.towers || 0, "tour"),
      plural(team.dragons || 0, "drake"), plural(team.barons || 0, "baron")].join(" · ");
    return el("div", { class: "scoreboard" },
      el("p", { class: "scoreboard-title" },
        el("strong", { text: sideName(side) }),
        el("span", { text: ` — ${recap}` })),
      statTable(columns, sidePlayers(game, side)));
  });

  return el("article", { class: "game" },
    el("h4", { class: "game-title" },
      el("span", { class: `form-chip ${win ? "is-win" : "is-loss"}`, "aria-hidden": "true", text: win ? "V" : "D" }),
      el("span", { text: `Game ${number} · ${win ? "Victoire" : "Défaite"} · ${duration(game.duration_s)}` })),
    draft,
    ...boards
  );
}

function renderHistory(games) {
  const fmt = { weekday: "short", day: "numeric", month: "short", year: "numeric" };
  $("#history").replaceChildren(...sessionList(games).map((session) => {
    const details = el("details", { class: "session" },
      el("summary", {},
        el("span", { class: "session-date", text: session.date.toLocaleDateString("fr-FR", fmt) }),
        el("span", { class: "session-title", text: session.title }),
        el("span", { class: "session-score", text: `${session.wins} – ${session.losses}` })));
    // Le détail n'est construit qu'à la première ouverture (10 lignes par game)
    details.addEventListener("toggle", () => {
      if (details.open && details.children.length === 1) {
        details.append(...session.games.map((g, i) => gameDetail(g, i + 1)));
      }
    });
    return details;
  }));
}

// Redessine toute la page avec les filtres courants
function render() {
  renderFilters();
  const games = filterGames(state.games, state.period, state.type);

  const empty = games.length === 0;
  $("#stats-empty").hidden = !empty;
  $("#stats-blocks").hidden = empty;
  if (empty) {
    $("#stats-empty").textContent = state.games.length === 0
      ? "Aucune game enregistrée pour l'instant. Les statistiques se rempliront au fil des games récupérées par le companion."
      : "Aucune game ne correspond à ces filtres.";
    return;
  }

  renderSummary(games);
  renderChampions(games);
  renderDraft(games);
  renderPlayers(games);
  renderHistory(games);
}


// ---------------------------------------------------------------------
// 5. Chargement et démarrage
// ---------------------------------------------------------------------

// events(…) et game_participants(…) : Supabase fait les jointures grâce
// aux clés étrangères. Chaque game arrive avec son rendez-vous et ses 10 joueurs.
const GAME_COLUMNS = "id, event_id, started_at, duration_s, is_custom, our_side, winner, draft, teams, "
  + "events(title, type, opponent), "
  + "game_participants(side, slot, riot_id, champion, kills, deaths, assists, cs, gold, damage)";

// Supabase renvoie au plus 1000 lignes par requête : on lit par paquets
async function fetchGames() {
  const PAGE = 500;
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("games")
      .select(GAME_COLUMNS)
      // Sans notre côté ou sans vainqueur, pas de victoire ni de défaite à compter
      .not("our_side", "is", null)
      .not("winner", "is", null)
      .order("started_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < PAGE) return all;
  }
}

async function loadStats() {
  try {
    const [players, games] = await Promise.all([
      db.from("players").select("id, pseudo, riot_id, main_role, status"),
      fetchGames(),
    ]);
    if (players.error) throw new Error(players.error.message);
    state.players = players.data;
    state.games = games;
  } catch (err) {
    return showError(`Impossible de charger les statistiques : ${err.message}`);
  }
  render();
}

startSession(loadStats);
