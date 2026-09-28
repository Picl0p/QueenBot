"""
Notifications Discord de la team Queen's Gambit.

Deux notifications :
  * relance  : le dimanche soir, mentionne ceux qui n'ont pas rempli
               leurs dispos de la semaine suivante ;
  * planning : chaque jour, annonce les rendez-vous du jour avec
               qui est dispo, à éviter, pas dispo ou n'a pas répondu.

Le script est lancé par GitHub Actions (.github/workflows/notifications.yml).
Il n'utilise que la bibliothèque standard de Python : rien à installer.

Variables d'environnement :
  SUPABASE_URL          URL du projet Supabase               (secret)
  SUPABASE_SERVICE_KEY  clé service_role / secret de Supabase (secret)
  DISCORD_WEBHOOK_URL   URL du webhook du salon Discord      (secret)
  SITE_URL              adresse du site, pour les liens      (facultatif)
  DISCORD_ROLE_ID       rôle à mentionner pour le planning   (facultatif)
  SCHEDULE              cron qui a déclenché le script (fourni par GitHub)
  MODE                  "relance" ou "planning" (lancement manuel)
  DRY_RUN               "true" : affiche le message sans l'envoyer

Test en local (affiche sans envoyer) :
  MODE=planning DRY_RUN=true python scripts/notify.py
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

PARIS = ZoneInfo("Europe/Paris")

# ---------------------------------------------------------------------
# Horaires
#
# GitHub Actions ne connaît que l'heure UTC, sans heure d'été. Chaque
# notification a donc deux crons dans le workflow : un pour l'heure d'été
# (Paris = UTC+2) et un pour l'heure d'hiver (Paris = UTC+1). Le script
# ne poste que si le décalage actuel de Paris correspond au cron qui l'a
# déclenché. C'est robuste aux retards de GitHub (qui peuvent atteindre
# plusieurs dizaines de minutes).
#
# ⚠️ Ces chaînes doivent être IDENTIQUES à celles du workflow.
# ---------------------------------------------------------------------
SCHEDULES = {
    "0 18 * * 0": ("relance", 2),    # dimanche 20h, heure d'été
    "0 19 * * 0": ("relance", 1),    # dimanche 20h, heure d'hiver
    "0 10 * * *": ("planning", 2),   # tous les jours 12h, heure d'été
    "0 11 * * *": ("planning", 1),   # tous les jours 12h, heure d'hiver
}

TYPE_LABELS = {
    "entrainement": "Entraînement",
    "scrim": "Scrim",
    "match_officiel": "Match officiel",
    "review": "Review",
    "autre": "Autre",
}

JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
        "août", "septembre", "octobre", "novembre", "décembre"]

COULEUR_OR = 0xE3B65F   # couleur de la bande des messages Discord


# ---------------------------------------------------------------------
# Petits utilitaires
# ---------------------------------------------------------------------

def env(name, required=True):
    value = os.environ.get(name, "").strip()
    if required and not value:
        sys.exit(f"Variable d'environnement manquante : {name}")
    return value


def date_fr(d):
    """date(2026, 10, 5) → 'lundi 5 octobre'"""
    return f"{JOURS[d.weekday()]} {d.day} {MOIS[d.month - 1]}"


def heure_fr(dt):
    """datetime → '20h' ou '20h30'"""
    return f"{dt.hour}h" if dt.minute == 0 else f"{dt.hour}h{dt.minute:02d}"


def monday_of(d):
    return d - timedelta(days=d.weekday())


def iso_utc(dt):
    return dt.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------
# Supabase (API REST générée automatiquement par Supabase)
# ---------------------------------------------------------------------

def supabase(path, params=None, body=None):
    """Appelle l'API REST de Supabase et renvoie le JSON décodé.

    La clé service_role contourne les règles RLS : c'est voulu ici,
    le script doit lire les dispos de tout le monde. C'est aussi pour
    ça qu'elle ne doit JAMAIS apparaître dans le code du site.
    """
    url = f"{env('SUPABASE_URL').rstrip('/')}/rest/v1/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)

    key = env("SUPABASE_SERVICE_KEY")
    headers = {"apikey": key, "Content-Type": "application/json"}
    # Les anciennes clés (format JWT, commençant par "eyJ") doivent aussi
    # être passées en Authorization ; les nouvelles clés "sb_secret_..." non.
    if key.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {key}"

    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, headers=headers,
                                     method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read() or "null")
    except urllib.error.HTTPError as e:
        sys.exit(f"Erreur Supabase {e.code} sur {path} : {e.read().decode()}")


# ---------------------------------------------------------------------
# Discord
# ---------------------------------------------------------------------

def send_discord(payload):
    payload.setdefault("username", "Queen's Gambit")

    if env("DRY_RUN", required=False).lower() == "true":
        print("[DRY RUN] Message qui serait envoyé :")
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return

    request = urllib.request.Request(
        env("DISCORD_WEBHOOK_URL"),
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            # Discord refuse les requêtes avec l'User-Agent Python par défaut
            "User-Agent": "QueensGambitNotifier (github-actions, 1.0)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30):
            print("Message envoyé sur Discord.")
    except urllib.error.HTTPError as e:
        sys.exit(f"Erreur Discord {e.code} : {e.read().decode()}")


def lien_site():
    url = env("SITE_URL", required=False)
    return f"\n👉 {url}" if url else ""


# ---------------------------------------------------------------------
# Notification 1 : relance du dimanche soir
# ---------------------------------------------------------------------

def relance(today):
    # Lundi de la semaine suivante (le dimanche, c'est demain)
    next_monday = monday_of(today) + timedelta(days=7)

    missing = supabase("rpc/players_missing_availability",
                       body={"p_week_start": next_monday.isoformat()})

    if not missing:
        print("Tout le monde a rempli ses dispos : aucune relance.")
        return

    mentions = ", ".join(f"<@{p['discord_id']}>" for p in missing)
    send_discord({
        "content": (
            f"📅 **Dispos de la semaine du {date_fr(next_monday)}**\n"
            f"Il manque encore : {mentions}. Pensez à les remplir !"
            f"{lien_site()}"
        ),
        # Seules les personnes listées sont notifiées
        "allowed_mentions": {"users": [p["discord_id"] for p in missing]},
    })


# ---------------------------------------------------------------------
# Notification 2 : planning du jour
# ---------------------------------------------------------------------

def heures_couvertes(start, end):
    """Heures (date, heure) occupées par un rendez-vous, en heure de Paris.
    20h–22h → [(jour, 20), (jour, 21)] ; sans fin → seulement l'heure de début."""
    if end is None:
        return [(start.date(), start.hour)]
    cursor = start.replace(minute=0, second=0, microsecond=0)
    slots = []
    while cursor < end:
        slots.append((cursor.date(), cursor.hour))
        cursor += timedelta(hours=1)
    return slots


