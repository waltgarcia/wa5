// WA5 local control server.
//
// Lets an agent (Hermes over MCP) inspect the open accounts and leave DRAFTS
// written in the message box. It never sends: sending is up to the user.
//
// - Listens only on 127.0.0.1, never on the network.
// - Requires a token generated on first run; it lives in the app's data folder
//   (permissions 600), outside the repository.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONTROL_PORT = 5077;

// --- JS executed inside each WhatsApp view -----------------------------------
// The selectors were discovered by testing against real WhatsApp Web (2026):
// every chat is a [role="row"] inside #pane-side, with known data-testids.
const JS_CHAT_LIST = `(() => {
  // Invisible direction marks (U+202A-U+202E) leak into the innerText and dirty
  // the names; they are stripped before the names are returned.
  const clean = (s) => (s || '').replace(/[\\u200e\\u200f\\u202a-\\u202e]/g, '').replace(/\\s+/g, ' ').trim();
  const rows = Array.from(document.querySelectorAll('#pane-side [role="row"]'));
  const out = [];
  for (const r of rows) {
    const titleBox = r.querySelector('[data-testid="cell-frame-title"]');
    if (!titleBox) continue;
    const titleSpan = titleBox.querySelector('span[title]');
    const chat = clean(titleSpan ? titleSpan.getAttribute('title') : titleBox.innerText);
    if (!chat) continue;
    const detailBox = r.querySelector('[data-testid="cell-frame-primary-detail"]');
    const secondaryBox = r.querySelector('[data-testid="cell-frame-secondary"]');
    const time = r.querySelector('[data-testid="chat-list-timestamp"]');
    const badge = r.querySelector('[data-testid="icon-unread-count"]');
    const outgoing = !!r.querySelector('[data-icon^="msg-"]');
    // The last message text shows up in primary-detail on some versions and in
    // secondary on others: both are tried and whatever looks like a time is
    // dropped. "ayer" is WhatsApp's own Spanish label for yesterday.
    const looksLikeTime = (t) => /^(\\d{1,2}:\\d{2}|ayer|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})$/i.test(t);
    const candidates = [];
    for (const box of [secondaryBox, detailBox]) {
      if (!box) continue;
      const span = box.querySelector('span[dir="auto"]') || box.querySelector('span');
      candidates.push(clean(span ? span.innerText : box.innerText));
    }
    const lastMessage = candidates.find(t => t && !looksLikeTime(t)) || '';
    out.push({
      chat,
      lastMessage,
      time: clean(time ? time.innerText : ''),
      unread: clean(badge ? badge.innerText : ''),
      awaitingReply: !outgoing
    });
  }
  return JSON.stringify(out);
})()`;

const JS_READ_MESSAGES = `(() => {
  const msgs = Array.from(document.querySelectorAll('[data-testid="msg-container"]'));
  const out = msgs.map(m => {
    const author = m.querySelector('[data-testid="author"]');
    const txt = m.querySelector('[data-testid="selectable-text"]');
    const meta = m.querySelector('[data-testid="msg-meta"]');
    const outgoing = !!m.querySelector('[data-testid="tail-out"]');
    const incoming = !!m.querySelector('[data-testid="tail-in"]');
    return {
      from: outgoing ? 'me' : (author ? author.innerText.trim() : 'other'),
      text: txt ? txt.innerText.trim() : '',
      time: meta ? meta.innerText.replace(/\\n/g, ' ').trim() : null,
      direction: outgoing ? 'outgoing' : (incoming ? 'incoming' : 'unknown')
    };
  }).filter(m => m.text || m.time);
  return JSON.stringify(out);
})()`;

const JS_OPEN_TITLE = `(() => {
  const h = document.querySelector('[data-testid="conversation-info-header-chat-title"]')
        || document.querySelector('header [data-testid="conversation-header"] span[title]')
        || document.querySelector('header span[title]');
  return h ? (h.getAttribute('title') || h.innerText || '').trim() : '';
})()`;

