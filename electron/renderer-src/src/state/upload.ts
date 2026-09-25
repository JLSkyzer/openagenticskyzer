import type { Attachment } from '../../../core/attachments.mts';
import { extractPdfText } from './pdf-text.ts';

// pdf.js is imported on first use only, and through a dynamic import: it is large, and the unit tests (which run in
// Node, where Vite's `?url` does not exist) never reach it — they inject their own reader.
const readPdfInBrowser = async (bytes: Uint8Array) => extractPdfText(bytes, (await import('./pdf-loader.ts')).loadPdfjs);

// file_processor.py::process_upload, in the renderer: the packaged worker has no node_modules (build.files leaves
// them out), so nothing that needs a library — a PDF reader — could live there. Everything here is checked against
// the real Python function on the same bytes (tests/upload.test.mts).
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.py', '.js', '.ts', '.json', '.yaml', '.yml', '.toml', '.html', '.css', '.rs', '.go', '.java',
  '.c', '.cpp', '.sh', '.xml', '.sql', '.env', '.cfg', '.ini',
]);
const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/** The `accept` of the file picker: exactly what `processUpload` supports (input_bar.py's own list). */
export const ACCEPT_ATTRIBUTE = [...TEXT_EXTENSIONS, '.pdf', '.csv', ...Object.keys(IMAGE_MIME)].join(',');

const MAX_TEXT_CHARS = 50_000;
const MAX_CSV_ROWS = 50;
// The original had no limit; a base64 image is copied into conversations.json on every save, and a huge file would
// freeze the IPC round trip.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** pathlib's `Path(name).suffix`: the last dot of the file name, unless it is the first character or the last. */
function suffixOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot).toLowerCase() : '';
}

// UTF-8, invalid bytes replaced (errors="replace"). A BOM is dropped — in Python it stayed glued to the first CSV
// header — which is a deliberate improvement, not an accident.
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes);
const firstChars = (text: string, count: number) => Array.from(text).slice(0, count).join(''); // code points, like Python's [:n]

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

// ── csv.DictReader + str(dict) ─────────────────────────────────────────────────────────────────────────────────

/** Python's `csv.reader` with the default dialect (comma, double quote, doubled quote, non-strict). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'start' | 'plain' | 'quoted' | 'quote-in-quoted' = 'start';
  let skipLineFeed = false;
  const endRow = () => { rows.push(row); row = []; field = ''; state = 'start'; };
  for (const ch of text) {
    if (skipLineFeed) { skipLineFeed = false; if (ch === '\n') continue; }
    const newline = ch === '\n' || ch === '\r';
    if (state === 'quoted') {
      if (ch === '"') state = 'quote-in-quoted'; else field += ch;
    } else if (state === 'quote-in-quoted') {
      if (ch === '"') { field += '"'; state = 'quoted'; }
      else if (ch === ',') { row.push(field); field = ''; state = 'start'; }
      else if (newline) { row.push(field); skipLineFeed = ch === '\r'; endRow(); }
      else { field += ch; state = 'plain'; }
    } else if (state === 'start') {
      if (ch === '"') state = 'quoted';
      else if (ch === ',') { row.push(field); field = ''; }
      else if (newline) {
        // A blank line is an empty row; after a comma it ends a row with one more, empty, field.
        if (row.length > 0) row.push(field);
        skipLineFeed = ch === '\r'; endRow();
      } else { field += ch; state = 'plain'; }
    } else if (ch === ',') { row.push(field); field = ''; state = 'start'; }
    else if (newline) { row.push(field); skipLineFeed = ch === '\r'; endRow(); }
    else field += ch;
  }
  if (state === 'quoted' || state === 'quote-in-quoted' || state === 'plain' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Python's `repr(str)`: single quotes unless the text has a ' and no ", the quote escaped when both appear. */
function pyString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch !== ' ' && NOT_PRINTABLE.test(ch)) {
      const code = ch.codePointAt(0)!;
      out += code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\U${code.toString(16).padStart(8, '0')}`;
    } else out += ch;
  }
  return out + quote;
}
const pyValue = (value: string | string[] | null): string =>
  value === null ? 'None' : Array.isArray(value) ? `[${value.map(pyString).join(', ')}]` : pyString(value);

/** csv.DictReader over the parsed rows, each rendered as `str(dict)`. */
function csvPreview(text: string): { rows: string[]; count: number } {
  const parsed = parseCsv(text);
  if (parsed.length === 0) return { rows: [], count: 0 };
  const header = parsed[0];
  const rendered: string[] = [];
  for (const row of parsed.slice(1)) {
    if (row.length === 0) continue; // DictReader skips blank lines
    const entries = new Map<string | null, string | string[] | null>();
    header.forEach((key, index) => { if (index < row.length) entries.set(key, row[index]); });
    if (header.length < row.length) entries.set(null, row.slice(header.length));
    else for (const key of header.slice(row.length)) entries.set(key, null);
    rendered.push(`{${[...entries].map(([key, value]) => `${key === null ? 'None' : pyString(key)}: ${pyValue(value)}`).join(', ')}}`);
  }
  const kept = rendered.slice(0, MAX_CSV_ROWS);
  return { rows: kept, count: kept.length };
}

/**
 * An attachment from a file's name and bytes, or null when its type is not supported (the caller says so).
 * Throws for a file over the size limit.
 */
export async function processUpload(name: string, bytes: Uint8Array, options: { readPdf?: (bytes: Uint8Array) => Promise<string> } = {}): Promise<Attachment | null> {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`${name} dépasse la limite de 10 Mo`);
  const extension = suffixOf(name);
  const size_kb = Math.max(1, Math.floor(bytes.length / 1024));
  if (extension === '.pdf') {
    try {
      const text = await (options.readPdf ?? readPdfInBrowser)(bytes);
      return { name, content_type: 'pdf', content: firstChars(text, MAX_TEXT_CHARS), size_kb };
    } catch (error) {
      // As in the original: an unreadable PDF is not refused, it becomes a text attachment that says why.
      return { name, content_type: 'text', content: `[Erreur lecture PDF: ${error instanceof Error ? error.message : String(error)}]`, size_kb };
    }
  }
  if (extension === '.csv') {
    const { rows, count } = csvPreview(decode(bytes));
    return { name, content_type: 'csv', content: `CSV (${count} lignes preview):\n${rows.join('\n')}`, size_kb };
  }
  if (extension in IMAGE_MIME) return { name, content_type: 'image', content: `data:${IMAGE_MIME[extension]};base64,${toBase64(bytes)}`, size_kb };
  if (TEXT_EXTENSIONS.has(extension)) return { name, content_type: 'text', content: firstChars(decode(bytes), MAX_TEXT_CHARS), size_kb };
  return null;
}
