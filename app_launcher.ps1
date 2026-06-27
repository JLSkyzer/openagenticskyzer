# Launcher rapide pour openagenticskyzer GUI — PowerShell
# À placer à la racine ou dans le PATH

param(
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$Args
)

$ErrorActionPreference = 'SilentlyContinue'

# Désactiver les warnings
$env:TF_CPP_MIN_LOG_LEVEL = 3
[Environment]::SetEnvironmentVariable("PYTHONUNBUFFERED", "1")

# Lancer l'app GUI directement
python -c "from openagenticskyzer.app.main import main_app; main_app()" @Args

exit $LASTEXITCODE
