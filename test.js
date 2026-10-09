// Standalone test runner — no test framework needed.
// All fixtures are fabricated inline; no dependency on real WhatsApp data.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function assertContains(haystack, needle, label) {
  assert(haystack.includes(needle), `${label}  [expected: ${JSON.stringify(needle)}]`);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const GROUP_ID = '66658120500-1588652598@g.us';

const FIXTURE_BEFORE = {
  groupId: GROUP_ID,
  groupName: 'Open to Bliss updates',
  extractedAt: '2026-01-01T10:00:00.000Z',
  members: [
    { phone: '351917190172', name: 'Alexandra Sedas',  isAdmin: false },
    { phone: '33665757442',  name: 'Alison Sarah Pym', isAdmin: false },
    { phone: '5215579091711', name: 'Satyama Ratna',   isAdmin: true  },
    { phone: '447584665606', name: '',                 isAdmin: false },
    { phone: '66963160339',  name: '',                 isAdmin: false },
  ],
};

const FIXTURE_AFTER = {
  groupId: GROUP_ID,
  groupName: 'Open to Bliss updates',
  extractedAt: '2026-02-01T10:00:00.000Z',
  members: [
    // Alexandra removed, New Person added, rest unchanged
    { phone: '33665757442',  name: 'Alison Sarah Pym', isAdmin: false },
    { phone: '5215579091711', name: 'Satyama Ratna',   isAdmin: true  },
    { phone: '447584665606', name: '',                 isAdmin: false },
    { phone: '66963160339',  name: '',                 isAdmin: false },
    { phone: '999999999999', name: 'New Person',        isAdmin: false },
  ],
};

const FIXTURE_SAME = {
  ...FIXTURE_BEFORE,
  extractedAt: '2026-03-01T10:00:00.000Z',
};

const BEFORE_FILE = path.join('data', '_test_before.json');
const AFTER_FILE  = path.join('data', '_test_after.json');
const SAME_FILE   = path.join('data', '_test_same.json');

if (!fs.existsSync('data')) fs.mkdirSync('data');

// ─── Suite 1: TXT formatting ─────────────────────────────────────────────────

console.log('\n=== Suite 1: TXT formatting ===');

const { extractionToTxt } = require('./dist/groups');

const txt = extractionToTxt(FIXTURE_BEFORE);
const txtLines = txt.split('\n');

assertContains(txt, 'Group:     Open to Bliss updates',   'header: group name');
assertContains(txt, 'Extracted: 2026-01-01T10:00:00.000Z', 'header: timestamp');
assertContains(txt, 'Members:   5',                        'header: member count');

assertContains(txt, '+5215579091711', 'admin phone present');
assertContains(txt, 'Satyama Ratna',  'admin name present');
assertContains(txt, '[admin]',         'admin flag present');

// Named members first, then unnamed
const namedLines   = txtLines.filter(l => /^\+\d/.test(l) && l.trim().split(/\s{2,}/)[1]);
const unnamedLines = txtLines.filter(l => /^\+\d/.test(l) && !l.trim().split(/\s{2,}/)[1]);
const lastNamedIdx   = Math.max(...namedLines.map(l => txtLines.indexOf(l)));
const firstUnnamedIdx = Math.min(...unnamedLines.map(l => txtLines.lastIndexOf(l)));
assert(lastNamedIdx < firstUnnamedIdx, 'named members appear before unnamed members');

// Alphabetical: Alexandra before Alison
const alexIdx   = txt.indexOf('Alexandra Sedas');
const alisonIdx = txt.indexOf('Alison Sarah Pym');
assert(alexIdx < alisonIdx, 'alphabetical ordering of named members');

// All 5 members present
const memberLines = txtLines.filter(l => /^\+\d/.test(l));
assert(memberLines.length === 5, `all 5 members present (got ${memberLines.length})`);

// Admin member not in unnamed section
const adminLine = txtLines.find(l => l.includes('Satyama Ratna'));
assert(adminLine && adminLine.includes('[admin]') && !adminLine.includes('[admin]  [admin]'),
  'admin line has exactly one [admin] tag');

// ─── Suite 2: TXT written to disk ────────────────────────────────────────────

console.log('\n=== Suite 2: TXT written to disk ===');

const txtPath = path.join('data', '_test_output.txt');
if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);

fs.writeFileSync(txtPath, extractionToTxt(FIXTURE_BEFORE), 'utf-8');
assert(fs.existsSync(txtPath), 'txt file created');

const fromDisk = fs.readFileSync(txtPath, 'utf-8');
assertContains(fromDisk, 'Members:   5', 'txt file has correct member count');
assertContains(fromDisk, '[admin]',      'txt file contains admin flag');

