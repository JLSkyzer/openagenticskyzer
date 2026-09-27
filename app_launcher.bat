@echo off
REM Launcher rapide pour l'app Electron (openagent-desktop) — remplace l'ancienne GUI Python/NiceGUI
REM À placer à la racine ou dans le PATH

setlocal enabledelayedexpansion

REM npm start (electron .) lance le renderer déjà buildé dans electron\renderer-dist —
REM si le renderer a changé, lancer d'abord "npm run renderer:build" dans electron\.
pushd "%~dp0electron"
call npm start %*
popd

endlocal
