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

type Part = { type: 'image_url'; image_url: { url: string } } | { type: 'text'; text: string };

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
  return attachments.length === 0 ? rest : { ...rest, content: buildMessageContent(String(message.content ?? ''), attachments as Attachment[]) };
}