const diskMemberLines = fromDisk.split('\n').filter(l => /^\+\d/.test(l));
assert(diskMemberLines.length === 5, `txt file has all 5 member lines (got ${diskMemberLines.length})`);

fs.unlinkSync(txtPath);

// ─── Suite 3: Compare — changes detected ─────────────────────────────────────

console.log('\n=== Suite 3: Compare — changes detected ===');

fs.writeFileSync(BEFORE_FILE, JSON.stringify(FIXTURE_BEFORE, null, 2));
fs.writeFileSync(AFTER_FILE,  JSON.stringify(FIXTURE_AFTER,  null, 2));

try {
  const out = execSync(
    `node dist/cli.js compare ${BEFORE_FILE} ${AFTER_FILE}`,
    { encoding: 'utf-8' }
  );

  console.log('\n  [compare output]\n' + out.split('\n').map(l => '  ' + l).join('\n'));

  assertContains(out, 'Open to Bliss updates',      'group name shown');
  assertContains(out, '2026-01-01T10:00:00.000Z',   'before timestamp shown');
  assertContains(out, '2026-02-01T10:00:00.000Z',   'after timestamp shown');
  assertContains(out, 'Added (1)',                   'correct added count');
  assertContains(out, 'Removed (1)',                 'correct removed count');
  assertContains(out, '999999999999',                'added member phone present');
  assertContains(out, 'New Person',                  'added member name present');
  assertContains(out, '351917190172',                'removed member phone present');
  assertContains(out, 'Alexandra Sedas',             'removed member name present');

  // Unchanged members must not appear in added/removed sections
  const addedSection   = out.slice(out.indexOf('Added'));
  const removedSection = out.slice(out.indexOf('Removed'));
  assert(!addedSection.includes('Alison'),   'unchanged member not in added section');
  assert(!removedSection.includes('999999'), 'new member not in removed section');
} finally {
  fs.unlinkSync(BEFORE_FILE);
  fs.unlinkSync(AFTER_FILE);
}

// ─── Suite 4: Compare — no changes ───────────────────────────────────────────

console.log('\n=== Suite 4: Compare — no changes ===');

fs.writeFileSync(BEFORE_FILE, JSON.stringify(FIXTURE_BEFORE, null, 2));
fs.writeFileSync(SAME_FILE,   JSON.stringify(FIXTURE_SAME,   null, 2));

try {
  const out = execSync(
    `node dist/cli.js compare ${BEFORE_FILE} ${SAME_FILE}`,
    { encoding: 'utf-8' }
  );
  assertContains(out, 'No membership changes detected.', 'no-change message shown');
} finally {
  fs.unlinkSync(BEFORE_FILE);
  fs.unlinkSync(SAME_FILE);
}

// ─── Suite 5: Compare auto-detect (two files, same group) ────────────────────

console.log('\n=== Suite 5: Compare auto-detect ===');

// Write two files with same groupId, different timestamps
const autoA = path.join('data', '_autotest_a.json');
const autoB = path.join('data', '_autotest_b.json');
fs.writeFileSync(autoA, JSON.stringify(FIXTURE_BEFORE, null, 2));
// tiny delay so mtime differs, then write B as the "newer" file
fs.writeFileSync(autoB, JSON.stringify(FIXTURE_AFTER, null, 2));
// touch autoB to ensure it's newer
fs.utimesSync(autoB, new Date(), new Date(Date.now() + 1000));

try {
  const out = execSync(`node dist/cli.js compare`, { encoding: 'utf-8' });
  assertContains(out, 'Open to Bliss updates', 'auto-detect: correct group name');
  assertContains(out, 'Added (1)',              'auto-detect: found added member');
  assertContains(out, 'Removed (1)',            'auto-detect: found removed member');
} finally {
  fs.unlinkSync(autoA);
  fs.unlinkSync(autoB);
}

// ─── Suite 6: Chat export TXT formatting ─────────────────────────────────────

console.log('\n=== Suite 6: Chat export TXT formatting ===');

const { chatExportToTxt, resolveChat } = require('./dist/export');

