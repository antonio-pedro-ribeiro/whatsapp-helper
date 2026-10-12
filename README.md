# whatsapp-helper

A Windows CLI tool for connecting to WhatsApp, extracting group member lists, and diffing them across time.

## What it does

- **Authenticate** with WhatsApp via QR code (same as WhatsApp Web)
- **Extract** the member list of any group you belong to (phone + display name) and save it as a timestamped JSON file
- **Compare** two extractions to see who joined or left a group
- **Export** the message history of any chat (individual or group) to a readable `.txt`, optionally with `.json` and media

## Prerequisites

- Node.js 20+
- A WhatsApp account on your phone

## Installation

```sh
npm install
npm run build
npm link
```

After linking, the `wha` command is available globally.

## Usage

```
wha <command>
```

| Command | Description |
|---|---|
| `wha status` | Show session and saved extraction status (no connection needed) |
| `wha groups` | List all WhatsApp groups you are a member of |
| `wha extract <group>` | Extract members of a group to `data/` |
| `wha extract <group> --txt` | Also write a human-readable `.txt` alongside the JSON |
| `wha chats` | List all chats (individual and group) with their IDs |
| `wha chats export <chat>` | Export a chat's entire history to a `.txt` in `exports/` (`<chat>` = name, phone number or chat ID). `wha export <chat>` is a shorthand |
| `wha export <chat> --json` | Also write a machine-readable `.json` |
| `wha export <chat> --media` | Also download media attachments into `exports/<name>_<timestamp>_media/` |
| `wha export <chat> --limit <n>` | Only the most recent `<n>` messages |
| `wha export <chat> --since <date>` | Only messages on or after `<date>` (e.g. `2026-01-31`) |
| `wha compare` | Diff the two most recent extractions for the same group |
| `wha compare <file1> <file2>` | Diff two specific extraction files |
| `wha reset` | Delete the saved session (triggers a new QR code on next run) |

## First run

On first run, a QR code is printed in the terminal. Scan it with WhatsApp on your phone. The session is saved locally and reused on subsequent runs — no QR required unless the session expires.

## Output files

Extractions are saved under `data/` with the naming pattern:

```
data/<group-name>_<ISO-timestamp>.json
```

The `--txt` flag writes an additional human-readable file at the same path with a `.txt` extension, listing named members first (alphabetically), then unnamed members, each with their phone number and admin status.

### Chat exports

Chat exports are saved under `exports/` (kept separate from `data/` so `compare` and `status` are unaffected):

```
exports/<chat-name>_<ISO-timestamp>.txt
```

One line per message, in chronological order and local time:

```
[2026-01-01 10:00:00] Alexandra Sedas: Hello all
[2026-01-01 10:01:00] You: Hi!
[2026-01-01 10:02:00] +447584665606: <image omitted> nice view
```

Limitations: older messages are fetched from your phone (keep it online during the export), but WhatsApp only serves about the last 12 months of history to linked devices, so older messages are not included. For the complete history use WhatsApp's own *Export chat* on the phone. With `--media`, old attachments that WhatsApp no longer stores are reported as "unavailable".

## Example workflow

```sh
# First time — scan the QR code that appears
wha groups

# Extract members now
wha extract "My Group"

# ... wait a few days, then extract again
wha extract "My Group"

# See who joined or left
wha compare
```

```sh
# Export a full conversation, with media
wha chats
wha export "Alexandra" --media
wha export "+351 917 190 172" --since 2026-01-01 --json
```
