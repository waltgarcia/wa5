// WA5 — hasta cinco cuentas de WhatsApp Web al mismo tiempo, cada una aislada.
// Cada cuenta vive en su propia sesión persistente de Chromium: cookies, localStorage
// e IndexedDB separados, así que nunca se pisan las sesiones entre números.
const { app, BrowserWindow, WebContentsView, ipcMain, Menu, session, shell, nativeTheme, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SIDEBAR = 78;
const MAX_CUENTAS = 5;
const URL_WA = 'https://web.whatsapp.com/';
const PALETA = ['#25D366', '#128C7E', '#0A84FF', '#D60079', '#F5A623'];

app.setName('WA5');

const dirDatos = () => app.getPath('userData');
const ARCHIVO = () => path.join(dirDatos(), 'cuentas.json');

let win = null;
let cuentas = [];                 // [{ id, nombre, color }]
let activa = null;                // id de la cuenta visible
const vistas = new Map();         // id -> WebContentsView
const noLeidos = new Map();       // id -> número
const cargando = new Map();       // id -> 'cargando' | 'lista' | 'error'

// ---------------------------------------------------------------- persistencia
function cargar() {
  try {
    const raw = JSON.parse(fs.readFileSync(ARCHIVO(), 'utf8'));
    if (Array.isArray(raw.cuentas)) cuentas = raw.cuentas.slice(0, MAX_CUENTAS);
    activa = raw.activa || (cuentas[0] && cuentas[0].id) || null;
    return raw.ventana || null;
  } catch (e) {
    cuentas = [];
    activa = null;
    return null;
  }
}

function guardar() {
  try {
    fs.mkdirSync(dirDatos(), { recursive: true });
    const previo = (() => {
      try { return JSON.parse(fs.readFileSync(ARCHIVO(), 'utf8')); } catch (e) { return {}; }
    })();
    fs.writeFileSync(ARCHIVO(), JSON.stringify({ cuentas, activa, ventana: previo.ventana || null }, null, 1));
  } catch (e) {
    console.error('[wa5] no se pudo guardar:', e.message);
  }
}

// ---------------------------------------------------------------- sesiones
function particion(id) { return 'persist:wa-' + id; }

function prepararSesion(id) {
  const s = session.fromPartition(particion(id));
  // WhatsApp Web necesita notificaciones, cámara/micrófono para llamadas y —clave—
  // almacenamiento persistente ('durable-storage'). Sin ese permiso Chromium niega
  // el bucket persistente y la app se queda para siempre en "Cargando tus chats…".
  // Se permite todo lo que la app web pueda pedir salvo lo que no tiene por qué usar.
  const BLOQUEADOS = new Set(['geolocation', 'midi', 'midiSysex', 'hid', 'serial', 'usb', 'openExternal']);
  s.setPermissionRequestHandler((_wc, permiso, callback) => callback(!BLOQUEADOS.has(permiso)));
  s.setPermissionCheckHandler((_wc, permiso) => !BLOQUEADOS.has(permiso));
  return s;
}

function crearVista(cuenta) {
  prepararSesion(cuenta.id);

  const v = new WebContentsView({
    webPreferences: {
      partition: particion(cuenta.id),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false
    }
  });
  v.setBackgroundColor('#111b21');
  const wc = v.webContents;

  // Se quita la marca de Electron del user agent para que WhatsApp trate al
  // cliente como un navegador normal.
  wc.setUserAgent(
    wc.getUserAgent()
      .replace(/Electron\/[\d.]+\s/, '')
      .replace(/wa5\/[\d.]+\s/i, '')
  );

  const refrescarNoLeidos = (titulo) => {
    const t = String(titulo || '');
    const m = t.match(/\((\d+)\)/);
    const n = m ? parseInt(m[1], 10) : (/^\s*•/.test(t) ? 1 : 0);
    const antes = noLeidos.get(cuenta.id) || 0;
    noLeidos.set(cuenta.id, n);
    if (win && !win.isDestroyed()) {
      win.webContents.send('estado:noLeidos', { id: cuenta.id, n });
      if (n > antes && cuenta.id !== activa) avisar(cuenta, t);
    }
  };

  // Estado de carga: mientras una cuenta arranca desde cero el usuario necesita
  // ver que algo pasa; sin esto la ventana parece congelada.
  const avisarCarga = (estado) => {
    cargando.set(cuenta.id, estado);
    if (win && !win.isDestroyed()) win.webContents.send('estado:carga', { id: cuenta.id, estado });
  };
  wc.on('did-start-loading', () => avisarCarga('cargando'));
  wc.on('did-finish-load', () => avisarCarga('lista'));
  wc.on('did-fail-load', (_e, codigo, desc, _url, esPrincipal) => {
    if (esPrincipal) avisarCarga('error');
  });
  wc.on('render-process-gone', () => avisarCarga('error'));


  wc.on('page-title-updated', (_e, t) => refrescarNoLeidos(t));
  wc.on('did-finish-load', () => refrescarNoLeidos(wc.getTitle()));

  // Los enlaces ajenos a WhatsApp se abren en el navegador del sistema.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/([a-z]+\.)?whatsapp\.com/i.test(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.loadURL(URL_WA);
  vistas.set(cuenta.id, v);
  win.contentView.addChildView(v);
  return v;
}

function avisar(cuenta, titulo) {
  try {
    if (!Notification.isSupported()) return;
    const limpio = String(titulo).replace(/^\(\d+\)\s*/, '').replace(/^•\s*/, '').replace(/ - WhatsApp$/, '');
    new Notification({
      title: `${cuenta.nombre} · ${limpio || 'WhatsApp'}`,
      body: 'Tienes mensajes nuevos en esta cuenta.'
    }).on('click', () => activar(cuenta.id)).show();
  } catch (e) { /* las notificaciones son un extra, nunca rompen la app */ }
}

// ---------------------------------------------------------------- geometría
function posicionar() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  const ancho = Math.max(320, width - SIDEBAR);
  for (const [id, v] of vistas) {
    const visible = id === activa;
    v.setVisible(visible);
    if (visible) v.setBounds({ x: SIDEBAR, y: 0, width: ancho, height });
  }
}

