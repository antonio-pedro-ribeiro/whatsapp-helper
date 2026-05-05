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
│   ├── cli.ts           # Commander entrypoint, subcommand wiring, status command
│   ├── client.ts        # whatsapp-web.js client init, QR display, session persistence
│   ├── groups.ts        # groups and extract commands
│   ├── compare.ts       # diff logic between two extraction files
│   └── types.ts         # Member, Extraction, DiffResult interfaces
├── data/                # Extraction output files (gitignored)
├── .wwebjs_auth/        # whatsapp-web.js session cache (gitignored)
├── test.js              # Self-contained test runner (no framework)
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

## Usage

```
wha <command> [options]

Commands:
  groups                  List all WhatsApp groups you are a member of
  extract <group>         Extract members of a group and save to data/
  compare [file1] [file2] Diff two extraction files
  status                  Show session and data directory status
  reset                   Delete the saved session (triggers new QR on next run)
  help [command]          Display help for a command
```

## Commands

### `wha groups`
List all WhatsApp groups the account is a member of.

```
wha groups
```

Output: table of group name and group ID.

### `wha extract <group-name-or-id>`
Extract members of the specified group and save to `data/<name>_<timestamp>.json`.

```
wha extract "My Group Name"
wha extract 5511999990000-1234567890@g.us
wha extract "My Group Name" --txt
```

Prints a confirmation with member count and output file path(s).

#### `--txt` flag
When passed, also writes a human-readable `.txt` file alongside the JSON at the same base path (`data/<name>_<timestamp>.txt`).

Format:
- Header: group name, extraction timestamp, member count
- One member per line: `+<phone>  <name>  [admin]`
- Named members listed first (alphabetically), unnamed members after

### `wha compare [file1] [file2]`
Compare two extraction files. If no files given, automatically uses the two most recent files for the same group under `data/`.

```
wha compare
wha compare data/abc_2025-01-01.json data/abc_2025-02-01.json
```

Output: two sections — **Added** and **Removed** — each as a table of phone + name.

### `wha status`
Show session and data directory status. Runs instantly with no WhatsApp connection needed.

```
wha status
```

Output:
- **Session** — whether a saved session exists and when it was last used. Possible states:
  - `saved` — session is present, last-used timestamp shown
  - `no saved session` — `.wwebjs_auth/` is absent; next run will show a QR code
  - `session data missing` — directory exists but is empty (corrupted); run `wha reset`
- **Data** — per-group summary of extraction files: file count, most recent member count, last extraction timestamp

### `wha reset`
Delete the saved WhatsApp session so the next run shows a fresh QR code.

```
wha reset
```

Removes `.wwebjs_auth/`. Use this when the session has expired and re-authentication is failing, or to switch to a different WhatsApp account.

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
npm link             # registers 'wha' as a global command
```

Then use from any directory:

```sh
wha status
wha groups
wha extract "My Group"
wha extract "My Group" --txt
wha compare
wha reset
```

Or run directly without linking:

```sh
node dist/cli.js groups
```

## Key Implementation Notes

- Use `LocalAuth` (not `NoAuth`) so sessions survive process restarts. Session is stored in `.wwebjs_auth/session/`.
- `ready` fires before WhatsApp's internal chat store finishes loading. A 1-second delay after `ready` prevents `getChats()` from hanging on first call.
- `getChats()` is wrapped with a 60-second timeout; if it expires the error message suggests `wha reset`.
- `client.destroy()` is capped at 5 seconds and its errors are swallowed — `TargetCloseError` is expected when Chrome is already shutting down.
- whatsapp-web.js `client.getChats()` returns all chats; filter by `chat.isGroup` to get groups.
- Group participants are on `groupChat.participants` — each has `id.user` (phone) and `isAdmin`.
- Display names: prefer `contact.pushname`, fall back to `contact.name`, then empty string. Fetching contacts requires `client.getContactById(participant.id._serialized)` — this adds latency for large groups.
- The `compare` command matches members by phone number, not by name (names change).
- QR code is printed to stderr so stdout stays clean for scripting.
- Commands that open the WhatsApp client call `process.exit()` explicitly after `destroyClient()` — Puppeteer keeps handles that prevent natural Node.js exit.

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
