import fs from 'fs';
import path from 'path';
import { GroupChat } from 'whatsapp-web.js';
import { getClient } from './client';
import type { Extraction, Member } from './types';

const DATA_DIR = 'data';

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

async function getAllGroups(): Promise<GroupChat[]> {
  const client = await getClient();
  const chats = await client.getChats();
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

export async function extractGroup(query: string): Promise<void> {
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
  const filename = `${sanitizeName(group.name)}_${timestamp}.json`;
  const outPath = path.join(DATA_DIR, filename);
  fs.writeFileSync(outPath, JSON.stringify(extraction, null, 2), 'utf-8');

  console.log(`Extracted ${members.length} members from "${group.name}"`);
  console.log(`Saved to: ${outPath}`);
}
