# Modèles 100 % locaux : la sélection du modèle n'offre plus que des fichiers `.gguf` locaux

Date : 2026-10-17. Statut : conception à valider par l'utilisateur ; non implémentée.
Relue par un builder (3 questions, tranchées ci-dessous par l'utilisateur ou notées comme
choix de conception).

## Intention

Décision de l'utilisateur (2026-10-17) : « je ne veux plus aucun fournisseur en ligne en
gros ». Les modèles de l'app sont **uniquement** les fichiers `.gguf` de sa bibliothèque,
chargés par l'app elle-même (node-llama-cpp).

Précision de l'utilisateur (2026-10-17), qui borne tout le lot : « On ne retire AUCUN
outil hein, tout doit être conserver voir ajouté si il en manque même. Quand je parlais
d'en ligne, je parlais des provider en ligne. en gros dans la sélection du modèle plus de
provider autre que des fichiers locaux ». Seule la **sélection du modèle** change : le
coffre des connexions, le client HTTP de chat, le formulaire fournisseur / URL / clé et
les clés enregistrées partent. Aucun outil et aucun réglage n'est retiré.

Réponses de l'utilisateur aux questions de cadrage :

- **périmètre** : plus de modèles en ligne. Un `.gguf` ne s'ajoute qu'à partir d'un
  fichier déjà présent sur le disque, ce qui est déjà le seul chemin existant ;
- **clés API enregistrées** : « Les effacer ». Le coffre des connexions est supprimé au
  premier lancement de la nouvelle version ;
- **modèle d'embeddings** de la recherche sémantique : « L'inclure dans l'app ». Il est
  livré dans l'installeur et tout téléchargement est interdit.

L'étape précédente (commit 40cc3b3) a retiré Ollama, LM Studio et llama.cpp serveur. Ce
lot retire le reste : OpenRouter, Together, Groq, Mistral et Gemini.

## Objectifs

1. **Un seul moteur de modèle**, le moteur local GGUF (`core/local-engine.mts`,
   `localProvider`).
   - L'agent, la compaction et toute génération passent par lui.
   - Sans `.gguf` actif, l'envoi est refusé avec un message clair qui dit d'ajouter ou de
     choisir un modèle `.gguf`. Rien ne part sur le réseau.
2. **Suppression des fournisseurs en ligne**, dans le cœur et dans l'interface.
   - Cœur : `core/connections.mts` (coffre, profils, consentement d'URL, lecture des `.env`
     et des `current_provider`/`current_model` hérités), le client HTTP
     `ChatProvider` de `core/provider.mts`, `OUTPUT_CAPS`, `CONTEXT_WINDOWS`.
   - Processus principal : les ops `connection-snapshot` / `save-connection` et
     `resolveSendPayload` dans `main.cjs`.
   - Interface : le formulaire fournisseur, URL, clé et la fenêtre de consentement dans
     `ModelDialog`, plus `providers.ts`, `ProviderName`, `ConnectionSnapshot` /
     `ConnectionPatch` et `getConnection` / `saveConnection`.
   - Les **types** partagés (`ChatMessage`, `ToolCall`, `ToolSchema`…) restent, déplacés
     si besoin dans un module sans client HTTP. `connection` cesse d'être un paramètre
     de `runAgent`, `compactMessages` et `outputCap`.
3. **Effacement des clés.** Au démarrage, une fois, l'app supprime :
   - `<dataHome>/connections.v1.json` ;
   - ses copies écrites par `JsonStore` (`*.pre-electron.bak` et fichiers temporaires) ;
   - les clés `current_provider` et `current_model` du `config.json` global.

   **La sauvegarde `config.json.pre-electron.bak`** (copie d'avant Electron) est
   **nettoyée, pas supprimée**, sur décision de l'utilisateur (« Nettoyer seulement ces
   clés »). On n'y retire que `current_provider` et `current_model`, et tout le reste
   reste tel quel. `hf_token` n'est **jamais** effacé, ni du `config.json` ni de cette
   sauvegarde : le jeton Hugging Face est gardé (objectif 5).
   - Ce nettoyage, et celui du `config.json` lui-même, ne doit **pas** créer de nouvelle
     sauvegarde contenant encore ces clés. `JsonStore.update` copie le fichier avant sa
     première écriture : il faut donc soit nettoyer après coup, soit écrire sans passer
     par cette copie. Le builder choisit et le prouve par test.

   La suppression est idempotente et ne fait jamais échouer le démarrage : un échec est
   journalisé et retenté au lancement suivant. La migration du dossier de données
   (`core/data-dir.mts`) ne connaît plus ce fichier. Les fichiers `.env` des projets de
   l'utilisateur ne sont **jamais** touchés : ils lui appartiennent. L'app cesse
   simplement de les lire.
