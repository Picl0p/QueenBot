"""
Companion LCU de la team Queen's Gambit.

Il tourne sur l'ordinateur de la personne qui récupère les games, à côté
du client League of Legends. Installation (une seule fois) :

    Windows : double-clic sur installer_companion.bat (dossier scripts)
    Mac     : python3 scripts/lcu_companion.py --install

Il démarre ensuite tout seul à l'ouverture de la session, reste en
arrière-plan, et se réveille dès que le client LoL est ouvert : il n'y a
plus à y penser. Ce qu'il fait est écrit dans le fichier .queenbot.log
de ton dossier personnel.

Il lit les données du client LoL local (l'API "LCU"), ce qui permet de
récupérer AUSSI les games personnalisées (scrims, matchs en code tournoi),
que l'API publique de Riot ne donne pas.

Ce qu'il fait, tout seul, tant que le client est ouvert :
  1. pendant le champ select, il relève la draft (bans et picks, dans l'ordre) ;
  2. à la fin de la game, il récupère le résultat et les stats des 10 joueurs ;
  3. il enregistre le tout dans Supabase (tables games et game_participants) ;
  4. il annonce le résultat dans le post Discord de la session en cours.

Seules sont envoyées les games perso et les flex, en 5v5 sur la Faille,
où au moins 4 joueurs de la team sont dans la même équipe (d'après les
colonne riot_id de la table players, "Pseudo#TAG"). Le reste (soloQ,
ARAM, flex avec d'autres amis…) ne sort jamais de l'ordinateur.

À chaque ouverture du client, il rattrape les games des dernières 24h
qu'il aurait manquées (la draft est alors donnée sans l'ordre des picks).
Une game n'est jamais enregistrée ni annoncée deux fois.

Il n'utilise que la bibliothèque standard de Python : rien à installer.

Réglages :
  * le jeton de la team est demandé au premier lancement, puis gardé dans
    le fichier .queenbot.json de ton dossier personnel (il se lit dans
    Supabase, voir sql/05_sessions_discord_games.sql, section 5) ;
  * l'adresse Supabase est lue dans js/config.js.
  Variables d'environnement possibles à la place : QUEENBOT_TOKEN,
  SUPABASE_URL, SUPABASE_ANON_KEY.
  Si LoL est installé à un endroit inhabituel, --install demande son dossier.

Options :
  --install     lancement automatique à l'ouverture de session
  --uninstall   retire le lancement automatique
  --dry-run     n'envoie rien : affiche ce qui serait envoyé
  --game ID     (ré)envoie une game précise, puis s'arrête
Sans option : tourne dans le terminal (pratique pour voir ce qui se passe).
"""

import argparse
import base64
import json
import os
import plistlib
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

TEAM_NAME = "Queen's Gambit"

POLL_SECONDS = 3            # fréquence de lecture de l'état du client
RETRY_SECONDS = 10          # entre deux essais de récupération d'une game finie
GIVE_UP_SECONDS = 20 * 60   # on abandonne si les stats n'arrivent jamais
CATCH_UP_HOURS = 24         # au lancement, on rattrape les games récentes
MIN_DURATION_S = 5 * 60     # en dessous : remake ou game annulée, on ignore

FLEX_QUEUES = {440}         # files classées envoyées en plus des games perso
MIN_TEAM_PLAYERS = 4        # joueurs de la team dans la même équipe pour garder la game
SUMMONERS_RIFT = 11

# Phases du client pendant lesquelles la game est en cours
IN_GAME_PHASES = {"GameStart", "InProgress", "Reconnect"}

CONFIG_FILE = Path.home() / ".queenbot.json"
SITE_CONFIG = Path(__file__).resolve().parent.parent / "js" / "config.js"
LOG_FILE = Path.home() / ".queenbot.log"

# Écrit par le companion d'arrière-plan : son numéro de processus. S'il y
# lit autre chose, c'est qu'un autre a pris le relais (ou qu'on l'a
# désinstallé) : il s'arrête. Jamais deux companions en même temps.
PID_FILE = Path.home() / ".queenbot.pid"

# Lancement automatique sous Windows : un petit fichier dans le dossier
# "Démarrage", que Windows exécute à l'ouverture de session.
STARTUP_VBS = (Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu"
               / "Programs" / "Startup" / "QueenBot companion.vbs")

# Lancement automatique sur Mac : un "LaunchAgent", c'est-à-dire un petit
# fichier qui demande à macOS de démarrer le script à l'ouverture de session.
LAUNCH_LABEL = "gg.queensgambit.companion"
LAUNCH_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCH_LABEL}.plist"

