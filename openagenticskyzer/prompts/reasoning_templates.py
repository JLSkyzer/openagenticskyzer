# openagenticskyzer/prompts/reasoning_templates.py
"""Templates CoT injectés selon le type de tâche détecté."""

COT_PROMPT = """\
Tu es en mode raisonnement interne. L'utilisateur NE VERRA PAS ce texte.
Raisonne méthodiquement avant de répondre.

Message à analyser : {message}

{template_extra}

Suis EXACTEMENT cette structure :

## 1. Reformulation
[Reformule le problème dans tes propres mots en 1-2 phrases]

## 2. Contraintes identifiées
[Liste les contraintes, requirements, et contexte importants]

## 3. Approches possibles
[Liste 2-3 approches différentes avec leurs avantages/inconvénients]

## 4. Approche retenue
[Choix avec justification courte]

## 5. Points d'attention
[Erreurs classiques à éviter, cas limites, hypothèses à vérifier]

Sois concis. Ce raisonnement guidera ta réponse finale.
"""

COT_SYSTEM_INJECT = """\
[RAISONNEMENT INTERNE — utilise-le pour construire ta réponse]
{reasoning}
[FIN RAISONNEMENT]

Maintenant réponds à l'utilisateur de manière claire et directe, \
en utilisant les insights du raisonnement ci-dessus.
"""

CRITIQUE_PROMPT = """\
Analyse cette réponse que tu viens de produire et détecte les problèmes.

Question originale : {question}

Ta réponse : {response}

Réponds UNIQUEMENT avec ce JSON (pas de texte avant ou après) :
{{
  "has_issues": true,
  "issues": ["problème 1", "problème 2"],
  "confidence": 3,
  "corrections_needed": ["correction 1", "correction 2"]
}}

Cherche : bugs logiques, cas limites oubliés, hypothèses incorrectes,
code qui ne compile pas, réponse incomplète, hallucinations potentielles.
confidence=5 = tu es certain que c'est correct.
"""

REASONING_TEMPLATES: dict[str, str] = {
    "debug": """\
## MODE DEBUG
- Commence TOUJOURS par identifier la cause racine, pas le symptôme
- Vérifie : variables nulles, indices hors limites, problèmes d'encodage, race conditions
- Propose un fix minimal qui touche le moins de code possible
- Inclus un test qui aurait attrapé ce bug
""",
    "architecture": """\
## MODE ARCHITECTURE
- Considère les trade-offs : performance vs lisibilité, flexibilité vs complexité
- Applique YAGNI : n'ajoute pas ce dont on n'a pas besoin maintenant
- Préfère la composition à l'héritage
- Pense à la testabilité : est-ce facilement testable unitairement ?
- Identifie les points de couplage fort et propose des interfaces propres
""",
    "code": """\
## MODE GÉNÉRATION DE CODE
- Identifie les cas limites AVANT d'écrire le code
- Pense aux types de données en entrée : null, vide, très grand, négatif
- Le code doit être correct avant d'être optimisé
- Inclus la gestion d'erreurs pour les opérations I/O et réseau
- Nomme les variables de manière descriptive, évite les abréviations
""",
    "math": """\
## MODE MATHÉMATIQUE / LOGIQUE
- Travaille étape par étape, vérifie chaque étape avant de continuer
- Précise les unités et les domaines de définition
- Vérifie le résultat avec un cas simple connu
- Si le problème est complexe, décompose-le en sous-problèmes
- Indique les hypothèses que tu fais
""",
    "research": """\
## MODE RECHERCHE / COMPARAISON
- Structure ta réponse : définition → avantages → inconvénients → cas d'usage
- Cite les sources ou standards quand pertinent
- Ne confonds pas popularité et pertinence technique
- Indique clairement quand une réponse dépend du contexte
""",
}
