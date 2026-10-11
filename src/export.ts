import fs from 'fs';
import path from 'path';
import { Chat, Client, Message } from 'whatsapp-web.js';
import { getClient } from './client';
import { getAllChats, sanitizeName } from './groups';
import type { ChatExport, ExportedMessage } from './types';

const EXPORT_DIR = 'exports';

export interface ExportOptions {
  limit?: number;
  since?: string;
  json?: boolean;
  media?: boolean;
  all?: boolean;
  match?: string;
}

// Labels used in the .txt output for media and other non-text messages,
// mirroring WhatsApp's own "<Media omitted>" style.
const TYPE_LABELS: Record<string, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  ptt: 'voice message',
  document: 'document',
  sticker: 'sticker',
  location: 'location',
  vcard: 'contact card',
  multi_vcard: 'contact cards',
  revoked: 'message deleted',
  poll_creation: 'poll',
  call_log: 'call',
};

function chatLabel(chat: Chat): string {
  return chat.name || chat.id.user;
}

export function resolveChat(chats: Chat[], query: string): Chat {
  const byId = chats.find((c) => c.id._serialized === query);
  if (byId) return byId;

  // Phone number match for individual chats ("+351 912 345 678" → "351912345678")
  const digits = query.replace(/[\s+()-]/g, '');
  if (/^\d+$/.test(digits)) {
    const byPhone = chats.find((c) => !c.isGroup && c.id.user === digits);
    if (byPhone) return byPhone;
  }

  const lower = query.toLowerCase();
  const byName = chats.filter((c) => chatLabel(c).toLowerCase().includes(lower));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const exact = byName.filter((c) => chatLabel(c).toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    const names = byName.map((c) => `  "${chatLabel(c)}" (${c.id._serialized})`).join('\n');
    throw new Error(`Multiple chats match "${query}":\n${names}\nUse the chat ID to disambiguate.`);
  }
  throw new Error(`No chat found matching "${query}". Run "wha chats" to see available chats.`);
}

export async function listChats(): Promise<void> {
  const chats = await getAllChats();
  if (chats.length === 0) {
    console.log('No chats found.');
    return;
  }
  const nameWidth = Math.max(...chats.map((c) => chatLabel(c).length), 10);
  console.log(`${'Chat Name'.padEnd(nameWidth)}  Type        Chat ID`);
  console.log(`${'-'.repeat(nameWidth)}  ----------  ${'-'.repeat(40)}`);
  for (const c of chats) {
    const type = c.isGroup ? 'group' : 'individual';
    console.log(`${chatLabel(c).padEnd(nameWidth)}  ${type.padEnd(10)}  ${c.id._serialized}`);
  }
}

function formatLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function chatExportToTxt(exp: ChatExport): string {
  const lines: string[] = [
    `Chat:      ${exp.chatName}`,
    `Type:      ${exp.isGroup ? 'group' : 'individual'}`,
    `Exported:  ${exp.exportedAt}`,
    `Messages:  ${exp.messages.length}`,
    '',
  ];

  for (const m of exp.messages) {
    const who = m.fromMe ? 'You' : (m.senderName || (m.sender ? `+${m.sender}` : 'Unknown'));
    let text = m.body;
    if (m.type === 'location') {
      // Location bodies are base64 thumbnails, not text.
      text = '<location>';
    } else if (m.hasMedia) {
      const label = TYPE_LABELS[m.type] ?? m.type;
      const tag = m.mediaFile ? `<${label}: ${m.mediaFile}>` : `<${label} omitted>`;
      text = m.body ? `${tag} ${m.body}` : tag;
    } else if (!text && TYPE_LABELS[m.type]) {
      text = `<${TYPE_LABELS[m.type]}>`;
    }
    // Indent continuation lines so each message stays visually grouped.
    lines.push(`[${formatLocal(m.timestamp)}] ${who}: ${text.replace(/\n/g, '\n    ')}`);
  }

  return lines.join('\n') + '\n';
}

