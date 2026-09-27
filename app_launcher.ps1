# Launcher rapide pour l'app Electron (openagent-desktop) — remplace l'ancienne GUI Python/NiceGUI
# À placer à la racine ou dans le PATH

param(
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$Args
)

$ErrorActionPreference = 'Stop'

# npm start (electron .) lance le renderer déjà buildé dans electron\renderer-dist —
# si le renderer a changé, lancer d'abord "npm run renderer:build" dans electron\.
$electronDir = Join-Path $PSScriptRoot 'electron'
Push-Location $electronDir
try {
    & npm start @Args
} finally {
    Pop-Location
}

exit $LASTEXITCODE
