// Servidor de control local de WA5.
//
// Permite que un agente (Hermes vía MCP) consulte las cuentas abiertas y deje
// BORRADORES escritos en la caja de texto. Nunca envía: el envío es del usuario.
//
// - Escucha solo en 127.0.0.1, nunca en la red.
// - Exige un token que se genera la primera vez y vive en la carpeta de datos
//   de la app (permisos 600), fuera del repositorio.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUERTO_CONTROL = 5077;

// --- JS que se ejecuta dentro de cada vista de WhatsApp ----------------------
// Los selectores se descubrieron probando contra WhatsApp Web real (2026):
// cada chat es una [role="row"] dentro de #pane-side, con data-testid conocidos.
const JS_LISTA_CHATS = `(() => {
  // Los marcadores invisibles de dirección (\u202a-\u202e) se cuelan en el
  // innerText y ensucian los nombres; se limpian antes de devolverlos.
  const limpio = (s) => (s || '').replace(/[\\u200e\\u200f\\u202a-\\u202e]/g, '').replace(/\\s+/g, ' ').trim();
  const filas = Array.from(document.querySelectorAll('#pane-side [role="row"]'));
  const out = [];
  for (const f of filas) {
    const cajaTitulo = f.querySelector('[data-testid="cell-frame-title"]');
    if (!cajaTitulo) continue;
    const spanTitulo = cajaTitulo.querySelector('span[title]');
    const chat = limpio(spanTitulo ? spanTitulo.getAttribute('title') : cajaTitulo.innerText);
    if (!chat) continue;
    const cajaDetalle = f.querySelector('[data-testid="cell-frame-primary-detail"]');
    const cajaSecundaria = f.querySelector('[data-testid="cell-frame-secondary"]');
    const hora = f.querySelector('[data-testid="chat-list-timestamp"]');
    const badge = f.querySelector('[data-testid="icon-unread-count"]');
    const saliente = !!f.querySelector('[data-icon^="msg-"]');
    // El texto del último mensaje aparece a veces en primary-detail y a veces en
    // secondary según la versión: se prueban los dos y se descarta lo que sea hora.
    const pareceHora = (t) => /^(\\d{1,2}:\\d{2}|ayer|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})$/i.test(t);
    const candidatos = [];
    for (const caja of [cajaSecundaria, cajaDetalle]) {
      if (!caja) continue;
      const span = caja.querySelector('span[dir="auto"]') || caja.querySelector('span');
      candidatos.push(limpio(span ? span.innerText : caja.innerText));
    }
    const ultimo = candidatos.find(t => t && !pareceHora(t)) || '';
    out.push({
      chat,
      ultimo,
      hora: limpio(hora ? hora.innerText : ''),
      noLeidos: limpio(badge ? badge.innerText : ''),
      esperaRespuesta: !saliente
    });
  }
  return JSON.stringify(out);
})()`;

const JS_LEER_MENSAJES = `(() => {
  const msgs = Array.from(document.querySelectorAll('[data-testid="msg-container"]'));
  const out = msgs.map(m => {
    const autor = m.querySelector('[data-testid="author"]');
    const txt = m.querySelector('[data-testid="selectable-text"]');
    const meta = m.querySelector('[data-testid="msg-meta"]');
    const saliente = !!m.querySelector('[data-testid="tail-out"]');
    const entrante = !!m.querySelector('[data-testid="tail-in"]');
    return {
      de: saliente ? 'yo' : (autor ? autor.innerText.trim() : 'otro'),
      texto: txt ? txt.innerText.trim() : '',
      hora: meta ? meta.innerText.replace(/\\n/g, ' ').trim() : null,
      direccion: saliente ? 'saliente' : (entrante ? 'entrante' : 'desconocida')
    };
  }).filter(m => m.texto || m.hora);
  return JSON.stringify(out);
})()`;

const JS_TITULO_ABIERTO = `(() => {
  const h = document.querySelector('[data-testid="conversation-info-header-chat-title"]')
        || document.querySelector('header [data-testid="conversation-header"] span[title]')
        || document.querySelector('header span[title]');
  return h ? (h.getAttribute('title') || h.innerText || '').trim() : '';
})()`;

const JS_BOTON_CHATS = `(() => {
  const b = Array.from(document.querySelectorAll('[role="button"],button'))
    .find(e => /^chats$/i.test((e.getAttribute('aria-label') || '').trim()));
  if (b) { b.click(); return 'ok'; }
  return 'sin-boton';
})()`;

const dormir = (ms) => new Promise(r => setTimeout(r, ms));

