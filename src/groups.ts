import fs from 'fs';
import path from 'path';
import { Chat, Client, GroupChat } from 'whatsapp-web.js';
import { getClient } from './client';
import type { Extraction, Member } from './types';

// The typings declare these as interfaces only; the runtime exports the classes.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GroupChat: GroupChatClass, PrivateChat: PrivateChatClass } = require('whatsapp-web.js');

const DATA_DIR = 'data';

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

// Replacement for client.getChats(). The library builds every chat model with
// Promise.all, so a single chat that WhatsApp Web fails to load (seen with
// newer WhatsApp Web builds, mostly "@lid" contacts) rejects the whole call.
// Here each chat is loaded on its own; if the full model fails we fall back to
// the fields read directly from the in-memory chat, which is all we need.
async function loadChats(client: Client): Promise<Chat[]> {
  const models = await client.pupPage!.evaluate(async () => {
    const w = globalThis as any;
    const plainWid = (wid: any) => ({ server: wid.server, user: wid.user, _serialized: wid._serialized });
    const toPn = (wid: any) => {
      try { return w.require('WAWebLidMigrationUtils').toPn(wid) ?? wid; } catch { return wid; }
    };

    const chats = w.require('WAWebCollections').Chat.getModelsArray();
    return Promise.all(chats.map(async (chat: any) => {
      try {
        return await w.WWebJS.getChatModel(chat);
      } catch {
        // fall through to the minimal model
      }
      try {
        const isGroup = !!chat.groupMetadata || chat.id.server === 'g.us';
        let participants: any[] = [];
        try {
          participants = chat.groupMetadata?.participants?.getModelsArray().map((p: any) => ({
            id: plainWid(toPn(p.id)),
            isAdmin: !!p.isAdmin,
            isSuperAdmin: !!p.isSuperAdmin,
          })) ?? [];
        } catch {
          // leave participants empty
        }
        return {
          id: plainWid(chat.id),
          formattedTitle: chat.formattedTitle || chat.name || '',
          isGroup,
          t: chat.t,
          groupMetadata: isGroup ? { participants } : undefined,
        };
      } catch {
        return null;
      }
    }));
  });

  return models
    .filter((m: any) => m)
    .map((m: any) => (m.isGroup ? new GroupChatClass(client, m) : new PrivateChatClass(client, m)));
}

export async function getAllChats(): Promise<Chat[]> {
  const client = await getClient();
  return Promise.race([
    loadChats(client),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Timed out loading chats (60s). Try "wha reset" if this persists.')),
        60_000
      )
    ),
  ]);
}

async function getAllGroups(): Promise<GroupChat[]> {
  const chats = await getAllChats();
  return chats.filter((c) => c.isGroup) as GroupChat[];
}

function resolveGroup(groups: GroupChat[], query: string): GroupChat {
  const byId = groups.find((g) => g.id._serialized === query);
  if (byId) return byId;

  const lower = query.toLowerCase();
  const byName = groups.filter((g) => g.name.toLowerCase().includes(lower));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const exact = byName.find((g) => g.name.toLowerCase() === lower);
    if (exact) return exact;
    const names = byName.map((g) => `  "${g.name}" (${g.id._serialized})`).join('\n');
    throw new Error(`Multiple groups match "${query}":\n${names}\nUse the group ID to disambiguate.`);
  }
  throw new Error(`No group found matching "${query}". Run "wha groups" to see available groups.`);
}

export async function listGroups(): Promise<void> {
  const groups = await getAllGroups();
  if (groups.length === 0) {
    console.log('No groups found.');
    return;
  }
  const nameWidth = Math.max(...groups.map((g) => g.name.length), 10);
  console.log(`${'Group Name'.padEnd(nameWidth)}  Group ID`);
  console.log(`${'-'.repeat(nameWidth)}  ${'-'.repeat(40)}`);
  for (const g of groups) {
    console.log(`${g.name.padEnd(nameWidth)}  ${g.id._serialized}`);
  }
}

export function extractionToTxt(extraction: Extraction): string {
  const lines: string[] = [
    `Group:     ${extraction.groupName}`,
    `Extracted: ${extraction.extractedAt}`,
    `Members:   ${extraction.members.length}`,
    '',
  ];

  const named = extraction.members.filter((m) => m.name).sort((a, b) => a.name.localeCompare(b.name));
  const unnamed = extraction.members.filter((m) => !m.name);

  const phoneWidth = Math.max(...extraction.members.map((m) => m.phone.length), 5);

  for (const m of [...named, ...unnamed]) {
    const admin = m.isAdmin ? '  [admin]' : '';
    lines.push(`+${m.phone.padEnd(phoneWidth)}  ${m.name}${admin}`);
  }

  return lines.join('\n') + '\n';
}

export async function extractGroup(query: string, opts: { txt?: boolean } = {}): Promise<void> {
  ensureDataDir();
  const client = await getClient();
  const groups = await getAllGroups();
  const group = resolveGroup(groups, query);

  process.stderr.write(`Fetching participants for "${group.name}"...\n`);

  const members: Member[] = [];
  for (const p of group.participants) {
    let name = '';
    try {
      const contact = await client.getContactById(p.id._serialized);
      name = contact.pushname || contact.name || '';
    } catch {
      // contact lookup failed — leave name empty
    }
    members.push({ phone: p.id.user, name, isAdmin: p.isAdmin });
  }

  const extraction: Extraction = {
    groupId: group.id._serialized,
    groupName: group.name,
    extractedAt: new Date().toISOString(),
    members,
  };

  const timestamp = extraction.extractedAt.replace(/[:.]/g, '-');
  const base = `${sanitizeName(group.name)}_${timestamp}`;
  const jsonPath = path.join(DATA_DIR, `${base}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(extraction, null, 2), 'utf-8');

  console.log(`Extracted ${members.length} members from "${group.name}"`);
  console.log(`Saved to: ${jsonPath}`);

  if (opts.txt) {
    const txtPath = path.join(DATA_DIR, `${base}.txt`);
    fs.writeFileSync(txtPath, extractionToTxt(extraction), 'utf-8');
    console.log(`Saved to: ${txtPath}`);
  }
}