# Emplacements habituels du fichier "lockfile" (écrit par le client LoL
# quand il est ouvert : il contient le port et le mot de passe de l'API locale)
LOCKFILE_PATHS = [
    r"C:\Riot Games\League of Legends\lockfile",
    r"D:\Riot Games\League of Legends\lockfile",
    r"E:\Riot Games\League of Legends\lockfile",
    "/Applications/League of Legends.app/Contents/LoL/lockfile",
]

SIDES = {100: "blue", 200: "red"}
OTHER_SIDE = {"blue": "red", "red": "blue"}
SIDE_ICON = {"blue": "🔵", "red": "🔴"}

COLOR_WIN, COLOR_LOSS, COLOR_NEUTRAL = 0x57F287, 0xED4245, 0xE3B65F


class LcuGone(Exception):
    """Le client LoL ne répond plus (il a été fermé)."""


# ---------------------------------------------------------------------
# Réglages (jeton, adresse Supabase)
# ---------------------------------------------------------------------

def load_settings(need_token=True, interactive=True):
    saved = {}
    if CONFIG_FILE.exists():
        try:
            saved = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            saved = {}

    # Adresse et clé publique du site : mêmes valeurs que js/config.js
    site = {}
    if SITE_CONFIG.exists():
        text = SITE_CONFIG.read_text(encoding="utf-8")
        for name in ("SUPABASE_URL", "SUPABASE_ANON_KEY"):
            match = re.search(rf'const {name}\s*=\s*"([^"]+)"', text)
            if match:
                site[name] = match.group(1)

    settings = {
        "url": os.environ.get("SUPABASE_URL") or saved.get("supabase_url") or site.get("SUPABASE_URL"),
        "key": os.environ.get("SUPABASE_ANON_KEY") or saved.get("supabase_anon_key") or site.get("SUPABASE_ANON_KEY"),
        "token": os.environ.get("QUEENBOT_TOKEN") or saved.get("token"),
    }
    # LoL installé à un endroit inhabituel (demandé par --install)
    if saved.get("lockfile"):
        LOCKFILE_PATHS.insert(0, saved["lockfile"])
    if not settings["url"] or not settings["key"]:
        sys.exit("Adresse Supabase introuvable : lance le script depuis le dossier du site "
                 "(il lit js/config.js), ou définis SUPABASE_URL et SUPABASE_ANON_KEY.")

    if need_token and not settings["token"]:
        if not interactive:
            sys.exit("Pas de jeton enregistré : relance l'installation (--install).")
        print("Premier lancement : colle le jeton de la team (demande-le à un admin).")
        settings["token"] = input("Jeton : ").strip()
        if not settings["token"]:
            sys.exit("Pas de jeton : arrêt.")
        saved["token"] = settings["token"]
        CONFIG_FILE.write_text(json.dumps(saved, indent=2), encoding="utf-8")
        print(f"Jeton enregistré dans {CONFIG_FILE}\n")
    return settings


# ---------------------------------------------------------------------
# Client LoL (API locale "LCU")
# ---------------------------------------------------------------------

