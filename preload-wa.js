// Minimal preload injected into each account's WhatsApp page.
//
// It exposes nothing to the page: it only listens for user gestures and tells the
// main process whether there is real activity. That way the password is only asked
// for after several minutes without touching anything.
const { ipcRenderer } = require('electron');

let last = 0;

function signal() {
  const now = Date.now();
  if (now - last < 2000) return; // no more than one signal every 2 s
  last = now;
  try { ipcRenderer.send('wa5:activity'); } catch { /* app is shutting down */ }
}

for (const event of ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
  window.addEventListener(event, signal, { capture: true, passive: true });
}
