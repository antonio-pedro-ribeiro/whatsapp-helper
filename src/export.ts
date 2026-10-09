import fs from 'fs';
import path from 'path';
import { Chat, Message } from 'whatsapp-web.js';
import { getClient } from './client';
import { getAllChats, sanitizeName } from './groups';
import type { ChatExport, ExportedMessage } from './types';

const EXPORT_DIR = 'exports';

export interface ExportOptions {
  limit?: number;
  since?: string;
  json?: boolean;
  media?: boolean;
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

  // Phone number match for individual chats ("+351 912 345 678" â†’ "351912345678")
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
    const who = m.fromMe ? 'You' : (m.senderName || (/^\d+$/.test(m.sender) ? `+${m.sender}` : m.sender || 'Unknown'));
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

export async function exportChat(query: string, opts: ExportOptions = {}): Promise<void> {
  const limit = opts.limit ?? Infinity;
  if (!(limit > 0)) throw new Error('--limit must be a positive number.');

  let sinceMs: number | undefined;
  if (opts.since) {
    sinceMs = Date.parse(opts.since);
    if (Number.isNaN(sinceMs)) throw new Error(`Invalid --since date "${opts.since}". Use e.g. 2026-01-31.`);
  }

  const client = await getClient();
  const chats = await getAllChats();
  const chat = resolveChat(chats, query);
  const name = chatLabel(chat);

  process.stderr.write(`Loading messages for "${name}"...\n`);
  let msgs = await fetchMessages(chat, limit);
  if (sinceMs !== undefined) msgs = msgs.filter((m) => m.timestamp * 1000 >= sinceMs!);

  const exportedAt = new Date().toISOString();
  const base = `${sanitizeName(name)}_${exportedAt.replace(/[:.]/g, '-')}`;
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const mediaDirName = `${base}_media`;
  const mediaDir = path.join(EXPORT_DIR, mediaDirName);
  if (opts.media && msgs.some((m) => m.hasMedia)) fs.mkdirSync(mediaDir, { recursive: true });

  // Senders in groups are increasingly "@lid" IDs (WhatsApp's internal ID, not
  // a phone number). Map them back to the phone number when WhatsApp knows it;
  // otherwise keep the raw ID so different unknown senders stay distinguishable.
  const senders = new Map<string, { phone: string; name: string }>();
  async function senderInfo(id: string): Promise<{ phone: string; name: string }> {
    if (senders.has(id)) return senders.get(id)!;
    let phone = id.endsWith('@c.us') ? id.split('@')[0] : id;
    if (id.endsWith('@lid')) {
      try {
        const pn = await client.pupPage!.evaluate((lid: string) => {
          const w = globalThis as any;
          const wid = w.require('WAWebWidFactory').createWid(lid);
          return w.require('WAWebLidMigrationUtils').toPn(wid)?._serialized ?? null;
        }, id);
        if (pn) phone = pn.split('@')[0];
      } catch {
        // mapping unavailable — keep the raw ID
      }
    }
    let name = '';
    // A saved address-book name may live on the phone-number contact rather
    // than the "@lid" one, so try both.
    const ids = /^\d+$/.test(phone) && !id.endsWith('@c.us') ? [id, `${phone}@c.us`] : [id];
    for (const cid of ids) {
      try {
        const contact = await client.getContactById(cid);
        name = contact.pushname || contact.name || '';
      } catch {
        // contact lookup failed — leave name empty
      }
      if (name) break;
    }
    const info = { phone, name };
    senders.set(id, info);
    return info;
  }

  const messages: ExportedMessage[] = [];
  let mediaSaved = 0;
  let mediaFailed = 0;
  for (const [i, m] of msgs.entries()) {
    // In groups the sender is `author`; in individual chats it is `from`
    // (or `to` when the message is our own).
    const senderId = m.fromMe ? '' : (m.author || m.from);
    const sender = senderId ? await senderInfo(senderId) : { phone: '', name: '' };
    // notifyName is the display name the sender had when the message was sent.
    const notifyName: string = (m as any)._data?.notifyName || '';
    const entry: ExportedMessage = {
      id: m.id._serialized,
      timestamp: new Date(m.timestamp * 1000).toISOString(),
      sender: sender.phone,
      senderName: sender.name || notifyName,
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
    exportedAt,
    messages,
  };

  const txtPath = path.join(EXPORT_DIR, `${base}.txt`);
  fs.writeFileSync(txtPath, chatExportToTxt(exp), 'utf-8');

  console.log(`Exported ${messages.length} messages from "${name}"`);
  console.log(`Saved to: ${txtPath}`);

  if (opts.json) {
    const jsonPath = path.join(EXPORT_DIR, `${base}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(exp, null, 2), 'utf-8');
    console.log(`Saved to: ${jsonPath}`);
  }
  if (opts.media) {
    console.log(`Media: ${mediaSaved} saved${mediaFailed ? `, ${mediaFailed} unavailable` : ''}` +
      (mediaSaved ? ` (${mediaDir})` : ''));
  }
}
