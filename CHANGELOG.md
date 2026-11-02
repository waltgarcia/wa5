# Changelog

All notable changes to WA5 are listed here. This project follows
[Semantic Versioning](https://semver.org/).

## 1.4.0 — English everywhere

The whole repository is now in English: code, comments, identifiers, UI strings, file names
and docs. Anyone who clones it reads the same language.

**Renamed to match one shared contract**
- IPC channels: `state:accounts`, `state:unread`, `state:load`, `ui:rename`, `accounts:*`,
  `access:*`, `wa5:activity`
- Preload APIs: `window.wa.*` (`state`, `add`, `rename`, `remove`, `activate`, `reload`,
  `logout`, `menu`, `onAccounts`, `onUnread`, `onLoadState`, `activity`, `onRenameRequest`)
  and `window.access.*` (`state`, `configure`, `unlock`, `touchId`)
- HTTP routes: `GET /state`, `GET /pending`, `GET /read`, `POST /draft`, `GET /diag`
- MCP tools: `wa5_accounts`, `wa5_pending`, `wa5_read`, `wa5_draft`
- Source files: `seguridad.js` → `security.js`, `reinstalar.sh` → `reinstall.sh`,
  `docs/captura.png` → `docs/screenshot.png`
- Actions jobs: `empaquetar` → `package`, `publicar` → `release`

**Payload contract**
- Load state values are `loading`, `ready`, `error`, `pending`
- `state:unread` carries `{ id, unread }` and `state:load` carries `{ id, loadState }`
- `startControl()` receives `{ getView, getAccounts, activate, dataDir, isUnlocked, state }`
  and `state()` answers `{ unlocked, accounts: [{ id, name, unread, loadState }], active,
  version }`

**Data**
- Desktop files move to `accounts.json`, `access.json` and `session.json`
- Migration renames the old files and rewrites their keys on first launch, so accounts and
  the active one survive and no QR code is needed again
- `security.js` still accepts the previous `access.json` field names, so the configured
  password keeps working; the file is normalised the next time it is written

**Build**
- `npm run empaquetar` is now `npm run build`
- The workflow checks the syntax of all nine source files before packaging

## 1.3.1

- Chat titles no longer carry bidi marks or "N unread messages" prefixes
- `/pending` returns clean chat names and last-message text

## 1.3.0 — Lock after inactivity

- The password is asked again after 5 minutes without mouse, keyboard or account switches,
  instead of on every launch
- Activity is reported from inside each WhatsApp account too, not only from the sidebar
- The activity marker is signed with an HMAC, so editing `sesion.json` does not skip the
  password

## 1.2.0 — Entry password

- Fixed profile name plus a local password, stored as a scrypt hash with `600` permissions
- Without unlocking, the WhatsApp window is never created: there are no chats behind the door
- Touch ID unlock on Macs with a sensor
- `⌘L` locks immediately; the control server answers `423` while locked

## 1.1.0 — Local control and MCP

- HTTP server on `127.0.0.1:5077` with a per-install token: `/state`, `/pending`, `/read`,
  `/draft`, `/diag`
- MCP stdio server exposing those routes as tools
- Reading and drafting only: **there is no send tool**, on purpose

## 1.0.1

- **Repair if stuck loading**: clears cache and service workers for one partition while
  keeping cookies and IndexedDB, so an account stuck on “Loading your chats…” recovers
  without scanning the QR code again

## 1.0.0

- First packaged version: up to five WhatsApp Web accounts in one window, each in its own
  `persist:wa-<id>` partition
- Sidebar with unread counters, Dock badge, native notifications, per-account zoom
- Staggered preloading and a loading ring per account
