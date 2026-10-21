# Diagnostic des tours : voir ce que fait l'IA, l'arrêter vraiment, séparer sa réflexion

Date : 2026-10-21. Statut : conception décidée par l'agent (l'utilisateur a demandé d'enchaîner « d'une traite sans te stopper ») ; à relire par l'utilisateur au retour.

## Intention

La mesure réelle du 27B (2026-10-21) a montré qu'on ne peut pas savoir ce que fait l'IA pendant un tour.

**Ce qu'on a observé :**
- **Aucun retour visuel** : environ 5 min sans rien à l'écran, pas de statut, pas de chronomètre.
- **Un stop qui tarde** : il met longtemps à couper.
- **Une réflexion qui fuit** : le raisonnement en anglais s'affiche dans la réponse, terminé par un `</think>` littéral.
- **Aucun journal** pour comprendre ce qui s'est passé.

**Demandes de l'utilisateur :**
- « tout enregistrer pour debug le coeur et le cerveau de l'ia » ;
- un chronomètre sous chaque réponse ;
- la réflexion séparée de la réponse, « un peu comme le fait claude code » ;
- les dossiers de `~/.openagent` créés au démarrage « pour que le client sache les différentes possibilités ».

S'y ajoutent les défauts relevés en passant : une bulle qui défile sur le côté, le texte du chat vide alors qu'un dossier est ouvert, le bruit de l'updater quand aucune release n'existe, et le débordement Vulkan sur NVIDIA.

La carte du code est dans `.superpowers/runs/explore-turn-diagnostics.md` (repérage du 2026-10-21) et ses lignes font foi.

## Objectifs

1. **Phases d'un tour, en direct.** Le worker émet un événement d'agent `phase` à chaque changement. Les phases :
   - `preparing` : outils, instructions, serveurs MCP ;
   - `loading` : chargement du modèle, avec un pourcentage tiré de `onLoadProgress` de node-llama-cpp ;
   - `reading` : lecture du message (prefill), de l'entrée dans `generateResponse` jusqu'au premier morceau généré ;
   - `thinking` : morceaux de réflexion ;
   - `writing` : texte de la réponse ;
   - `tool` : avec le nom de l'outil ;
   - `stopping` : dès que le stop est demandé.

   **Affichage dans le chat :** sous le dernier message, une ligne de statut remplace les trois points actuels :
   - « Préparation… »
   - « Chargement du modèle… 42 % »
   - « Lecture du message… »
   - « Réflexion… »
   - « Écriture… »
   - « Outil : internet_search… »
   - « Arrêt en cours… »

   Elle porte un chronomètre qui tourne depuis l'envoi.
2. **Chronomètre par réponse.** Le worker mesure et joint à la fin du tour (`done` comme `stopped`) un objet `timing` :
   - `loadMs`, `readMs` (jusqu'au premier morceau, réflexion comprise), `firstTextMs` (jusqu'au premier mot de la réponse) et `totalMs` ;
   - `outputTokens` et `tokensPerSecond` quand ils sont connus.

   **Stockage :** le timing est enregistré sur le message assistant (le transcript le garde).

   **Affichage :** une ligne discrète sous chaque réponse, par exemple « 1ᵉʳ mot 4,2 s · total 12,8 s · 8,3 tok/s · chargement 35 s ». Le chargement n'apparaît que s'il a eu lieu.
3. **Réflexion séparée.**
   - **Lecture :** les morceaux de réflexion sont lus par `onResponseChunk` (segments `thought` de node-llama-cpp). Ils sont envoyés en événements `thinking` et ne passent plus dans le texte.
   - **Repli applicatif :** si le texte contient `</think>` sans `<think>` ouvrant avant, ce qui précède est de la réflexion. Il en va de même pour un `<think>…</think>` complet resté dans le texte.
   - **Stockage :** la réflexion est enregistrée sur le message assistant (`reasoning`). Elle n'est jamais renvoyée au modèle, comme aujourd'hui.
   - **Affichage :** un bloc « Réflexion » repliable au-dessus de la réponse. Il est ouvert pendant que le modèle réfléchit, puis replié une fois la réponse finie, avec sa durée.
   - **Journal au chargement :** le nom du chat wrapper résolu et ses réglages de segments.
4. **Un stop qui coupe vraiment.**
   - **Ce qui rend la main au stop :**
     - le chargement du modèle (`loadSignal`) ;
     - la création du contexte (`createSignal`) ;
     - l'attente d'une estimation (`windowFor` / `idle()`) ;
     - l'attente du verrou de chargement.
   - **Ce que voit l'utilisateur :** le renderer passe tout de suite en « Arrêt en cours… », et le bouton est désactivé jusqu'à l'événement `stopped`.
   - **Limite connue, documentée :** node-llama-cpp ne permet pas d'interrompre la lecture du prompt (prefill) en cours. Le stop prend alors effet à la fin de cette lecture. La latence réelle du stop est mesurée et journalisée.