def find_lcu_credentials(scan_processes=True):
    """Renvoie (port, mot de passe) du client LoL ouvert, ou None."""
    for path in LOCKFILE_PATHS:
        try:
            # Contenu : "LeagueClient:pid:port:motdepasse:https"
            parts = Path(path).read_text(encoding="utf-8").strip().split(":")
            return int(parts[2]), parts[3]
        except (OSError, IndexError, ValueError):
            continue

    # LoL installé ailleurs : le port et le mot de passe sont aussi dans
    # la ligne de commande du processus du client.
    if not scan_processes:
        return None
    try:
        if sys.platform == "win32":
            command = ["powershell", "-NoProfile", "-Command",
                       "(Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\").CommandLine"]
        else:
            command = ["ps", "-A", "-o", "command"]
        output = subprocess.run(command, capture_output=True, text=True, timeout=15,
                                # Windows : pas de fenêtre noire qui clignote en arrière-plan
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except (OSError, subprocess.SubprocessError):
        return None

    for line in output.splitlines():
        if "LeagueClientUx" not in line:
            continue
        port = re.search(r"--app-port=(\d+)", line)
        password = re.search(r"--remoting-auth-token=([\w-]+)", line)
        if port and password:
            return int(port.group(1)), password.group(1)
    return None


class Lcu:
    def __init__(self, port, password):
        self.base = f"https://127.0.0.1:{port}"
        auth = base64.b64encode(f"riot:{password}".encode()).decode()
        self.headers = {"Authorization": f"Basic {auth}", "Accept": "application/json"}
        # Le client utilise un certificat maison de Riot, inconnu de Python.
        # On ne le vérifie pas : la connexion ne sort pas de la machine.
        self.ssl = ssl.create_default_context()
        self.ssl.check_hostname = False
        self.ssl.verify_mode = ssl.CERT_NONE

    def get(self, path):
        """JSON renvoyé par le client, ou None si la ressource n'existe pas (encore)."""
        request = urllib.request.Request(self.base + path, headers=self.headers)
        try:
            with urllib.request.urlopen(request, timeout=10, context=self.ssl) as response:
                return json.loads(response.read() or "null")
        except urllib.error.HTTPError:
            return None          # 404 : pas de champ select en cours, game pas encore dispo…
        except ValueError:
            return None
        except OSError as e:     # connexion refusée, délai dépassé : client fermé
            raise LcuGone(str(e)) from e


def stop_if_replaced(background):
    """En arrière-plan : s'arrête si un autre companion a pris le relais."""
    if not background:
        return
    try:
        owner = PID_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        owner = ""
    if owner != str(os.getpid()):
        print("Un autre companion a pris le relais (ou désinstallation) : arrêt.")
        sys.exit(0)


def wait_for_client(background=False):
    announced = False
    attempt = 0
    while True:
        # Le fichier lockfile est regardé toutes les 5 s (ça ne coûte rien) ;
        # la liste des processus, plus lourde, seulement toutes les 30 s.
        credentials = find_lcu_credentials(scan_processes=attempt % 6 == 0)
        attempt += 1
        if credentials:
            lcu = Lcu(*credentials)
            try:
                if lcu.get("/lol-summoner/v1/current-summoner"):
                    return lcu
            except LcuGone:
                pass
        if not announced:
            print("En attente du client League of Legends… (ouvre-le et connecte-toi)")
            announced = True
        time.sleep(5)
        stop_if_replaced(background)


# ---------------------------------------------------------------------
# Mise en forme d'une game (fonctions pures : aucune connexion)
# ---------------------------------------------------------------------

def riot_id(player):
    name = player.get("gameName") or player.get("summonerName") or ""
    tag = player.get("tagLine") or ""
    return f"{name}#{tag}" if name and tag else name


def is_wanted(game):
    """Game en 5v5 sur la Faille, perso ou flex ?"""
    custom = game.get("gameType") == "CUSTOM_GAME"
    return (game.get("mapId") == SUMMONERS_RIFT
            and game.get("gameMode") == "CLASSIC"
            and (custom or game.get("queueId") in FLEX_QUEUES))


def draft_from_champ_select(session, champion_side, me_side, champions):
    """Draft dans l'ordre, d'après le dernier état du champ select.

    champion_side : {id du champion: "blue"/"red"} d'après la game jouée.
    me_side : côté du compte connecté au client (None s'il était spectateur).
    Renvoie None si ce champ select n'est pas celui de cette game."""
    if not session:
        return None

    my_cells = {p.get("cellId") for p in session.get("myTeam", [])}

    def cell_side(cell):
        if me_side:
            return me_side if cell in my_cells else OTHER_SIDE[me_side]
        return "blue" if cell is not None and cell < 5 else "red"   # cases 0 à 4 : côté bleu

    order = []
    for group in session.get("actions", []):
        for action in group:
            champion = action.get("championId")
            if not action.get("completed") or not champion or action.get("type") not in ("ban", "pick"):
                continue
            if action["type"] == "pick":
                side = champion_side.get(champion)
                if side is None:
                    return None   # champion pické mais pas joué : ce n'est pas la bonne game
            else:
                side = cell_side(action.get("actorCellId"))
            order.append({"type": action["type"], "side": side,
                          "champion": champions.get(champion, str(champion))})

    if sum(1 for a in order if a["type"] == "pick") != len(champion_side):
        return None   # champ select incomplet (script lancé en cours de draft)

    draft = {"source": "champ_select", "order": order}
    for side in ("blue", "red"):
        draft[side] = {
            "bans": [a["champion"] for a in order if a["side"] == side and a["type"] == "ban"],
            "picks": [a["champion"] for a in order if a["side"] == side and a["type"] == "pick"],
        }
    return draft


def norm_id(riot_id):
    """'Queen Isa#EUW' → 'queenisa#euw' : majuscules et espaces ne comptent pas."""
    return re.sub(r"\s+", "", riot_id or "").lower()


def team_side(participants, team_ids):
    """Côté où jouent au moins MIN_TEAM_PLAYERS joueurs de la team, ou None."""
    def in_team(riot_id):
        # Un Riot ID enregistré sans "#TAG" est comparé sur le pseudo seul
        full = norm_id(riot_id)
        return bool(full) and (full in team_ids or full.split("#")[0] in team_ids)

    for side in ("blue", "red"):
        present = sum(1 for p in participants if p["side"] == side and in_team(p["riot_id"]))
        if present >= MIN_TEAM_PLAYERS:
            return side
    return None


def normalise_game(game, champions, me, champ_select=None, team_ids=None):
    """Réponse brute du client → game au format attendu par la base (ingest_game).

    team_ids : Riot ID de la team (déjà passés par norm_id). "our_side" est
    alors le côté où ils sont au moins 4, ou None : la game n'est pas pour nous.
    Sans cette liste (dry run), on prend le côté du compte connecté."""
    identities = {i.get("participantId"): i.get("player") or {}
                  for i in game.get("participantIdentities", [])}

    participants, slots = [], {"blue": 0, "red": 0}
    me_side = winner = None
    champion_side = {}

    for p in game.get("participants", []):
        side = SIDES.get(p.get("teamId"))
        if side is None:
            continue
        stats = p.get("stats") or {}
        player = identities.get(p.get("participantId"), {})

        if stats.get("win"):
            winner = side
        if (me.get("puuid") and player.get("puuid") == me["puuid"]) or \
           (me.get("summonerId") and player.get("summonerId") == me["summonerId"]):
            me_side = side

        champion_id = p.get("championId")
        champion_side[champion_id] = side
        participants.append({
            "side": side,
            "slot": slots[side],
            "riot_id": riot_id(player) or None,
            "puuid": player.get("puuid") or None,
            "champion_id": champion_id,
            "champion": champions.get(champion_id, str(champion_id)),
            "kills": stats.get("kills", 0),
            "deaths": stats.get("deaths", 0),
            "assists": stats.get("assists", 0),
            "cs": stats.get("totalMinionsKilled", 0) + stats.get("neutralMinionsKilled", 0),
            "gold": stats.get("goldEarned", 0),
            "damage": stats.get("totalDamageDealtToChampions", 0),
            "vision_score": stats.get("visionScore", 0),
            "level": stats.get("champLevel", 0),
        })
        slots[side] += 1

    our_side = me_side if team_ids is None else team_side(participants, team_ids)

    # Objectifs par équipe
    teams = {}
    for team in game.get("teams", []):
        side = SIDES.get(team.get("teamId"))
        if side is None:
            continue
        members = [p for p in participants if p["side"] == side]
        teams[side] = {
            "kills": sum(p["kills"] for p in members),
            "gold": sum(p["gold"] for p in members),
            "towers": team.get("towerKills", 0),
            "dragons": team.get("dragonKills", 0),
            "barons": team.get("baronKills", 0),
            "heralds": team.get("riftHeraldKills", 0),
            "inhibitors": team.get("inhibitorKills", 0),
        }
        if winner is None and str(team.get("win")).lower() in ("win", "true"):
            winner = side

    # Draft : dans l'ordre si on a vu le champ select ; sinon bans et picks
    # tels que la game les donne (bans dans l'ordre, picks dans l'ordre de l'équipe).
    draft = draft_from_champ_select(champ_select, champion_side, me_side, champions)
    if draft is None:
        draft = {"source": "match"}
        for team in game.get("teams", []):
            side = SIDES.get(team.get("teamId"))
            if side is None:
                continue
            bans = sorted(team.get("bans") or [], key=lambda b: b.get("pickTurn", 0))
            draft[side] = {
                "bans": [champions.get(b.get("championId"), str(b.get("championId")))
                         for b in bans if (b.get("championId") or -1) > 0],
                "picks": [p["champion"] for p in participants if p["side"] == side],
            }

    started = datetime.fromtimestamp(game.get("gameCreation", 0) / 1000, tz=timezone.utc)
    return {
        "riot_game_id": game.get("gameId"),
        "started_at": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "duration_s": game.get("gameDuration", 0),
        "game_version": game.get("gameVersion"),
        "queue_id": game.get("queueId"),
        "is_custom": game.get("gameType") == "CUSTOM_GAME",
        "our_side": our_side,
        "winner": winner,
        "draft": draft,
        "teams": teams,
        "participants": participants,
        "raw": game,
        "reported_by": riot_id(me) or None,
    }


def is_complete(game):
    """Les stats sont-elles arrivées ? (juste après la game, elles peuvent manquer)"""
    participants = game.get("participants") or []
    return len(participants) == 10 and all(p.get("stats") for p in participants)


def short_number(n):
    """23412 → '23.4k'"""
    return f"{n / 1000:.1f}k"


def plural(n, word):
    return f"{n} {word}{'s' if n > 1 else ''}"


def md_escape(text):
    """Neutralise la mise en forme Discord (un pseudo "xX_Dark_Xx" passerait en italique)."""
    return re.sub(r"([\\*_~`|>\[\]])", r"\\\1", str(text))


def build_result_message(game, info):
    """Message Discord annonçant le résultat d'une game.

    game : game normalisée ; info : réponse de ingest_game (numéro de la
    game dans la session, score de la série, adversaire…)."""
    number = info.get("game_number") or 1
    our_side = info.get("our_side") or game["our_side"]
    winner = game["winner"]
    draft = info.get("draft") or game["draft"]
    opponent = (info.get("event") or {}).get("opponent") or "Adversaires"

    if our_side:
        names = {our_side: TEAM_NAME, OTHER_SIDE[our_side]: opponent}
        won = winner == our_side
        title = f"Game {number} : {'victoire ✅' if won else 'défaite ❌'}"
        color = COLOR_WIN if won else COLOR_LOSS
    else:
        # Côté inconnu (dry run lancé depuis un compte qui ne jouait pas)
        names = {"blue": "Côté bleu", "red": "Côté rouge"}
        title = f"Game {number} : victoire du côté {'bleu' if winner == 'blue' else 'rouge'}"
        color = COLOR_NEUTRAL

    minutes, seconds = divmod(game["duration_s"], 60)
    description = f"⏱️ {minutes}:{seconds:02d}"
    if game.get("game_version"):
        description += " · patch " + ".".join(game["game_version"].split(".")[:2])
    if our_side and (info.get("wins") or info.get("losses")):
        description += f"\nSérie : **{info.get('wins', 0)} – {info.get('losses', 0)}**"

    draft_lines = []
    for side in ("blue", "red"):
        part = draft.get(side) or {}
        if part.get("bans"):
            draft_lines.append(f"{SIDE_ICON[side]} Bans : {' · '.join(part['bans'])}")
        draft_lines.append(f"{SIDE_ICON[side]} Picks : {' · '.join(part.get('picks', []))}")
    in_order = draft.get("source") == "champ_select"
    fields = [{
        "name": "📋 Draft" + ("" if in_order else " (ordre des picks non relevé)"),
        "value": "\n".join(draft_lines)[:1024],
        "inline": False,
    }]

    for side in ("blue", "red"):
        team = game["teams"].get(side, {})
        summary = [plural(team.get("kills", 0), "kill"), f"{short_number(team.get('gold', 0))} or",
                   plural(team.get("towers", 0), "tour"), plural(team.get("dragons", 0), "drake"),
                   plural(team.get("barons", 0), "baron")]
        lines = []
        for p in game["participants"]:
            if p["side"] != side:
                continue
            who = f" · {md_escape(p['riot_id'].split('#')[0])}" if p["riot_id"] else ""
            lines.append(f"**{p['champion']}**{who} : {p['kills']}/{p['deaths']}/{p['assists']}"
                         f" · {p['cs']} CS · {short_number(p['damage'])} dégâts")
        fields.append({
            "name": f"{SIDE_ICON[side]} {names[side]}{' 🏆' if side == winner else ''} : {' · '.join(summary)}"[:256],
            "value": "\n".join(lines)[:1024] or "–",
            "inline": False,
        })

    return {
        "username": TEAM_NAME,
        "embeds": [{"title": title, "description": description, "color": color, "fields": fields}],
        "allowed_mentions": {"parse": []},
    }


# ---------------------------------------------------------------------
# Supabase et Discord
# ---------------------------------------------------------------------

def post_json(url, body, headers=None):
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read() or "null")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"erreur {e.code} : {e.read().decode(errors='replace')}") from e
    except urllib.error.URLError as e:
        hint = ""
        if "CERTIFICATE_VERIFY_FAILED" in str(e) and sys.platform == "darwin":
            hint = (" (sur Mac : lance une fois « Install Certificates.command », "
                    "dans le dossier Python de tes Applications)")
        raise RuntimeError(f"connexion impossible : {e.reason}{hint}") from e


