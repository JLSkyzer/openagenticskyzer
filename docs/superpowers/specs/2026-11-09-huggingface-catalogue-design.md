# Catalogue de modèles Hugging Face — conception

Date : 2026-11-09. Statut : en attente de validation.

Dans ce document, « (décidé) » signale ce que l'utilisateur a validé, et « (choix de conception) » ce que l'auteur a tranché et que l'utilisateur peut revoir.

## Intention

L'utilisateur ne s'y connaît pas forcément en IA. Il ne sait pas quel modèle tournera sur sa machine, ni lequel sait appeler des outils pour développer. Le catalogue doit permettre à n'importe qui, sans connaissances, de faire le meilleur choix pour lui (décidé).

Le test de réussite : quelqu'un qui ne connaît ni les quantifications ni la VRAM ouvre le catalogue, clique sur un bouton, et se retrouve avec un modèle qui tourne sur sa machine et sait utiliser les outils.

## Objectifs

1. **Une recommandation claire.** À l'ouverture, l'app connaît la machine et interroge Hugging Face. En haut, un seul modèle recommandé, avec une note /5, une phrase simple qui l'explique, et un bouton **Installer et utiliser** (décidé). La seule décision qui reste : installer ou pas (décidé).
2. **Une liste pour fouiller.** Sous la recommandation, une liste classée par note, avec recherche et tri (décidé).
3. **Une note /5 honnête** qui combine trois questions : est-ce que ça tourne sur cette machine et à quelle vitesse, est-ce que le modèle sait appeler des outils, est-il bon en code. Ce qu'on ne sait pas juger est marqué « inconnu », jamais noté au hasard (décidé).
4. **Un téléchargement fiable**, décrit plus bas (décidé).
5. **Un dossier de modèles réglable** (décidé).
6. **Un modèle par défaut global, et un choix par projet** (décidé).

## Hors périmètre

Pas d'autre source que Hugging Face, pas de suppression automatique, pas de téléchargement sans clic de l'utilisateur, pas de modèle en ligne (décidé). Pas de vision ni d'audio : c'est le projet 3 (choix de conception).

## Ce qui serait un échec, même si ça marche techniquement

- Recommander un modèle qui ne tourne pas sur la machine.
- Afficher une note qui a l'air sûre sur une donnée inventée.
- Activer un fichier incomplet ou corrompu.
- Laisser un dépôt récupéré sur internet imposer un modèle (décidé).
- Exiger de l'utilisateur qu'il comprenne une quantification pour réussir.

## Contraintes

- Modèles `.gguf` locaux uniquement ; Hugging Face sert de catalogue et de source de téléchargement.
- Aucun outil ni réglage retiré. Le dépôt est public : pas de chemin personnel.
- Texte d'interface en français. L'import manuel d'un `.gguf` reste possible.
- Le jeton Hugging Face, s'il existe (`hf_token`), n'est envoyé qu'à `huggingface.co` et jamais journalisé.
- Tests : aucun vrai téléchargement ni appel réseau réel dans la suite automatique (serveur factice local) ; dossiers de données temporaires. Les tests en fenêtre tournent une seule fois.

## Ce qui existe

- `core/gguf-library.mts` : liste de références `{id, name, path, size_bytes, added_at}`, sans copie ; une entrée dont le fichier a disparu est écartée sans bruit.
- `active_local_model` (`core/settings.mts`) : un seul modèle actif, global. `core/hardware.mts` lit la machine.
- `core/offload-estimate.mts` : estime la répartition carte / processeur ; `ModelSource` prévoit déjà `{kind: 'remote', url}`, encore non implémenté (`REMOTE_ESTIMATE_LATER`).
- `ModelDialog.tsx` : la fenêtre de choix du modèle. Opérations `gguf-list`, `gguf-add`, `gguf-remove`.

## Ce que Hugging Face expose (observé le 2026-11-09)

- `GET /api/models?filter=gguf&search=…&sort=downloads&expand[]=gguf&expand[]=downloads&expand[]=likes&expand[]=gated&expand[]=tags&expand[]=lastModified` : donne `gguf.total`, `gguf.architecture`, `gguf.context_length` et **`gguf.chat_template`** sans télécharger.
- `GET /api/models/<dépôt>/tree/main?recursive=true` : chaque fichier a sa taille et, en LFS, `lfs.oid`, le SHA-256.
- `/resolve/main/<fichier>` redirige (307) et accepte les plages (`Accept-Ranges: bytes`).

## Le parcours

**Ouverture.** Une nouvelle section **Catalogue** dans la fenêtre de choix du modèle (choix de conception). Sans réseau, un message clair, et les modèles déjà installés restent utilisables.

**Choix du fichier.** Dans un dépôt, l'app choisit toute seule : la quantification la plus haute qui tient en entier sur la carte pour le contexte visé ; sinon la plus haute dont la répartition carte / processeur reste estimée utilisable. Un modèle en plusieurs morceaux (`-00001-of-00003`) compte pour un seul, et `mmproj` est exclu. Un utilisateur qui fouille peut choisir un autre fichier dans le détail d'un modèle (choix de conception).

**Installer et utiliser.** Vérifie la place libre, télécharge, vérifie, ajoute à la bibliothèque, active comme modèle par défaut.

## La note /5

Calculée localement à partir de données affichées, et expliquée en une phrase. Marquée « estimée » tant que le modèle n'a pas tourné sur la machine.