function enviarEstado() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('estado:cuentas', {
    cuentas: cuentas.map(c => ({
      ...c,
      noLeidos: noLeidos.get(c.id) || 0,
      carga: cargando.get(c.id) || (vistas.has(c.id) ? 'lista' : 'pendiente')
    })),
    activa,
    max: MAX_CUENTAS
  });
  const total = cuentas.reduce((s, c) => s + (noLeidos.get(c.id) || 0), 0);
  if (app.dock) app.dock.setBadge(total > 0 ? String(total) : '');
}

// ---------------------------------------------------------------- operaciones
function activar(id) {
  if (!cuentas.some(c => c.id === id)) return;
  activa = id;
  guardar();
  if (!vistas.has(id)) crearVista(cuentas.find(c => c.id === id));
  posicionar();
  const v = vistas.get(id);
  if (v) v.webContents.focus();
  enviarEstado();
}

// Precarga en segundo plano las cuentas que todavía no tienen vista, para que al
// cambiar a ellas no arranquen desde cero. Se hace de una en una y espaciado para
// no competir con la cuenta que el usuario está usando.
function precargar() {
  const pendientes = cuentas.filter(c => !vistas.has(c.id));
  pendientes.forEach((cuenta, i) => {
    setTimeout(() => {
      if (!win || win.isDestroyed() || vistas.has(cuenta.id)) return;
      crearVista(cuenta);
      posicionar();
      enviarEstado();
    }, 3000 + i * 4000);
  });
  if (pendientes.length) {
    console.log('[wa5] precargando', pendientes.map(c => c.nombre).join(', '));
  }
}

function agregarCuenta(nombre) {
  if (cuentas.length >= MAX_CUENTAS) return { ok: false, error: `Límite alcanzado: ${MAX_CUENTAS} cuentas.` };
  const id = crypto.randomBytes(4).toString('hex');
  const cuenta = {
    id,
    nombre: (nombre || '').trim() || `Cuenta ${cuentas.length + 1}`,
    color: PALETA[cuentas.length % PALETA.length]
  };
  cuentas.push(cuenta);
  activa = id;
  guardar();
  crearVista(cuenta);
  posicionar();
  enviarEstado();
  return { ok: true, cuenta };
}

function renombrar(id, nombre) {
  const c = cuentas.find(x => x.id === id);
  if (!c) return { ok: false };
  const limpio = (nombre || '').trim();
  if (limpio) c.nombre = limpio;
  guardar();
  enviarEstado();
  return { ok: true };
}

async function eliminar(id, borrarDatos = true) {
  const i = cuentas.findIndex(x => x.id === id);
  if (i < 0) return { ok: false };
  const v = vistas.get(id);
  if (v) {
    try { win.contentView.removeChildView(v); } catch (e) {}
    try { v.webContents.close(); } catch (e) {}
    vistas.delete(id);
  }
  if (borrarDatos) {
    try { await session.fromPartition(particion(id)).clearStorageData(); } catch (e) {}
  }
  cuentas.splice(i, 1);
  noLeidos.delete(id);
  if (activa === id) activa = cuentas[0] ? cuentas[0].id : null;
  guardar();
  if (activa) activar(activa); else enviarEstado();
  return { ok: true };
}

function recargar(id) {
  const v = vistas.get(id);
  if (v) v.webContents.reload();
}