def supabase_rpc(settings, function, body):
    headers = {"apikey": settings["key"]}
    # Les anciennes clés (format JWT, commençant par "eyJ") doivent aussi
    # être passées en Authorization ; les nouvelles clés "sb_publishable_..." non.
    if settings["key"].startswith("eyJ"):
        headers["Authorization"] = f"Bearer {settings['key']}"
    return post_json(f"{settings['url'].rstrip('/')}/rest/v1/rpc/{function}", body, headers)


def send_game(settings, game, dry_run=False):
    """Enregistre la game, puis l'annonce sur Discord si la base le demande."""
    label = f"Game {game['riot_game_id']}"

    if dry_run:
        print(f"[DRY RUN] {label} : ce qui serait enregistré (sans les données brutes) :")
        print(json.dumps({k: v for k, v in game.items() if k != "raw"}, indent=2, ensure_ascii=False))
        print("[DRY RUN] Message Discord :")
        print(json.dumps(build_result_message(game, {}), indent=2, ensure_ascii=False))
        return

    info = supabase_rpc(settings, "ingest_game", {"p_token": settings["token"], "p_game": game})
    event = info.get("event")
    where = f"rattachée à « {event['title']} »" if event else "sans rendez-vous correspondant"
    print(f"{label} {'enregistrée' if info.get('created') else 'déjà enregistrée'}, {where}.")

    if not info.get("notify"):
        if event and not event.get("thread_id"):
            print("  Pas d'annonce : ce rendez-vous n'a pas de post Discord.")
        return

    webhook = info["webhook_url"].strip().split("?")[0].rstrip("/")
    query = urllib.parse.urlencode({"wait": "true", "thread_id": event["thread_id"]})
    message = post_json(f"{webhook}?{query}", build_result_message(game, info),
                        # Discord refuse les requêtes avec l'User-Agent Python par défaut
                        {"User-Agent": "QueensGambitCompanion (lcu, 1.0)"})
    supabase_rpc(settings, "mark_game_notified", {
        "p_token": settings["token"],
        "p_riot_game_id": game["riot_game_id"],
        "p_message_id": message["id"],
    })
    print("  Résultat annoncé dans le post Discord.")


