// WA5 — up to five WhatsApp Web accounts at the same time, each one isolated.
// Every account lives in its own persistent Chromium session: cookies, localStorage
// and IndexedDB are separate, so sessions never overwrite each other between numbers.
const { app, BrowserWindow, WebContentsView, ipcMain, Menu, session, shell, nativeTheme, Notification, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const security = require('./security');

const SIDEBAR = 78;
const MAX_ACCOUNTS = 5;
// Minutes without touching the app before it asks for the password again.
const IDLE_MINUTES = 5;
const IDLE_TIMEOUT_MS = IDLE_MINUTES * 60 * 1000;
const WA_URL = 'https://web.whatsapp.com/';
const PALETTE = ['#25D366', '#128C7E', '#0A84FF', '#D60079', '#F5A623'];

app.setName('WA5');

const dataDir = () => app.getPath('userData');
const ACCOUNTS_FILE = () => path.join(dataDir(), 'accounts.json');

let win = null;
let accessWindow = null;
let unlocked = false;
let savedBounds = null;
let accounts = [];                // [{ id, name, color }]
let activeId = null;              // id of the visible account
const views = new Map();          // id -> WebContentsView
const unread = new Map();         // id -> number
const loadState = new Map();      // id -> 'loading' | 'ready' | 'error'

// ---------------------------------------------------------------- persistence
// The data files were renamed to English; without this the first run after the
// rename would look like a fresh install and the user would lose their session.
function migrateLegacyFiles() {
  const renames = [
    ['cuentas.json', 'accounts.json'],
    ['acceso.json', 'access.json'],
    ['sesion.json', 'session.json']
  ];
  const dir = dataDir();
  for (const [oldName, newName] of renames) {
    const oldPath = path.join(dir, oldName);
    const newPath = path.join(dir, newName);
    if (!fs.existsSync(oldPath) || fs.existsSync(newPath)) continue;
    try {
      fs.renameSync(oldPath, newPath);
    } catch (e) {
      console.error('[wa5] could not migrate', oldName, '→', newName, ':', e.message);
    }
  }
  migrateAccountKeys();
}

// The entries inside the accounts file were renamed too: renaming the file is not
// enough, the old keys would parse into an empty list and the accounts would vanish.
function migrateAccountKeys() {
  const file = ACCOUNTS_FILE();
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return; }
  if (!Array.isArray(data.cuentas)) return;
  const migrated = {
    accounts: data.cuentas.map(c => ({ id: c.id, name: c.nombre || c.name, color: c.color })),
    activeId: data.activa || null,
    window: data.ventana || null
  };
  try {
    fs.writeFileSync(file, JSON.stringify(migrated, null, 1));
  } catch (e) {
    console.error('[wa5] could not rewrite accounts file:', e.message);
  }
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE(), 'utf8'));
    if (Array.isArray(raw.accounts)) accounts = raw.accounts.slice(0, MAX_ACCOUNTS);
    activeId = raw.activeId || (accounts[0] && accounts[0].id) || null;
    return raw.window || null;
  } catch (e) {
    accounts = [];
    activeId = null;
    return null;
  }
}

function save() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const previous = (() => {
      try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE(), 'utf8')); } catch (e) { return {}; }
    })();
    fs.writeFileSync(ACCOUNTS_FILE(), JSON.stringify({ accounts, activeId, window: previous.window || null }, null, 1));
  } catch (e) {
    console.error('[wa5] could not save:', e.message);
  }
}

// ---------------------------------------------------------------- sessions
function partitionName(id) { return 'persist:wa-' + id; }

function prepareSession(id) {
  const s = session.fromPartition(partitionName(id));
  // WhatsApp Web needs notifications, camera/microphone for calls and —crucially—
  // persistent storage ('durable-storage'). Without that permission Chromium denies
  // the persistent bucket and the app stays forever on "Loading your chats…".
  // Everything the web app may ask for is allowed except what it has no reason to use.
  const BLOCKED = new Set(['geolocation', 'midi', 'midiSysex', 'hid', 'serial', 'usb', 'openExternal']);
  s.setPermissionRequestHandler((_wc, permission, callback) => callback(!BLOCKED.has(permission)));
  s.setPermissionCheckHandler((_wc, permission) => !BLOCKED.has(permission));
  return s;
}

