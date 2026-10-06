"""
Classement et games récentes de chaque joueur, pour la page « Joueurs ».

Pour chaque compte LoL des titulaires (compte principal et smurfs, saisis
dans « Mon profil »), le script demande à l'API de Riot :
  * le rang soloQ et flex (palier, division, LP, victoires, défaites) ;
  * les dernières games de soloQ, de flex et de normale (champion,
    résultat, K/D/A, CS), jouées seul, à plusieurs ou en team.
Les scrims et les tournois n'y sont pas : ce sont des parties
personnalisées, absentes de l'historique de Riot (ils sont suivis par
le companion, voir la page Statistiques).

Il range le tout dans Supabase (tables riot_accounts et soloq_games,
voir sql/12_soloq_joueurs.sql et sql/13_games_joueurs_files.sql). La page
Joueurs ne fait que lire ces tables : la clé Riot ne quitte jamais GitHub.

Le script est lancé toutes les heures par GitHub Actions
(.github/workflows/riot.yml). Il n'utilise que la bibliothèque standard
de Python : rien à installer.

Variables d'environnement :
  RIOT_API_KEY          clé de l'API Riot (« RGAPI-… »)          (secret)
  SUPABASE_URL          URL du projet Supabase                   (secret)
  SUPABASE_SERVICE_KEY  clé service_role / secret de Supabase    (secret)
  DRY_RUN               "true" : affiche sans rien enregistrer

Test en local (affiche sans enregistrer) :
  DRY_RUN=true python scripts/riot_sync.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

# Tous les comptes de la team sont sur le serveur EUW
PLATFORM = "https://euw1.api.riotgames.com"       # classement, profil
REGION = "https://europe.api.riotgames.com"       # comptes, historique

# Files suivies : ce que chacun joue de son côté
QUEUES = {
    420: "soloQ",
    440: "flex",
    400: "normale (draft)",
    430: "normale (aveugle)",
    490: "normale (partie rapide)",
}
MATCHES_PER_QUEUE = 10    # games récentes regardées par file, à chaque passage
KEEP_DAYS = 120           # au-delà, les vieilles games sont supprimées

# Une clé personnelle autorise 100 appels par 2 minutes : on espace les
# appels pour rester en dessous, plutôt que de se faire refuser.
MIN_INTERVAL_S = 1.25
_last_call = 0.0


def env(name, required=True):
    value = os.environ.get(name, "").strip()
    if required and not value:
        sys.exit(f"Variable d'environnement manquante : {name}")
    return value


DRY_RUN = env("DRY_RUN", required=False).lower() == "true"


# ---------------------------------------------------------------------
# Riot
# ---------------------------------------------------------------------

def key_refused(error, url):
    """Message clair quand Riot refuse la clé : sa réponse, l'appel concerné, et quoi vérifier."""
    try:
        detail = json.loads(error.read()).get("status", {}).get("message", "")
    except (ValueError, AttributeError):
        detail = ""
    key = env("RIOT_API_KEY")
    endpoint = "/" + url.split("/", 3)[3].split("?")[0]
    hints = []
    if not key.startswith("RGAPI-"):
        hints.append("la clé ne commence pas par « RGAPI- » : le secret RIOT_API_KEY est sans doute mal collé (guillemets, espace, morceau manquant)")
    elif error.code == 401:
        hints.append("Riot ne reconnaît aucune clé dans la demande")
    else:
        hints.append("clé expirée (une clé de développement ne dure que 24 h : voir sa date sur developer.riotgames.com) "
                     "ou clé sans accès à cette partie de l'API")
    # On ne montre jamais la clé elle-même : seulement sa longueur et sa forme
    shape = "commence bien par « RGAPI- »" if key.startswith("RGAPI-") else "ne commence PAS par « RGAPI- »"
    return " ".join([
        f"La clé Riot est refusée ({error.code}{' : ' + detail if detail else ''}) sur {endpoint}.",
        f"Clé utilisée : {len(key)} caractères, {shape} (une clé en fait 42).",
        f"À vérifier : {' ; '.join(hints)}.",
    ])


