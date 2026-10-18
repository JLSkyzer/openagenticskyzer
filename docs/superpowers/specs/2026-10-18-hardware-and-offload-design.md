# Matériel et débordement : voir la machine, maîtriser la répartition carte / processeur, CUDA en option

Date : 2026-10-18. Statut : conception à valider par l'utilisateur ; non implémentée.
Projet 1 sur 3 (ordre validé par l'utilisateur : 1. matériel et débordement, 2. catalogue
de modèles noté sur 5, 3. perception image / audio / vidéo).

## Intention

L'utilisateur veut charger des modèles `.gguf` plus gros que la VRAM de sa carte en
répartissant les couches entre la carte graphique et le processeur avec la RAM (« swap »
dans ses mots). Il en parle depuis longtemps : l'app Python le faisait
(`estimate_gpu_layers`, étiquette `python-final`), et la migration ne l'a pas repris
explicitement. Ce projet est aussi la base du projet 2, où chaque modèle reçoit une note
sur 5 calculée pour la machine de l'utilisateur.

Repérage du 2026-10-18 (node-llama-cpp 3.21.1, RTX 4060, Ryzen 7 5800X, 32 Gio de RAM) :

- **Le débordement marche déjà.** L'app charge avec `gpuLayers` « auto » : les couches qui
  ne tiennent pas dans la VRAM restent sur le processeur. Mais rien n'est affiché.
- **Le nombre de couches diffère selon la question posée.** Pour le même 27B, on obtient
  34 (« auto »), 31 (`fitContext` 16 384) ou 28 (évaluateur). Le chiffre réellement
  chargé n'est pas garanti.
- **Le contexte peut gonfler.** Quand il reste de la mémoire, le contexte « auto » monte
  jusqu'à 160 000 à 260 000 tokens et consomme la RAM.
- **L'estimation sans chargement existe.** Elle fonctionne même sur un fichier distant
  lu par plages (`readGgufFileInfo`, `GgufInsights`). Elle prend 10 à 20 s par modèle
  (évaluateur), et 60 à 110 s pour la résolution fine des couches.
- **L'app installée tourne en Vulkan sur NVIDIA.** Les binaires CUDA de node-llama-cpp
  ne sont pas livrés (`win-x64-cuda` 168 Mo, `win-x64-cuda-ext` 351 Mo). Sur la machine de
  l'utilisateur, CUDA ne se lance pas faute de runtime.

Décision de l'utilisateur (2026-10-18) : **CUDA en option**.

## Objectifs

1. **Voir la machine.** L'app détecte et affiche :
   - le moteur utilisé (CUDA, Vulkan ou processeur) ;
   - le nom de la carte ;
   - la VRAM totale et libre ;
   - la RAM totale et libre ;
   - le processeur et ses cœurs de calcul.

   Elle les affiche dans une section « Matériel » des réglages. Les valeurs sont lues par
   le worker via node-llama-cpp et Node (`os`). Un bouton les relit.
2. **Une répartition déterministe.** Le chargement d'un modèle demande explicitement la
   répartition qui laisse la place au contexte voulu
   (`gpuLayers: { fitContext: { contextSize } }`). Le nombre de couches affiché avant le
   chargement doit être celui qui est réellement chargé. Si même 0 couche ne tient pas,
   l'erreur est claire et en français, et rien n'est à moitié chargé.
3. **Un contexte plafonné.** Le contexte d'un modèle local ne grandit plus selon la
   mémoire libre. Il vaut `max(MIN_LOCAL_CONTEXT, valeur réglée)`, plafonné par le
   contexte d'entraînement du modèle et par le réglage `max_tokens` existant.
   - `MIN_LOCAL_CONTEXT` vaut 16 384.
   - La règle exacte est laissée au builder, qui la justifie. Une valeur supérieure à
     l'entraînement reste permise comme aujourd'hui pour un petit modèle (16 384).
