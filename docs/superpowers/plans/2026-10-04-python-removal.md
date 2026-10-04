# Bascule finale sans Python — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive the user's uncommitted Python work on a branch, tag the last Python commit `python-final`, remove the Python app from master, and rewrite README/CONTRIBUTING for the Electron app alone.

**Architecture:** Git-only safekeeping first (branch + annotated tag, both pushed and verified on `origin`), then one `git rm` commit, then documentation, then verification and the migration checklist. `electron/` is not modified.

**Tech Stack:** git, Node 24 (`node --experimental-strip-types`), Electron 44, electron-builder (NSIS).

**Spec:** `docs/superpowers/specs/2026-10-04-python-removal-design.md`

## Global Constraints

- Order is strict: Task 1 (archive branch + tag, both pushed and verified) must be complete before Task 2 removes anything.
- Never touch the user's other uncommitted changes: `docs/superpowers/plans/2026-04-27-onboarding-auto.md` (deleted), `docs/superpowers/plans/2026-04-27-semantic-plugins.md` (deleted), `docs/superpowers/plans/liste logique à suivre.txt` (modified), `docs/superpowers/specs/2026-09-14-electron-autonomous-design.md` (modified), and the untracked `docs/superpowers/plans/2026-09-14-native-desktop-gui.md`, `docs/superpowers/plans/2026-10-01-mcp-enhancement.md`, `docs/superpowers/plans/OK 2026-04-27-onboarding-auto.md`, `docs/superpowers/plans/OK 2026-04-27-semantic-plugins.md`, `docs/superpowers/specs/2026-09-14-native-desktop-gui-design.md`. They stay in the working tree, uncommitted, byte-identical.
- Never `git add -A` / `git add .`; every `git add` / `git rm` names its paths. Never `--force`, never `--no-verify`.
- Removed from master (Task 2), and nothing else: `openagenticskyzer/`, `tests/` (Python suite), `pyproject.toml`, `requirements.txt`, `scratchpad_base_context_bar.py`, `install.bat`.
- Not touched: `electron/`, `docs/` (history), `tasks/` (except Task 4's edits), `.claude`, `.gitignore`, `superpowers.lnk`, `ollama meilleur modèle.txt`, `app_launcher.bat`, `app_launcher.ps1`, untracked local folders (`.venv`, `openagentic_ai/`, `openagenticskyzer.egg-info`, `.pytest_cache`), and `~/.openagent`.
- Every test that opens a real window (`npm run test:*` visual/e2e, `test:package`) is run ONCE; a failure is reported, not re-run in a loop.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- tsc baselines: `npx tsc --noEmit -p tsconfig.core.json` → 5 pre-existing errors only; `npx tsc --noEmit -p renderer-src/tsconfig.json` → 0. Full suite baseline: 726/726.

---

## File Structure

| Path | Change |
|---|---|
| branch `archive/native-desktop-attempt` | created: one commit with the user's 4 modified Python files + untracked `openagenticskyzer/desktop/` |
| tag `python-final` | created (annotated) on master's last commit that contains the Python app |
| `openagenticskyzer/`, `tests/`, `pyproject.toml`, `requirements.txt`, `scratchpad_base_context_bar.py`, `install.bat` | removed from master |
| `README.md` | rewritten (French) |
| `CONTRIBUTING.md` | rewritten (French, Node) |
| `tasks/todo.md` | migration checklist lines 9–15 updated with proofs; lot bilan appended |

---

### Task 1: Archive branch and `python-final` tag

**Files:** none on master. Git refs only.

- [ ] **Step 1: Record the exact state to archive, and keep a copy**

Run from the repo root (Git Bash):

```bash
cd /d/Openagenticai-skyzeredition
git status --short > /tmp/oa-status-before.txt
cat /tmp/oa-status-before.txt
git rev-parse HEAD > /tmp/oa-master-head.txt
rm -rf /tmp/oa-archive-copy && mkdir -p /tmp/oa-archive-copy
for f in openagenticskyzer/agent.py openagenticskyzer/app/main.py openagenticskyzer/app/components/sidebar.py openagenticskyzer/indexer/knowledge.py; do mkdir -p "/tmp/oa-archive-copy/$(dirname "$f")"; cp "$f" "/tmp/oa-archive-copy/$f"; done
cp -r openagenticskyzer/desktop /tmp/oa-archive-copy/openagenticskyzer/desktop
find /tmp/oa-archive-copy -path '*/__pycache__' -prune -o -type f -print | sort
```

Expected: the status lists ` M` for the 4 Python files, `?? openagenticskyzer/desktop/`, and exactly the user's docs changes listed in Global Constraints. If ANY other change appears under `openagenticskyzer/`, stop and report.

- [ ] **Step 2: Create the archive branch and commit only the Python files**

```bash
git switch -c archive/native-desktop-attempt
git add openagenticskyzer/agent.py openagenticskyzer/app/main.py openagenticskyzer/app/components/sidebar.py openagenticskyzer/indexer/knowledge.py openagenticskyzer/desktop
git diff --cached --name-only
```

Expected: the 4 files + the files under `openagenticskyzer/desktop/`; no `__pycache__` (ignored); none of the user's docs changes. If a `__pycache__` file is staged, `git restore --staged <path>` it.

```bash
git commit -m "archive: abandoned native-desktop attempt (pywebview window, Electron launcher stub) saved before the Python app is removed from master

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Verify the archive matches the copy (line endings normalised)**

```bash
ok=1
for f in $(git diff --name-only HEAD~1 HEAD); do
  a=$(git show "HEAD:$f" | sed 's/\r$//' | sha256sum | cut -d' ' -f1)
  b=$(sed 's/\r$//' "/tmp/oa-archive-copy/$f" | sha256sum | cut -d' ' -f1)
  [ "$a" = "$b" ] || { echo "DIFF $f"; ok=0; }
done
expected=$(cd /tmp/oa-archive-copy && find . -path '*/__pycache__' -prune -o -type f -print | sed 's#^\./##' | sort)
actual=$(git diff --name-only HEAD~1 HEAD | sort)
[ "$expected" = "$actual" ] || { echo "FILE LIST DIFFERS"; ok=0; }
[ $ok = 1 ] && echo ARCHIVE-IDENTICAL
```

Expected: `ARCHIVE-IDENTICAL`. Otherwise stop and report (do not continue to Task 2).

- [ ] **Step 4: Return to master; the user's other changes are intact**

```bash
git switch master
git status --short
```

Expected: the 4 Python files are clean (their master version), `openagenticskyzer/desktop/` is no longer in the working tree (it lives on the archive branch), and every docs line of `/tmp/oa-status-before.txt` is still present. If `git switch` refuses, stop and report — never force.

- [ ] **Step 5: Tag the last Python commit and push both refs**

```bash
test "$(git rev-parse HEAD)" = "$(cat /tmp/oa-master-head.txt)" && echo HEAD-UNCHANGED
git tag -a python-final -m "Last master commit containing the Python app (NiceGUI GUI and the openagent CLI) before its removal (2026-10-04)"
git push origin archive/native-desktop-attempt
git push origin python-final
git ls-remote --heads origin archive/native-desktop-attempt
git ls-remote --tags origin python-final
```

Expected: `HEAD-UNCHANGED`; both `ls-remote` lines print a hash.

---

### Task 2: Remove the Python app from master

**Files:** remove `openagenticskyzer/`, `tests/`, `pyproject.toml`, `requirements.txt`, `scratchpad_base_context_bar.py`, `install.bat`.

- [ ] **Step 1: Prove `electron/` does not depend on the Python code**

```bash
cd /d/Openagenticai-skyzeredition
git grep -n -i "openagenticskyzer\|openagentic_ai\|pyproject\|requirements.txt" -- electron ':!electron/package-lock.json'
```

Expected: only lines that (a) detect Python projects in `electron/core/project-analyzer.mts` or its tests, (b) check that Python is absent (`checkPythonAbsent` and the tests using it), or (c) are comments/strings naming the old app (e.g. "Copied from utils.py", "parity with …py"). Classify every line in the report. Any `require`/`import`/spawn of a Python file is a blocker: stop and report.

- [ ] **Step 2: Remove**

```bash
git rm -r -q openagenticskyzer tests pyproject.toml requirements.txt scratchpad_base_context_bar.py
git rm -q install.bat
git status --short
```

Expected: staged deletions only for those paths (`install.bat` was already deleted in the working tree; `git rm` stages it). The user's docs changes remain unstaged.

- [ ] **Step 3: Verify the Electron app is unaffected**

```bash
cd electron
timeout 900 node --experimental-strip-types --test tests/all.mts 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped)"
npx tsc --noEmit -p tsconfig.core.json 2>&1 | grep -c "error TS"
npx tsc --noEmit -p renderer-src/tsconfig.json 2>&1 | grep -c "error TS"
cd ..
```

Expected: 726 tests, 726 pass, 0 fail; `5`; `0`.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove the Python app (NiceGUI GUI, openagent CLI, its tests and packaging); the Electron app is the only app — the Python code stays reachable at tag python-final

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git show --stat HEAD | tail -3
```