def riot(url):
    """Appelle l'API de Riot. Renvoie le JSON, ou None si la ressource n'existe pas (404)."""
    global _last_call
    for attempt in range(4):
        wait = MIN_INTERVAL_S - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()

        request = urllib.request.Request(url, headers={"X-Riot-Token": env("RIOT_API_KEY")})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (401, 403):
                sys.exit(key_refused(e, url))
            if e.code == 429:
                # Trop d'appels : Riot indique combien de secondes attendre
                pause = int(e.headers.get("Retry-After", "10")) + 1
                print(f"  Limite d'appels atteinte, pause de {pause} s.")
                time.sleep(pause)
                continue
            if e.code >= 500 and attempt < 3:
                time.sleep(5)
                continue
            raise RuntimeError(f"Riot a répondu {e.code} sur {url.split('?')[0]}") from e
    raise RuntimeError("Riot refuse toujours après plusieurs essais (limite d'appels).")


# ---------------------------------------------------------------------
# Supabase (API REST générée automatiquement par Supabase)
# ---------------------------------------------------------------------

def supabase(method, path, params=None, body=None, prefer=None):
    """La clé service_role contourne les règles RLS : c'est voulu, le
    script écrit dans des tables que les membres ne peuvent que lire."""
    url = f"{env('SUPABASE_URL').rstrip('/')}/rest/v1/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    key = env("SUPABASE_SERVICE_KEY")
    headers = {"apikey": key, "Content-Type": "application/json"}
    # Les anciennes clés (format JWT, commençant par "eyJ") vont aussi dans Authorization
    if key.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {key}"
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read() or "null")
    except urllib.error.HTTPError as e:
        sys.exit(f"Erreur Supabase {e.code} sur {path} : {e.read().decode()}")


def upsert(table, rows, conflict):
    """Ajoute des lignes, ou remplace celles qui existent déjà (même clé)."""
    if not rows:
        return
    if DRY_RUN:
        print(f"[DRY RUN] {table} :")
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return
    supabase("POST", table, {"on_conflict": conflict}, rows, "resolution=merge-duplicates,return=minimal")


# ---------------------------------------------------------------------
# Mise en forme (fonctions pures : aucune connexion)
# ---------------------------------------------------------------------

def split_riot_id(riot_id):
    """'MCU Daylly#MCU' → ('MCU Daylly', 'MCU') ; None sans tag."""
    name, sep, tag = (riot_id or "").strip().rpartition("#")
    return (name.strip(), tag.strip()) if sep and name.strip() and tag.strip() else None


def team_accounts(players):
    """[(player_id, riot_id, is_main)] : compte principal puis smurfs de chaque
    titulaire. Le coach et les remplaçants ne sont pas sur la page Joueurs :
    inutile de dépenser des appels à Riot pour eux."""
    accounts = []
    for p in players:
        if p.get("status") != "titulaire":
            continue
        if (p.get("riot_id") or "").strip():
            accounts.append((p["id"], p["riot_id"].strip(), True))
        for smurf in p.get("smurfs") or []:
            if (smurf or "").strip():
                accounts.append((p["id"], smurf.strip(), False))
    return accounts


def rank_fields(entries):
    """Entrées de classement de Riot → colonnes solo_* et flex_* (None si non classé)."""
    fields = {}
    for prefix, queue in (("solo", "RANKED_SOLO_5x5"), ("flex", "RANKED_FLEX_SR")):
        entry = next((e for e in entries or [] if e.get("queueType") == queue), None)
        fields.update({
            f"{prefix}_tier": entry.get("tier") if entry else None,
            f"{prefix}_division": entry.get("rank") if entry else None,
            f"{prefix}_lp": entry.get("leaguePoints") if entry else None,
            f"{prefix}_wins": entry.get("wins") if entry else None,
            f"{prefix}_losses": entry.get("losses") if entry else None,
        })
    return fields


