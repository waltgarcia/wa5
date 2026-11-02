const lista = document.getElementById('cuentas');
const botonAgregar = document.getElementById('agregar');
const area = document.getElementById('area');
const pie = document.getElementById('pie');

let estado = { cuentas: [], activa: null, max: 5 };

function inicial(nombre) {
  const limpio = (nombre || '?').trim();
  return limpio ? limpio[0].toUpperCase() : '?';
}

function pintar() {
  lista.innerHTML = '';
  for (const cuenta of estado.cuentas) {
    const div = document.createElement('div');
    div.className = 'cuenta' + (cuenta.id === estado.activa ? ' activa' : '');
    if (cuenta.carga === 'cargando') div.classList.add('cargando');
    if (cuenta.carga === 'error') div.classList.add('fallo');
    div.style.background = cuenta.color || '#25D366';
    let pista = 'Clic: abrir · Clic derecho: opciones';
    if (cuenta.carga === 'cargando') pista = 'Cargando WhatsApp…';
    if (cuenta.carga === 'error') pista = 'No cargó. Clic derecho → Recargar';
    div.title = cuenta.nombre + '\n' + pista;
    div.textContent = inicial(cuenta.nombre);
    if (cuenta.noLeidos > 0) {
      const globo = document.createElement('span');
      globo.className = 'globo';
      globo.textContent = cuenta.noLeidos > 99 ? '99+' : String(cuenta.noLeidos);
      div.appendChild(globo);
    }
    div.addEventListener('click', () => window.wa.activar(cuenta.id));
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.wa.menu(cuenta.id);
    });
    lista.appendChild(div);
  }

  botonAgregar.disabled = estado.cuentas.length >= estado.max;
  botonAgregar.title = botonAgregar.disabled
    ? `Límite: ${estado.max} cuentas`
    : 'Agregar cuenta';

  pie.textContent = `${estado.cuentas.length}/${estado.max}`;

  // el aviso de bienvenida solo se ve cuando todavía no hay ninguna cuenta
  area.style.display = estado.cuentas.length > 0 ? 'none' : 'flex';
}

botonAgregar.addEventListener('click', async () => {
  if (estado.cuentas.length >= estado.max) return;
  const nombre = prompt('¿Cómo se llama esta cuenta? (ej. Personal, Consultorio, Essity)');
  if (nombre === null) return;
  await window.wa.agregar(nombre);
});

window.wa.alCambiarCuentas((data) => {
  estado = data;
  pintar();
});

window.wa.alCambiarNoLeidos(({ id, n }) => {
  const c = estado.cuentas.find(x => x.id === id);
  if (c) { c.noLeidos = n; pintar(); }
});

window.wa.alCambiarCarga(({ id, estado: fase }) => {
  const c = estado.cuentas.find(x => x.id === id);
  if (c) { c.carga = fase; pintar(); }
});

window.wa.alPedirRenombrar(async (id) => {
  const cuenta = estado.cuentas.find(x => x.id === id);
  if (!cuenta) return;
  const nombre = prompt('Nuevo nombre para esta cuenta:', cuenta.nombre);
  if (nombre === null) return;
  await window.wa.renombrar(id, nombre);
});

window.wa.estado().then((data) => {
  estado = data;
  pintar();
});

// Avisar al proceso principal de que hay actividad, para que la contraseña solo
// se pida después de varios minutos sin tocar la app.
let ultimoAviso = 0;
function avisarActividad() {
  const ahora = Date.now();
  if (ahora - ultimoAviso < 2000) return;
  ultimoAviso = ahora;
  window.wa.actividad();
}
for (const ev of ['mousemove', 'mousedown', 'keydown', 'wheel']) {
  window.addEventListener(ev, avisarActividad, { passive: true });
}