function createView(account) {
  prepareSession(account.id);

  const v = new WebContentsView({
    webPreferences: {
      partition: partitionName(account.id),
      preload: path.join(__dirname, 'preload-wa.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false
    }
  });
  v.setBackgroundColor('#111b21');
  const wc = v.webContents;

  // The Electron mark is stripped from the user agent so WhatsApp treats the
  // client as a normal browser.
  wc.setUserAgent(
    wc.getUserAgent()
      .replace(/Electron\/[\d.]+\s/, '')
      .replace(/wa5\/[\d.]+\s/i, '')
  );

  const refreshUnread = (title) => {
    const t = String(title || '');
    const m = t.match(/\((\d+)\)/);
    const n = m ? parseInt(m[1], 10) : (/^\s*•/.test(t) ? 1 : 0);
    const before = unread.get(account.id) || 0;
    unread.set(account.id, n);
    if (win && !win.isDestroyed()) {
      win.webContents.send('state:unread', { id: account.id, unread: n });
      if (n > before && account.id !== activeId) notifyNewMessage(account, t);
    }
  };

  // Load state: while an account boots from scratch the user needs to see that
  // something is happening; without this the window looks frozen.
  const notifyLoad = (state) => {
    loadState.set(account.id, state);
    if (win && !win.isDestroyed()) win.webContents.send('state:load', { id: account.id, loadState: state });
  };
  wc.on('did-start-loading', () => notifyLoad('loading'));
  wc.on('did-finish-load', () => notifyLoad('ready'));
  wc.on('did-stop-loading', () => notifyLoad('ready'));
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame) notifyLoad('error');
  });
  wc.on('render-process-gone', () => notifyLoad('error'));


  wc.on('page-title-updated', (_e, t) => refreshUnread(t));
  wc.on('did-finish-load', () => refreshUnread(wc.getTitle()));

  // Links that do not belong to WhatsApp open in the system browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/([a-z]+\.)?whatsapp\.com/i.test(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.loadURL(WA_URL);
  views.set(account.id, v);
  win.contentView.addChildView(v);
  return v;
}

function notifyNewMessage(account, title) {
  try {
    if (!Notification.isSupported()) return;
    const clean = String(title).replace(/^\(\d+\)\s*/, '').replace(/^•\s*/, '').replace(/ - WhatsApp$/, '');
    new Notification({
      title: `${account.name} · ${clean || 'WhatsApp'}`,
      body: 'You have new messages in this account.'
    }).on('click', () => activateAccount(account.id)).show();
  } catch (e) { /* notifications are a nice-to-have, they never break the app */ }
}

// ---------------------------------------------------------------- geometry
function layout() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  const viewWidth = Math.max(320, width - SIDEBAR);
  for (const [id, v] of views) {
    const visible = id === activeId;
    v.setVisible(visible);
    if (visible) v.setBounds({ x: SIDEBAR, y: 0, width: viewWidth, height });
  }
}

function sendState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state:accounts', {
    accounts: accounts.map(c => ({
      ...c,
      unread: unread.get(c.id) || 0,
      loadState: loadState.get(c.id) || (views.has(c.id) ? 'ready' : 'pending')
    })),
    activeId,
    max: MAX_ACCOUNTS
  });
  const total = accounts.reduce((s, c) => s + (unread.get(c.id) || 0), 0);
  if (app.dock) app.dock.setBadge(total > 0 ? String(total) : '');
}

// ---------------------------------------------------------------- operations
function activateAccount(id) {
  if (!accounts.some(c => c.id === id)) return;
  activeId = id;
  save();
  if (!views.has(id)) createView(accounts.find(c => c.id === id));
  layout();
  const v = views.get(id);
  if (v) v.webContents.focus();
  sendState();
}

