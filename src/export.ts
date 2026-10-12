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

// Phone numbers of individual "@lid" chats, as far as WhatsApp Web knows them.
async function lidPhoneNumbers(client: Client, chats: Chat[]): Promise<Map<string, string>> {
  const lids = chats.filter((c) => !c.isGroup && c.id.server === 'lid').map((c) => c.id._serialized);
  if (lids.length === 0) return new Map();
  try {
    const pairs = await client.pupPage!.evaluate((ids: string[]) => {
      const w = globalThis as any;
      const { createWid } = w.require('WAWebWidFactory');
      const { toPn } = w.require('WAWebLidMigrationUtils');
      return ids.map((id) => {
        try {
          return [id, toPn(createWid(id))?.user ?? null];
        } catch {
          return [id, null];
        }
      });
    }, lids);
    return new Map(pairs.filter((p): p is [string, string] => !!p[1]));
  } catch {
    return new Map(); // mapping unavailable — phone lookup falls back to id.user
  }
}

// `phones` maps chat IDs to phone numbers for individual chats whose ID is an
// "@lid" (WhatsApp's internal ID), where `id.user` is not the phone number.
export function resolveChat(chats: Chat[], query: string, phones: Map<string, string> = new Map()): Chat {
  const byId = chats.find((c) => c.id._serialized === query);
  if (byId) return byId;

  // Phone number match for individual chats ("+351 912 345 678" → "351912345678")
  const digits = query.replace(/[\s+()-]/g, '');
  if (/^\d+$/.test(digits)) {
    const byPhone = chats.find((c) => !c.isGroup &&
      (c.id.user === digits || phones.get(c.id._serialized) === digits));
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

interface HistoryStep {
  count: number;          // messages now loaded in the chat
  oldest: number | null;  // unix seconds of the oldest loaded message
  phone?: 'ok' | 'error' | 'timeout' | 'unavailable';
}

// One step of history loading, run inside WhatsApp Web. First drains what the
// linked device already stores locally (loadEarlierMsgs). With an anchor, it
// then asks the phone for the next batch of older messages — the same request
// as WhatsApp Web's "Click here to get older messages from your phone" — waits
// for the reply and drains again.
//
// The request names a starting message ("anchor") and the phone returns the
// messages before it. WhatsApp Web always uses the oldest loaded message; the
// phone silently ignores some anchors (presumably messages it no longer has),
// so `anchor` picks the n-th oldest loaded message instead (0 = oldest).
async function historyStep(client: Client, chatId: string, anchor: number | null): Promise<HistoryStep> {
  return client.pupPage!.evaluate(async (id: string, anchorIdx: number | null) => {
    const req = (globalThis as any).require;
    const chat = req('WAWebCollections').Chat.get(id);
    const { loadEarlierMsgs } = req('WAWebChatLoadMessages');
    const drain = async () => {
      // Capped so a single evaluate stays well under Puppeteer's protocol timeout.
      for (let i = 0; i < 50; i++) {
        const got = await loadEarlierMsgs({ chat });
        if (!got || !got.length) break;
      }
    };
    const summary = () => {
      const all = chat.msgs.getModelsArray();
      return { count: all.length, oldest: all.length ? Math.min(...all.map((m: any) => m.t)) : null };
    };

    await drain();
    if (anchorIdx === null) return summary();

    let phone: 'ok' | 'error' | 'timeout' | 'unavailable' = 'unavailable';
    const utils = req('WAWebNonMessageDataRequestHistorySyncOnDemandUtils');
    const originalGetOldest = utils.getOldestMsgInChatFromDB;
    try {
      // isHistorySyncOnDemandEnabled() is false for many accounts, which only
      // hides WhatsApp Web's "get older messages" button: the phone still
      // answers the request, so send it regardless.
      // WhatsApp Web stops sending requests for 2 hours after 10 failures;
      // failed anchors are expected here, so reset its failure record.
      Object.assign(utils.historySyncOnDemandRequestsFailureRecord, {
        disableRequestSending: false, failureCount: 0, firstFailureRequestTimeStampSec: undefined,
      });
      if (anchorIdx > 0) {
        const sorted = chat.msgs.getModelsArray().slice().sort((a: any, b: any) => a.t - b.t);
        const msg = sorted[Math.min(anchorIdx, sorted.length - 1)];
        utils.getOldestMsgInChatFromDB = async () => msg;
      }
      const events = req('WAWebHistorySyncOnDemandEvents').WAWebHistorySyncOnDemandEvents;
      const type = req('WAWebProtobufsE2E.pb').Message$PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND;
      // With the gate off, the success/error events often never fire even
      // though the phone's messages do arrive, so also poll for new messages.
      let succeeded = false;
      let failed = false;
      const ok = () => { succeeded = true; };
      const err = () => { failed = true; };
      events.on('history_sync_on_demand_events:success_history_sync_od', ok);
      events.on('history_sync_on_demand_events:error_history_sync_od', err);
      req('WAWebSendNonMessageDataRequest')
        .sendPeerDataOperationRequest(type, { chatId: chat.id })
        .catch(err);
      const deadline = Date.now() + 30_000;
      phone = 'timeout';
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const got = await loadEarlierMsgs({ chat });
        if ((got && got.length) || succeeded) { phone = 'ok'; break; }
      }
      if (phone === 'timeout' && failed) phone = 'error';
      events.off?.('history_sync_on_demand_events:success_history_sync_od', ok);
      events.off?.('history_sync_on_demand_events:error_history_sync_od', err);
    } catch {
      // on-demand sync not available in this WhatsApp Web build
    } finally {
      utils.getOldestMsgInChatFromDB = originalGetOldest;
    }
    await drain();
    return { ...summary(), phone };
  }, chatId, anchor);
}

// Anchors to try, in order, when a request for older messages brings nothing.
const ANCHOR_RETRIES = [0, 1, 3, 10, 25];

// Loads as much history as needed into WhatsApp Web's memory: everything
// stored on this linked device, then older batches requested from the phone,
// until the phone has nothing more, or --limit / --since is satisfied.
async function loadHistory(client: Client, chatId: string, limit: number, sinceMs?: number): Promise<void> {
  const enough = (s: HistoryStep) =>
    s.count >= limit || (sinceMs !== undefined && s.oldest !== null && s.oldest * 1000 < sinceMs);

  let step = await historyStep(client, chatId, null);
  while (!enough(step)) {
    const prev = step;
    for (const anchor of ANCHOR_RETRIES) {
      step = await historyStep(client, chatId, anchor);
      if (step.phone === 'unavailable' || step.oldest !== prev.oldest) break;
    }
    if (step.oldest === prev.oldest) {
      process.stderr.write(
        step.phone === 'unavailable'
          ? '  Older messages are only on your phone, and this WhatsApp Web build cannot request them.\n'
          : '  No older messages came back from your phone. Either that is the start of the history on your\n' +
            '  phone, or the phone did not answer (keep it online with WhatsApp open and try again).\n'
      );
      break;
    }
    const oldest = step.oldest !== null ? new Date(step.oldest * 1000).toISOString().slice(0, 10) : '?';
    process.stderr.write(`  loaded ${step.count} messages so far (back to ${oldest})\n`);
  }
}

async function fetchMessages(chat: Chat, limit: number): Promise<Message[]> {
  // Puppeteer sends arguments as JSON, which turns Infinity into null — and a
  // null limit makes whatsapp-web.js skip paging entirely. Use a finite number.
  const msgs = await chat.fetchMessages({ limit: Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER });
  return msgs.sort((a, b) => a.timestamp - b.timestamp);
}

// Current WhatsApp Web message keys no longer carry `_serialized`, so build
// the usual "<fromMe>_<chat>_<id>" form when it is missing.
function messageId(m: Message): string {
  const id = m.id as any;
  if (id._serialized) return id._serialized;
  const remote = typeof id.remote === 'string' ? id.remote : id.remote?._serialized ?? '';
  return `${id.fromMe}_${remote}_${id.id}`;
}

interface DownloadedMedia {
  mimetype: string;
  filename: string | null;
  data: string; // base64
}

// Replaces whatsapp-web.js' Message.downloadMedia(), which no longer works on
// current WhatsApp Web: it looks the message up by `id._serialized` (now
// undefined) and calls downloadAndMaybeDecrypt without a mimetype, which is
// now rejected ("Unexpected mimetype application/octet-stream").
// The message is found by its raw ID among the chat's loaded messages.
async function downloadMedia(client: Client, chatId: string, rawId: string): Promise<DownloadedMedia | null> {
  return client.pupPage!.evaluate(async (cid: string, rid: string) => {
    const req = (globalThis as any).require;
    const chat = req('WAWebCollections').Chat.get(cid);
    const msg = chat?.msgs.getModelsArray().find((x: any) => x.id.id === rid);
    if (!msg || !msg.directPath) return null;

    const qpl = { addAnnotations() { return this; }, addPoint() { return this; } };
    const decrypt = () => req('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
      directPath: msg.directPath,
      encFilehash: msg.encFilehash,
      filehash: msg.filehash,
      mediaKey: msg.mediaKey,
      mediaKeyTimestamp: msg.mediaKeyTimestamp,
      type: msg.type,
      mimetype: msg.mimetype,
      signal: new AbortController().signal,
      downloadQpl: qpl,
    });

    let buf: ArrayBuffer;
    try {
      buf = await decrypt();
    } catch {
      // The CDN link may have expired: let WhatsApp Web refresh it (it asks the
      // phone to re-upload when needed), then try once more.
      await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
      if (!msg.directPath) return null;
      buf = await decrypt();
    }

    // Base64-encode in chunks; String.fromCharCode(...bytes) overflows the stack on large files.
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    }
    return { mimetype: msg.mimetype, filename: msg.filename ?? null, data: btoa(bin) };
  }, chatId, rawId);
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
  const limit = opts.limit ?? Infinity;
  await loadHistory(client, chat.id._serialized, limit, sinceMs);
  let msgs = await fetchMessages(chat, limit);
  if (sinceMs !== undefined) msgs = msgs.filter((m) => m.timestamp * 1000 >= sinceMs);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const mediaDirName = `${base}_media`;
  const mediaDir = path.join(dir, mediaDirName);
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
      id: messageId(m),
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
        // Cap each download: re-uploads of old media from the phone can hang.
        const media = await Promise.race([
          downloadMedia(client, chat.id._serialized, m.id.id),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 60_000)),
        ]);
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
    if (opts.media && m.hasMedia && (mediaSaved + mediaFailed) % 25 === 0) {
      process.stderr.write(`  media: ${mediaSaved} saved, ${mediaFailed} unavailable\n`);
    }
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
    const phones = /^[\d\s+()-]+$/.test(query) ? await lidPhoneNumbers(client, chats) : undefined;
    const chat = resolveChat(chats, query, phones);
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
