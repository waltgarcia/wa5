const $ = (id) => document.getElementById(id);
let modo = 'configurar';

function mostrarError(t) { $('error').textContent = t || ''; }

async function iniciar() {
  const e = await window.acceso.estado();
  if (e.configurado) {
    modo = 'entrar';
    $('titulo').textContent = 'Entrar a WA5';
    $('subtitulo').textContent = 'Escribe tu contraseña para abrir las cuentas.';
    $('grupoPerfil').classList.add('oculto');
    $('grupoRepetir').classList.add('oculto');
    $('accion').textContent = 'Entrar';
    if (e.touchid) $('botonHuella').classList.remove('oculto');
  } else {
    modo = 'configurar';
  }
  $('contrasena').focus();
}

$('botonHuella').addEventListener('click', async () => {
  mostrarError('');
  const r = await window.acceso.touchid();
  if (!r.ok) mostrarError(r.error);
});

$('forma').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  mostrarError('');
  $('accion').disabled = true;

  try {
    if (modo === 'configurar') {
      const perfil = $('perfil').value.trim();
      const c1 = $('contrasena').value;
      const c2 = $('repetir').value;
      if (!perfil) return mostrarError('Escribe el nombre del perfil.');
      if (c1.length < 6) return mostrarError('La contraseña debe tener al menos 6 caracteres.');
      if (c1 !== c2) return mostrarError('Las dos contraseñas no coinciden.');
      const r = await window.acceso.configurar(perfil, c1);
      if (!r.ok) return mostrarError(r.error);
    } else {
      const r = await window.acceso.desbloquear($('contrasena').value);
      if (!r.ok) {
        mostrarError(r.error);
        $('contrasena').value = '';
        $('contrasena').focus();
      }
    }
  } finally {
    $('accion').disabled = false;
  }
});

iniciar();