// Repara una cuenta atorada en "Cargando tus chats…". Borra caché y service
// workers de esa partición —lo que se corrompe— pero CONSERVA cookies e
// IndexedDB, así que la sesión no se pierde y no hay que volver a escanear.
async function reparar(id) {
  const v = vistas.get(id);
  try {
    const s = session.fromPartition(particion(id));
    await s.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    await s.clearCache();
  } catch (e) {
    console.error('[wa5] reparar:', e.message);
  }
  if (v) {
    cargando.set(id, 'cargando');
    enviarEstado();
    v.webContents.reload();
  }
  return { ok: true };
}

async function cerrarSesion(id) {
  try { await session.fromPartition(particion(id)).clearStorageData(); } catch (e) {}
  const v = vistas.get(id);
  if (v) v.webContents.loadURL(URL_WA);
}

function zoom(id, delta) {
  const v = vistas.get(id);
  if (!v) return;
  v.webContents.setZoomLevel(Math.max(-2, Math.min(3, v.webContents.getZoomLevel() + delta)));
}

// ---------------------------------------------------------------- ventana
function crearVentana(bounds) {
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
  win.on('resize', posicionar);

  let temporizador = null;
  const recordarVentana = () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => {
      try {
        const actual = JSON.parse(fs.readFileSync(ARCHIVO(), 'utf8'));
        actual.ventana = win.getBounds();
        fs.writeFileSync(ARCHIVO(), JSON.stringify(actual, null, 1));
      } catch (e) {}
    }, 600);
  };
  win.on('resize', recordarVentana);
  win.on('move', recordarVentana);

  win.webContents.on('did-finish-load', () => {
    enviarEstado();
    posicionar();
  });
  win.on('closed', () => { win = null; });
}

// ---------------------------------------------------------------- menú y atajos
function instalarMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'Cuentas',
      submenu: [
        {
          label: 'Agregar cuenta…',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => { if (cuentas.length < MAX_CUENTAS) agregarCuenta(''); }
        },
        { type: 'separator' },
        ...[1, 2, 3, 4, 5].map(n => ({
          label: `Ir a la cuenta ${n}`,
          accelerator: `CmdOrCtrl+${n}`,
          click: () => { if (cuentas[n - 1]) activar(cuentas[n - 1].id); }
        })),
        { type: 'separator' },
        {
          label: 'Recargar cuenta activa',
          accelerator: 'CmdOrCtrl+R',
          click: () => { if (activa) recargar(activa); }
        }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'WA5 en GitHub', click: () => shell.openExternal('https://github.com/waltgarcia/wa5') }
      ]
    }
  ]));
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('cuentas:estado', () => ({
  cuentas: cuentas.map(c => ({
    ...c,
    noLeidos: noLeidos.get(c.id) || 0,
    carga: cargando.get(c.id) || (vistas.has(c.id) ? 'lista' : 'pendiente')
  })),
  activa, max: MAX_CUENTAS
}));
ipcMain.handle('cuentas:agregar', (_e, nombre) => agregarCuenta(nombre));
ipcMain.handle('cuentas:renombrar', (_e, id, nombre) => renombrar(id, nombre));
ipcMain.handle('cuentas:eliminar', (_e, id, borrar) => eliminar(id, borrar));
ipcMain.handle('cuentas:activar', (_e, id) => { activar(id); return { ok: true }; });
ipcMain.handle('cuentas:recargar', (_e, id) => { recargar(id); return { ok: true }; });
ipcMain.handle('cuentas:cerrarSesion', (_e, id) => cerrarSesion(id).then(() => ({ ok: true })));
ipcMain.handle('cuentas:menu', (_e, id) => {
  Menu.buildFromTemplate([
    { label: 'Renombrar…', click: () => win.webContents.send('ui:renombrar', id) },
    { label: 'Recargar', click: () => recargar(id) },
    { label: 'Reparar si se queda cargando', click: () => reparar(id) },
    { label: 'Cerrar sesión de esta cuenta', click: () => cerrarSesion(id) },
    { type: 'separator' },
    { label: 'Acercar', click: () => zoom(id, 0.5) },
    { label: 'Alejar', click: () => zoom(id, -0.5) },
    { label: 'Tamaño normal', click: () => { const v = vistas.get(id); if (v) v.webContents.setZoomLevel(0); } },
    { type: 'separator' },
    { label: 'Eliminar cuenta', click: () => eliminar(id, true) }
  ]).popup({ window: win });
  return { ok: true };
});

// ---------------------------------------------------------------- arranque
app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  const bounds = cargar();
  instalarMenu();
  crearVentana(bounds);

  win.webContents.once('did-finish-load', () => {
    if (cuentas.length === 0) agregarCuenta('Personal');
    else activar(activa || cuentas[0].id);
    precargar();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana(null);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
