# openagenticskyzer — GUI App Design Spec

**Date :** 2026-04-26  
**Auteur :** JLSkyzer  
**Statut :** Validé

---

## 1. Vue d'ensemble

Ajout d'une interface graphique desktop à `openagenticskyzer`, lancée via `openagent -app`. L'app reprend toutes les capacités de l'agent CLI (modes ask/auto/plan, tous les providers, outils fichiers/shell/web) et les expose dans une interface visuelle sombre, inspirée de Claude Code desktop.

L'app et le CLI partagent la même logique agent (`openagentic_ai/`). L'app est une couche UI qui s'appuie sur le même core, sans dupliquer la logique métier.

---

## 2. Entrée / lancement

### CLI
```bash
openagent -app          # lance l'app en fenêtre native
openagent -app --port 8080  # port personnalisé (optionnel)
```

### Technologie UI : NiceGUI
- Framework Python pur, installé via `pip install openagenticskyzer[app]`
- Rendu HTML/CSS dans une fenêtre native (via `pywebview`) — pas de navigateur visible
- Permet de réutiliser exactement les styles des maquettes validées
- Dépendances additionnelles : `nicegui`, `pywebview`

### Démarrage
1. `agent.py` détecte `-app` dans les arguments
2. Lance `openagentic_ai/app/main.py` → serveur NiceGUI local
3. Ouvre une fenêtre native (`native=True`) titrée "openagent"
4. Charge la dernière session ou affiche l'écran d'accueil vide

---

## 3. Architecture

```
openagentic_ai/
├── agent.py               ← détecte -app, dispatch vers app/main.py
├── app/
│   ├── main.py            ← point d'entrée NiceGUI, routing des pages
│   ├── state.py           ← état global de l'app (dossier actif, modèle, settings)
│   ├── components/
│   │   ├── sidebar.py     ← liste des dossiers, bouton ouvrir
│   │   ├── chat.py        ← fil de messages + tool previews
│   │   ├── input_bar.py   ← textarea + model picker + send
│   │   ├── context_bar.py ← jauge contexte + auto-compact
│   │   ├── settings.py    ← panneau settings (toutes les pages)
│   │   └── model_modal.py ← popup ajout/sélection de modèle
│   └── storage.py         ← lecture/écriture config app (JSON), sessions
├── graph/                 ← inchangé
├── tools/                 ← inchangé
├── context/
│   └── messages.py        ← ajouter param `max_tokens: int | None` à trim_message_history()
├── permissions.py         ← nouveau : PermissionManager + PermissionToolNode
└── utils/utils.py         ← ajouter _DEFAULT_CTX_LIMITS + get_available_ollama_models()
```

---

## 4. Layout principal

### 4.1 Top bar
- Logo `◈ openagent` + badge mode actif (auto/ask/plan)
- Chemin du dossier actif affiché
- Bouton ⚙️ pour ouvrir les settings

### 4.2 Sidebar (230px)
- Bouton **"📂 Ouvrir un dossier"** en haut (dialog système de sélection de dossier)
- Section **"Historique des dossiers"** : liste des dossiers où une session existe
  - Nom du dossier (tronqué si long)
  - Chemin complet + date de dernière session
  - Clic → change le dossier actif, charge la session correspondante
- Dossier actif mis en surbrillance (bordure violette gauche)
- Scroll si liste longue

### 4.3 Zone de chat (principale)
- Fil scrollable des messages (utilisateur + IA)
- **Bulles utilisateur** : alignées à droite, fond violet sombre
- **Bulles IA** : alignées à gauche, fond gris sombre
- **Tool previews** : blocs compacts intercalés dans le fil, affichant :
  - Tag coloré du type d'action : `READ` (orange), `WRITE` (vert), `RUN` (bleu), `SEARCH` (violet)
  - Fichier/commande concerné
  - Pour WRITE : diff partiel (+N lignes, preview des 3 premières lignes ajoutées)
  - Pour RUN : commande + sortie (tronquée à 5 lignes)
- **Bannière de permission** (si mode "Demander") : barre orange avec 3 boutons
  - **Toujours** — ajoute l'action à la liste blanche du dossier
  - **Autoriser** — une fois
  - **Refuser** — bloque l'action

