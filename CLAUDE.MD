# whatsapp-helper

A Windows CLI tool for connecting to WhatsApp, extracting group member lists, and diffing them across time.

## Purpose

Authenticate with WhatsApp using `whatsapp-web.js` (QR-code-based, same mechanism as WhatsApp Web), then:
1. **Extract** — dump the member list of a group (phone number + display name) to a timestamped JSON file.
2. **Compare** — diff two extractions to surface added and removed members.

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js 20+ | whatsapp-web.js ecosystem |
| Language | TypeScript | Type safety for member/diff models |
| WhatsApp | whatsapp-web.js | Maintained, QR-auth, group participant API |
| CLI framework | Commander.js | Subcommand routing, help generation |
| Output format | JSON (extraction) + human-readable table (diff) | Machine-readable storage, human-readable diffs |

## Project Structure

```
whatsapp-helper/
├── src/
│   ├── cli.ts           # Commander entrypoint, subcommand wiring
│   ├── client.ts        # whatsapp-web.js client init, QR display, session persistence
│   ├── groups.ts        # list-groups and extract commands
│   ├── compare.ts       # diff logic between two extraction files
│   └── types.ts         # Member, Extraction, DiffResult interfaces
├── data/                # Extraction output files (gitignored)
├── .wwebjs_auth/        # whatsapp-web.js session cache (gitignored)
├── package.json
├── tsconfig.json
└── CLAUDE.MD
```

## Core Types

```ts
interface Member {
  phone: string;   // E.164 without '+', e.g. "5511999990000"
  name: string;    // Display name from WhatsApp (may be empty)
  isAdmin: boolean;
}

interface Extraction {
  groupId: string;
  groupName: string;
  extractedAt: string;  // ISO 8601
  members: Member[];
}

interface DiffResult {
  groupId: string;
  groupName: string;
  before: string;  // ISO 8601 timestamp of earlier extraction
  after: string;   // ISO 8601 timestamp of later extraction
  added: Member[];
  removed: Member[];
}
```

## Commands

### `wha groups`
List all WhatsApp groups the account is a member of.

```
wha groups
```

Output: table of group name and group ID.

### `wha extract <group-name-or-id>`
Extract members of the specified group and save to `data/<groupId>_<timestamp>.json`.

```
wha extract "My Group Name"
wha extract 5511999990000-1234567890@g.us
```

Prints a confirmation with member count and output file path.

### `wha compare [file1] [file2]`
Compare two extraction files. If no files given, automatically uses the two most recent files for the same group under `data/`.

```
wha compare
wha compare data/abc_2025-01-01.json data/abc_2025-02-01.json
```

Output: two sections — **Added** and **Removed** — each as a table of phone + name.

## Authentication Flow

1. On first run, `client.ts` starts whatsapp-web.js with `LocalAuth` strategy (persists session under `.wwebjs_auth/`).
2. A QR code is printed to terminal using the `qrcode-terminal` package.
3. User scans with WhatsApp on their phone.
4. On subsequent runs the stored session is reused automatically — no QR required unless the session expires.

## Data Storage

- Extractions are saved as JSON files in `data/` with naming: `<sanitized-group-name>_<ISO-timestamp>.json`
- `data/` and `.wwebjs_auth/` are gitignored to protect personal data and session tokens.

## Build & Run

```sh
npm install
npm run build        # tsc → dist/
node dist/cli.js groups
node dist/cli.js extract "My Group"
node dist/cli.js compare
```

Or with ts-node for development:

```sh
npx ts-node src/cli.ts groups
```

A `bin` field in `package.json` maps `wha` → `dist/cli.js` so `npm link` makes the `wha` command available globally.

## Key Implementation Notes

- Use `LocalAuth` (not `NoAuth`) so sessions survive process restarts.
- whatsapp-web.js `client.getChats()` returns all chats; filter by `chat.isGroup` to get groups.
- Group participants are on `groupChat.participants` — each has `id.user` (phone) and `isAdmin`.
- Display names: prefer `contact.pushname`, fall back to `contact.name`, then empty string. Fetching contacts requires `client.getContactById(participant.id._serialized)` — this adds latency; batch or skip for large groups if needed.
- The `compare` command matches members by phone number, not by name (names change).
- Print QR code to stderr so stdout output stays clean for scripting.

## Dependencies

```json
{
  "dependencies": {
    "whatsapp-web.js": "^1.x",
    "commander": "^12.x",
    "qrcode-terminal": "^0.12.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "@types/node": "^20.x",
    "ts-node": "^10.x"
  }
}
```

## .gitignore additions

```
data/
.wwebjs_auth/
dist/
node_modules/
```