5. **Journal complet des tours.** C'est un fichier JSON Lines par jour, `<dataHome>/logs/turns/AAAA-MM-JJ.jsonl`, écrit par le worker.
   - **Une ligne par événement**, avec horodatage, `runId` et dossier :
     - le début du tour, avec le modèle, le moteur, le placement et la taille du contexte ;
     - chaque phase et sa durée ;
     - la taille du prompt en tokens ;
     - chaque appel d'outil, avec ses arguments, sa durée, ok ou erreur, et son résultat ;
     - la réflexion et la réponse ;
     - les statistiques de génération ;
     - le stop et sa latence ;
     - les erreurs.
   - **Réglage `turn_log` : `full` (défaut, c'est la demande de l'utilisateur) | `metadata` | `off`.**
     - `metadata` omet les contenus : textes, arguments, résultats.
     - `full` garde les contenus, tronqués à 20 000 caractères par champ.
   - **Masquage :** quel que soit le niveau, le journal masque :
     - `hf_token` ;
     - les `env`/`headers` MCP ;
     - les résultats d'outils de fichiers portant sur un fichier sensible (`isSensitiveFile` / `protectedPathMatcher`) ;
     - toute valeur qui ressemble à un jeton connu (motifs `hf_`, `ghp_`, `github_pat_`, `sk-`…).
   - **Rétention :** 14 jours, avec un nettoyage au démarrage du worker.
   - **Accès :** Réglages › Général gagne « Journal des tours » (le select) et un bouton « Ouvrir le dossier des journaux ».
   - **Pas une sauvegarde :** ce journal sert au diagnostic. La conversation reste enregistrée dans le projet comme aujourd'hui.
6. **Dossiers de données visibles.**
   - **Création au démarrage :** l'app crée les dossiers qu'elle lit et qui manquent : `knowledge/`, `tools/` et `logs/`. Le pack CUDA (`cuda-pack/`) reste géré par son installeur.
   - **`LISEZMOI.txt` à la racine :** un fichier régénéré à chaque démarrage, propriété de l'app. Il décrit en français chaque fichier et dossier du dossier de données : son rôle, qui l'écrit, et ce que l'utilisateur peut y déposer, comme des outils `.mjs` dans `tools/`. Les dossiers par projet (`<projet>/.openagent/`) y sont aussi décrits.
   - **Aucun fichier existant n'est modifié ni déplacé.**
7. **Corrections d'interface.**
   - **Mots trop longs :** un mot très long ne fait plus défiler le chat sur le côté (`overflow-wrap: anywhere` sur le markdown et les bulles).
   - **Chat vide :** avec un dossier ouvert, il affiche une invitation à écrire, pas « Ouvre un dossier pour commencer. ».
8. **Updater sans release.**
   - **Ce qui change :** quand GitHub répond qu'aucune release n'est publiée (HTTP 404/406), l'état devient « Aucune version publiée pour l'instant ».
   - **Ce qui disparaît :** ce n'est plus un « Échec », et le journal n'affiche plus de pile d'erreur.
9. **Conseil CUDA sur NVIDIA.**
   - **Condition :** le moteur est Vulkan sur une carte NVIDIA.
   - **Texte affiché** dans l'onglet Matériel : « Sur les cartes NVIDIA, le pack CUDA est recommandé : avec Vulkan, une partie du modèle peut déborder en mémoire partagée et ralentir fortement les réponses. »

   C'est le fait mesuré le 2026-10-21 (2,1 Gio contre 0,14 Gio en mémoire partagée), dont la cause reste inconnue.

## Hors objectifs

- **Interrompre le prefill en cours :** la bibliothèque ne le permet pas (voir l'objectif 4).
- **La cause du débordement Vulkan :** elle reste inconnue. L'objectif 9 conseille, il ne corrige pas.
- **La publication réelle du pack CUDA** (release) : elle demande l'accord explicite de l'utilisateur.
- **Les projets 2 (catalogue) et 3 (perception)**, et l'audit des outils.
- **Aucun outil ni réglage n'est retiré** (règle de l'utilisateur).

## Contraintes

- **Tests :** tests réels, rouge d'abord, `stories260K.gguf` comme modèle réel, `OPENAGENT_HOME` isolé.
- **Tests à fenêtre :** une seule fois chacun, sortie complète dans un fichier.
- **Charge :** la suite complète tourne seule, une fois par tâche, au premier plan (l'utilisateur joue sur ce PC).
- **Dépôt public :** aucun chemin personnel.
- **Langue :** textes d'interface en français.
- **Journal :** il ne doit jamais contenir de secret, ce qui se vérifie par un test qui y injecte des jetons factices.

## Vérification attendue

- **Suite et build :** suite complète, `tsc` cœur (5 erreurs de référence) et renderer (0), build du renderer.
- **Tests worker sur `stories260K` :**
  - les événements `phase` dans l'ordre (`preparing` → `loading` → `reading` → `writing` → fin) ;
  - le `timing` joint ;
  - un stop pendant `loading` rend la main avant la fin du chargement ;
  - le journal du tour existe et ne contient aucun jeton injecté.
- **Tests unitaires :**
  - le découpage de la réflexion (avec et sans `<think>` ouvrant, morceaux à cheval sur la balise) ;
  - le masquage ;
  - la rétention ;
  - le `LISEZMOI.txt` ;
  - l'updater 404/406.
- **Tests à fenêtre touchés**, une fois chacun : le statut et le chronomètre visibles pendant un tour, la réflexion repliable.
- **Vérification manuelle avec l'utilisateur, si possible :** un tour sur un modèle qui réfléchit (Qwen3), avec la réflexion séparée et le journal lu.
