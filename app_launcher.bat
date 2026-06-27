@echo off
REM Launcher rapide pour openagenticskyzer GUI — évite les imports inutiles
REM À placer à la racine ou dans le PATH

setlocal enabledelayedexpansion

REM Désactiver les warnings TensorFlow
set TF_CPP_MIN_LOG_LEVEL=3

REM Lancer l'app GUI directement (pas de agent.py)
python -c "from openagenticskyzer.app.main import main_app; main_app()" %*

endlocal
