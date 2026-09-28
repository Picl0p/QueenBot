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