const JS_CHATS_BUTTON = `(() => {
  const b = Array.from(document.querySelectorAll('[role="button"],button'))
    .find(e => /^chats$/i.test((e.getAttribute('aria-label') || '').trim()));
  if (b) { b.click(); return 'ok'; }
  return 'no-button';
})()`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function openChat(wc, chat) {
  const r = await wc.executeJavaScript(`(() => {
    const target = ${JSON.stringify(String(chat))}.toLowerCase();
    const rows = Array.from(document.querySelectorAll('#pane-side [role="row"]'));
    let row = null;
    for (const r of rows) {
      const t = r.querySelector('[data-testid="cell-frame-title"]');
      const n = t ? t.innerText.trim().toLowerCase() : '';
      if (!n) continue;
      if (n === target) { row = r; break; }
      if (!row && n.includes(target)) row = r;
    }
    if (!row) return 'not-found';
    row.click();
    return 'ok';
  })()`);
  if (r !== 'ok') {
    throw new Error(r === 'not-found'
      ? `I don't see any chat named "${chat}" in that account`
      : `Could not open the chat (${r})`);
  }
  const ready = await waitFor(wc, `!!document.querySelector('[data-testid="msg-container"]')`, 10000);
  await sleep(600); // WhatsApp finishes painting the last stretch
  return ready;
}

async function waitFor(wc, expr, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await wc.executeJavaScript(expr)) return true;
    } catch { /* the view may be navigating */ }
    await sleep(250);
  }
  return false;
}

const JS_BOX_STATE = `(() => {
  const c = document.querySelector('footer div[contenteditable="true"]')
        || document.querySelector('div[contenteditable="true"][role="textbox"]');
  if (!c) return JSON.stringify({present: false});
  return JSON.stringify({present: true, text: (c.innerText || '').replace(/\\n/g, '').trim()});
})()`;

async function writeDraft(wc, text) {
  const state = JSON.parse(await wc.executeJavaScript(JS_BOX_STATE));
  if (!state.present) throw new Error('I could not find the message box of that chat');
  if (state.text) {
    throw new Error(`The box already has text in it ("${state.text.slice(0, 60)}"); I won't overwrite it`);
  }
  await wc.executeJavaScript(`(() => {
    const c = document.querySelector('footer div[contenteditable="true"]')
          || document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (c) c.focus();
    return 'ok';
  })()`);
  // insertText types as if it were the keyboard: WhatsApp's editor accepts it
  // and enables the send button, but it does NOT send. The Enter is the user's.
  wc.insertText(String(text));
  await sleep(500);
  const after = JSON.parse(await wc.executeJavaScript(JS_BOX_STATE));
  // "enviar" is WhatsApp's own aria-label in the Spanish UI, not ours.
  const sendButton = await wc.executeJavaScript(`(() => {
    const b = Array.from(document.querySelectorAll('[role="button"],button'))
      .find(e => /^enviar$/i.test((e.getAttribute('aria-label') || '').trim()));
    return b ? 'ready' : 'no-button';
  })()`);
  return { box: after.text, sendButton };
}

