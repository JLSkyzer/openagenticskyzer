# openagent

Agent de code pour Windows : une application de bureau qui travaille dans le dossier que tu ouvres — lire, écrire et modifier des fichiers, lancer des commandes, utiliser git, chercher dans le code et sur le web — avec tes propres clés de fournisseur ou un modèle local `.gguf`.

## Installer

1. Télécharge `openagent-Setup-<version>.exe` depuis les [Releases GitHub](https://github.com/JLSkyzer/openagenticskyzer/releases).
2. Lance-le. L'installation se fait pour ton compte uniquement, sans droits administrateur (dossier `%LOCALAPPDATA%\Programs\openagent-desktop`), avec des raccourcis sur le bureau et dans le menu Démarrer.
3. Windows SmartScreen peut afficher « Windows a protégé votre ordinateur » : l'installeur n'est pas signé. « Informations complémentaires » puis « Exécuter quand même ».

Les mises à jour se téléchargent en arrière-plan ; un bandeau « Version X prête » propose de redémarrer. La désinstallation (Paramètres Windows › Applications) ne supprime pas tes données (`~/.openagent` par défaut).

## Fonctions

- **Fournisseurs** : OpenRouter, Together, Groq, Mistral, Gemini, Ollama, LM Studio, llama.cpp (serveur), ou un modèle `.gguf` exécuté dans l'application, sans serveur.
- **Modes** : `ask` (questions, lecture seule), `plan` (plan détaillé, lecture seule), `auto` (agent).
- **Permissions** : `demander` (les écritures, les commandes shell et les outils d'extension — MCP, plugins — sont confirmés ; la confirmation de chaque catégorie se règle dans les paramètres), `auto`, `strict` ; « Toujours » vaut pour la session.
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