# ---------------------------------------------------------------------
# Boucle principale
# ---------------------------------------------------------------------

class Companion:
    def __init__(self, lcu, settings, dry_run):
        self.lcu = lcu
        self.settings = settings
        self.dry_run = dry_run
        self.me = lcu.get("/lol-summoner/v1/current-summoner") or {}
        # Noms des champions, dans la langue du client : {id: nom}
        summary = lcu.get("/lol-game-data/assets/v1/champion-summary.json") or []
        self.champions = {c["id"]: c["name"] for c in summary if c.get("id", -1) > 0}

        self.champ_select = None   # dernier état vu du champ select en cours
        self.drafts = {}           # id de game → champ select correspondant
        self.pending = {}          # id de game → {"since", "next"} : games finies à récupérer
        self.done = set()          # games déjà traitées depuis le lancement
        self.phase = None

    def process(self, game_id):
        """Récupère une game finie et l'envoie. Renvoie False s'il faut réessayer plus tard."""
        game = self.lcu.get(f"/lol-match-history/v1/games/{game_id}")
        if not game or not is_complete(game):
            return False

        self.done.add(game_id)
        if not is_wanted(game):
            print(f"Game {game_id} ignorée (ni perso ni flex en 5v5 sur la Faille).")
        elif game.get("gameDuration", 0) < MIN_DURATION_S:
            print(f"Game {game_id} ignorée (moins de {MIN_DURATION_S // 60} minutes).")
        else:
            try:
                team_ids = self.team_ids()
                normalised = normalise_game(game, self.champions, self.me,
                                            self.drafts.get(game_id), team_ids)
                if team_ids is not None and not team_ids:
                    print(f"Game {game_id} ignorée : aucun Riot ID renseigné pour la team "
                          f"(colonne riot_id de la table players). Ensuite : --game {game_id}")
                elif team_ids is not None and normalised["our_side"] is None:
                    print(f"Game {game_id} ignorée (moins de {MIN_TEAM_PLAYERS} joueurs de la team "
                          f"dans la même équipe).")
                else:
                    send_game(self.settings, normalised, self.dry_run)
            except RuntimeError as e:
                print(f"Game {game_id} : envoi impossible ({e}).")
                if "Jeton du companion invalide" in str(e):
                    sys.exit(f"Le jeton est refusé. Supprime {CONFIG_FILE} puis relance pour en saisir un nouveau.")
                self.done.discard(game_id)
                return False
        self.drafts.pop(game_id, None)
        return True

    def team_ids(self):
        """Riot ID de la team, relus à chaque game (la liste peut changer).
        None en dry run sans jeton : on ne peut pas filtrer."""
        if not self.settings.get("token"):
            print("  (pas de jeton : le filtre « 4 joueurs de la team » n'est pas appliqué)")
            return None
        ids = supabase_rpc(self.settings, "team_riot_ids", {"p_token": self.settings["token"]})
        return {norm_id(i) for i in ids or []}

    def catch_up(self):
        """Au lancement : envoie les games récentes qui auraient été manquées."""
        history = self.lcu.get("/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=19")
        games = ((history or {}).get("games") or {}).get("games") or []
        limit = datetime.now(timezone.utc) - timedelta(hours=CATCH_UP_HOURS)
        for game in sorted(games, key=lambda g: g.get("gameCreation", 0)):
            created = datetime.fromtimestamp(game.get("gameCreation", 0) / 1000, tz=timezone.utc)
            if created >= limit and is_wanted(game) and game.get("gameId") not in self.done:
                self.process(game["gameId"])

    def tick(self):
        phase = self.lcu.get("/lol-gameflow/v1/gameflow-phase")
        if phase != self.phase:
            self.phase = phase
            print(f"[{datetime.now():%H:%M}] {phase}")

        if phase == "ChampSelect":
            session = self.lcu.get("/lol-champ-select/v1/session")
            if session:
                self.champ_select = session

        elif phase in IN_GAME_PHASES:
            session = self.lcu.get("/lol-gameflow/v1/session") or {}
            game_id = (session.get("gameData") or {}).get("gameId")
            if game_id and game_id not in self.pending and game_id not in self.done:
                self.pending[game_id] = {"since": None, "next": 0}
                if self.champ_select:
                    self.drafts[game_id] = self.champ_select
                    self.champ_select = None
                print(f"Game {game_id} en cours, je récupère les stats dès qu'elle se termine.")

        else:
            # Game terminée (ou client au repos) : on récupère ce qui attend
            now = time.time()
            for game_id, wait in list(self.pending.items()):
                wait["since"] = wait["since"] or now
                if now < wait["next"]:
                    continue
                if self.process(game_id):
                    del self.pending[game_id]
                elif now - wait["since"] > GIVE_UP_SECONDS:
                    print(f"Game {game_id} : stats introuvables, j'abandonne. "
                          f"Tu peux réessayer avec : --game {game_id}")
                    del self.pending[game_id]
                else:
                    wait["next"] = now + RETRY_SECONDS


