import fs from 'fs';
import path from 'path';
import type { DiffResult, Extraction, Member } from './types';

const DATA_DIR = 'data';

function loadExtraction(filePath: string): Extraction {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as Extraction;
}

function findLatestPair(): [string, string] {
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`Data directory "${DATA_DIR}" does not exist. Run "wha extract" first.`);
  }

  const files = fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(DATA_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (files.length < 2) {
    throw new Error('Need at least two extraction files to compare. Run "wha extract" again after some time has passed.');
  }

  // Group files by groupId prefix (first part before first timestamp segment)
  const extractions = files.map((f) => ({ file: f, data: loadExtraction(f) }));
  const byGroup = new Map<string, typeof extractions>();
  for (const e of extractions) {
    const id = e.data.groupId;
    if (!byGroup.has(id)) byGroup.set(id, []);
    byGroup.get(id)!.push(e);
  }

  // Find the group with the most files, prefer groups with >= 2 extractions
  for (const entries of byGroup.values()) {
    if (entries.length >= 2) {
      // entries are already sorted by mtime desc (newest first)
      return [entries[1].file, entries[0].file];
    }
  }

  // Fallback: use the two most recent files regardless of group
  return [files[1], files[0]];
}

function diffMembers(before: Extraction, after: Extraction): DiffResult {
  const beforeMap = new Map(before.members.map((m) => [m.phone, m]));
  const afterMap = new Map(after.members.map((m) => [m.phone, m]));

  const added: Member[] = [];
  const removed: Member[] = [];

  for (const [phone, member] of afterMap) {
    if (!beforeMap.has(phone)) added.push(member);
  }
  for (const [phone, member] of beforeMap) {
    if (!afterMap.has(phone)) removed.push(member);
  }

  return {
    groupId: after.groupId,
    groupName: after.groupName,
    before: before.extractedAt,
    after: after.extractedAt,
    added,
    removed,
  };
}

function printMemberTable(members: Member[]): void {
  if (members.length === 0) {
    console.log('  (none)');
    return;
  }
  const nameWidth = Math.max(...members.map((m) => m.name.length), 4);
  console.log(`  ${'Phone'.padEnd(15)}  ${'Name'.padEnd(nameWidth)}  Admin`);
  console.log(`  ${'-'.repeat(15)}  ${'-'.repeat(nameWidth)}  -----`);
  for (const m of members) {
    console.log(`  ${m.phone.padEnd(15)}  ${m.name.padEnd(nameWidth)}  ${m.isAdmin ? 'yes' : ''}`);
  }
}

export function compareExtractions(file1?: string, file2?: string): void {
  let beforePath: string;
  let afterPath: string;

  if (file1 && file2) {
    [beforePath, afterPath] = [file1, file2];
  } else if (file1 || file2) {
    throw new Error('Provide either both files or neither (auto-detect).');
  } else {
    [beforePath, afterPath] = findLatestPair();
  }

  const before = loadExtraction(beforePath);
  const after = loadExtraction(afterPath);
  const diff = diffMembers(before, after);

  console.log(`Group:   ${diff.groupName}`);
  console.log(`Before:  ${diff.before}  (${before.members.length} members)`);
  console.log(`After:   ${diff.after}  (${after.members.length} members)`);
  console.log();

  const noChanges = diff.added.length === 0 && diff.removed.length === 0;
  if (noChanges) {
    console.log('No membership changes detected.');
    return;
  }

  console.log(`Added (${diff.added.length}):`);
  printMemberTable(diff.added);
  console.log();
  console.log(`Removed (${diff.removed.length}):`);
  printMemberTable(diff.removed);
}
