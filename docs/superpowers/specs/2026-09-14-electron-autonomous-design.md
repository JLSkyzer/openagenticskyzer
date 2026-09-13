# Openagent Desktop — migration intégrale sans Python

Date : 2026-09-14. Statut : conception à relire ; application non migrée.

Cette spécification remplace la conception Electron avec pont Python. La demande
validée est de migrer le produit, et non d'habiller le moteur Python.

## Contrat de livraison

- Application Windows Electron autonome, moteur agent JavaScript/TypeScript.
- Aucune installation de Python, aucun Python embarqué, aucun processus Python,
  serveur NiceGUI, Tkinter ou navigateur externe requis pour utiliser le produit.
- Développement lancé depuis la racine avec npm ; distribution via un exécutable
  Windows. Node/npm sont des prérequis de développement, pas de l'utilisateur final.
- Travail sur `master`. Préserver les modifications étrangères à la migration.
- Reprendre les fonctions de l'ancienne interface selon la matrice de parité ;
  un bouton présent, une compilation ou un test de syntaxe ne prouvent pas la parité.
- Conserver les projets, conversations et configurations existants. Aucune
  suppression des données utilisateur ni manipulation des installations Windows.

## Architecture

Le processus principal Electron possède la fenêtre unique, les dialogues natifs,
la zone de notification, le stockage chiffré des nouveaux secrets et le cycle de vie
des workers. Il vérifie l'origine et le schéma de chaque requête IPC.

Le renderer TypeScript/React gère l'affichage, sans accès Node ni au système de
fichiers. Un preload expose une liste fermée d'opérations typées et des abonnements
avec désinscription. Aucun relais générique de commande shell n'est exposé.

Le moteur TypeScript s'exécute dans un worker Node. Les services sont séparés :
stockage/migration, configurations, providers, boucle agent, permissions, outils,
contexte/mémoire, index, extensions/MCP, gestion des modèles et téléchargements.
L'indexation intensive ne bloque ni la fenêtre ni les demandes d'arrêt.

Chaque opération longue possède un identifiant, un projet et une branche capturés
au démarrage. Les événements portent ces mêmes identifiants. Un changement de
projet ne peut réaffecter une réponse, une écriture, une permission ou un index.
L'annulation interrompt le réseau et les processus enfants concernés ; les erreurs
et fins d'opérations ferment systématiquement les abonnements associés.

## Navigation et présentation

Une fenêtre avec sidebar projets, espace conversation et panneau latéral de
prévisualisation. Typographie lisible, composants cohérents, thème sombre/clair,
accent réglable, raccourcis clavier et focus accessibles. Les contenus et libellés
ne doivent pas se chevaucher à la taille minimale de fenêtre et au zoom Windows.

Deux accès distincts et nommés en toutes lettres :

1. **Paramètres de l'application**, disponible même sans projet : Général,
   Apparence, Contexte & mémoire, Permissions, Connexions par défaut, Intégrations,
   Données et actions sensibles.
2. **Paramètres du projet**, près du nom du projet actif : Connexion et modèle,
   Mode agent, Instructions, Exclusions, Permissions héritées/personnalisées.

La sélection de modèle et les téléchargements possèdent leur propre espace,
distinct des réglages. Palette de commandes, bibliothèque de prompts, mémoire,
exports et initialisation projet sont des actions réelles, pas des notices.

## Configurations et secrets

Les fichiers globaux `~/.openagent/config.json`, `folders.json`, `prompts.json`,
`mcp.json`, et les fichiers projet `.openagent/config.json`, `chat_history.json`,
`memory.md`, `learnings.json` restent des sources de migration. Respecter
`OPENAGENT_HOME` et le répertoire de sessions configuré. Vérifier les formats
réels avant chaque convertisseur ; sauvegarder avant toute transformation.

Résolution explicite : réglage projet explicite > réglage global explicite >
configuration historique applicable > défaut documenté. Un champ hérité affiche
son origine ; sauvegarder le projet ne copie pas les valeurs globales ni ses clés.
Changer de provider ne récupère jamais la clé d'un autre provider.

