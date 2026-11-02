// Preload mínimo que se inyecta en la página de WhatsApp de cada cuenta.
//
// No expone nada a la página: solo escucha gestos del usuario y avisa al proceso
// principal para que la app sepa si hay actividad real. Así la contraseña se pide
// únicamente después de varios minutos sin tocar nada.
const { ipcRenderer } = require('electron');

let ultimo = 0;

function avisar() {
  const ahora = Date.now();
  if (ahora - ultimo < 2000) return; // no más de un aviso cada 2 s
  ultimo = ahora;
  try { ipcRenderer.send('wa5:actividad'); } catch { /* app cerrándose */ }
}

for (const evento of ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
  window.addEventListener(evento, avisar, { capture: true, passive: true });
}
