// file_processor.py::build_message_content, plus the step the original did not need: here the saved transcript
// keeps what the user TYPED and the files aside (`attachments`), and the model-ready form is built only when the
// provider is called — so a later turn still sees the files, without their text ever being pasted into a bubble,
// an export or a summary.
export interface Attachment {
  name: string;
  content_type: 'text' | 'pdf' | 'csv' | 'image';
  // Extracted text, or a `data:image/…;base64,…` URI for an image.
  content: string;
  size_kb: number;
}

const KINDS = new Set(['text', 'pdf', 'csv', 'image']);
// Only a real image in a DATA URI: an `image_url` the provider is handed is fetched BY the provider, so an http(s)/
// file URL here would make it request whatever address the page names (an internal service, a cloud metadata host).
// SVG is left out on purpose (it can carry script).
const IMAGE_DATA_URI = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/;
const MAX_ATTACHMENTS = 20;
const MAX_TOTAL_CHARS = 30_000_000;

/**
 * The attachments of a `send` request, checked before anything starts. The page is not trusted to send only what
 * processUpload produces. Returns clean copies (known fields only); an absent list is an empty one.
 */
export function validateAttachments(input: unknown): Attachment[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('Pièces jointes invalides : une liste est attendue');
  if (input.length > MAX_ATTACHMENTS) throw new Error(`Pièces jointes invalides : ${MAX_ATTACHMENTS} au plus`);
  let total = 0;
  const checked = input.map((item): Attachment => {
    if (!item || typeof item !== 'object') throw new Error('Pièce jointe invalide');
    const { name, content_type, content, size_kb } = item as Record<string, unknown>;
    if (typeof name !== 'string' || name.length < 1 || name.length > 255) throw new Error('Pièce jointe invalide : nom');
    if (typeof content_type !== 'string' || !KINDS.has(content_type)) throw new Error('Pièce jointe invalide : type');
    if (typeof content !== 'string') throw new Error('Pièce jointe invalide : contenu');
    if (!Number.isInteger(size_kb) || (size_kb as number) < 0) throw new Error('Pièce jointe invalide : taille');
    if (content_type === 'image' && !IMAGE_DATA_URI.test(content)) throw new Error('Pièce jointe invalide : image');
    total += content.length;
    return { name, content_type: content_type as Attachment['content_type'], content, size_kb: size_kb as number };
  });
  if (total > MAX_TOTAL_CHARS) throw new Error('Pièces jointes invalides : trop volumineuses');
  return checked;
}

type Part ={ type: 'image_url'; image_url: { url: string } } | { type: 'text'; text: string };

/**
 * A plain string when there is no image, else OpenAI's multimodal list: the images first, then ONE text part.
 * Every non-image file becomes a "--- name ---" block placed before the text (blocks joined by a blank line).
 */
export function buildMessageContent(text: string, files: readonly Attachment[]): string | Part[] {
  if (files.length === 0) return text;
  const imageParts: Part[] = [];
  const textParts: string[] = [];
  for (const file of files) {
    if (file.content_type === 'image') imageParts.push({ type: 'image_url', image_url: { url: file.content } });
    else textParts.push(`--- ${file.name} ---\n${file.content}\n---`);
  }
  const fullText = textParts.length ? textParts.join('\n\n') + (text ? `\n\n${text}` : '') : text;
  return imageParts.length ? [...imageParts, { type: 'text', text: fullText }] : fullText;
}

interface Wire { role: string; content: unknown; [key: string]: unknown }

/**
 * The message as the model must receive it. A user message with attachments is expanded; the `attachments` field
 * itself is never sent (an unknown key can be refused by a provider). Everything else passes through untouched,
 * and the stored message is never modified.
 */
export function toWireMessage<T extends Wire>(message: T): Wire {
  if ((message.role !== 'user' && message.role !== 'human') || !Array.isArray(message.attachments)) return message;
  const { attachments, ...rest } = message;
  return (attachments.length === 0 ? rest : { ...rest, content: buildMessageContent(String(message.content ?? ''), attachments as Attachment[]) }) as unknown as Wire;
}
