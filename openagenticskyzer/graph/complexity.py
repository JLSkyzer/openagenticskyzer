"""Détecteur de complexité — pur Python, aucun appel LLM, < 1ms."""
import re
from dataclasses import dataclass


@dataclass
class ComplexityAnalysis:
    mode: str       # "simple" | "standard" | "complex" | "critical"
    task_type: str  # "debug" | "architecture" | "code" | "math" | "research" | "general"
    score: int      # 0-100


_CRITICAL_PATTERNS = re.compile(
    r"(?:architectur|refactor|migrat|sécuris|vulnérabilit|optimis|concurrent|race.?condition"
    r"|thread.?safe|deadlock|memory.?leak|design.?pattern|scalab|compar\w* .+(?:approach|option)"
    r"|should i use|which (?:is better|approach))",
    re.IGNORECASE,
)

_COMPLEX_PATTERNS = re.compile(
    r"(?:implémente|implemente|implement|debug|pourquoi (?:ça|ca|cela)|why (?:does|is|isn't)"
    r"|explique|explain|step.?by.?step|how (?:does|do)|comment (?:ça marche|fonctionne)"
    r"|résous|résoudre|solve|algorithm|récursiv|recursive|async|await|multithread|tri)",
    re.IGNORECASE,
)

_SIMPLE_PATTERNS = re.compile(
    r"^(?:merci|thanks|ok|oui|non|yes|no|bonjour|salut|hello|parfait|super|génial|cool"
    r"|lgtm|done|fini|c'est bon|ça marche)[\s!.]*$",
    re.IGNORECASE,
)

_TASK_TYPES: dict[str, re.Pattern] = {
    "debug": re.compile(
        r"(?:bug|erreur|error|crash|exception|traceback|fail|broken|ne marche pas|doesn'?t work)",
        re.IGNORECASE,
    ),
    "architecture": re.compile(
        r"(?:architectur|design|structure|organis|pattern|scalab|refactor|décompos)",
        re.IGNORECASE,
    ),
    "math": re.compile(
        r"(?:calcul|calculat|formula|equation|probabilit|statistic|mathématique|algorith|complexité|O\()",
        re.IGNORECASE,
    ),
    "research": re.compile(
        r"(?:qu'est.?ce que|what is|explique|explain|compare|différence|difference|meilleur|best practice)",
        re.IGNORECASE,
    ),
    "code": re.compile(
        r"(?:écri[st]|write|implémente|implement|crée|create|génère|generat|code|fonction|function|classe|class)",
        re.IGNORECASE,
    ),
}


def analyze_complexity(message: str, history_len: int = 0) -> ComplexityAnalysis:
    """Détermine le mode de raisonnement optimal pour ce message. < 1ms."""
    msg = message.strip()

    # Déterminer le task_type d'abord (pour utiliser dans le scoring)
    task_type = "general"
    for name, pattern in _TASK_TYPES.items():
        if pattern.search(msg):
            task_type = name
            break

    # Messages très courts et simples → simple
    if _SIMPLE_PATTERNS.match(msg):
        return ComplexityAnalysis("simple", task_type, 10)

    # Calcul du score
    score = min(len(msg) // 50, 20)
    score += history_len // 5
    score += 30 if _CRITICAL_PATTERNS.search(msg) else 0
    score += 15 if _COMPLEX_PATTERNS.search(msg) else 0
    # Bonus pour task_type "code" et "debug"
    score += 5 if task_type in ("debug", "code") else 0
    score += 10 if msg.count("\n") > 3 else 0
    score += 10 if re.search(r"```|`[^`]+`", msg) else 0

    # Thresholds baissés pour plus de sensibilité
    if score >= 30:
        mode = "critical"
    elif score >= 20:
        mode = "complex"
    elif score >= 10:
        mode = "standard"
    else:
        mode = "simple"

    return ComplexityAnalysis(mode, task_type, min(score, 100))