4. **Afficher la répartition.**
   - **Bouton du modèle et fenêtre de choix.** Le modèle actif montre :
     - « N/M couches sur la carte » (ou « tout sur la carte », ou « processeur seul ») ;
     - la VRAM et la RAM qu'il utilise une fois chargé ;
     - avant le chargement, l'estimation, marquée comme telle.
   - **Événement du worker.** L'information passe par l'événement `model` existant
     (`ModelStatus`), étendu de champs facultatifs, et par l'op `model-status`.
5. **Une estimation réutilisable.** Le worker expose une estimation sans chargement pour un
   fichier local, par une op dédiée. L'estimation donne :
   - le nombre de couches sur la carte ;
   - la VRAM et la RAM nécessaires au contexte visé ;
   - un indicateur « tient sur la carte / déborde / ne tient pas ».

   Comportement attendu :
   - **Résultat mis en cache.** La clé est le fichier (taille et date de modification ou
     empreinte), le matériel et le contexte.
   - **Calcul annulable.** Le calcul se fait en arrière-plan, sans bloquer l'interface, et
     peut être annulé.
   - **Lecture distante préparée.** L'interface est prévue pour accepter plus tard une
     source distante (projet 2), sans l'implémenter pour l'interface ici.
6. **CUDA en option.** Pour une carte NVIDIA :
   - **Un pack CUDA téléchargeable** depuis la section « Matériel », sur clic, avec la
     taille affichée avant le téléchargement, une vérification d'intégrité, la vérification
     de l'espace disque et une annulation possible.
   - **Utilisation au prochain chargement.** Une fois installé, l'app utilise CUDA si le
     pack se charge ; sinon elle revient à Vulkan avec un message.
   - **Désinstallation.** On peut le désinstaller.
   - **Sans pack ou sans NVIDIA :** comportement actuel, Vulkan puis processeur.

## Décisions après relecture (2026-10-18)

**De l'utilisateur**
- **Contexte :** nouveau réglage « Contexte des modèles locaux » dans la section Matériel.
  Valeurs : 16k, 32k, 64k, 128k ou « max du modèle ». Défaut **32 768**, plafonné par ce que
  le modèle supporte. Changer la valeur recharge le modèle au message suivant. Le réglage
  `max_tokens` existant reste un plafond de la fenêtre de requête, comme aujourd'hui.
  L'objectif 3 se lit avec cette valeur.
- **Pack CUDA publié avec chaque release.** Le script de release construit le pack
  correspondant à la version exacte du moteur et le publie dans la même release GitHub
  publique : morceaux de moins de 2 Gio, empreinte intégrée à l'app.
  - Cela suppose que la licence NVIDIA autorise la redistribution. C'est vérifié d'abord ;
    si elle ne l'autorise pas, on le dit avant d'implémenter.
  - Si, après une mise à jour, le pack installé ne correspond plus, l'app repasse en Vulkan
    et propose de télécharger le bon pack.
  - Une publication réelle n'a lieu qu'avec l'accord explicite de l'utilisateur. Toute
    exécution du script de release se fait en `--dry-run`.
- **Mesure finale** sur le 27B IQ3_M que l'utilisateur a dans ses Téléchargements, avec son
  accord. Le fichier est ajouté à la bibliothèque d'une app de test isolée : on ne touche
  ni sa vraie bibliothèque, ni le fichier.

**Choix de conception (miens)**
- **Ré-ajustement au chargement.** On charge avec `gpuLayers: { fitContext }`, qui relit la
  VRAM libre à ce moment-là. Le chiffre affiché avant le chargement est une estimation,
  marquée « estimé ». Après le chargement, c'est le nombre réel (`model.gpuLayers`) qui
  s'affiche. Cette lecture remplace la formulation de l'objectif 2 : le chiffre **chargé**
  est toujours vrai, le chiffre **estimé** peut différer si la VRAM libre a changé entre-temps.