4. **Outils web de l'agent gardés.** L'utilisateur est revenu sur une première version de
   cette conception (2026-10-17) : « DONC TOI TU VOIT DE LA LOGIQUE A ENLEVER LES OUTILS
   LES PLUS IMPORTANT POUR UNE IA ? ». « Plus de fournisseur en ligne » vise les
   fournisseurs de **modèles** seulement. `fetch_url`, `internet_search` et tout ce qui
   les accompagne restent inchangés (voir « Hors objectifs »).
5. **Jeton Hugging Face gardé** : `core/hf-token.mts`, l'op `test-hf-token`, le réglage
   `hf_token`, la section de l'onglet Général et la mention dans l'onglet Danger restent
   inchangés, et une valeur `hf_token` enregistrée n'est pas effacée (voir « Hors
   objectifs »).
6. **Modèle d'embeddings livré dans l'app.**
   - Décision : on livre la variante **quantifiée** de `Xenova/all-MiniLM-L6-v2` (environ
     23 Mo, estimation à vérifier). La variante fp32 que la bibliothèque charge
     aujourd'hui pèse environ 90 Mo, trop pour le dépôt public.
   - Les fichiers sont téléchargés **une seule fois par le développeur**, licence
     vérifiée, puis commités dans le dépôt. L'app, elle, ne télécharge jamais rien.
   - Les vecteurs changent légèrement. La **version du format de l'index sémantique** (et
     de la base de connaissances) est donc incrémentée, et un index d'ancienne version
     est reconstruit automatiquement une fois, sans jamais mélanger d'anciens et de
     nouveaux vecteurs.
   - Ces fichiers sont empaquetés dans l'installeur.
   - Le chargeur (`core/embeddings.mts`) pointe dessus et désactive tout téléchargement
     (`allowRemoteModels = false`, chemin local).
   - En développement, le même dossier est pris dans le dépôt, ou dans un dossier de
     ressources documenté ; c'est au builder de choisir.
   - Si le modèle manque, la recherche sémantique échoue proprement avec un message ;
     elle ne télécharge jamais.
   - La **licence** du modèle (Apache-2.0 annoncée) est vérifiée et citée avant
     l'empaquetage.
   - Le cache existant `<dataHome>/embeddings-cache/` peut rester ; il n'est plus utilisé.
7. **Fenêtre de contexte réelle.** La jauge de contexte, la compaction automatique et le
   curseur de l'onglet Contexte lisent la fenêtre du moteur local, et non plus une table
   par fournisseur. Ces trois éléments lisaient jusqu'ici la fenêtre du fournisseur en
   ligne même avec un `.gguf` actif.
   - Le worker connaît `engineContextSize` une fois le modèle chargé. Avant chargement,
     on prend une valeur prudente (`MIN_CONTEXT`, 16 384) ou la valeur lue dans les
     métadonnées du `.gguf`, au choix du builder, qui le dit.
   - Le réglage `max_tokens` reste un plafond.
8. **Textes de l'interface.**
   - L'étape « modèle » de l'accueil dit d'ajouter un fichier `.gguf`.
   - Le bouton du modèle affiche le `.gguf` actif ou « Aucun modèle ».
   - L'en-tête d'export nomme le `.gguf` actif ; il citait jusqu'ici la connexion en ligne
     même avec un modèle local actif.
9. **Un seul endroit décide du modèle actif.**
   - `active_local_model` (dans `config.json`) est la seule source.
   - Le worker le lit lui-même, au lieu de se fier au seul identifiant envoyé par
     l'interface.
   - Un identifiant dont le fichier a disparu est signalé (« Modèle local introuvable »)
     et l'interface invite à en choisir un autre.

## Hors objectifs (gardés, car non liés aux modèles)

Aucun outil et aucun réglage n'est retiré (« On ne retire AUCUN outil hein »). Restent
inchangés :

- **Les outils web de l'agent** (objectif 4) : `core/web-tools.mts` (`fetch_url`,
  `internet_search`, Tavily, DuckDuckGo), la catégorie d'outil `network`, le réglage
  `search_ask` et son interrupteur dans l'onglet Permissions, le badge SEARCH, les détails
  de carte, l'étiquette d'export `search` et la phrase du prompt système sur le contenu
  venant d'Internet.
