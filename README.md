# Queen's Gambit – espace de la team

Site statique (HTML/CSS/JS) branché sur Supabase.

## Lancer en local

1. Renseigner `js/config.js` (URL du projet et clé anon, dans Supabase > Project Settings > API).
2. Dans ce dossier : `python -m http.server 8000`
3. Ouvrir http://localhost:8000

## Structure

- `index.html` : structure de la page
- `css/style.css` : thème (couleurs de la team en haut du fichier)
- `js/config.js` : configuration Supabase et plage horaire de l'échiquier
- `js/app.js` : connexion Discord, planning, échiquier des dispos
- `assets/` : logo, favicon, bannière
- `sql/` : migrations Supabase, à exécuter dans l'ordre (SQL Editor)
- `scripts/notify.py` : notifications Discord planifiées (GitHub Actions)
- `scripts/lcu_companion.py` : récupération des games depuis le client LoL

## Posts Discord des sessions

À chaque rendez-vous ajouté sur le site, un post est créé dans le forum Discord.
Pour un scrim ou un match officiel, il reprend le statut, l'heure de la draft, le
format, le side, le lien de draft et les infos de l'adversaire. Modifier le
rendez-vous réécrit le post et signale dedans ce qui a changé.

Mise en place (une seule fois) :

1. Exécuter `sql/05_sessions_discord_games.sql` dans Supabase.
2. Créer un webhook sur le salon **forum** (Modifier le salon > Intégrations > Webhooks).
3. L'enregistrer dans Supabase avec la requête de la section 5 du fichier SQL.

Le webhook ne peut pas renommer un post : si la date ou l'adversaire change, le
titre est à corriger à la main dans Discord. Les types de rendez-vous qui ont
droit à un post se règlent dans `js/config.js` (`DISCORD_POST_TYPES`).

## Companion LCU (games, drafts, stats)

`scripts/lcu_companion.py` tourne sur le PC Windows de la personne qui récupère
les games, à côté du client LoL. Il enregistre dans Supabase la draft, le résultat
et les stats des 10 joueurs, puis annonce le résultat dans le post Discord de la session.

Il ne garde que les games perso et les flex où au moins 4 joueurs de la team
sont dans la même équipe.

Mise en place (une seule fois) :

1. Exécuter `sql/06_riot_ids.sql`. Les joueurs sont reconnus grâce à la colonne
   `riot_id` (« Pseudo#TAG ») de la table `players`.
2. Récupérer le jeton du companion (section 5 de `sql/05_sessions_discord_games.sql`).
3. Sur le PC : installer Python (https://www.python.org/downloads/) et récupérer
   ce dossier en entier (sur GitHub : Code > Download ZIP, puis le décompresser).
4. Double-cliquer sur `scripts/installer_companion.bat` et coller le jeton.

Il démarre ensuite tout seul à chaque démarrage de Windows, sans fenêtre, et
attend que le client LoL soit ouvert. Son journal est le fichier `.queenbot.log`
du dossier personnel (`C:\Users\TonNom`).

Si le dossier est déplacé ou remplacé par une version plus récente, relancer
`installer_companion.bat`.

Depuis une invite de commandes ouverte dans le dossier :

- Voir ce qu'il ferait sans rien envoyer : `py scripts\lcu_companion.py --dry-run`
- Renvoyer une game précise : `py scripts\lcu_companion.py --game ID`
- Retirer le lancement automatique : `py scripts\lcu_companion.py --uninstall`