# ---------------------------------------------------------------------
# Lancement automatique à l'ouverture de session
# ---------------------------------------------------------------------

def background_command():
    """Commande qui lance ce script en arrière-plan, avec le même Python."""
    python = Path(sys.executable)
    if sys.platform == "win32":
        # pythonw.exe : le Python "sans fenêtre", livré à côté de python.exe
        windowless = python.with_name("pythonw.exe")
        python = windowless if windowless.exists() else python
    return [str(python), str(Path(__file__).resolve()), "--background"]


def startup_vbs():
    """Contenu du fichier de démarrage Windows : lance le companion sans fenêtre."""
    command = " ".join(f'""{part}""' if " " in part or "\\" in part else part
                       for part in background_command())
    # 0 = fenêtre cachée ; False = ne pas attendre la fin
    return f'CreateObject("WScript.Shell").Run "{command}", 0, False\r\n'


def launch_agent_plist():
    return plistlib.dumps({
        "Label": LAUNCH_LABEL,
        "ProgramArguments": background_command(),
        "RunAtLoad": True,                      # à l'ouverture de session
        "StandardOutPath": str(LOG_FILE),
        "StandardErrorPath": str(LOG_FILE),
    })


def launchctl(*args):
    return subprocess.run(["launchctl", *args], capture_output=True, text=True)