- **Tourne sur la machine.** Depuis la taille du fichier, les métadonnées et le matériel, avec l'estimation existante étendue à la source distante si c'est faisable, sinon une estimation par la taille (au constructeur de trancher après essai). Ce qui ne tient ni en VRAM ni en RAM vaut 0 et n'est jamais recommandé.
- **Sait appeler des outils.** Détecté depuis `gguf.chat_template`. **Attention (vérifié dans ce projet) :** le 27B fonctionne avec un gabarit sans outils, car node-llama-cpp les rend lui-même. L'absence d'outils dans le gabarit ne prouve donc pas l'incapacité. Le constructeur doit partir de ce que node-llama-cpp sait réellement faire avec ce gabarit, et rendre trois états : oui, non, inconnu.
- **Bon en code.** Une liste livrée avec l'app, datée et sourcée, de familles de modèles connues (choix de conception). Hors liste : « inconnu ». Aucune récupération de classement en ligne à ce stade.

Règles de composition (choix de conception) : un modèle qui ne sait pas appeler les outils ne dépasse pas 2/5. Un axe « inconnu » plafonne la note et se voit dans la phrase. La popularité sert seulement à départager deux notes égales. Une version « abliterated » ou modifiée n'est ni mise en avant, ni cachée. Les pondérations exactes sont laissées au constructeur, et testées par des cas nommés.

Un dépôt à accès restreint (`gated`, ou 401/403) est signalé et n'est pas proposé en un clic (décidé).

## Le téléchargement

- Barre de progression, vitesse, temps restant, annulation (décidé).
- Reprise automatique après une coupure réseau ou une fermeture de l'app (décidé), par un fichier `.part` et une requête de plage ; un dépôt dont le fichier a changé repart de zéro.
- Empreinte SHA-256 vérifiée à la fin ; **un fichier invalide n'est jamais activé** (décidé).
- Place libre vérifiée avant de commencer (décidé).
- Un seul téléchargement à la fois, les autres en file (choix de conception).
- Le nom de fichier distant est validé : il ne sort jamais du dossier des modèles.
- Les textes venus d'un dépôt sont traités comme des données non fiables ; aucun rendu HTML de la fiche du modèle.
- Il ne doit pas ralentir l'interface ni le moteur : la vérification du SHA se fait hors du fil du moteur.

## Le dossier des modèles

Réglage dans **Réglages › Matériel**, avec un emplacement par défaut dans le dossier de données de l'app. Le changer ne déplace rien : les modèles déjà téléchargés restent trouvés là où ils sont (décidé).

## Global et par projet

Un modèle par défaut pour toute l'app, et dans chaque projet un sélecteur **Par défaut** ou un modèle précis (décidé). Ce choix est gardé dans les données de l'utilisateur, **pas dans `.openagent/` ni dans le dépôt du projet** (décidé). Si le modèle du projet a disparu, l'app revient au modèle par défaut et le dit. Changer de projet recharge le modèle si nécessaire, et l'état de chargement du chat le montre.

## Précisions (choix de conception, après relecture)

**Par projet.** La clé est le chemin canonique du dossier, comme dans la liste des dossiers de l'app. Un projet déplacé ou renommé repart sur le modèle par défaut. Le choix se lit au moment d'envoyer un message : changer de projet n'interrompt pas une réponse en cours dans un autre, et le rechargement éventuel a lieu au message suivant.

**Estimation « tourne ».** Le contexte visé est le réglage `local_context` de l'utilisateur, ou 32 768 si ce réglage vaut `max`. L'estimation par répartition existante est la référence. Si le repli sur la taille est nécessaire, il reste volontairement prudent : les marges pour le système et le cache sont des constantes nommées, testées, et calées sur les mesures réelles du 27B (12,8 Go de fichier, 25 couches sur 66 pour environ 6 Go de VRAM utile). En cas de doute, la note descend.

**Empreinte.** Chaque morceau d'un modèle découpé a son propre SHA-256, vérifié un par un. Un fichier sans `lfs.oid` n'est pas installable en un clic : la fiche le dit, et l'import manuel reste possible.

**Détection des outils.** Le projet commence par un essai sur la prise en charge réelle de node-llama-cpp : `resolveChatWrapper` et le gabarit, sans modèle chargé, sur plusieurs gabarits réels dont celui du 27B. L'essai fixe ce que veulent dire oui et non. Gabarit absent ou non reconnu : « inconnu ».

**Familles « bon en code ».** Remplir la liste fait partie du projet : les familles courantes, chacune avec source et date. Hors liste, « inconnu » n'empêche pas d'être recommandé : un modèle qui tourne et sait appeler les outils peut monter à 3,5/5 avec un axe code inconnu.

**Pas de candidat éligible.** Si rien ne tourne ou s'il n'y a pas de réseau : un message clair à la place de la recommandation, sans bouton d'installation. Si le meilleur candidat a un axe « outils » inconnu : il est montré comme « à essayer », et n'est pas la recommandation en un clic.

**Reprise.** Le `.part` reste dans le dossier des modèles choisi au lancement du téléchargement : changer le dossier ne touche pas à un téléchargement commencé. Le fichier est considéré changé si sa taille ou son `lfs.oid` diffère, ce qui relance de zéro. Au redémarrage, le téléchargement en cours et ceux en file reprennent, puisque chacun vient d'un clic de l'utilisateur, avec une annulation visible.

## Laissé au constructeur

Découpage des modules, format de stockage, cache de la liste Hugging Face, disposition exacte de l'écran, pondérations de la note.

## Critères de fin

- Sur un serveur factice : recherche, choix du fichier, téléchargement, coupure et reprise, annulation, SHA invalide refusé, disque plein, dépôt restreint, sans réseau.
- Tests des cas de la note, dont « inconnu » et « ne tient pas ».
- Un test en fenêtre du parcours complet, une seule fois.
- Vérifié une fois en réel, avec l'utilisateur : un vrai petit modèle téléchargé, activé et capable d'appeler un outil.