// Preloads in the background the accounts that have no view yet, so switching to
// them does not start from scratch. One at a time and spaced out, so it does not
// compete with the account the user is actually using.
function preloadAccounts() {
  const pending = accounts.filter(c => !views.has(c.id));
  pending.forEach((account, i) => {
    setTimeout(() => {
      if (!win || win.isDestroyed() || views.has(account.id)) return;
      createView(account);
      layout();
      sendState();
    }, 3000 + i * 4000);
  });
  if (pending.length) {
    console.log('[wa5] preloading', pending.map(c => c.name).join(', '));
  }
}

function addAccount(name) {
  if (accounts.length >= MAX_ACCOUNTS) return { ok: false, error: `Limit reached: ${MAX_ACCOUNTS} accounts.` };
  const id = crypto.randomBytes(4).toString('hex');
  const account = {
    id,
    name: (name || '').trim() || `Account ${accounts.length + 1}`,
    color: PALETTE[accounts.length % PALETTE.length]
  };
  accounts.push(account);
  activeId = id;
  save();
  createView(account);
  layout();
  sendState();
  return { ok: true, account };
}

function renameAccount(id, name) {
  const c = accounts.find(x => x.id === id);
  if (!c) return { ok: false };
  const clean = (name || '').trim();
  if (clean) c.name = clean;
  save();
  sendState();
  return { ok: true };
}

async function removeAccount(id, wipeData = true) {
  const i = accounts.findIndex(x => x.id === id);
  if (i < 0) return { ok: false };
  const v = views.get(id);
  if (v) {
    try { win.contentView.removeChildView(v); } catch (e) {}
    try { v.webContents.close(); } catch (e) {}
    views.delete(id);
  }
  if (wipeData) {
    try { await session.fromPartition(partitionName(id)).clearStorageData(); } catch (e) {}
  }
  accounts.splice(i, 1);
  unread.delete(id);
  if (activeId === id) activeId = accounts[0] ? accounts[0].id : null;
  save();
  if (activeId) activateAccount(activeId); else sendState();
  return { ok: true };
}

function reloadAccount(id) {
  const v = views.get(id);
  if (v) v.webContents.reload();
}

// Repairs an account stuck on "Loading your chats…". Wipes cache and service
// workers of that partition —the part that gets corrupted— but KEEPS cookies and
// IndexedDB, so the session survives and the QR code does not need scanning again.
async function repairAccount(id) {
  const v = views.get(id);
  try {
    const s = session.fromPartition(partitionName(id));
    await s.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    await s.clearCache();
  } catch (e) {
    console.error('[wa5] repair:', e.message);
  }
  if (v) {
    loadState.set(id, 'loading');
    sendState();
    v.webContents.reload();
  }
  return { ok: true };
}

async function logoutAccount(id) {
  try { await session.fromPartition(partitionName(id)).clearStorageData(); } catch (e) {}
  const v = views.get(id);
  if (v) v.webContents.loadURL(WA_URL);
}

function zoom(id, delta) {
  const v = views.get(id);
  if (!v) return;
  v.webContents.setZoomLevel(Math.max(-2, Math.min(3, v.webContents.getZoomLevel() + delta)));
}

// ---------------------------------------------------------------- access
// The app does not open WhatsApp until the password is typed: the main window is
// never even created, so there are no conversations visible behind it.
let lastActivity = Date.now();
let lastSaved = 0;

function markActivity() {
  lastActivity = Date.now();
  // Do not hit the disk on every keystroke: refreshing once a minute is enough.
  if (lastActivity - lastSaved > 60_000) {
    lastSaved = lastActivity;
    security.saveActivity(dataDir(), lastActivity);
  }
}

// Every 20 s it checks whether the idle time has elapsed. If it has, it locks.
function watchInactivity() {
  setInterval(() => {
    if (!unlocked) return;
    if (Date.now() - lastActivity >= IDLE_TIMEOUT_MS) {
      console.log(`[wa5] ${IDLE_MINUTES} min idle: locking`);
      lock();
    } else if (Date.now() - lastSaved > 60_000) {
      // The real last activity is persisted (without moving it forward), so that if
      // you quit the app the countdown keeps running from the last gesture.
      lastSaved = Date.now();
      security.saveActivity(dataDir(), lastActivity);
    }
  }, 20_000);
}