def uninstall(quiet=False):
    # Le companion en cours le remarque en quelques secondes et s'arrête
    PID_FILE.write_text("stop", encoding="utf-8")
    if sys.platform == "win32":
        STARTUP_VBS.unlink(missing_ok=True)
    elif sys.platform == "darwin":
        launchctl("bootout", f"gui/{os.getuid()}/{LAUNCH_LABEL}")
        LAUNCH_PLIST.unlink(missing_ok=True)
    if not quiet:
        print("Lancement automatique retiré.")


def ask_lol_folder():
    """Si LoL n'est à aucun endroit habituel, demande son dossier et le retient."""
    if any(Path(path).parent.exists() for path in LOCKFILE_PATHS):
        return
    print("Je ne trouve pas League of Legends aux endroits habituels.")
    print("Colle le chemin de son dossier (celui qui contient LeagueClient.exe),")
    folder = input("ou appuie sur Entrée pour passer : ").strip().strip('"')
    if not folder:
        return
    if not Path(folder).is_dir():
        print("  Ce dossier n'existe pas : je continue sans.")
        return
    saved = json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {}
    saved["lockfile"] = str(Path(folder) / "lockfile")
    CONFIG_FILE.write_text(json.dumps(saved, indent=2), encoding="utf-8")


def install(settings):
    if sys.platform not in ("win32", "darwin"):
        sys.exit("Le lancement automatique n'est prévu que pour Windows et macOS.")

    # On vérifie le jeton tout de suite, tant qu'il y a quelqu'un pour lire l'erreur
    try:
        ids = supabase_rpc(settings, "team_riot_ids", {"p_token": settings["token"]})
    except RuntimeError as e:
        sys.exit(f"Impossible de joindre la base avec ce jeton ({e}).\n"
                 f"Si le jeton est faux, supprime {CONFIG_FILE} puis relance l'installation.")
    print(f"Jeton accepté. Riot ID de la team connus : {len(ids or [])}.")
    if not ids:
        print("  ⚠️ Aucun Riot ID renseigné : aucune game ne sera envoyée (colonne riot_id de la table players).")

    ask_lol_folder()
    uninstall(quiet=True)

    if sys.platform == "win32":
        STARTUP_VBS.parent.mkdir(parents=True, exist_ok=True)
        # utf-16 : le format que Windows lit sans se tromper sur les accents des chemins
        STARTUP_VBS.write_text(startup_vbs(), encoding="utf-16")
        subprocess.Popen(["wscript.exe", str(STARTUP_VBS)])   # démarre tout de suite
    else:
        time.sleep(1)   # laisse à macOS le temps d'arrêter l'ancienne version
        LAUNCH_PLIST.parent.mkdir(parents=True, exist_ok=True)
        LAUNCH_PLIST.write_bytes(launch_agent_plist())
        result = launchctl("bootstrap", f"gui/{os.getuid()}", str(LAUNCH_PLIST))
        if result.returncode != 0:
            sys.exit(f"macOS a refusé le lancement automatique : {result.stderr.strip() or result.stdout.strip()}")

    print("Installé : le companion tourne en arrière-plan et redémarrera à chaque ouverture de session.")
    print(f"  Journal : {LOG_FILE}")
    print("  Si tu déplaces le dossier du site, relance l'installation.")


