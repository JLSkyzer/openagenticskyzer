// Copied from storage.py::DEFAULT_PROMPTS (the NiceGUI app): the literal was parsed with Python's ast on
// 2026-09-22 and written out by a script, not retyped — a test compares ids and order, and the whole set was
// diffed against the Python source when this file was generated.
export interface DefaultPrompt { id: string; name: string; icon: string; description: string; template: string }

export const DEFAULT_PROMPTS: readonly DefaultPrompt[] = [
  {
    id: "refactor",
    name: "Refactoriser",
    icon: "🔧",
    description: "Améliore la lisibilité et la structure du code",
    template: "Refactorise ce fichier en suivant les bonnes pratiques.\n\nObjectifs :\n- Nommer clairement les fonctions et variables\n- Réduire la duplication\n- Améliorer la lisibilité\n- Ajouter des types si manquants\n\nFichier : {filename}"
  },
  {
    id: "tests",
    name: "Écrire les tests",
    icon: "🧪",
    description: "Génère des tests unitaires",
    template: "Écris des tests unitaires exhaustifs pour {filename}.\nUtilise pytest. Couvre les cas normaux, les cas limites, et les erreurs."
  },
  {
    id: "explain",
    name: "Expliquer",
    icon: "📖",
    description: "Explique le code sélectionné",
    template: "Explique ce code en détail, ligne par ligne si nécessaire :\n{filename}"
  },
  {
    id: "pr_desc",
    name: "Description PR",
    icon: "📝",
    description: "Génère une description de Pull Request",
    template: "Génère une description de Pull Request à partir du git diff.\nFormat : titre, résumé des changements, type de changement (feat/fix/refactor), impact."
  },
  {
    id: "debug",
    name: "Déboguer",
    icon: "🐛",
    description: "Analyse une erreur et propose un fix",
    template: "Analyse cette erreur et propose un fix avec explication :\n\n"
  },
  {
    id: "optimize",
    name: "Optimiser",
    icon: "⚡",
    description: "Améliore les performances",
    template: "Analyse les performances de {filename} et propose des optimisations concrètes avec benchmarks si possible."
  },
  {
    id: "security",
    name: "Audit sécurité",
    icon: "🔒",
    description: "Cherche les vulnérabilités",
    template: "Effectue un audit de sécurité complet de {filename}.\nVérifie : injection, XSS, CSRF, secrets exposés, dépendances vulnérables, OWASP Top 10."
  },
  {
    id: "review",
    name: "Code review",
    icon: "👁️",
    description: "Revue complète avec suggestions",
    template: "Effectue une revue de code complète de {filename}.\nPriorise : CRITIQUE > IMPORTANT > SUGGESTION. Référence les numéros de ligne."
  },
  {
    id: "document",
    name: "Documenter",
    icon: "📚",
    description: "Ajoute docstrings et commentaires",
    template: "Ajoute des docstrings et commentaires clairs à {filename}.\nRespecte le style existant."
  },
  {
    id: "translate",
    name: "Traduire",
    icon: "🔄",
    description: "Traduit le code dans un autre langage",
    template: "Traduis {filename} dans un autre langage de programmation.\nPrécise le langage cible si tu le sais."
  }
];