function extensionFor(mimetype: string, filename?: string | null): string {
  if (filename && path.extname(filename)) return path.extname(filename);
  const sub = (mimetype.split(';')[0].split('/')[1] || 'bin').toLowerCase();
  const map: Record<string, string> = { jpeg: '.jpg', ogg: '.ogg', mpeg: '.mp3', 'x-m4a': '.m4a', quicktime: '.mov' };
  return map[sub] ?? `.${sub.replace(/[^a-z0-9]/g, '')}`;
}

async function fetchMessages(chat: Chat, limit: number): Promise<Message[]> {
  // limit = Infinity makes whatsapp-web.js page back through the whole history
  // that is available on this linked device.
  const msgs = await chat.fetchMessages({ limit });
  return msgs.sort((a, b) => a.timestamp - b.timestamp);
}

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

// Matches a wildcard pattern (* and ?, case-insensitive) against the chat
// name, the chat ID and the bare phone/group number.
export function selectChats(chats: Chat[], pattern: string): Chat[] {
  const re = globToRegExp(pattern);
  return chats.filter((c) => re.test(chatLabel(c)) || re.test(c.id._serialized) || re.test(c.id.user));
}

interface ChatResult {
  messages: number;
  mediaSaved: number;
  mediaFailed: number;
  txtPath: string;
}

