#!/usr/bin/env node
import { Command } from 'commander';
import { destroyClient } from './client';
import { compareExtractions } from './compare';
import { extractGroup, listGroups } from './groups';

const program = new Command();

program
  .name('wha')
  .description('WhatsApp group member extractor and differ')
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

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