### 4.4 Barre de contexte (entre chat et input)
- Jauge de progression (0–100%) de l'utilisation du contexte
- Texte : `X% utilisé · ~N tokens`
- Bouton **"⚡ Auto-compact"** (manuel) + déclenche auto si seuil atteint
- Masquable depuis les settings

### 4.5 Zone d'input
- Textarea multilignes (Shift+Enter = nouvelle ligne, Enter = envoyer)
- **Bouton modèle** : affiche le modèle actif avec un point vert, ouvre le model picker au clic
- **Bouton envoyer** (►)
- Hints discrets : `⌘K commandes · @ mentionner fichier · /mode`

---

## 5. Sélecteur de modèle (model picker)

Popup ouverte depuis le bouton modèle dans l'input bar.

### Modèles détectés automatiquement
Affiche les providers dont la clé API est présente dans `.env` du dossier actif ou du dossier home.

- Si aucun modèle détecté → message : *"Aucun modèle configuré dans ce dossier. Configurez une clé API ou lancez Ollama."*

### Section Ollama
- Détection automatique : appel `ollama list` au chargement → liste les modèles installés localement
- Dropdown des modèles Ollama installés (ex : `qwen2.5-coder`, `llama3.2`, `mistral`)
- Bouton **"📥 Télécharger un modèle Ollama"** → ouvre un sous-panneau :
  - Champ de recherche du nom de modèle (ex : `codellama:7b`)
  - Bouton Télécharger → lance `ollama pull <model>` en arrière-plan avec barre de progression
  - Lien vers `ollama.com/library` pour explorer les modèles disponibles

### Bouton "➕ Ajouter un modèle (cloud)"
Popup avec formulaire :
- Sélecteur de provider : Together / Groq / Mistral / Gemini / OpenRouter
- Champ clé API
- Champ modèle (pré-rempli avec le défaut, modifiable)
- Bouton **Tester** → vérifie la clé avec un appel minimal
- Bouton **Enregistrer** → écrit dans `.env` du dossier actif

---

## 6. Panneau Settings

Accessible via ⚙️ dans la top bar. Remplace la zone principale (sidebar reste visible, atténuée).

### Navigation (onglets gauche)

**Global :**
- 🌐 Général
- 🧠 Contexte & Mémoire
- 🔒 Permissions
- 🎨 Apparence

**Dossier actif :**
- 📁 \<nom du dossier\>
- 🤖 Modèles
- 📝 Contexte dossier

**⚠️ Danger**

---

### 6.1 Général (global)
| Paramètre | Type | Défaut |
|---|---|---|
| Mode agent par défaut | radio ask/auto/plan | auto |
| Langue de l'interface | select | Français |
| Démarrer dans le dernier dossier | toggle | on |
| Animations | toggle | on |

### 6.2 Contexte & Mémoire (global)
| Paramètre | Type | Défaut |
|---|---|---|
| Limite de contexte | slider dynamique (max = max du modèle actif) | 50% du max |
| Tokens réservés pour la réponse | slider 512–8192 | 2048 |
| Auto-compact | toggle | on |
| Seuil auto-compact | slider 40–95% | 70% |
| Afficher la jauge de contexte | toggle | on |
| Rétention des sessions | select 7j/30j/90j/infini | 30j |

**Règle du slider de limite :**
- Lit le modèle actif → récupère son max théorique depuis `_DEFAULT_CTX_LIMITS`, nouvelle constante dans `utils.py` :
  ```python
  _DEFAULT_CTX_LIMITS = {
      "together": 128_000, "groq": 128_000, "mistral": 32_000,
      "gemini": 1_000_000, "openrouter": 128_000, "ollama": 32_000,
  }
  ```
- Pour Ollama : affiche un warning *"Limité par votre VRAM/RAM — vérifiez avec `ollama ps`"*
- Le slider est recalculé à chaque changement de modèle

### 6.3 Permissions (global)
| Paramètre | Type | Défaut |
|---|---|---|
| Niveau global | radio Demander/Auto/Strict | Demander |
| Exécution shell (run_command) | toggle | on (demander) |
| Écriture/suppression fichiers | toggle | off (auto) |
| Recherche internet | toggle | off (auto) |

**Niveaux :**
- **Demander** : bannière orange pour chaque action risquée
- **Auto** : aucune confirmation, tout s'exécute (équivalent `--dangerously-skip-permissions`)
- **Strict** : mode read-only forcé, aucune écriture ni exécution shell