async function exportOne(client: Client, chat: Chat, opts: ExportOptions, sinceMs: number | undefined,
  dir: string, base: string): Promise<ChatResult> {
  const name = chatLabel(chat);
  let msgs = await fetchMessages(chat, opts.limit ?? Infinity);
  if (sinceMs !== undefined) msgs = msgs.filter((m) => m.timestamp * 1000 >= sinceMs);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const mediaDirName = `${base}_media`;
  const mediaDir = path.join(dir, mediaDirName);
  if (opts.media && msgs.some((m) => m.hasMedia)) fs.mkdirSync(mediaDir, { recursive: true });

  const contactNames = new Map<string, string>();
  async function nameFor(id: string): Promise<string> {
    if (contactNames.has(id)) return contactNames.get(id)!;
    let n = '';
    try {
      const contact = await client.getContactById(id);
      n = contact.pushname || contact.name || '';
    } catch {
      // contact lookup failed — leave name empty
    }
    contactNames.set(id, n);
    return n;
  }

  const messages: ExportedMessage[] = [];
  let mediaSaved = 0;
  let mediaFailed = 0;
  for (const [i, m] of msgs.entries()) {
    // In groups the sender is `author`; in individual chats it is `from`
    // (or `to` when the message is our own).
    const senderId = m.fromMe ? '' : (m.author || m.from);
    const entry: ExportedMessage = {
      id: m.id._serialized,
      timestamp: new Date(m.timestamp * 1000).toISOString(),
      sender: senderId ? senderId.split('@')[0] : '',
      senderName: senderId ? await nameFor(senderId) : '',
      fromMe: m.fromMe,
      type: m.type,
      body: m.body ?? '',
      hasMedia: m.hasMedia,
    };

    if (opts.media && m.hasMedia) {
      try {
        const media = await m.downloadMedia();
        if (media) {
          const file = `${String(i + 1).padStart(5, '0')}_${m.type}${extensionFor(media.mimetype, media.filename)}`;
          fs.writeFileSync(path.join(mediaDir, file), Buffer.from(media.data, 'base64'));
          entry.mediaFile = `${mediaDirName}/${file}`;
          mediaSaved++;
        } else {
          mediaFailed++;
        }
      } catch {
        // Old media is often no longer on WhatsApp's servers.
        mediaFailed++;
      }
    }

    messages.push(entry);
    if ((i + 1) % 500 === 0) process.stderr.write(`  processed ${i + 1}/${msgs.length}\n`);
  }

  const exp: ChatExport = {
    chatId: chat.id._serialized,
    chatName: name,
    isGroup: chat.isGroup,
    exportedAt: new Date().toISOString(),
    messages,
  };

  const txtPath = path.join(dir, `${base}.txt`);
  fs.writeFileSync(txtPath, chatExportToTxt(exp), 'utf-8');
  if (opts.json) {
    fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(exp, null, 2), 'utf-8');
  }
  return { messages: messages.length, mediaSaved, mediaFailed, txtPath };
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function exportChat(query: string | undefined, opts: ExportOptions = {}): Promise<void> {
  const selectors = [query !== undefined, !!opts.all, opts.match !== undefined].filter(Boolean).length;
  if (selectors !== 1) throw new Error('Specify exactly one of: a chat, --all, or --match <pattern>.');

  const limit = opts.limit ?? Infinity;
  if (!(limit > 0)) throw new Error('--limit must be a positive number.');

  let sinceMs: number | undefined;
  if (opts.since) {
    sinceMs = Date.parse(opts.since);
    if (Number.isNaN(sinceMs)) throw new Error(`Invalid --since date "${opts.since}". Use e.g. 2026-01-31.`);
  }

  const client = await getClient();
  const chats = await getAllChats();

  // ── Single chat ──────────────────────────────────────────────────────────
  if (query !== undefined) {
    const chat = resolveChat(chats, query);
    const name = chatLabel(chat);
    process.stderr.write(`Loading messages for "${name}"...\n`);
    const base = `${sanitizeName(name)}_${timestampSlug()}`;
    const r = await exportOne(client, chat, opts, sinceMs, EXPORT_DIR, base);

    console.log(`Exported ${r.messages} messages from "${name}"`);
    console.log(`Saved to: ${r.txtPath}`);
    if (opts.json) console.log(`Saved to: ${path.join(EXPORT_DIR, `${base}.json`)}`);
    if (opts.media) {
      console.log(`Media: ${r.mediaSaved} saved${r.mediaFailed ? `, ${r.mediaFailed} unavailable` : ''}` +
        (r.mediaSaved ? ` (${path.join(EXPORT_DIR, `${base}_media`)})` : ''));
    }
    return;
  }

  // ── Several chats (--all / --match) ──────────────────────────────────────
  const selected = opts.all ? chats : selectChats(chats, opts.match!);
  if (selected.length === 0) {
    throw new Error(`No chat matches "${opts.match}". Run "wha chats" to see available chats.`);
  }

  const batchDir = path.join(EXPORT_DIR, `batch_${timestampSlug()}`);
  process.stderr.write(`Exporting ${selected.length} chat(s) to ${batchDir}\n`);

  const usedBases = new Set<string>();
  const failures: string[] = [];
  let totalMessages = 0;
  let totalMedia = 0;
  for (const [i, chat] of selected.entries()) {
    const name = chatLabel(chat);
    // Different chats can share a sanitized name — keep file names unique.
    let base = sanitizeName(name) || 'chat';
    for (let n = 2; usedBases.has(base.toLowerCase()); n++) base = `${sanitizeName(name) || 'chat'}_${n}`;
    usedBases.add(base.toLowerCase());

    process.stderr.write(`[${i + 1}/${selected.length}] "${name}"...\n`);
    try {
      const r = await exportOne(client, chat, opts, sinceMs, batchDir, base);
      totalMessages += r.messages;
      totalMedia += r.mediaSaved;
      console.log(`  ${String(r.messages).padStart(6)} messages  ${name}`);
    } catch (err) {
      // One broken chat must not abort a long batch.
      failures.push(name);
      console.error(`  failed: "${name}": ${(err as Error).message}`);
    }
  }

  console.log(`Exported ${selected.length - failures.length}/${selected.length} chats, ` +
    `${totalMessages} messages${opts.media ? `, ${totalMedia} media files` : ''}`);
  console.log(`Saved to: ${batchDir}`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} chat(s) failed: ${failures.map((f) => `"${f}"`).join(', ')}`);
  }
}