function showAccess() {
  if (accessWindow) { accessWindow.focus(); return; }
  unlocked = false;

  accessWindow = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'WA5',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b141a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-login.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  accessWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  accessWindow.once('ready-to-show', () => accessWindow.show());
  accessWindow.on('closed', () => {
    accessWindow = null;
    // If the access window is closed without entering, the app quits: there is no
    // way to skip the password by parking it to one side.
    if (!unlocked && !win) app.quit();
  });
}

function startApp() {
  if (win) { win.focus(); return; }
  const bounds = savedBounds || load();
  createWindow(bounds);
  win.webContents.once('did-finish-load', () => {
    if (accounts.length === 0) addAccount('Personal');
    else activateAccount(activeId || accounts[0].id);
    preloadAccounts();
  });
}

function enter() {
  unlocked = true;
  markActivity();
  security.saveActivity(dataDir(), lastActivity);
  if (accessWindow) {
    const v = accessWindow;
    accessWindow = null;
    v.destroy();
  }
  startApp();
}

// Lock: the WhatsApp views are destroyed (no chats left in memory or on screen)
// and the password screen comes back.
function lock() {
  if (!unlocked) return;
  unlocked = false;
  security.forgetActivity(dataDir());
  if (win) {
    savedBounds = win.getBounds();
    win.destroy();
    win = null;
  }
  for (const [id, v] of views) {
    try { v.webContents.close(); } catch { /* already closed */ }
    views.delete(id);
  }
  unread.clear();
  loadState.clear();
  activeId = null;
  showAccess();
}

// ---------------------------------------------------------------- window
function createWindow(bounds) {
  win = new BrowserWindow({
    width: (bounds && bounds.width) || 1280,
    height: (bounds && bounds.height) || 860,
    x: bounds ? bounds.x : undefined,
    y: bounds ? bounds.y : undefined,
    minWidth: 900,
    minHeight: 600,
    title: 'WA5',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#111b21',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('resize', layout);

  let timer = null;
  const rememberBounds = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const current = JSON.parse(fs.readFileSync(ACCOUNTS_FILE(), 'utf8'));
        current.window = win.getBounds();
        fs.writeFileSync(ACCOUNTS_FILE(), JSON.stringify(current, null, 1));
      } catch (e) {}
    }, 600);
  };
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);

  win.webContents.on('did-finish-load', () => {
    sendState();
    layout();
  });
  win.webContents.on('before-input-event', () => { if (unlocked) markActivity(); });
  win.on('focus', () => { if (unlocked) markActivity(); });
  win.on('closed', () => { win = null; });
}

// ---------------------------------------------------------------- menu and shortcuts
function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'Accounts',
      submenu: [
        {
          label: 'Add account…',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => { if (accounts.length < MAX_ACCOUNTS) addAccount(''); }
        },
        { type: 'separator' },
        ...[1, 2, 3, 4, 5].map(n => ({
          label: `Go to account ${n}`,
          accelerator: `CmdOrCtrl+${n}`,
          click: () => { if (accounts[n - 1]) activateAccount(accounts[n - 1].id); }
        })),
        { type: 'separator' },
        {
          label: 'Reload active account',
          accelerator: 'CmdOrCtrl+R',
          click: () => { if (activeId) reloadAccount(activeId); }
        },
        { type: 'separator' },
        {
          label: 'Lock now',
          accelerator: 'CmdOrCtrl+L',
          click: () => lock()
        }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'WA5 on GitHub', click: () => shell.openExternal('https://github.com/waltgarcia/wa5') }
      ]
    }
  ]));
}

// ---------------------------------------------------------------- access (IPC)
let verifier = null;
const getVerifier = () => {
  if (!verifier) verifier = security.createVerifier(dataDir());
  return verifier;
};

ipcMain.handle('access:state', () => {
  const a = security.readAccess(dataDir());
  let touchId = false;
  try {
    touchId = process.platform === 'darwin' && systemPreferences.canPromptTouchID();
  } catch { /* Mac without a fingerprint sensor or without Touch ID */ }
  return { configured: !!a, profile: a ? a.profile : null, touchId };
});

