# Vitesse du LLM local : mesurer, puis ne plus relire ce qui n'a pas changé

Date : 2026-10-25. Statut : conception validée par l'utilisateur, qui a validé la structure en six temps et pris les deux décisions ci-dessous.

## Intention

Sur le Qwen3.8-27B IQ3_M de l'utilisateur (CUDA, 19 couches sur 66, contexte 32 k), les mesures du 2026-10-24 donnent :
- **Relecture :** 4 074 jetons à chaque message, en 29 s.
- **Réflexion puis écriture :** 29 s de réflexion, puis 75 s d'écriture pour 110 jetons, soit environ 1 tok/s.
- **Chargement :** 33 s.

L'utilisateur veut un lot « bien structuré avec de bonnes recherches de où on peut optimiser le tout », mesures à l'appui.

La recherche du 2026-10-24 sert de base. Ses lignes font foi, et ses hypothèses sont marquées comme telles :
- `.superpowers/runs/perf-research-app.md` (chemin d'un tour dans l'app) ;
- `.superpowers/runs/perf-research-nlc.md` (leviers de node-llama-cpp 3.21.1) ;
- `.superpowers/runs/perf-research-web.md` (état de l'art llama.cpp, chiffres externes).

## Décisions de l'utilisateur (2026-10-25)

- **Prédiction multi-jetons (MTP) :** hors lot. On attend que node-llama-cpp l'expose officiellement. Le moteur llama.cpp embarqué la contient, mais la 3.21.1 ne l'expose pas. Le lot ajoute seulement un point de vigilance dans le bilan.
- **Réflexion :** un réglage « Longueur maximale de la réflexion », **sans limite par défaut**.

## Règle du lot

**Aucune optimisation n'est gardée sans mesure.** Chaque levier passe par le banc d'essai (objectif 1), avant et après. Un levier sans gain mesuré, ou avec une régression de qualité ou de stabilité, est retiré et consigné. Aucun chiffre n'est présenté comme mesuré s'il ne l'a pas été. Aucun outil ni réglage n'est retiré.

## Objectifs

1. **Banc d'essai reproductible**, à construire en premier.
   - **Scénarios fixes :**
     - **A.** Une conversation de 3 messages courts dans un dossier vide.
     - **B.** Un message qui déclenche un appel d'outil, `read_file` sur un petit fichier fourni.
     - **C.** Un démarrage à froid, puis un démarrage à chaud.
   - **Relevés par tour :** chargement (et ses étapes), lecture, réflexion, écriture, jetons d'entrée réellement évalués contre jetons réutilisés, tok/s, VRAM et RAM. Les mesures s'appuient sur le journal des tours existant, sur `sequence.tokenMeter`, sur `performanceTracking` et sur `printTimings()`, avec un indicateur de réutilisation par tour.
   - **Deux modèles :**
     - **un petit**, en tests automatiques : `stories260K` pour la mécanique ;
     - **le 27B de l'utilisateur**, en passage manuel, avec son accord et sans jeu lancé.
   - **Sortie :** un fichier de résultats daté, qui sert de point de comparaison.
2. **Ne plus relire ce qui n'a pas changé.** C'est le gain attendu le plus gros, mais il reste une hypothèse à prouver.
   - **Mesurer d'abord la réutilisation réelle**, du message 2 au message 4 du scénario A.
   - **Modèles hybrides et récurrents :**
     - points de sauvegarde (`getSequence({checkpoints})`) juste après la partie fixe : instructions et outils ;
     - un intervalle plus court que les 8 192 jetons par défaut ;
     - un plafond de mémoire.
   - **Préserver l'historique déjà évalué :** garder la réflexion de la réponse précédente dans l'historique rendu, si le gain est mesuré (`keepOnlyLastThought`, ou l'équivalent pour un modèle Jinja). Repasser `lastEvaluationContextWindow` / `contextShift.lastEvaluationMetadata` d'un appel à l'autre.
   - **Ordre stable du prompt :** les parties qui changent (mémoire, contexte du projet) passent après les outils, si le modèle supporte ce placement. La liste et l'ordre des outils restent stables d'un tour à l'autre.
3. **Alléger la description des outils.** Elle pèse environ 3 700 jetons, soit environ 88 % de la relecture.
   - Raccourcir les descriptions et compacter les schémas, **sans retirer d'outil**.
   - La qualité d'appel des outils est vérifiée par le scénario B et par les tests d'agent existants.
4. **Charger plus vite.**
   - Démarrer le moteur (`getLlama` et son test du binaire) en arrière-plan dès l'ouverture de l'app, et non au premier message.
   - Charger le modèle en parallèle de la préparation des outils.
   - Utiliser la limite de couches mémorisée sous forme numérique, avec `useMmap` explicite, ce qui demande moins de sondages.
   - Mesurer le gain de chacune de ces actions.
5. **Écrire plus vite.**
   - La prédiction par recopie (`InputLookupTokenPredictor`), sans modèle en plus.
   - La taille des lots pour la lecture (512 aujourd'hui).
   - Le nombre de threads.
   - La compression du cache (q8_0), dont le gain est probablement faible sur un modèle hybride ; à mesurer.
   - Le réglage « Longueur maximale de la réflexion » (décision ci-dessus).
6. **Moins de concurrence en arrière-plan.**
   - L'index sémantique devient incrémental, limité en ressources, et mis en pause pendant un tour.
   - Les serveurs MCP restent en vie au lieu d'être relancés à chaque tour.
   - La réallocation entre deux tours tient compte du coût de vider le cache.

## Hors objectifs

- La prédiction multi-jetons et toute modification du module natif de node-llama-cpp.
- Le débordement Vulkan sur NVIDIA, dont la cause reste inconnue.
- Les projets 2 (catalogue) et 3 (perception).

## Contraintes

- Tests réels, rouge d'abord. `OPENAGENT_HOME` isolé dans les tests.
- La suite complète tourne seule, une fois par tâche.
- Les tests à fenêtre tournent une seule fois chacun.
- Pas de passage lourd quand un jeu tourne : les processus de tests AxionEngine ou Unity d'autres sessions sont tolérés.
- Les passages sur le 27B se font **seulement avec l'utilisateur présent**.
- Dépôt public : aucun chemin personnel. Interface en français.

## Vérification attendue

- Le banc d'essai produit un fichier de référence avant toute optimisation, et un fichier après chaque levier gardé.
- Le bilan présente un tableau avant / après sur le 27B : lecture du message 2, tok/s, chargement à froid et à chaud. Chaque chiffre y est marqué « mesuré ».
- Pas de régression : suite complète, tests d'agent et d'outils, tests à fenêtre touchés une fois.