def game_row(match, puuid, player_id):
    """Une game de l'API Riot → ligne de soloq_games pour ce compte.
    None pour une game annulée (remake), d'une file non suivie, ou si le
    compte n'y est pas."""
    info = match.get("info") or {}
    me = next((p for p in info.get("participants", []) if p.get("puuid") == puuid), None)
    if me is None or me.get("gameEndedInEarlySurrender") or info.get("queueId") not in QUEUES:
        return None
    started = info.get("gameStartTimestamp") or info.get("gameCreation") or 0
    return {
        "match_id": match["metadata"]["matchId"],
        "puuid": puuid,
        "player_id": player_id,
        "started_at": datetime.fromtimestamp(started / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "duration_s": int(info.get("gameDuration") or 0),
        "champion": me.get("championName") or str(me.get("championId")),
        "champion_id": me.get("championId"),
        "queue_id": info.get("queueId"),
        "position": me.get("teamPosition") or None,
        "win": bool(me.get("win")),
        "kills": me.get("kills", 0),
        "deaths": me.get("deaths", 0),
        "assists": me.get("assists", 0),
        "cs": me.get("totalMinionsKilled", 0) + me.get("neutralMinionsKilled", 0),
    }


# ---------------------------------------------------------------------
# Synchronisation
# ---------------------------------------------------------------------

def sync_account(player_id, riot_id, is_main):
    """Met à jour un compte : son rang, puis ses nouvelles games (soloQ, flex, normales)."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    row = {"player_id": player_id, "riot_id": riot_id, "is_main": is_main, "updated_at": now, "error": None}

    parts = split_riot_id(riot_id)
    account = None
    if parts:
        quoted = "/".join(urllib.parse.quote(part, safe="") for part in parts)
        account = riot(f"{REGION}/riot/account/v1/accounts/by-riot-id/{quoted}")
    if not account:
        # On garde la ligne, avec l'erreur : la page l'affiche au joueur concerné
        row["error"] = "Compte introuvable chez Riot : vérifie le Riot ID (Pseudo#TAG) dans « Mon profil »."
        upsert("riot_accounts", [row], "player_id,riot_id")
        print(f"  {riot_id} : introuvable chez Riot.")
        return

    puuid = account["puuid"]
    summoner = riot(f"{PLATFORM}/lol/summoner/v4/summoners/by-puuid/{puuid}") or {}
    entries = riot(f"{PLATFORM}/lol/league/v4/entries/by-puuid/{puuid}") or []
    row.update({
        "puuid": puuid,
        "game_name": account.get("gameName"),
        "tag_line": account.get("tagLine"),
        "profile_icon": summoner.get("profileIconId"),
        "level": summoner.get("summonerLevel"),
        **rank_fields(entries),
    })
    upsert("riot_accounts", [row], "player_id,riot_id")

    # Dernières games de chaque file suivie ; on ne redemande pas celles qu'on connaît déjà
    match_ids = []
    for queue in QUEUES:
        query = urllib.parse.urlencode({"queue": queue, "start": 0, "count": MATCHES_PER_QUEUE})
        match_ids += riot(f"{REGION}/lol/match/v5/matches/by-puuid/{puuid}/ids?{query}") or []
    match_ids = list(dict.fromkeys(match_ids))   # sans doublon, dans l'ordre
    known = set()
    if match_ids and not DRY_RUN:
        known = {g["match_id"] for g in supabase("GET", "soloq_games", {
            "select": "match_id", "puuid": f"eq.{puuid}", "match_id": f"in.({','.join(match_ids)})"})}
    games = []
    for match_id in match_ids:
        if match_id in known:
            continue
        match = riot(f"{REGION}/lol/match/v5/matches/{match_id}")
        game = game_row(match, puuid, player_id) if match else None
        if game:
            games.append(game)
    upsert("soloq_games", games, "match_id,puuid")

    rank = f"{row['solo_tier']} {row['solo_division']} {row['solo_lp']} LP" if row["solo_tier"] else "non classé"
    print(f"  {riot_id} : {rank}, {len(games)} nouvelle(s) game(s).")


def main():
    players = supabase("GET", "players", {"select": "id,pseudo,status,riot_id,smurfs", "order": "pseudo"})
    accounts = team_accounts(players)
    print(f"{len(accounts)} compte(s) à mettre à jour" + (" (dry run : rien n'est enregistré)" if DRY_RUN else ""))

    failures = 0
    for player_id, riot_id, is_main in accounts:
        try:
            sync_account(player_id, riot_id, is_main)
        except (RuntimeError, KeyError, ValueError, urllib.error.URLError) as e:
            # Un compte en échec ne doit pas empêcher les autres
            failures += 1
            print(f"  {riot_id} : échec ({e}).")

    if not DRY_RUN:
        # Comptes retirés d'un profil depuis le dernier passage : on enlève leur ligne
        current = {(player_id, riot_id) for player_id, riot_id, _ in accounts}
        for old in supabase("GET", "riot_accounts", {"select": "player_id,riot_id"}):
            if (old["player_id"], old["riot_id"]) not in current:
                supabase("DELETE", "riot_accounts",
                         {"player_id": f"eq.{old['player_id']}", "riot_id": f"eq.{old['riot_id']}"})
                print(f"  {old['riot_id']} : retiré (plus dans le profil).")
        # Vieilles games
        limit = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
        supabase("DELETE", "soloq_games", {"started_at": f"lt.{limit}"})

    if failures:
        sys.exit(f"{failures} compte(s) en échec.")
    print("Terminé.")


if __name__ == "__main__":
    main()