// Touch ID is a convenient shortcut, not the key: the password is still the
// fallback when it fails, when the finger is wet, or when the Mac lacks it.
ipcMain.handle('access:touchid', async () => {
  try {
    if (process.platform !== 'darwin' || !systemPreferences.canPromptTouchID()) {
      return { ok: false, error: 'Touch ID is not available for this app on this Mac.' };
    }
    await systemPreferences.promptTouchID('unlock WA5');
    enter();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Could not verify your fingerprint.' };
  }
});

ipcMain.handle('access:configure', (_e, { profile, password }) => {
  try {
    security.configure(dataDir(), profile, password);
    verifier = security.createVerifier(dataDir());
    enter();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('access:unlock', (_e, { password }) => {
  try {
    getVerifier()(password);
    enter();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---------------------------------------------------------------- IPC
ipcMain.handle('accounts:state', () => ({
  accounts: accounts.map(c => ({
    ...c,
    unread: unread.get(c.id) || 0,
    loadState: loadState.get(c.id) || (views.has(c.id) ? 'ready' : 'pending')
  })),
  activeId, max: MAX_ACCOUNTS
}));
ipcMain.handle('accounts:add', (_e, name) => addAccount(name));
ipcMain.handle('accounts:rename', (_e, id, name) => renameAccount(id, name));
ipcMain.handle('accounts:remove', (_e, id, wipe) => removeAccount(id, wipe));
ipcMain.handle('accounts:activate', (_e, id) => { activateAccount(id); return { ok: true }; });
ipcMain.handle('accounts:reload', (_e, id) => { reloadAccount(id); return { ok: true }; });
ipcMain.handle('accounts:logout', (_e, id) => logoutAccount(id).then(() => ({ ok: true })));
ipcMain.handle('accounts:menu', (_e, id) => {
  Menu.buildFromTemplate([
    { label: 'Rename…', click: () => win.webContents.send('ui:rename', id) },
    { label: 'Reload', click: () => reloadAccount(id) },
    { label: 'Repair if stuck loading', click: () => repairAccount(id) },
    { label: 'Log out of this account', click: () => logoutAccount(id) },
    { type: 'separator' },
    { label: 'Zoom in', click: () => zoom(id, 0.5) },
    { label: 'Zoom out', click: () => zoom(id, -0.5) },
    { label: 'Actual size', click: () => { const v = views.get(id); if (v) v.webContents.setZoomLevel(0); } },
    { type: 'separator' },
    { label: 'Remove account', click: () => removeAccount(id, true) }
  ]).popup({ window: win });
  return { ok: true };
});

// ---------------------------------------------------------------- startup
function startLocalControl() {
  try {
    const { startControl } = require('./control');
    startControl({
      getView: (id) => views.get(id) || null,
      getAccounts: () => accounts,
      activate: activateAccount,
      dataDir: dataDir(),
      isUnlocked: () => unlocked,
      state: () => ({
        unlocked,
        accounts: accounts.map(c => ({
          id: c.id, name: c.name,
          unread: unread.get(c.id) || 0,
          loadState: loadState.get(c.id) || (views.has(c.id) ? 'ready' : 'pending')
        })),
        active: activeId, version: app.getVersion()
      })
    });
  } catch (e) {
    console.error('[wa5] could not start local control:', e.message);
  }
}

app.whenReady().then(() => {
  migrateLegacyFiles();
  nativeTheme.themeSource = 'dark';
  savedBounds = load();
  installMenu();
  startLocalControl();

  // If the last activity was less than IDLE_MINUTES ago nothing is asked: the
  // password only comes back after that long without touching the app.
  const idleMs = security.idleMs(dataDir());
  if (idleMs < IDLE_TIMEOUT_MS) {
    unlocked = true;
    lastActivity = Date.now() - idleMs;
    lastSaved = Date.now();
    startApp();
  } else {
    showAccess();
  }
  watchInactivity();

  app.on('activate', () => {
    if (!win && !accessWindow) showAccess();
  });
});

// Any gesture counts as activity, whether it comes from the sidebar or WhatsApp.
ipcMain.on('wa5:activity', () => { if (unlocked) markActivity(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
