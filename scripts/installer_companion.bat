@echo off
rem Double-clique sur ce fichier pour installer le companion (Windows).
rem A faire une seule fois : il se lancera ensuite tout seul a chaque demarrage.
rem Il faut avoir installe Python : https://www.python.org/downloads/
chcp 65001 >nul
cd /d "%~dp0.."

where py >nul 2>nul
if %errorlevel%==0 (
  py scripts\lcu_companion.py --install
) else (
  python scripts\lcu_companion.py --install
)
if errorlevel 1 (
  echo.
  echo L'installation n'a pas abouti. Si le message parle de Python introuvable,
  echo installe Python depuis https://www.python.org/downloads/ puis recommence.
)
echo.
pause
