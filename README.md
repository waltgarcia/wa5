# WA5

**Up to five WhatsApp Web accounts at the same time, in a single macOS app.**

Each account runs in its own Chromium session —separate cookies, `localStorage` and
`IndexedDB`— so no number ever sees or overwrites another's session. Switch accounts with
one click or with `⌘1` … `⌘5`.

> Independent project. Not affiliated with, sponsored by, or endorsed by WhatsApp LLC or
> Meta Platforms, Inc. “WhatsApp” is a trademark of its respective owners.

![WA5 with four accounts in the sidebar](docs/screenshot.png)

---

## What it does

- **Five simultaneous accounts**, each with its own independent, persistent login.
- **Real session isolation**: every account lives in a different `persist:wa-<id>`
  partition. No browser profiles, no loose windows.
- **Entry password** with a fixed profile name and optional **Touch ID** (see below).
- **Instant switching** from the sidebar or with `⌘1` … `⌘5`.
- **Unread counters** per account, plus the total in the Dock badge.
- **Native notification** when a message arrives in an account that is not on screen.
- **Local control server** (optional) so an agent can read chats and leave drafts.
- **Log out** or **remove** an account, actually deleting its local data.
- **Independent zoom** per account (`⌘+`, `⌘-`, `⌘0`).
- Zero telemetry: WA5 sends nothing to any server. Everything stays on your Mac.

## What it does not do

- It does not create WhatsApp accounts: you use numbers you already have.
- It does not bypass WhatsApp's rules; the app simply loads `web.whatsapp.com`.
- It does not work without internet or without the linked phone, just like WhatsApp Web.
- **It never sends messages on its own.** The control server only writes drafts.

## Install

Requires macOS 11 or later and Node 18 or later.

```bash
git clone https://github.com/waltgarcia/wa5.git
cd wa5
npm install
npm start
```

### Build the .app

```bash
npm run build           # leaves dist/WA5-darwin-arm64/WA5.app
cp -R dist/WA5-darwin-arm64/WA5.app /Applications/
./reinstall.sh          # or run the script, which does both and opens it
```

The first time you open the unsigned `.app`, macOS will ask for confirmation:
right-click the icon → **Open**.

## Entry password and Touch ID

On first launch the app asks for two things:

1. **Profile name** — stored once, never asked again.
2. **Local password** — at least 6 characters.

Without them the WhatsApp window is never created: there are no conversations behind the
door. The password is stored as a **scrypt** hash (16-byte random salt, 16,384 iterations)
in `~/Library/Application Support/WA5/access.json` with `600` permissions. The password
text itself is never written to disk.

**It is only asked once**: while you use the app it does not come back. It reappears when
**5 minutes pass without touching anything** (no mouse, no keyboard, no account switch),
and also if you quit the app and reopen it after that long. The countdown runs from your
last real gesture, it is measured both in the sidebar and inside each WhatsApp account, and
the marker that remembers it is signed with the hash, so editing it by hand will not get you
past the password.

On Macs with a sensor, **Use Touch ID** also appears, unlocking with your fingerprint. The
password still works as a fallback: Touch ID depends on the fingerprint being enrolled on
that Mac and on the sensor responding.

`⌘L` locks the app instantly: the WhatsApp views are destroyed and the password screen
returns.

After 5 failed attempts in a row the app waits 30 seconds before accepting another try.

> If you forget the password, delete `access.json` and set it up again. WhatsApp sessions
> are not lost, because they live in a different folder.

## Adding and using accounts

1. Open the app, set up access and enter. An account called **Personal** is created for you.
2. On your phone: WhatsApp → **Linked devices** → *Link a device*.
3. Scan the QR code. Repeat with the **+** in the sidebar for each new account.
4. Right-click a circle in the sidebar: rename, reload, repair, log out, zoom or remove.

| Shortcut | Action |
|---|---|
| `⌘1` … `⌘5` | Go to account 1–5 |
| `⌘⇧N` | Add account |
| `⌘R` | Reload the active account |
| `⌘L` | Lock the app |
| `⌘+` / `⌘-` / `⌘0` | Zoom the active account |