Les `.env` historiques sont lus sans modifier `process.env` ni le fichier. Les
nouveaux secrets sont conservés par le processus principal dans un coffre local
chiffré ; le renderer reçoit uniquement un état « configurée » et peut envoyer une
nouvelle valeur ou demander son effacement. Les anciens fichiers restent intacts,
avec une indication claire s'ils contiennent encore des secrets en clair.
Une modification d'URL associée à une clé demande une confirmation explicite.

Écritures atomiques, validation avant écriture, sauvegardes de migration et erreurs
visibles. Un JSON illisible n'est jamais silencieusement remplacé par des défauts.
Les branches ont une persistance séparée : sauvegarder une branche ne peut écraser
la conversation principale. Les actions sensibles sont confirmées et ciblées.

## Moteur agent et intégrations

Reprendre providers distants (OpenRouter, Together, Groq, Mistral, Gemini) et moteurs
locaux (Ollama, LM Studio, llama.cpp). Tester chaque protocole de streaming et
tool-calling ; ne pas supposer que tous sont identiques. Préserver les modes
ask/auto/plan, les étapes de raisonnement/critique utiles et la prévention des
boucles sans reproduire les contournements qui exécutent une action hors permission.

Les permissions sont appliquées dans le moteur, pas seulement dans le prompt ou
l'interface. Une compaction/réécriture auxiliaire n'a aucun outil disponible. Les
outils fichiers résolvent leurs chemins dans le projet capturé, y compris face aux
jonctions/liens symboliques ; les outils Git utilisent des arguments structurés.

L'index sémantique utilise un moteur d'embedding exécuté en JavaScript/ONNX, sans
service Python. Choix exact et distribution des poids à valider par un essai sur
Windows. Reconstruire l'index code depuis les sources sans effacer l'ancien Chroma.
Pour les documents de connaissance, inventorier les sources conservées : si seul
Chroma contient encore le texte, fournir une extraction sans Python vérifiée avant
de déclarer la migration des connaissances terminée. Ne pas rebaptiser une simple
recherche lexicale « recherche sémantique ».

Plugins : nouveau contrat JavaScript avec schéma d'arguments, nom, description et
fonction d'exécution, activé explicitement par l'utilisateur. Les fichiers `.py`
personnalisés ne peuvent pas être exécutés dans un produit sans Python : ils sont
détectés et signalés comme nécessitant un portage, jamais chargés silencieusement.
Les extensions livrées avec le projet doivent être portées. Les définitions MCP
sont conservées ; aucun serveur n'est lancé pour simplement ouvrir les réglages.
Un serveur tiers qui exige Python est signalé comme dépendance externe incompatible
avec le parcours sans Python, pas installé automatiquement.

Ollama, LM Studio et llama.cpp restent des moteurs locaux optionnels, pas des
prérequis pour les providers distants. Conserver découverte, sélection, contexte,
réserve VRAM, catalogue, téléchargements GGUF/multipart et désinstallation ciblée.
Pas d'installation ni de gros téléchargement au démarrage sans accord.

## Sécurité de l'interface

`contextIsolation: true`, `nodeIntegration: false`, sandbox renderer, CSP locale,
navigation arbitraire bloquée, nouvelles fenêtres refusées. Les liens externes sont
ouverts uniquement après action explicite et validation du protocole. Markdown
nettoyé ; HTML/SVG/Mermaid générés traités comme non fiables dans une prévisualisation
isolée sans accès IPC, fichiers, secrets ni réseau par défaut.

## Validation avant bascule

1. Tests unitaires et intégration avec homes/projets temporaires uniquement.
2. Tests providers contre serveurs simulés : streaming découpé, outils, erreurs
   401/429, interruption, déconnexion, refus de permission, limite de boucle.
3. Tests d'isolation entre deux projets et plusieurs branches pendant les opérations.
4. Test de chaque ligne de la matrice : clic → opération → résultat → persistance.
5. Tests Electron réels : une fenêtre, réglages globaux sans projet, réglages projet,
   restauration après fermeture, clavier, apparence et captures inspectées.
6. Build Windows exécuté avec Python absent du PATH ; vérifier les processus lancés
   et le contenu du paquet, pas seulement rechercher le mot Python dans les sources.
7. Retirer anciens launchers/interfaces et dépendances Python du produit actif
   seulement après ces preuves. Le code historique reste récupérable dans Git.

Référence de couverture : `docs/superpowers/plans/2026-09-14-electron-parity.md`.