async function abrirChat(wc, chat) {
  const r = await wc.executeJavaScript(`(() => {
    const objetivo = ${JSON.stringify(String(chat))}.toLowerCase();
    const filas = Array.from(document.querySelectorAll('#pane-side [role="row"]'));
    let fila = null;
    for (const f of filas) {
      const t = f.querySelector('[data-testid="cell-frame-title"]');
      const n = t ? t.innerText.trim().toLowerCase() : '';
      if (!n) continue;
      if (n === objetivo) { fila = f; break; }
      if (!fila && n.includes(objetivo)) fila = f;
    }
    if (!fila) return 'no-encontrado';
    fila.click();
    return 'ok';
  })()`);
  if (r !== 'ok') {
    throw new Error(r === 'no-encontrado'
      ? `No veo ningún chat que se llame "${chat}" en esa cuenta`
      : `No pude abrir el chat (${r})`);
  }
  const listo = await esperar(wc, '!!document.querySelector(\'[data-testid="msg-container"]\')', 10000);
  await dormir(600); // WhatsApp termina de pintar el último tramo
  return listo;
}

async function esperar(wc, expr, ms = 8000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    try {
      if (await wc.executeJavaScript(expr)) return true;
    } catch { /* la vista puede estar navegando */ }
    await dormir(250);
  }
  return false;
}

const JS_ESTADO_CAJA = `(() => {
  const c = document.querySelector('footer div[contenteditable="true"]')
        || document.querySelector('div[contenteditable="true"][role="textbox"]');
  if (!c) return JSON.stringify({hay: false});
  return JSON.stringify({hay: true, texto: (c.innerText || '').replace(/\\n/g, '').trim()});
})()`;

async function borrador(wc, texto) {
  const estado = JSON.parse(await wc.executeJavaScript(JS_ESTADO_CAJA));
  if (!estado.hay) throw new Error('No encontré la caja de texto de ese chat');
  if (estado.texto) {
    throw new Error(`La caja ya tiene texto escrito ("${estado.texto.slice(0, 60)}"); no la sobreescribo`);
  }
  await wc.executeJavaScript(`(() => {
    const c = document.querySelector('footer div[contenteditable="true"]')
          || document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (c) c.focus();
    return 'ok';
  })()`);
  // insertText escribe como si fuera el teclado: el editor de WhatsApp lo acepta
  // y habilita el botón de enviar, pero NO envía. El Enter lo da el usuario.
  wc.insertText(String(texto));
  await dormir(500);
  const despues = JSON.parse(await wc.executeJavaScript(JS_ESTADO_CAJA));
  const botonEnviar = await wc.executeJavaScript(`(() => {
    const b = Array.from(document.querySelectorAll('[role="button"],button'))
      .find(e => /^enviar$/i.test((e.getAttribute('aria-label') || '').trim()));
    return b ? 'listo' : 'sin-boton';
  })()`);
  return { caja: despues.texto, botonEnviar };
}