- **Le jeton Hugging Face** (objectif 5) : `core/hf-token.mts` (qui appelle
  `huggingface.co`), l'op `test-hf-token`, le réglage `hf_token`, la section de l'onglet
  Général et la mention dans l'onglet Danger.
- **Les pièces jointes image restent comme aujourd'hui**, sur décision de l'utilisateur. On
  peut toujours en joindre ; le modèle local reçoit la note « image ignorée ». La vision
  arrive au lot suivant, « vision + débordement VRAM vers RAM/CPU » (voir
  `tasks/todo.md`). Ce lot ne doit rien casser de ce chemin.
- Les mises à jour automatiques de l'app (GitHub Releases).
- `git push` / `git pull`.
- Les serveurs MCP distants ajoutés par l'utilisateur.
- Le lien vers highlight.js (cdnjs) dans l'export HTML. C'est une limite connue, à noter
  au bilan.
- La CSP du renderer (`connect-src https:`) : elle peut être resserrée si plus rien ne
  l'utilise. C'est au builder de vérifier ; à défaut, la noter.

## Anti-objectifs (échec même si « ça marche »)

- Un chemin restant qui envoie un prompt ou un fichier du projet vers un service en ligne.
- Une clé API qui reste lisible sur le disque après le premier lancement, dans le coffre,
  sa sauvegarde ou `config.json`.
- La recherche sémantique qui télécharge quoi que ce soit.
- Un démarrage qui échoue à cause d'un ancien coffre, d'un ancien `config.json` ou d'un
  ancien historique.
- Des tests affaiblis : une preuve qui existait (boucle de l'agent, outils, permissions,
  compaction, interruption, reprises…) doit continuer d'exister sur le nouveau chemin.

## Contraintes

- Tests réels sans mocks, avec le test rouge écrit d'abord.
- Les données réelles de l'utilisateur ne sont jamais touchées par les tests :
  `OPENAGENT_HOME` est isolé.
- Tout test qui ouvre une fenêtre est lancé **une seule fois** ; un échec est rapporté,
  pas relancé.
- Dépôt public : aucun chemin ni aucune donnée personnelle.
- Aucun appel réseau dans les tests, hors faux serveurs locaux propres aux tests.

## Ce qui est laissé au builder (décisions à justifier dans le plan)

- **Remplacer le harnais de test.** Aujourd'hui, presque tous les tests du worker et de
  l'interface pilotent l'agent par le client HTTP contre un faux serveur OpenAI local.
  Il faut une couture de test qui permette d'injecter un fournisseur scripté dans le
  worker. Elle doit être **inaccessible dans l'app empaquetée** : autorisée seulement
  quand le processus principal l'active hors empaquetage, jamais par une simple variable
  d'environnement dans l'app installée. Le petit `.gguf` de test (`stories260K.gguf`)
  sert à prouver le vrai chemin local de bout en bout. Le builder choisit la forme et
  montre que la couture ne peut pas servir à rouvrir un accès réseau.
- **Fenêtre de contexte avant le chargement du modèle**, voir l'objectif 7.
- **Emplacement des fichiers d'embeddings** en développement et dans le paquet
  (`extraResources` ou `asarUnpack`), et la vérification de leur présence à la
  construction.
- **Découpage en tâches.** Le harnais d'abord ; puis le cœur ; puis l'effacement des clés
  et la migration ; puis les embeddings ; puis l'interface ; puis les preuves en fenêtre
  et la clôture.

## Vérification attendue

- Suite complète, `tsc` du cœur (5 erreurs préexistantes) et du renderer (0), et
  construction du renderer.
- Un test qui prouve qu'aucun module de production n'importe plus `ChatProvider`, ne
  référence plus `api.openrouter` ni les autres hôtes des fournisseurs de modèles en
  ligne, et qu'`embeddings.mts` ne peut pas télécharger. Ce test n'interdit ni `tavily`,
  ni `duckduckgo`, ni `huggingface.co` : les outils web et le jeton Hugging Face sont
  gardés.
- Un test de l'effacement au démarrage : un coffre, sa copie `.bak`, et un `config.json`
  avec `current_provider`, `current_model` et `hf_token` ; après le démarrage, le coffre,
  ses copies et les deux clés de fournisseur ont disparu, `hf_token` est intact, rien
  d'autre n'a bougé, et un second démarrage ne fait rien.
- La recherche sémantique fonctionne hors ligne avec le modèle livré.
- L'app empaquetée : `package:win` puis `test:package`, lancés une seule fois, et la
  présence du modèle d'embeddings dans le paquet.
- Les tests à fenêtre touchés, une seule fois chacun.