**Même système pour le CLI :**
```bash
openagent --permission auto      # bypass total
openagent --permission strict    # lecture seule
openagent                        # défaut = demander si TTY, sinon auto
```
**Règle TTY :** si `sys.stdin.isatty()` est `True` (terminal interactif), le défaut est `demander`. Si le CLI est appelé dans un pipe ou script (`openagent "query" | ...`), le défaut bascule sur `auto` pour ne pas bloquer. L'utilisateur peut toujours forcer avec `--permission`.

### 6.4 Apparence (global)
| Paramètre | Type | Défaut |
|---|---|---|
| Thème | radio Sombre/Clair | Sombre |
| Taille de police | slider 11–16px | 13px |
| Largeur max des bulles | slider 50–90% | 70% |

### 6.5 Paramètres du dossier actif
| Paramètre | Type | Défaut |
|---|---|---|
| Mode agent pour ce dossier | radio Hériter/ask/auto/plan | Hériter |
| Fichiers ignorés | texte (style .gitignore) | node_modules/, .env, dist/ |
| Permissions spécifiques | toggle (override le global) | off |
| Prompt système custom | bouton → éditeur texte plein écran | vide |

### 6.6 Zone Danger
- **Effacer l'historique du dossier** (sessions JSON supprimées)
- **Retirer ce dossier de la sidebar** (ne supprime pas les fichiers projet)
- **Réinitialiser tous les paramètres** (config.json réinitialisé)

---

## 7. Système de permissions (CLI + App)

### Nouvelle option CLI
```bash
openagent [query] [--permission demander|auto|strict]
```

### Implémentation
- Nouveau fichier `openagentic_ai/permissions.py`
- `PermissionManager(mode, callback)` : singleton passé au graph à la construction
- **Point d'interception** : dans `graph/nodes.py`, le `tool_node` est remplacé par un `PermissionToolNode` qui appelle `PermissionManager.check(tool_name, args)` avant d'exécuter chaque tool
- En mode `demander` (app) : `callback` est une coroutine asyncio qui émet un événement NiceGUI → attend la réponse utilisateur (boutons Allow/Deny/Always)
- En mode `demander` (CLI) : `callback` fait un `input()` rich interactif ; si pas de TTY détecté (`sys.stdin.isatty() == False`), bascule automatiquement en mode `auto` pour ne pas bloquer
- En mode `auto` : `check()` retourne toujours `True` sans interaction
- En mode `strict` : `check()` retourne `False` pour toute action write/run, log l'action bloquée

### Actions soumises à permission (mode "demander")
- `run_command` — toujours
- `create_file`, `edit_file`, `delete_file` — si fichier hors du dossier actif
- `delete_dir` — toujours
- `internet_search` — configurable

### Liste blanche persistante (par dossier)
- Stockée dans `.openagent/permissions.json` dans le dossier projet
- Entrées : `{ "action": "run_command", "pattern": "npm *", "allow": true }`
- Le bouton "Toujours" dans la bannière ajoute une entrée

---

## 8. Stockage et persistance

### Config globale app
- Fichier : `~/.openagent/config.json`
- Contenu : tous les paramètres globaux (sections 6.1–6.4)

### Config par dossier
- Fichier : `<dossier>/.openagent/config.json`
- Contenu : paramètres dossier (section 6.5) + liste blanche permissions

### Sessions (existant, inchangé)
- Gérées par `context/persistence.py` (déjà implémenté)
- L'app les lit pour remplir la sidebar et restaurer les conversations

### Index des dossiers connus
- Fichier : `~/.openagent/folders.json`
- Liste des dossiers ayant eu au moins une session, avec métadonnées (dernière session, nombre de sessions)
- Mis à jour à chaque ouverture de dossier

---

## 9. Dépendances additionnelles

```toml
[project.optional-dependencies]
app = [
    "nicegui>=1.4",
    "pywebview>=4.0",
]
```

Installation :
```bash
pip install openagenticskyzer[app]
```

---

## 10. Périmètre hors-spec (non inclus dans ce plan)

- Authentification multi-utilisateurs
- Thème clair (interface uniquement, pas de fonctionnalité)
- Notifications système OS
- Raccourcis clavier avancés (au-delà de Enter/Shift+Enter)
- Synchronisation cloud des sessions
