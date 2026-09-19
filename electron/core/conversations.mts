import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonStore, metadataDirectory, object } from './json-store.mts';

export interface Message {
  role: 'user' | 'ai' | 'assistant' | 'human' | 'tool' | 'system';
  content: string;
  [key: string]: unknown;
}
interface Branch { id: string; label: string; messages: Message[]; created_at: string }
interface ConversationFile { version: 1; branches: Branch[] }

function validId(id: string) {
  if (id !== 'main' && !/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) throw new Error('Branche invalide');
}
function validMessages(messages: unknown): asserts messages is Message[] {
  if (!Array.isArray(messages) || messages.some(m => !m || !['user', 'ai', 'assistant', 'human', 'tool', 'system'].includes(m.role) || typeof m.content !== 'string')) {
    throw new Error('Historique invalide');
  }
}
function validate(doc: ConversationFile) {
  object(doc);
  if (doc.version !== 1 || !Array.isArray(doc.branches)) throw new Error('Format conversation inconnu');
  const seen = new Set<string>();
  for (const b of doc.branches) {
    object(b); validId(b.id); validMessages(b.messages);
    if (seen.has(b.id) || typeof b.label !== 'string' || typeof b.created_at !== 'string') throw new Error('Branche invalide');
    seen.add(b.id);
  }
  if (!seen.has('main')) throw new Error('Conversation principale absente');
  return doc;
}

export class Conversations {
  private store = new JsonStore();
  private async paths(folder: string) {
    const dir = await metadataDirectory(folder);
    return { file: join(dir, 'conversations.json'), legacy: join(dir, 'chat_history.json') };
  }
  private async initial(legacy: string): Promise<ConversationFile> {
    const messages = await this.store.read<Message[]>(legacy, []);
    validMessages(messages);
    return { version: 1, branches: [{ id: 'main', label: 'Principale', messages, created_at: new Date().toISOString() }] };
  }
  private async read(folder: string) {
    const { file, legacy } = await this.paths(folder);
    const doc = await this.store.read<ConversationFile | undefined>(file, undefined);
    return validate(doc === undefined ? await this.initial(legacy) : doc);
  }
  async list(folder: string) {
    return (await this.read(folder)).branches.map(({ messages, ...meta }) => ({ ...meta, message_count: messages.length }));
  }
  async messages(folder: string, id: string) {
    validId(id);
    const branch = (await this.read(folder)).branches.find(b => b.id === id);
    if (!branch) throw new Error('Branche introuvable');
    return branch.messages;
  }
  private async update(folder: string, change: (doc: ConversationFile) => ConversationFile) {
    const { file, legacy } = await this.paths(folder);
    return this.store.update<ConversationFile | undefined>(file, undefined, async saved => {
      const doc = validate(saved === undefined ? await this.initial(legacy) : saved);
      return validate(change(doc));
    });
  }
  async save(folder: string, id: string, messages: Message[]) {
    validId(id); validMessages(messages);
    const snapshot = structuredClone(messages);
    await this.update(folder, doc => {
      const branch = doc.branches.find(b => b.id === id);
      if (!branch) throw new Error('Branche introuvable');
      branch.messages = snapshot; return doc;
    });
  }
  /** Empties the folder's history: every fork is dropped and the main branch keeps no message. */
  async clear(folder: string) {
    let removed = 0;
    await this.update(folder, doc => {
      removed = doc.branches.reduce((sum, b) => sum + b.messages.length, 0);
      const main = doc.branches.find(b => b.id === 'main')!;
      return { version: 1, branches: [{ ...main, messages: [] }] };
    });
    return { removed_messages: removed };
  }
  async fork(folder: string, source: string, count: number, label: string) {
    validId(source);
    if (typeof label !== 'string' || !label.trim() || label.length > 100) throw new Error('Nom de branche invalide');
    const id = randomUUID();
    await this.update(folder, doc => {
      const original = doc.branches.find(b => b.id === source);
      if (!original || !Number.isInteger(count) || count < 0 || count > original.messages.length) throw new Error('Point de bifurcation invalide');
      doc.branches.push({ id, label: label.trim(), messages: original.messages.slice(0, count), created_at: new Date().toISOString() });
      return doc;
    });
    return { id, label: label.trim() };
  }
}
