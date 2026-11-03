const accountsList = document.getElementById('accounts');
const addButton = document.getElementById('add-account');
const view = document.getElementById('view');
const footer = document.getElementById('footer');

let state = { accounts: [], activeId: null, max: 5 };

// The 34 px strip at the top of the sidebar only exists to make room for the macOS
// traffic lights; on Windows the normal title bar already does that job.
if (window.wa.platform && window.wa.platform !== 'darwin') {
  document.body.classList.add('framed');
}


function initial(name) {
  const clean = (name || '?').trim();
  return clean ? clean[0].toUpperCase() : '?';
}

function render() {
  accountsList.innerHTML = '';
  for (const account of state.accounts) {
    const div = document.createElement('div');
    div.className = 'account' + (account.id === state.activeId ? ' active' : '');
    if (account.loadState === 'loading') div.classList.add('loading');
    if (account.loadState === 'error') div.classList.add('failed');
    div.style.background = account.color || '#25D366';
    let hint = 'Click: open · Right-click: options';
    if (account.loadState === 'loading') hint = 'Loading WhatsApp…';
    if (account.loadState === 'error') hint = 'Failed to load. Right-click → Reload';
    div.title = account.name + '\n' + hint;
    div.textContent = initial(account.name);
    if (account.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = account.unread > 99 ? '99+' : String(account.unread);
      div.appendChild(badge);
    }
    div.addEventListener('click', () => window.wa.activate(account.id));
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.wa.menu(account.id);
    });
    accountsList.appendChild(div);
  }

  addButton.disabled = state.accounts.length >= state.max;
  addButton.title = addButton.disabled
    ? `Limit: ${state.max} accounts`
    : 'Add account';

  footer.textContent = `${state.accounts.length}/${state.max}`;

  // the welcome notice is only visible while there is still no account at all
  view.style.display = state.accounts.length > 0 ? 'none' : 'flex';
}

addButton.addEventListener('click', async () => {
  // Logged so a "the + button does nothing" report can be told apart from a click
  // that macOS eats (drag region) instead of guessing.
  if (window.wa.uiLog) window.wa.uiLog('+ button: click received');
  if (state.accounts.length >= state.max) return;
  // The name is asked in a child window from the main process: a dialog drawn here
  // would be hidden behind the WhatsApp view.
  const result = await window.wa.add();
  if (result && result.ok === false && result.error) alert(result.error);
});

window.wa.onAccounts((data) => {
  state = data;
  render();
});

window.wa.onUnread(({ id, unread }) => {
  const a = state.accounts.find(x => x.id === id);
  if (a) { a.unread = unread; render(); }
});

window.wa.onLoadState(({ id, loadState }) => {
  const a = state.accounts.find(x => x.id === id);
  if (a) { a.loadState = loadState; render(); }
});

// Renaming is handled in the main process now, in the same child window that asks
// for a new account's name.


window.wa.state().then((data) => {
  state = data;
  render();
});

// Tell the main process there is activity, so the password is only asked for
// after several minutes without touching the app.
let lastSignal = 0;
function signalActivity() {
  const now = Date.now();
  if (now - lastSignal < 2000) return;
  lastSignal = now;
  window.wa.activity();
}
for (const ev of ['mousemove', 'mousedown', 'keydown', 'wheel']) {
  window.addEventListener(ev, signalActivity, { passive: true });
}
