"""Live GGUF catalog fetched from HuggingFace API.

Fetches models from trusted GGUF quantizer orgs (bartowski, lmstudio-community, etc.)
plus global trending GGUF repos. Results are cached for 5 minutes.
"""
import json
import math
import re
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone


# Orgs connus pour produire des GGUF de qualité
_GGUF_ORGS = [
    "bartowski",
    "lmstudio-community",
    "NousResearch",
    "Qwen",
    "unsloth",
    "MaziyarPanahi",
]

_CACHE: dict = {"models": None, "fetched_at": 0.0}
_CACHE_TTL = 300  # 5 minutes

_MODEL_CTX_HINTS: dict[str, int] = {
    "llama-3.3": 128, "llama-3.2": 128, "llama-3.1": 128, "llama3.3": 128, "llama3.2": 128, "llama3.1": 128,
    "mistral-nemo": 128, "mistral": 32,
    "qwen2.5": 128, "qwen2": 32,
    "phi-3.5": 128, "phi-3": 128, "phi-4": 16, "phi3.5": 128, "phi4": 16,
    "gemma-2": 8, "gemma2": 8,
    "deepseek-r1": 128, "deepseek-coder-v2": 128, "deepseek-coder": 64,
    "starcoder2": 16, "codestral": 32,
    "hermes-3": 128,
}


@dataclass
class HFModel:
    hf_id: str
    name: str
    params_b: float          # milliards de paramètres (0 si inconnu)
    ram_min: float           # GB RAM estimé pour Q4_K_M
    vram_min: float          # GB VRAM estimé
    cat: str                 # "code" | "tool-use" | "général"
    tool_stars: int          # 1-5
    downloads: int
    likes: int
    last_modified: str       # ISO datetime string
    tags: list[str] = field(default_factory=list)   # "tendances" | "récent"

    @property
    def ctx_k(self) -> int:
        lower = self.hf_id.lower()
        for key, k in _MODEL_CTX_HINTS.items():
            if key in lower:
                return k
        return 0

    @property
    def params(self) -> str:
        if self.params_b <= 0:
            return "?"
        if self.params_b < 1:
            return f"{self.params_b:.1f}B"
        return f"{int(self.params_b)}B"

    @property
    def desc(self) -> str:
        org = self.hf_id.split("/")[0]
        dl = self.downloads
        if dl >= 1_000_000:
            dl_str = f"{dl / 1_000_000:.1f}M dl"
        elif dl >= 1_000:
            dl_str = f"{dl / 1_000:.0f}k dl"
        else:
            dl_str = f"{dl} dl"
        return f"{org} · {dl_str}"

    def score_for_specs(self, ram_gb: float, vram_gb: float) -> float:
        """Score de recommandation 0-100 basé sur le matériel de l'utilisateur.

        Composantes :
        - 50% : adéquation matérielle (GPU > CPU > impossible)
        - 20% : popularité (log-scale downloads)
        - 30% : qualité heuristique (tool_stars)
        """
        if self.ram_min > ram_gb and self.vram_min > vram_gb:
            return 0.0

        # Adéquation matérielle
        if vram_gb >= self.vram_min:
            hw = 100.0
        elif ram_gb >= self.ram_min:
            hw = 55.0
        else:
            hw = 15.0  # techniquement possible mais très lent

        # Popularité log-scale (évite que les gros modèles dominent juste par dl)
        pop = min(100.0, math.log10(max(1, self.downloads)) * 20.0)

        # Qualité / tool use heuristique
        qual = self.tool_stars * 20.0

        return hw * 0.50 + pop * 0.20 + qual * 0.30


# ── Helpers d'extraction ──────────────────────────────────────────────────────

def _extract_params_b(name: str) -> float:
    """Extrait le nombre de paramètres en milliards depuis le nom du modèle."""
    m = re.search(r"(\d+(?:\.\d+)?)\s*[Bb](?:\b|[^a-zA-Z])", name)
    if m:
        return float(m.group(1))
    return 0.0


def _estimate_ram(params_b: float) -> float:
    """Estime le besoin RAM en GB pour une quant Q4_K_M."""
    if params_b <= 0:
        return 4.0
    # Q4_K_M ≈ 0.56 octet/param + overhead KV cache + overhead système
    return round(params_b * 0.56 + max(1.0, params_b * 0.07), 1)


def _tool_stars(name_lower: str, hf_tags: list[str]) -> int:
    tag_str = " ".join(hf_tags).lower()
    if "hermes" in name_lower:
        return 5
    if any(k in name_lower for k in ("mistral", "mixtral", "qwen2.5", "llama-3.1", "llama-3.3")):
        return 4
    if "tool" in tag_str or "function" in tag_str:
        return 4
    if any(k in name_lower for k in ("gemma", "deepseek")):
        return 3
    return 3