### If an account gets stuck on “Loading your chats…”

It is that partition's cache or service worker, not your session. Right-click the account →
**Repair if stuck loading**. It clears cache and service workers but keeps cookies and
`IndexedDB`, so **you do not need to scan the QR code again**.

## Local control for agents (optional)

The app starts an HTTP server on `127.0.0.1:5077` that only accepts requests from the same
Mac and requires a token generated on first run in
`~/Library/Application Support/WA5/control.json` (`600` permissions, outside the repo).

| Route | What it does |
|---|---|
| `GET /state` | accounts, unread counts and whether the app is unlocked |
| `GET /pending?account=X` | chats with unread messages |
| `GET /read?account=X&chat=Y&n=20` | last messages of a conversation |
| `POST /draft` | writes text into the message box, **without sending it** |
| `GET /diag` | view diagnostics (for debugging selectors) |

With the app locked the server answers `423`: the agent sees nothing until you unlock.

### MCP server

`mcp/servidor.mjs` exposes that control as MCP tools (`wa5_accounts`, `wa5_pending`,
`wa5_read`, `wa5_draft`). To use it with an MCP client, register it as a stdio server:

```json
{
  "mcpServers": {
    "wa5": {
      "command": "node",
      "args": ["/absolute/path/to/wa5/mcp/servidor.mjs"]
    }
  }
}
```

**There is no send tool.** `wa5_draft` leaves the text typed in and the chat open so the
person can review it and press Enter. Automating sending violates WhatsApp's terms and can
cost you your number; leaving it out is deliberate.

### Limits worth knowing

- Reading a conversation **marks it as read** in WhatsApp: the chat has to be opened.
- The selectors depend on WhatsApp Web's DOM. When Meta changes them, a few lines of
  `control.js` need adjusting (`/diag` helps you find them).
- The control server only answers while the app is open and unlocked.
- To read an account, the app brings it to the front: it is visible that the agent looked.

## Upgrading from 1.3 or earlier

Version 1.4.0 renamed the desktop data files from Spanish to English:

| Before | Now |
|---|---|
| `cuentas.json` | `accounts.json` |
| `acceso.json` | `access.json` |
| `sesion.json` | `session.json` |

The app renames them on first launch and rewrites the keys inside `accounts.json`, so your
accounts, the active one and the window position survive — and no QR code has to be scanned
again.

One file is deliberately left alone: `access.json` may still carry the old field names
(`perfil`, `sal`, `iteraciones`, `creado`). `security.js` reads both spellings, so your
password keeps working exactly as before; the file switches to the English names the next
time you set the password up again. Rewriting it automatically would have meant touching a
hash that cannot be verified without knowing the password, so it is not done.

## How it works

```
main.js                  main process: window, accounts and sessions
 ├─ BrowserWindow        draws only the sidebar (renderer/)
 ├─ WebContentsView ×N   one web view per account, isolated by partition
 └─ session.fromPartition('persist:wa-<id>')   cookies + storage per number
security.js             scrypt password and verification with attempt limit
control.js               local HTTP server for agents
mcp/servidor.mjs         stdio MCP server (not bundled inside the .app)
preload.js               IPC bridge with contextIsolation (no nodeIntegration)
renderer/                sidebar and access screen
```

Accounts are stored in `~/Library/Application Support/WA5/accounts.json`.
Each account's session data lives in
`~/Library/Application Support/WA5/Partitions/wa-<id>/`. Deleting that directory is the same
as logging out of every account.

## Why not a browser with profiles

It works, but you get loose windows with no shared bar, no unified badge, and one
`user-data-dir` per account to manage by hand. WA5 puts everything in one window and uses
Electron's session partitions, which is the mechanism Chromium itself uses to isolate
profiles.

## Status

macOS, Apple Silicon and Intel. It should work on Linux and Windows without changes, but it
is untested; PRs are welcome.

## License

MIT — see [LICENSE](LICENSE).