def statut_joueur(player_id, slots, dispos, a_repondu):
    """Statut d'un joueur sur toute la durée du rendez-vous :
    il faut être dispo sur TOUTES les heures pour être "dispo"."""
    if not a_repondu:
        return "pas_repondu"
    statuts = [dispos.get((player_id, day, hour)) for day, hour in slots]
    if any(s is None for s in statuts):
        return "pas_dispo"
    if any(s == "a_eviter" for s in statuts):
        return "a_eviter"
    return "dispo"


def planning(today):
    day_start = datetime.combine(today, time.min, tzinfo=PARIS)
    day_end = day_start + timedelta(days=1)

    events = supabase("events", {
        "select": "title,type,starts_at,ends_at,opponent,notes",
        "starts_at": [f"gte.{iso_utc(day_start)}", f"lt.{iso_utc(day_end)}"],
        "order": "starts_at",
    })
    if not events:
        print("Aucun rendez-vous aujourd'hui : pas de message.")
        return

    players = [p for p in supabase("players", {"select": "id,pseudo,status", "order": "pseudo"})
               if p["status"] != "coach"]

    # Qui a rempli la semaine en cours ?
    week_start = monday_of(today)
    submitted = {s["player_id"] for s in supabase("availability_submissions", {
        "select": "player_id",
        "week_start": f"eq.{week_start.isoformat()}",
    })}

    # Dispos d'aujourd'hui et de demain (pour les rendez-vous après minuit)
    rows = supabase("availabilities", {
        "select": "player_id,day,hour,status",
        "day": [f"gte.{today.isoformat()}", f"lte.{(today + timedelta(days=1)).isoformat()}"],
    })
    dispos = {(r["player_id"], date.fromisoformat(r["day"]), r["hour"]): r["status"] for r in rows}

    embeds = []
    for ev in events[:10]:   # Discord accepte au plus 10 encadrés par message
        start = datetime.fromisoformat(ev["starts_at"]).astimezone(PARIS)
        end = datetime.fromisoformat(ev["ends_at"]).astimezone(PARIS) if ev["ends_at"] else None
        slots = heures_couvertes(start, end)

        groupes = {"dispo": [], "a_eviter": [], "pas_dispo": [], "pas_repondu": []}
        for p in players:
            statut = statut_joueur(p["id"], slots, dispos, p["id"] in submitted)
            groupes[statut].append(p["pseudo"])

        titre = ev["title"] + (f" contre {ev['opponent']}" if ev["opponent"] else "")
        horaire = f"de {heure_fr(start)} à {heure_fr(end)}" if end else f"à {heure_fr(start)}"

        fields = [
            {"name": "✅ Dispo", "value": ", ".join(groupes["dispo"]) or "Personne", "inline": False},
        ]
        if groupes["a_eviter"]:
            fields.append({"name": "⚠️ À éviter", "value": ", ".join(groupes["a_eviter"]), "inline": False})
        if groupes["pas_dispo"]:
            fields.append({"name": "❌ Pas dispo", "value": ", ".join(groupes["pas_dispo"]), "inline": False})
        if groupes["pas_repondu"]:
            fields.append({"name": "❔ Pas répondu", "value": ", ".join(groupes["pas_repondu"]), "inline": False})

        description = f"**{TYPE_LABELS.get(ev['type'], ev['type'])}** aujourd'hui {horaire}"
        if ev["notes"]:
            description += f"\n{ev['notes']}"

        embed = {"title": titre, "description": description, "color": COULEUR_OR, "fields": fields}
        if env("SITE_URL", required=False):
            embed["url"] = env("SITE_URL")
        embeds.append(embed)

    role = env("DISCORD_ROLE_ID", required=False)
    payload = {
        "content": (f"<@&{role}> " if role else "") + f"🗓️ **Au programme ce {date_fr(today)}**",
        "embeds": embeds,
        "allowed_mentions": {"roles": [role] if role else []},
    }
    send_discord(payload)


# ---------------------------------------------------------------------
# Point d'entrée
# ---------------------------------------------------------------------

def main():
    now = datetime.now(PARIS)
    schedule = env("SCHEDULE", required=False)

    if schedule:
        # Lancement automatique : on vérifie que c'est le bon cron
        if schedule not in SCHEDULES:
            sys.exit(f"Cron inconnu : {schedule!r} (à ajouter dans SCHEDULES)")
        mode, expected_offset = SCHEDULES[schedule]
        offset = int(now.utcoffset().total_seconds() // 3600)
        if offset != expected_offset:
            print(f"Cron {schedule!r} prévu pour UTC+{expected_offset}, "
                  f"Paris est actuellement en UTC+{offset} : rien à faire.")
            return
    else:
        # Lancement manuel (bouton "Run workflow" ou test en local)
        mode = env("MODE", required=False) or "planning"

    print(f"Notification « {mode} » du {date_fr(now.date())}")
    if mode == "relance":
        relance(now.date())
    elif mode == "planning":
        planning(now.date())
    else:
        sys.exit(f"Mode inconnu : {mode!r}")


if __name__ == "__main__":
    main()
