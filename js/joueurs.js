"use strict";

// =====================================================================
// joueurs.js – page « Joueurs » : classement et soloQ de chaque joueur
//
// Les données viennent de l'API de Riot, mais pas depuis cette page :
// le script scripts/riot_sync.py (lancé toutes les heures par GitHub)
// range le classement et les dernières games soloQ de chaque compte
// dans les tables riot_accounts et soloq_games. Ici, on ne fait que lire.
//
// Organisation du fichier :
//   1. Champions et rangs (noms, icônes)
//   2. Calculs
//   3. Affichage d'un joueur
//   4. Chargement et démarrage
// =====================================================================


// ---------------------------------------------------------------------
// 1. Champions et rangs
// ---------------------------------------------------------------------

const DDRAGON = "https://ddragon.leagueoflegends.com";
const champions = new Map();   // identifiant Riot ("MonkeyKing") → { name, icon }
let ddragonVersion = null;

// Noms français et icônes (Data Dragon, le site d'images officiel de Riot).
// En cas d'échec, la page s'affiche quand même, avec les noms bruts.
async function loadChampions() {
  try {
    const versions = await (await fetch(`${DDRAGON}/api/versions.json`)).json();
    ddragonVersion = versions[0];
    const list = await (await fetch(`${DDRAGON}/cdn/${ddragonVersion}/data/fr_FR/champion.json`)).json();
    for (const c of Object.values(list.data)) {
      champions.set(c.id.toLowerCase(), { name: c.name, icon: `${DDRAGON}/cdn/${ddragonVersion}/img/champion/${c.image.full}` });
    }
  } catch (err) {
    console.warn("Icônes des champions indisponibles :", err);
  }
}

const championOf = (id) => champions.get(String(id).toLowerCase()) || { name: id, icon: null };

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

// "Diamant III · 63 LP", ou "Non classé"
function rankText(tier, division, lp) {
  if (!tier) return "Non classé";
  const name = TIER_NAMES[tier] || tier;
  return `${name}${NO_DIVISION.includes(tier) ? "" : ` ${division}`} · ${lp} LP`;
}

// Champions joués sur des games, du plus joué au moins joué
function recentChampions(games) {
  const map = new Map();
  for (const g of games) {
    const entry = map.get(g.champion) || { champion: g.champion, games: 0, wins: 0 };
    entry.games++;
    if (g.win) entry.wins++;
    map.set(g.champion, entry);
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

// Les dernières games, une par ligne
function gamesList(games) {
  if (!games.length) return el("p", { class: "stat-empty", text: "Aucune game soloQ récente." });
  return el("ul", { class: "soloq-games" }, ...games.map((g) => {
    const c = championOf(g.champion);
    return el("li", { class: "soloq-game", title: `${c.name} · ${g.win ? "victoire" : "défaite"} · ${ago(g.started_at)}` },
      el("span", { class: `form-chip ${g.win ? "is-win" : "is-loss"}`, title: g.win ? "Victoire" : "Défaite", text: g.win ? "V" : "D" }),
      champImg(g.champion, 28),
      el("span", { class: "soloq-champ", text: c.name }),
      el("span", { class: "soloq-kda", text: `${g.kills} / ${g.deaths} / ${g.assists}` }),
      el("span", { class: "soloq-when", text: ago(g.started_at) }));
  }));
}

// Forme récente en une ligne, pour les smurfs
function formRow(games) {
  return el("span", { class: "form" }, ...games.map((g) =>
    el("span", { class: `form-chip ${g.win ? "is-win" : "is-loss"}`, title: `${championOf(g.champion).name} · ${g.win ? "victoire" : "défaite"}`, text: g.win ? "V" : "D" })));
}

function playerCard(player, accounts, gamesByPuuid) {
  const main = accounts.find((a) => a.is_main) || null;
  const smurfs = accounts.filter((a) => !a.is_main);
  const mainGames = main ? (gamesByPuuid.get(main.puuid) || []) : [];
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

  card.append(rankBlock(main));

  const top = recentChampions(mainGames).slice(0, 5);
  if (top.length) {
    card.append(
      el("h3", { class: "stat-subtitle", text: "Champions joués récemment" }),
      el("p", { class: "chips" }, ...top.map((c) =>
        el("span", { class: "chip chip-champ", title: `${championOf(c.champion).name} : ${c.games} game${c.games > 1 ? "s" : ""}, ${pct(c.wins, c.games)} de victoires` },
          champImg(c.champion, 22), el("span", { text: `${c.games} · ${pct(c.wins, c.games)}` })))));
  }

  card.append(
    el("h3", { class: "stat-subtitle", text: "Dernières games soloQ" }),
    gamesList(mainGames.slice(0, 8)));

  if (smurfs.length) {
    card.append(el("details", { class: "smurf-list" },
      el("summary", { text: `Comptes secondaires (${smurfs.length})` }),
      ...smurfs.map((s) => el("div", { class: "smurf-account" },
        el("p", { class: "smurf-name" },
          el("strong", { text: s.game_name ? `${s.game_name}#${s.tag_line}` : s.riot_id }),
          el("span", { text: s.error ? ` · ${s.error}` : ` · ${rankText(s.solo_tier, s.solo_division, s.solo_lp)}` })),
        s.error ? null : formRow((gamesByPuuid.get(s.puuid) || []).slice(0, 10))))));
  }

  card.append(el("p", { class: "player-updated", text: `Mis à jour ${ago(main.updated_at)}` }));
  return card;
}


// ---------------------------------------------------------------------
// 4. Chargement et démarrage
// ---------------------------------------------------------------------

async function loadPlayers() {
  const since = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
  const [players, accounts, games] = await Promise.all([
    db.from("players").select("*"),
    db.from("riot_accounts").select("*"),
    db.from("soloq_games").select("*").gte("started_at", since).order("started_at", { ascending: false }).limit(1000),
    loadChampions(),
  ]);
  for (const res of [players, accounts, games]) {
    if (res.error) return showError(`Impossible de charger les joueurs : ${res.error.message}`);
  }

  const gamesByPuuid = new Map();
  for (const g of games.data) {
    if (!gamesByPuuid.has(g.puuid)) gamesByPuuid.set(g.puuid, []);
    gamesByPuuid.get(g.puuid).push(g);
  }

  // Du top au support, puis ceux sans rôle (le coach en dernier)
  const rank = (p) => (p.status === "coach" ? 99 : ROLE_ORDER.includes(p.main_role) ? ROLE_ORDER.indexOf(p.main_role) : 50);
  const sorted = [...players.data].sort((a, b) => rank(a) - rank(b) || a.pseudo.localeCompare(b.pseudo, "fr"));

  $("#players").replaceChildren(...sorted.map((p) =>
    playerCard(p, accounts.data.filter((a) => a.player_id === p.id), gamesByPuuid)));
  $("#players-empty").hidden = accounts.data.length > 0;
}

startSession(loadPlayers);
