#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { destroyClient } from './client';
import { compareExtractions } from './compare';
import { exportChat, listChats, type ExportOptions } from './export';
import { extractGroup, listGroups } from './groups';
import type { Extraction } from './types';

function showStatus(): void {
  // ── Session ──────────────────────────────────────────────────────────────
  const authDir = '.wwebjs_auth';

  console.log('Session');
  if (!fs.existsSync(authDir)) {
    console.log('  Status:    no saved session — next run will show a QR code');
  } else {
    // LocalAuth stores data in a subdirectory whose name depends on clientId
    // (e.g. "session" or "session-<id>"). Find whichever one is present.
    const sessionDir = fs.readdirSync(authDir)
      .map((f) => path.join(authDir, f))
      .find((f) => fs.statSync(f).isDirectory());

    if (!sessionDir) {
      console.log('  Status:    auth directory exists but session data is missing');
      console.log('  Action:    run "wha reset" then reconnect');
    } else {
      const mtime = fs.statSync(sessionDir).mtime;
      console.log('  Status:    saved');
      console.log(`  Last used: ${mtime.toISOString().replace('T', ' ').slice(0, 16)}`);
    }
  }

  // ── Data ─────────────────────────────────────────────────────────────────
  const dataDir = 'data';
  console.log('\nData');
  if (!fs.existsSync(dataDir)) {
    console.log('  No extraction files yet — run "wha extract <group>"');
    return;
  }

  const jsonFiles = fs.readdirSync(dataDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dataDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (jsonFiles.length === 0) {
    console.log('  No extraction files yet — run "wha extract <group>"');
    return;
  }

  // Group files by groupId
  const byGroup = new Map<string, { name: string; count: number; latest: Extraction }>();
  for (const f of jsonFiles) {
    try {
      const ex: Extraction = JSON.parse(fs.readFileSync(f, 'utf-8'));
      const entry = byGroup.get(ex.groupId);
      if (!entry) {
        byGroup.set(ex.groupId, { name: ex.groupName, count: 1, latest: ex });
      } else {
        entry.count++;
        if (ex.extractedAt > entry.latest.extractedAt) entry.latest = ex;
      }
    } catch {
      // skip malformed files
    }
  }

  console.log(`  ${jsonFiles.length} extraction file(s) across ${byGroup.size} group(s)\n`);

  const nameWidth = Math.max(...[...byGroup.values()].map((e) => e.name.length), 10);
  console.log(`  ${'Group'.padEnd(nameWidth)}  Files  Members  Last extracted`);
  console.log(`  ${'-'.repeat(nameWidth)}  -----  -------  --------------`);
  for (const { name, count, latest } of byGroup.values()) {
    const ts = latest.extractedAt.replace('T', ' ').slice(0, 16);
    console.log(`  ${name.padEnd(nameWidth)}  ${String(count).padEnd(5)}  ${String(latest.members.length).padEnd(7)}  ${ts}`);
  }
}

const program = new Command();

program
  .name('wha')
  .description('WhatsApp group member extractor and differ, and chat exporter')
  .version('1.0.0');

program
  .command('groups')
  .description('List all WhatsApp groups you are a member of')
  .action(async () => {
    try {
      await listGroups();
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      await destroyClient();
      process.exit(process.exitCode ?? 0);
    }
  });

program
  .command('extract <group>')
  .description('Extract members of a group by name or ID and save to data/')
  .option('--txt', 'also save a plain-text (.txt) version alongside the JSON')
  .action(async (group: string, opts: { txt?: boolean }) => {
    try {
      await extractGroup(group, opts);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      await destroyClient();
      process.exit(process.exitCode ?? 0);
    }
  });

program
  .command('chats')
  .description('List all WhatsApp chats (individual and group)')
  .action(async () => {
    try {
      await listChats();
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      await destroyClient();
      process.exit(process.exitCode ?? 0);
    }
  });

program
  .command('export [chat]')
  .description('Export the messages of a chat (by name, phone number or ID), or of several chats, to exports/')
  .option('--all', 'export every chat (individual and group) into exports/batch_<timestamp>/')
  .option('--match <pattern>', 'export chats whose name, phone or ID matches a wildcard pattern (* and ?), e.g. "Family*"')
  .option('--limit <n>', 'only export the most recent <n> messages', (v) => Number.parseInt(v, 10))
  .option('--since <date>', 'only export messages on or after <date> (e.g. 2026-01-31)')
  .option('--json', 'also save a machine-readable (.json) version alongside the .txt')
  .option('--media', 'download media attachments into a folder next to the export')
  .action(async (chat: string | undefined, opts: ExportOptions) => {
    try {
      await exportChat(chat, opts);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      await destroyClient();
      process.exit(process.exitCode ?? 0);
    }
  });

program
  .command('compare [file1] [file2]')
  .description('Diff two extraction files (defaults to the two most recent for the same group)')
  .action(async (file1?: string, file2?: string) => {
    try {
      compareExtractions(file1, file2);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command('status')
  .description('Show session and data directory status (no WhatsApp connection needed)')
  .action(() => {
    try {
      showStatus();
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command('reset')
  .description('Delete the saved WhatsApp session so the next run shows a fresh QR code')
  .action(() => {
    const authDir = '.wwebjs_auth';
    if (!fs.existsSync(authDir)) {
      console.log('No saved session found — nothing to reset.');
      return;
    }
    fs.rmSync(authDir, { recursive: true, force: true });
    console.log(`Deleted ${authDir}. Next run will show a new QR code.`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