// --- servidor --------------------------------------------------------------
function crearToken(rutaDatos) {
  const ruta = path.join(rutaDatos, 'control.json');
  try {
    const j = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (j && j.token) return j.token;
  } catch { /* primera vez */ }
  const token = crypto.randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(ruta, JSON.stringify({ token, puerto: PUERTO_CONTROL }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[wa5] no pude guardar el token de control:', e.message);
  }
  return token;
}

function json(res, codigo, datos) {
  const cuerpo = JSON.stringify(datos, null, 2);
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(cuerpo);
}

/**
 * @param {object} opciones
 * @param {(id:string)=>object|null} opciones.vistaDe  devuelve el WebContentsView
 * @param {()=>Array} opciones.cuentas                   lista de cuentas
 * @param {(id:string)=>void} opciones.activar          pone una cuenta al frente
 * @param {string} opciones.rutaDatos                   carpeta de datos de la app
 * @param {()=>object} opciones.estado                  estado interno de la app
 */
function iniciarControl({ vistaDe, cuentas, activar, rutaDatos, estado, estaDesbloqueada }) {
  const token = crearToken(rutaDatos);

  const servidor = http.createServer(async (req, res) => {
    // Solo local: si algo llegara de fuera, se corta aquí.
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
      return json(res, 403, { ok: false, error: 'solo localhost' });
    }
    if (req.headers['x-token'] !== token) {
      return json(res, 401, { ok: false, error: 'token inválido' });
    }

    // Con la app bloqueada el agente no ve nada: la contraseña manda.
    if (estaDesbloqueada && !estaDesbloqueada()) {
      return json(res, 423, {
        ok: false,
        error: 'WA5 está bloqueada. Desbloquéala en la app con la contraseña o Touch ID para que el agente pueda leer.'
      });
    }

    const url = new URL(req.url, `http://127.0.0.1:${PUERTO_CONTROL}`);
    const q = url.searchParams;

    try {
      // --- estado general --------------------------------------------------
      if (url.pathname === '/estado') {
        return json(res, 200, { ok: true, datos: estado() });
      }

      // --- elegir cuenta ---------------------------------------------------
      const idCuenta = q.get('cuenta');
      const cuenta = idCuenta
        ? cuentas().find(c => c.id === idCuenta || c.nombre.toLowerCase() === idCuenta.toLowerCase())
        : cuentas()[0];
      if (!cuenta) return json(res, 404, { ok: false, error: 'cuenta no encontrada' });
      const v = vistaDe(cuenta.id);
      if (!v) {
        activar(cuenta.id);
        await dormir(1500);
      }
      const vista = vistaDe(cuenta.id);
      if (!vista) return json(res, 409, { ok: false, error: `la cuenta "${cuenta.nombre}" aún no está cargada` });

      // WhatsApp solo pinta el DOM de la vista visible: una cuenta en segundo
      // plano responde vacío. Traerla al frente es además útil, porque el usuario
      // ve qué cuenta está consultando el agente.
      if (estado().activa !== cuenta.id) {
        activar(cuenta.id);
        await dormir(1800);
      }

      // --- chats pendientes ------------------------------------------------
      if (url.pathname === '/pendientes') {
        await vista.webContents.executeJavaScript(JS_BOTON_CHATS);
        // La lista tarda en pintar; esperar de forma activa en vez de a ciegas.
        const hayLista = await esperar(vista.webContents,
          'document.querySelectorAll(\'#pane-side [role="row"]\').length > 0', 15000);
        const chats = JSON.parse(await vista.webContents.executeJavaScript(JS_LISTA_CHATS));
        const soloPendientes = q.get('todos') !== '1';
        const datos = chats
          .filter(c => !soloPendientes || (c.noLeidos && c.noLeidos !== '0'))
          .map(c => ({ ...c, cuenta: cuenta.nombre, cuentaId: cuenta.id }));
        return json(res, 200, {
          ok: true, cuenta: cuenta.nombre, total: datos.length,
          listaVisible: hayLista,
          ...(hayLista ? {} : { aviso: 'La lista de chats todavía no está pintada; reintenta en unos segundos.' }),
          chats: datos
        });
      }

      // --- diagnóstico ------------------------------------------------------
      if (url.pathname === '/diag') {
        const d = JSON.parse(await vista.webContents.executeJavaScript(`(() => JSON.stringify({
          url: location.href,
          titulo: document.title,
          paneSide: !!document.querySelector('#pane-side'),
          filas: document.querySelectorAll('#pane-side [role="row"]').length,
          testids: (() => { const c={}; document.querySelectorAll('[data-testid]').forEach(e=>{const k=e.getAttribute('data-testid');c[k]=(c[k]||0)+1}); return Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,8); })(),
          filaMuestra: (() => {
            const f = document.querySelector('#pane-side [role="row"]');
            if (!f) return null;
            const r = {};
            f.querySelectorAll('[data-testid]').forEach(e => {
              r[e.getAttribute('data-testid')] = (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
            });
            return r;
          })(),
          texto: document.body.innerText.replace(/\\s+/g,' ').slice(0, 160)
        }))()`));
        return json(res, 200, { ok: true, cuenta: cuenta.nombre, ...d });
      }

      // --- leer una conversación -------------------------------------------
      if (url.pathname === '/leer') {
        const chat = q.get('chat');
        if (!chat) return json(res, 400, { ok: false, error: 'falta ?chat=' });
        const n = Math.min(parseInt(q.get('n') || '20', 10) || 20, 100);
        await abrirChat(vista.webContents, chat);
        const msgs = JSON.parse(await vista.webContents.executeJavaScript(JS_LEER_MENSAJES));
        const abierto = await vista.webContents.executeJavaScript(JS_TITULO_ABIERTO);
        return json(res, 200, {
          ok: true, cuenta: cuenta.nombre, chat: abierto || chat,
          total: msgs.length, mensajes: msgs.slice(-n)
        });
      }

      // --- dejar un borrador (NO envía) ------------------------------------
      if (url.pathname === '/borrador' && req.method === 'POST') {
        let cuerpo = '';
        for await (const t of req) cuerpo += t;
        let d;
        try { d = JSON.parse(cuerpo || '{}'); } catch { return json(res, 400, { ok: false, error: 'JSON inválido' }); }
        if (!d.chat || !d.texto) return json(res, 400, { ok: false, error: 'faltan chat y texto' });
        if (String(d.texto).length > 4000) return json(res, 400, { ok: false, error: 'texto demasiado largo' });
        await abrirChat(vista.webContents, d.chat);
        const r = await borrador(vista.webContents, d.texto);
        return json(res, 200, {
          ok: true, cuenta: cuenta.nombre, chat: d.chat,
          escrito: r.caja, botonEnviar: r.botonEnviar,
          aviso: 'Texto escrito en la caja. NO se envió: falta que el usuario dé Enter.'
        });
      }

      return json(res, 404, { ok: false, error: 'ruta desconocida' });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  });

  servidor.on('error', (e) => {
    console.error('[wa5] servidor de control:', e.code === 'EADDRINUSE'
      ? `el puerto ${PUERTO_CONTROL} ya está ocupado (¿otra copia de WA5 abierta?)`
      : e.message);
  });

  servidor.listen(PUERTO_CONTROL, '127.0.0.1', () => {
    console.log(`[wa5] control local en http://127.0.0.1:${PUERTO_CONTROL} (token en control.json)`);
  });

  return { servidor, token, puerto: PUERTO_CONTROL };
}

module.exports = { iniciarControl, PUERTO_CONTROL };