const FIXTURE_EXPORT = {
  chatId: GROUP_ID,
  chatName: 'Open to Bliss updates',
  isGroup: true,
  exportedAt: '2026-03-01T10:00:00.000Z',
  messages: [
    { id: 'a', timestamp: '2026-01-01T10:00:00.000Z', sender: '351917190172', senderName: 'Alexandra Sedas',
      fromMe: false, type: 'chat', body: 'Hello all', hasMedia: false },
    { id: 'b', timestamp: '2026-01-01T10:01:00.000Z', sender: '', senderName: '',
      fromMe: true, type: 'chat', body: 'line one\nline two', hasMedia: false },
    { id: 'c', timestamp: '2026-01-01T10:02:00.000Z', sender: '447584665606', senderName: '',
      fromMe: false, type: 'image', body: 'nice view', hasMedia: true },
    { id: 'd', timestamp: '2026-01-01T10:03:00.000Z', sender: '33665757442', senderName: 'Alison Sarah Pym',
      fromMe: false, type: 'ptt', body: '', hasMedia: true, mediaFile: 'x_media/00004_ptt.ogg' },
    { id: 'e', timestamp: '2026-01-01T10:04:00.000Z', sender: '33665757442', senderName: 'Alison Sarah Pym',
      fromMe: false, type: 'revoked', body: '', hasMedia: false },
    { id: 'f', timestamp: '2026-01-01T10:05:00.000Z', sender: '33665757442', senderName: 'Alison Sarah Pym',
      fromMe: false, type: 'location', body: '/9j/4AAQSkZJRgABAQ', hasMedia: false },
  ],
};

const chatTxt = chatExportToTxt(FIXTURE_EXPORT);
const msgLines = chatTxt.split('\n').filter(l => /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /.test(l));

assertContains(chatTxt, 'Chat:      Open to Bliss updates', 'header: chat name');
assertContains(chatTxt, 'Type:      group',                 'header: chat type');
assertContains(chatTxt, 'Messages:  6',                     'header: message count');
assert(msgLines.length === 6, `one timestamped line per message (got ${msgLines.length})`);
assertContains(chatTxt, 'Alexandra Sedas: Hello all',       'named sender + body');
assertContains(chatTxt, 'You: line one\n    line two',      'own message labelled "You", multi-line indented');
assertContains(chatTxt, '+447584665606: <image omitted> nice view', 'unnamed sender falls back to phone; media caption kept');
assertContains(chatTxt, '<voice message: x_media/00004_ptt.ogg>',   'downloaded media references file');
assertContains(chatTxt, '<message deleted>',                'revoked message labelled');
assertContains(chatTxt, 'Alison Sarah Pym: <location>',     'location labelled');
assert(!chatTxt.includes('/9j/'),                           'location thumbnail not dumped as text');
assert(chatTxt.indexOf('Hello all') < chatTxt.indexOf('line one'), 'messages kept in chronological order');

// ─── Suite 7: Chat resolution ────────────────────────────────────────────────

console.log('\n=== Suite 7: Chat resolution ===');

const fakeChat = (serialized, name, isGroup) =>
  ({ id: { _serialized: serialized, user: serialized.split('@')[0] }, name, isGroup });
const CHATS = [
  fakeChat(GROUP_ID, 'Open to Bliss updates', true),
  fakeChat('351917190172@c.us', 'Alexandra Sedas', false),
  fakeChat('33665757442@c.us', 'Alison', false),
  fakeChat('33665757443@c.us', 'Alison Pym', false),
];

assert(resolveChat(CHATS, GROUP_ID).name === 'Open to Bliss updates', 'resolve by chat ID');
assert(resolveChat(CHATS, '+351 917 190 172').name === 'Alexandra Sedas', 'resolve individual chat by phone');
assert(resolveChat(CHATS, 'bliss').name === 'Open to Bliss updates', 'resolve by partial name (case-insensitive)');
assert(resolveChat(CHATS, 'alison').name === 'Alison', 'exact name wins among multiple partial matches');

let ambiguousErr = '';
try { resolveChat(CHATS, 'ali'); } catch (e) { ambiguousErr = e.message; }
assertContains(ambiguousErr, 'Multiple chats match', 'ambiguous name throws');

let missingErr = '';
try { resolveChat(CHATS, 'nobody'); } catch (e) { missingErr = e.message; }
assertContains(missingErr, 'No chat found', 'unknown chat throws');

// ─── Suite 8: Export option validation (no WhatsApp connection) ──────────────

console.log('\n=== Suite 8: Export option validation ===');

for (const [args, expected, label] of [
  ['--limit 0',          '--limit must be a positive number', 'rejects --limit 0'],
  ['--limit abc',        '--limit must be a positive number', 'rejects non-numeric --limit'],
  ['--since not-a-date', 'Invalid --since date',              'rejects invalid --since'],
]) {
  let stderr = '';
  try {
    execSync(`node dist/cli.js export someone ${args}`, { encoding: 'utf-8', stdio: 'pipe' });
  } catch (e) {
    stderr = e.stderr;
  }
  assertContains(stderr, expected, label);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