// --- server ----------------------------------------------------------------
function createToken(dataDir) {
  const file = path.join(dataDir, 'control.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.token) return j.token;
  } catch { /* first run */ }
  const token = crypto.randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(file, JSON.stringify({ token, port: CONTROL_PORT }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[wa5] could not save the control token:', e.message);
  }
  return token;
}

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/**
 * @param {object} options
 * @param {(id:string)=>object|null} options.getView  returns the WebContentsView
 * @param {()=>Array} options.getAccounts             account list
 * @param {(id:string)=>void} options.activate        brings an account to the front
 * @param {string} options.dataDir                    app data folder
 * @param {()=>object} options.state                  app internal state
 */
function startControl({ getView, getAccounts, activate, dataDir, state, isUnlocked }) {
  const token = createToken(dataDir);

  // The account objects come from main.js; read either spelling so both halves
  // of the translation can land independently.
  const accountName = (a) => a.name ?? a.nombre;

  const server = http.createServer(async (req, res) => {
    // Local only: if anything ever arrived from outside, it is cut off here.
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
      return json(res, 403, { ok: false, error: 'localhost only' });
    }
    if (req.headers['x-token'] !== token) {
      return json(res, 401, { ok: false, error: 'invalid token' });
    }

    // While the app is locked the agent sees nothing: the password rules.
    if (isUnlocked && !isUnlocked()) {
      return json(res, 423, {
        ok: false,
        error: 'WA5 is locked. Unlock it in the app with the password or Touch ID so the agent can read.'
      });
    }

    const url = new URL(req.url, `http://127.0.0.1:${CONTROL_PORT}`);
    const q = url.searchParams;

    try {
      // --- overall state ---------------------------------------------------
      if (url.pathname === '/state') {
        return json(res, 200, { ok: true, data: state() });
      }

      // --- pick an account -------------------------------------------------
      const accountId = q.get('account');
      const account = accountId
        ? getAccounts().find(a => a.id === accountId || accountName(a).toLowerCase() === accountId.toLowerCase())
        : getAccounts()[0];
      if (!account) return json(res, 404, { ok: false, error: 'account not found' });
      const v = getView(account.id);
      if (!v) {
        activate(account.id);
        await sleep(1500);
      }
      const view = getView(account.id);
      if (!view) return json(res, 409, { ok: false, error: `account "${accountName(account)}" is not loaded yet` });

      // WhatsApp only paints the DOM of the visible view: an account in the
      // background answers empty. Bringing it to the front is also useful,
      // because the user sees which account the agent is querying.
      const st = state();
      if ((st.active ?? st.activa) !== account.id) {
        activate(account.id);
        await sleep(1800);
      }

      // --- pending chats ---------------------------------------------------
      if (url.pathname === '/pending') {
        await view.webContents.executeJavaScript(JS_CHATS_BUTTON);
        // The list is slow to paint; wait actively instead of blindly.
        const listVisible = await waitFor(view.webContents,
          `document.querySelectorAll('#pane-side [role="row"]').length > 0`, 15000);
        const chats = JSON.parse(await view.webContents.executeJavaScript(JS_CHAT_LIST));
        const onlyPending = q.get('all') !== '1';
        const data = chats
          .filter(c => !onlyPending || (c.unread && c.unread !== '0'))
          .map(c => ({ ...c, account: accountName(account), accountId: account.id }));
        return json(res, 200, {
          ok: true, account: accountName(account), total: data.length,
          listVisible,
          ...(listVisible ? {} : { notice: 'The chat list is not painted yet; retry in a few seconds.' }),
          chats: data
        });
      }

      // --- diagnostics -----------------------------------------------------
      if (url.pathname === '/diag') {
        const d = JSON.parse(await view.webContents.executeJavaScript(`(() => JSON.stringify({
          url: location.href,
          title: document.title,
          paneSide: !!document.querySelector('#pane-side'),
          rows: document.querySelectorAll('#pane-side [role="row"]').length,
          testids: (() => { const c={}; document.querySelectorAll('[data-testid]').forEach(e=>{const k=e.getAttribute('data-testid');c[k]=(c[k]||0)+1}); return Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,8); })(),
          sampleRow: (() => {
            const f = document.querySelector('#pane-side [role="row"]');
            if (!f) return null;
            const r = {};
            f.querySelectorAll('[data-testid]').forEach(e => {
              r[e.getAttribute('data-testid')] = (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
            });
            return r;
          })(),
          text: document.body.innerText.replace(/\\s+/g,' ').slice(0, 160)
        }))()`));
        return json(res, 200, { ok: true, account: accountName(account), ...d });
      }

      // --- read a conversation ---------------------------------------------
      if (url.pathname === '/read') {
        const chat = q.get('chat');
        if (!chat) return json(res, 400, { ok: false, error: 'missing ?chat=' });
        const n = Math.min(parseInt(q.get('n') || '20', 10) || 20, 100);
        await openChat(view.webContents, chat);
        const msgs = JSON.parse(await view.webContents.executeJavaScript(JS_READ_MESSAGES));
        const openTitle = await view.webContents.executeJavaScript(JS_OPEN_TITLE);
        return json(res, 200, {
          ok: true, account: accountName(account), chat: openTitle || chat,
          total: msgs.length, messages: msgs.slice(-n)
        });
      }

      // --- leave a draft (does NOT send) -----------------------------------
      if (url.pathname === '/draft' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        let d;
        try { d = JSON.parse(body || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
        if (!d.chat || !d.text) return json(res, 400, { ok: false, error: 'missing chat and text' });
        if (String(d.text).length > 4000) return json(res, 400, { ok: false, error: 'text too long' });
        await openChat(view.webContents, d.chat);
        const r = await writeDraft(view.webContents, d.text);
        return json(res, 200, {
          ok: true, account: accountName(account), chat: d.chat,
          written: r.box, sendButton: r.sendButton,
          notice: 'Text written into the box. It was NOT sent: the user still has to press Enter.'
        });
      }

      return json(res, 404, { ok: false, error: 'unknown route' });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  });

  server.on('error', (e) => {
    console.error('[wa5] control server:', e.code === 'EADDRINUSE'
      ? `port ${CONTROL_PORT} is already in use (another copy of WA5 running?)`
      : e.message);
  });

  server.listen(CONTROL_PORT, '127.0.0.1', () => {
    console.log(`[wa5] local control on http://127.0.0.1:${CONTROL_PORT} (token in control.json)`);
  });

  return { server, token, port: CONTROL_PORT };
}

module.exports = { startControl, CONTROL_PORT };