def _cat(name_lower: str) -> str:
    if any(k in name_lower for k in ("coder", "starcoder", "codestral", "deepseek-coder")):
        return "code"
    if "hermes" in name_lower:
        return "tool-use"
    return "général"


def _compute_tags(last_modified: str, downloads: int) -> list[str]:
    tags = []
    if last_modified:
        try:
            mod = datetime.fromisoformat(last_modified.replace("Z", "+00:00"))
            days = (datetime.now(timezone.utc) - mod).days
            if days < 60:
                tags.append("récent")
        except Exception:
            pass
    if downloads >= 5_000:
        tags.append("tendances")
    return tags


# ── Fetch ─────────────────────────────────────────────────────────────────────

def _get_json(url: str) -> list[dict]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "openagenticskyzer/1.0"})
        with urllib.request.urlopen(req, timeout=12) as r:
            return json.loads(r.read())
    except Exception:
        return []


def _parse_item(item: dict) -> "HFModel | None":
    hf_id = item.get("modelId") or item.get("id", "")
    if not hf_id:
        return None
    tags = item.get("tags", [])
    if "gguf" not in {t.lower() for t in tags}:
        return None

    name = hf_id.split("/")[-1] if "/" in hf_id else hf_id
    name = re.sub(r"[-_]?[Gg][Gg][Uu][Ff]$", "", name)

    params_b = _extract_params_b(name)
    ram = _estimate_ram(params_b)
    downloads = item.get("downloads", 0)

    return HFModel(
        hf_id=hf_id,
        name=name,
        params_b=params_b,
        ram_min=ram,
        vram_min=round(ram * 0.82, 1),
        cat=_cat(name.lower()),
        tool_stars=_tool_stars(name.lower(), tags),
        downloads=downloads,
        likes=item.get("likes", 0),
        last_modified=item.get("lastModified", ""),
        tags=_compute_tags(item.get("lastModified", ""), downloads),
    )


_FALLBACK_HF_IDS = [
    "NousResearch/Hermes-3-Llama-3.1-8B-GGUF",
    "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF",
    "lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF",
    "bartowski/phi-4-GGUF",
    "lmstudio-community/DeepSeek-R1-Distill-Qwen-14B-GGUF",
    "Qwen/Qwen2.5-Coder-32B-Instruct-GGUF",
    "lmstudio-community/Llama-3.3-70B-Instruct-GGUF",
]


def _build_fallback() -> list[HFModel]:
    """Retourne un catalogue minimal si l'API HF est inaccessible."""
    results = []
    for hf_id in _FALLBACK_HF_IDS:
        name = hf_id.split("/")[-1]
        name = re.sub(r"[-_]?[Gg][Gg][Uu][Ff]$", "", name)
        params_b = _extract_params_b(name)
        ram = _estimate_ram(params_b)
        results.append(HFModel(
            hf_id=hf_id,
            name=name,
            params_b=params_b,
            ram_min=ram,
            vram_min=round(ram * 0.82, 1),
            cat=_cat(name.lower()),
            tool_stars=_tool_stars(name.lower(), []),
            downloads=0,
            likes=0,
            last_modified="",
            tags=[],
        ))
    return results


def fetch_catalog(force: bool = False) -> list[HFModel]:
    """Retourne le catalogue GGUF depuis HuggingFace (cache 5 min)."""
    now = time.time()
    if (
        not force
        and _CACHE["models"] is not None
        and (now - _CACHE["fetched_at"]) < _CACHE_TTL
    ):
        return _CACHE["models"]

    seen: set[str] = set()
    raw: list[dict] = []

    # 1. Orgs de confiance
    for org in _GGUF_ORGS:
        url = (
            "https://huggingface.co/api/models"
            f"?filter=gguf&author={org}&sort=downloads&direction=-1&limit=25&full=false"
        )
        for item in _get_json(url):
            hf_id = item.get("modelId") or item.get("id", "")
            if hf_id and hf_id not in seen:
                seen.add(hf_id)
                raw.append(item)

    # 2. Trending global GGUF
    for item in _get_json(
        "https://huggingface.co/api/models"
        "?filter=gguf&sort=downloads&direction=-1&limit=50&full=false"
    ):
        hf_id = item.get("modelId") or item.get("id", "")
        if hf_id and hf_id not in seen:
            seen.add(hf_id)
            raw.append(item)

    # 3. Récemment modifiés
    for item in _get_json(
        "https://huggingface.co/api/models"
        "?filter=gguf&sort=lastModified&direction=-1&limit=30&full=false"
    ):
        hf_id = item.get("modelId") or item.get("id", "")
        if hf_id and hf_id not in seen:
            seen.add(hf_id)
            raw.append(item)

    models: list[HFModel] = []
    for item in raw:
        m = _parse_item(item)
        if m is not None:
            models.append(m)

    if not models:
        models = _build_fallback()

    models.sort(key=lambda m: -m.downloads)

    _CACHE["models"] = models
    _CACHE["fetched_at"] = now
    return models