---

### Task 3: README and CONTRIBUTING

**Files:** Modify `README.md`, `CONTRIBUTING.md` (full rewrite).

- [ ] **Step 1: Write `README.md`**

Replace the whole file with:

````markdown
# openagent

Agent de code pour Windows : une application de bureau qui travaille dans le dossier que tu ouvres — lire, écrire et modifier des fichiers, lancer des commandes, utiliser git, chercher dans le code et sur le web — avec tes propres clés de fournisseur ou un modèle local `.gguf`.

## Installer

1. Télécharge `openagent-Setup-<version>.exe` depuis les [Releases GitHub](https://github.com/JLSkyzer/openagenticskyzer/releases).
2. Lance-le. L'installation se fait pour ton compte uniquement, sans droits administrateur (dossier `%LOCALAPPDATA%\Programs\openagent-desktop`), avec des raccourcis sur le bureau et dans le menu Démarrer.
3. Windows SmartScreen peut afficher « Windows a protégé votre ordinateur » : l'installeur n'est pas signé. « Informations complémentaires » puis « Exécuter quand même ».

Les mises à jour se téléchargent en arrière-plan ; un bandeau « Version X prête » propose de redémarrer. La désinstallation (Paramètres Windows › Applications) ne supprime pas tes données (`~/.openagent`).

## Fonctions

- **Fournisseurs** : OpenRouter, Together, Groq, Mistral, Gemini, Ollama, LM Studio, llama.cpp (serveur), ou un modèle `.gguf` exécuté dans l'application, sans serveur.
- **Modes** : `ask` (questions, lecture seule), `plan` (plan détaillé, lecture seule), `auto` (agent).
- **Permissions** : `demander` (chaque écriture, commande ou action sensible est confirmée), `auto`, `strict` ; « Toujours » vaut pour la session.
- **Outils** : fichiers, recherche dans le code, git, commandes shell, web, mémoire de projet, initialisation de projet (`OPENAGENT.md`), serveurs MCP (stdio et distants), plugins Node.
- **Conversation** : branches, édition et régénération, pièces jointes (texte, code, CSV, PDF, images), artifacts (HTML, SVG, Mermaid, Markdown), jauge de contexte et compaction, export Markdown / HTML / JSON.
- **Interface** : palette de commandes (Ctrl+K), bibliothèque de prompts, thème clair / sombre, icône dans la zone de notification.
- **Projets** : historique des dossiers, confiance par projet avant d'exécuter les plugins ou serveurs MCP qu'un dépôt fournit, index sémantique du code et base de connaissances.

## Développer

Prérequis : Windows, Node.js 24, git 2.44 ou plus récent.

```bash
git clone https://github.com/JLSkyzer/openagenticskyzer.git
cd openagenticskyzer/electron
npm ci
npm run renderer:build
npm start
```

`app_launcher.bat` (ou `app_launcher.ps1`) à la racine lance la même chose. Après une modification de l'interface (`renderer-src/`), relancer `npm run renderer:build`.

Tests (sans fenêtre) :

```bash
cd electron
node --experimental-strip-types --test tests/all.mts
```

Les tests visuels (`npm run test:chat`, `npm run test:settings`, …) ouvrent une vraie fenêtre de l'application.

## Publier une version

1. Augmenter `version` dans `electron/package.json`, commiter et pousser.
2. `npm run release:win` depuis `electron/` (GitHub CLI `gh` connecté) : construit l'installeur et le dépose dans un **brouillon** de release.
3. Relire et publier le brouillon sur GitHub. Ne rien pousser sur la branche par défaut entre l'étape 2 et la publication : GitHub crée le tag au moment de la publication.

## Historique

L'ancienne application Python (interface NiceGUI et outil en ligne de commande `openagent "tâche"`) a été retirée le 2026-10-04. Elle reste disponible à l'étiquette git `python-final` (`git checkout python-final`).
````

- [ ] **Step 2: Verify every claim in the README against the code**

For each bullet of « Fonctions », find the implementing module and note it in the report (e.g. providers: `electron/core/connections.mts` `providers`; MCP remote: `electron/core/mcp-client.mts`; palette: the renderer's command palette component). Remove or correct any bullet that has no implementation — never leave an unverified claim. Check the install folder and data home statements against `docs/superpowers/specs/2026-10-02-windows-installer-updates-design.md` and the installer bilan in `tasks/todo.md`.

- [ ] **Step 3: Run each documented command once, in a scratch clone**

```bash
SCRATCH=$(mktemp -d)
git clone -q /d/Openagenticai-skyzeredition "$SCRATCH/oa"
cd "$SCRATCH/oa/electron" && npm ci --no-audit --no-fund && npm run renderer:build && node --experimental-strip-types --test tests/all.mts 2>&1 | grep -E "^ℹ (tests|pass|fail)"
cd / && rm -rf "$SCRATCH"
```

Expected: `npm ci` and `renderer:build` succeed; the suite passes. `npm start` is NOT launched here (it opens a window); Task 4 exercises the app once through `test:package`. Report the results.

- [ ] **Step 4: Write `CONTRIBUTING.md`**

Replace the whole file with:

````markdown
# Contribuer à openagent

## Mise en place

Prérequis : Windows, Node.js 24, git 2.44 ou plus récent.

```bash
git clone https://github.com/JLSkyzer/openagenticskyzer.git
cd openagenticskyzer/electron
npm ci
npm run renderer:build
```

## Structure

- `electron/main.cjs` — processus principal (fenêtre, coffre des clés, mises à jour).
- `electron/worker.mjs` — moteur (agent, outils, stockage), dans un `worker_threads`.
- `electron/core/*.mts` — modules du moteur, sans dépendance à Electron.
- `electron/renderer-src/` — interface React (Vite).
- `electron/tests/` — tests ; `tests/all.mts` les enregistre tous.

## Tests

```bash
cd electron
node --experimental-strip-types --test tests/all.mts
npx tsc --noEmit -p tsconfig.core.json
npx tsc --noEmit -p renderer-src/tsconfig.json
```

Les tests `npm run test:*` ouvrent une vraie fenêtre de l'application : lance-les un par un, une fois.

## Règles

- Tests d'abord : écrire le test, le voir échouer, puis implémenter.
- Tests réels : vrais fichiers, vrai worker, vrai serveur HTTP de test ; pas de mocks.
- Un commit par modification terminée et vérifiée, avec les seuls fichiers modifiés (pas de `git add -A`).
- Tout nouveau fichier chargé par le processus principal va dans `build.files` de `electron/package.json` dans le même commit.
- Les suivis et bilans de lots sont dans `tasks/todo.md` ; les leçons dans `tasks/lessons.md`.
````

- [ ] **Step 5: Commit**

```bash
cd /d/Openagenticai-skyzeredition
git add README.md CONTRIBUTING.md
git commit -m "docs: README and CONTRIBUTING describe the Electron desktop app alone (install, develop, release); the Python app is reachable at tag python-final

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Packaged proof, migration checklist, bilan, push

**Files:** Modify `tasks/todo.md`.

- [ ] **Step 1: Packaged app, once**

```bash
cd /d/Openagenticai-skyzeredition/electron
npm run package:win && npm run test:package
```

Expected: build succeeds; `PASS packaged executable launches outside npm start and loads the real UI` (this test also checks that no Python is required). Run once; on failure, report.

- [ ] **Step 2: Migration checklist (`tasks/todo.md` lines 9–15)**

For each unchecked line of « Migration 2026-09-14-electron-autonomous » (Stockage Node; Moteur Node; Modèles locaux, téléchargements, index/BDC, extensions et MCP; Vérifier chaque ligne de la matrice de parité; Packager et tester Windows sans Python, supprimer les anciens chemins actifs, documenter npm/exécutable; Commit/push), search the bilans below it (`grep -n "^### Bilan" tasks/todo.md`) for the proof. Check the box only when a bilan proves it; append ` — preuve : <bilan title> (<date>)` to the line. A line without complete proof stays unchecked and gets ` — reste : <what is missing>`. Do not otherwise change the wording of the existing lines.

- [ ] **Step 3: Bilan**

Append to the END of `tasks/todo.md` a section `### Bilan du lot — bascule finale sans Python (2026-10-04)` in French, in the style of the bilans above. Include:
- archive branch and tag (names, hashes, `ls-remote` proof, ARCHIVE-IDENTICAL);
- what was removed (file counts);
- the `git grep` classification;
- suite / tsc / test:package results;
- README claims verified (module per feature);
- what the user can delete locally if they want (`.venv`, `openagentic_ai/`, `openagenticskyzer.egg-info`, `.pytest_cache`, any old Python install outside the repo — never deleted by this lot);
- the abandoned CLI (reachable at `python-final`);
- the migration checklist outcome.

- [ ] **Step 4: Commit and push**

```bash
cd /d/Openagenticai-skyzeredition
git add tasks/todo.md
git commit -m "docs: migration checklist with proofs and bilan of the final switch to the Electron app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
git status -sb | head -1
```

Expected: `## master...origin/master`; the user's docs changes still listed as uncommitted, unchanged.
