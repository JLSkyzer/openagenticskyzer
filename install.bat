@echo off
echo.
echo  ◈ openagenticskyzer — Installation des dependances
echo  ────────────────────────────────────────────────────
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERREUR] Python introuvable. Installez Python 3.10+ depuis https://python.org
    pause
    exit /b 1
)

echo  [1/2] Installation des dependances depuis requirements.txt...
pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo  [ERREUR] pip install a echoue. Verifiez votre connexion internet.
    pause
    exit /b 1
)

echo.
echo  [2/2] Installation du package en mode editable...
pip install -e .
if errorlevel 1 (
    echo.
    echo  [ERREUR] Installation du package echouee.
    pause
    exit /b 1
)

echo.
echo  ────────────────────────────────────────────────────
echo  [OK] Installation terminee !
echo.
echo  Pour lancer l'app :
echo    python -m openagenticskyzer --app
echo.
echo  Pour utiliser un modele Ollama, installez Ollama depuis :
echo    https://ollama.com/download
echo  puis telechargez un modele :
echo    ollama pull qwen2.5-coder:7b
echo.
pause
