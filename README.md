# whatsapp-helper

A Windows CLI tool for connecting to WhatsApp, extracting group member lists, and diffing them across time.

## What it does

- **Authenticate** with WhatsApp via QR code (same as WhatsApp Web)
- **Extract** the member list of any group you belong to (phone + display name) and save it as a timestamped JSON file
- **Compare** two extractions to see who joined or left a group

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
