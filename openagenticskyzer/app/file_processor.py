"""Traitement des fichiers uploadés avant injection dans le contexte agent."""
import base64
import csv
import io
from pathlib import Path


_TEXT_EXTENSIONS = {
    ".txt", ".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml",
    ".toml", ".html", ".css", ".rs", ".go", ".java", ".c", ".cpp",
    ".sh", ".xml", ".sql", ".env", ".cfg", ".ini",
}
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
         "webp": "image/webp", "gif": "image/gif"}


def process_upload(name: str, raw_bytes: bytes):
    """Retourne un AttachedFile ou None si extension non supportée."""
    from openagenticskyzer.app.state import AttachedFile
    ext = Path(name).suffix.lower()
    size_kb = max(1, len(raw_bytes) // 1024)

    if ext == ".pdf":
        return _process_pdf(name, raw_bytes, size_kb)
    if ext == ".csv":
        return _process_csv(name, raw_bytes, size_kb)
    if ext in _IMAGE_EXTENSIONS:
        mime = _MIME.get(ext.lstrip("."), "image/png")
        b64 = base64.b64encode(raw_bytes).decode()
        return AttachedFile(name=name, content_type="image",
                           content=f"data:{mime};base64,{b64}", size_kb=size_kb)
    if ext in _TEXT_EXTENSIONS:
        text = raw_bytes.decode("utf-8", errors="replace")[:50_000]
        return AttachedFile(name=name, content_type="text", content=text, size_kb=size_kb)
    return None


def _process_pdf(name: str, raw_bytes: bytes, size_kb: int):
    from openagenticskyzer.app.state import AttachedFile
    try:
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(raw_bytes))
        text = "\n\n".join(page.extract_text() or "" for page in reader.pages)
        return AttachedFile(name=name, content_type="pdf",
                           content=text[:50_000], size_kb=size_kb)
    except Exception as exc:
        return AttachedFile(name=name, content_type="text",
                           content=f"[Erreur lecture PDF: {exc}]", size_kb=size_kb)


def _process_csv(name: str, raw_bytes: bytes, size_kb: int):
    from openagenticskyzer.app.state import AttachedFile
    text = raw_bytes.decode("utf-8", errors="replace")
    rows = list(csv.DictReader(io.StringIO(text)))[:50]
    preview = "\n".join(str(r) for r in rows)
    return AttachedFile(name=name, content_type="csv",
                       content=f"CSV ({len(rows)} lignes preview):\n{preview}", size_kb=size_kb)


def build_message_content(text: str, files: list) -> "list | str":
    """Construit le contenu du message : str simple ou list multimodale OpenAI."""
    if not files:
        return text
    image_parts = []
    text_parts = []
    for f in files:
        if f.content_type == "image":
            image_parts.append({"type": "image_url", "image_url": {"url": f.content}})
        else:
            text_parts.append(f"--- {f.name} ---\n{f.content}\n---")
    full_text = "\n\n".join(text_parts) + ("\n\n" + text if text else "") if text_parts else text
    if image_parts:
        return image_parts + [{"type": "text", "text": full_text}]
    return full_text