- **Mémoire « utilisée » une fois chargé.** Si node-llama-cpp expose une mesure par modèle
  (`model.memoryUsage` est signalé par le repérage, à confirmer), elle est affichée comme
  mesurée. Sinon, la valeur est marquée « estimé » ; jamais une différence globale avant /
  après présentée comme une mesure.

## Hors objectifs

- Le catalogue noté, la recherche Hugging Face et le téléchargement de modèles : projet 2.
- La perception : image, audio, vidéo, llama.cpp embarqué (projet 3).
- Le dossier configurable des modèles téléchargés : projet 2. Le pack CUDA, lui, va dans
  le dossier de données de l'app.
- Tous les outils et réglages existants restent intacts. Règle de l'utilisateur :
  « On ne retire AUCUN outil ».

## Anti-objectifs

- Un chiffre affiché qui ne correspond pas à ce qui est chargé.
- Un chargement qui gèle l'interface pendant une estimation de 60 s.
- Un pack CUDA qui empêche l'app de démarrer, ou qui la laisse sans moteur, s'il est absent,
  corrompu ou incompatible.
- Une estimation présentée comme une mesure. Les valeurs avant chargement sont marquées
  « estimé ».

## Contraintes

- Tests réels sans mocks, test rouge d'abord. `stories260K.gguf` sert de modèle réel.
- Les tests ne touchent jamais les données réelles : `OPENAGENT_HOME` est isolé.
- Tout test à fenêtre est lancé **une seule fois**, sortie complète dans un fichier.
- Aucun test ne télécharge le pack CUDA réel. Le téléchargement est testé contre un faux
  serveur local ; le chargement CUDA réel est une vérification manuelle ou empaquetée,
  dite comme telle.
- Dépôt public : aucun chemin ni aucune donnée personnelle.
- Les chiffres de performance ne sont présentés comme mesurés que s'ils l'ont été.

## Laissé au builder (à justifier dans le plan)

- **D'où vient le pack CUDA et comment node-llama-cpp le charge hors de `node_modules`.**
  Pistes :
  - une archive publiée sur les releases GitHub du projet (fichiers de moins de 2 Gio),
    construite à partir de `@node-llama-cpp/win-x64-cuda` et `win-x64-cuda-ext` ;
  - une option de recherche de binaires de node-llama-cpp, s'il en a une.

  À vérifier par un essai réel avant de figer :
  - que `-ext` apporte le runtime CUDA (sinon, dire ce qu'il faut à l'utilisateur) ;
  - que la licence du runtime NVIDIA permet de le redistribuer.

  Si c'est impossible proprement, le dire et proposer une alternative avant d'implémenter
  cette partie.
- La règle exacte du contexte plafonné (objectif 3).
- Le choix entre l'évaluateur rapide et la résolution fine pour l'estimation, la forme du
  cache, et l'arrêt pendant un tour de l'agent.
- Le découpage en tâches.

## Vérification attendue

- Suite complète, `tsc` cœur et renderer, construction du renderer.
- **Test réel du chargement** de `stories260K.gguf` avec la répartition déterministe : le
  nombre de couches annoncé est égal à `model.gpuLayers` après chargement. Variante sans
  carte : `gpu: false`, 0 couche.
- **Test du contexte plafonné**, sans contexte géant.
- **Test de l'estimation** : cache, annulation, indicateur.
- **Test du pack CUDA** contre un faux serveur : taille, intégrité, espace disque,
  annulation, désinstallation, et retour à Vulkan si le pack ne se charge pas.
- **Tests à fenêtre touchés**, une seule fois chacun. App empaquetée une fois : la section
  « Matériel » s'affiche dans l'app installée.
- **Mesure réelle sur la machine de l'utilisateur**, consignée au bilan : un modèle plus
  gros que la VRAM chargé dans l'app, avec les couches, la VRAM et la RAM affichées
  comparées à la réalité.