def main():
    parser = argparse.ArgumentParser(description="Companion LCU de la team Queen's Gambit")
    parser.add_argument("--install", action="store_true", help="lancement automatique à l'ouverture de session")
    parser.add_argument("--uninstall", action="store_true", help="retire le lancement automatique")
    parser.add_argument("--background", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--dry-run", action="store_true", help="n'envoie rien : affiche ce qui serait envoyé")
    parser.add_argument("--game", type=int, metavar="ID", help="(ré)envoie une game précise, puis s'arrête")
    args = parser.parse_args()

    if args.background:
        # Lancé par le système, sans fenêtre : tout ce qui est affiché va dans le journal
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 1_000_000:
            LOG_FILE.unlink()
        sys.stdout = sys.stderr = open(LOG_FILE, "a", encoding="utf-8", buffering=1)
        PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    else:
        # Sous Windows, la console n'est pas toujours en UTF-8 (accents, émojis)
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")

    if args.uninstall:
        return uninstall()

    settings = load_settings(need_token=not args.dry_run, interactive=not args.background)
    if args.install:
        return install(settings)

    print(f"[{datetime.now():%d/%m %H:%M}] Companion Queen's Gambit"
          + (" (dry run : rien n'est envoyé)" if args.dry_run else ""))

    while True:
        lcu = wait_for_client(args.background)
        try:
            companion = Companion(lcu, settings, args.dry_run)
            print(f"Connecté au client LoL ({riot_id(companion.me) or 'compte inconnu'}).")

            if args.game:
                if not companion.process(args.game):
                    sys.exit(f"Game {args.game} introuvable (ou stats pas encore disponibles).")
                return

            companion.catch_up()
            print("Je surveille tes games." + ("" if args.background else " (Ctrl+C pour arrêter)"))
            while True:
                try:
                    companion.tick()
                except LcuGone:
                    raise
                except Exception as e:   # un imprévu ne doit pas arrêter la surveillance
                    print(f"Erreur inattendue, je continue : {e!r}")
                time.sleep(POLL_SECONDS)
                stop_if_replaced(args.background)
        except LcuGone:
            print("Client LoL fermé.")
            time.sleep(5)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nArrêt.")
