// Puerta de acceso de WA5: nombre de perfil fijo + contraseña local.
//
// - La contraseña se guarda como hash scrypt con sal aleatoria; el texto nunca
//   toca el disco ni se registra en logs.
// - El archivo vive en la carpeta de datos de la app, fuera del repositorio.
// - Sin la contraseña correcta no se crea la ventana de WhatsApp, así que nadie
//   alcanza a ver las conversaciones desde la app.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ARCHIVO_ACCESO = (dirDatos) => path.join(dirDatos, 'acceso.json');
const INTENTOS_MAX = 5;
const ESPERA_TRAS_FALLOS = 30_000; // 30 s de castigo tras 5 fallos

function leerAcceso(dirDatos) {
  try {
    const j = JSON.parse(fs.readFileSync(ARCHIVO_ACCESO(dirDatos), 'utf8'));
    if (j && j.hash && j.perfil) return j;
  } catch { /* sin configurar todavía */ }
  return null;
}

function derivar(contrasena, sal, iteraciones) {
  return crypto.scryptSync(contrasena.normalize('NFKC'), sal, 64, { N: iteraciones }).toString('hex');
}

function configurar(dirDatos, perfil, contrasena) {
  const nombre = String(perfil || '').trim();
  if (nombre.length < 2 || nombre.length > 40) {
    throw new Error('El nombre del perfil debe tener entre 2 y 40 caracteres');
  }
  if (String(contrasena || '').length < 6) {
    throw new Error('La contraseña debe tener al menos 6 caracteres');
  }
  const iteraciones = 16384;
  const sal = crypto.randomBytes(16).toString('hex');
  const datos = {
    perfil: nombre,
    sal,
    iteraciones,
    hash: derivar(contrasena, sal, iteraciones),
    creado: new Date().toISOString()
  };
  fs.mkdirSync(dirDatos, { recursive: true });
  fs.writeFileSync(ARCHIVO_ACCESO(dirDatos), JSON.stringify(datos, null, 2), { mode: 0o600 });
  return { perfil: nombre };
}

function crearVerificador(dirDatos) {
  let fallos = 0;
  let bloqueadoHasta = 0;

  return function verificar(contrasena) {
    const datos = leerAcceso(dirDatos);
    if (!datos) throw new Error('Todavía no hay contraseña configurada');

    const ahora = Date.now();
    if (ahora < bloqueadoHasta) {
      const faltan = Math.ceil((bloqueadoHasta - ahora) / 1000);
      throw new Error(`Demasiados intentos. Espera ${faltan} s.`);
    }

    const intento = derivar(String(contrasena || ''), datos.sal, datos.iteraciones);
    const iguales =
      intento.length === datos.hash.length &&
      crypto.timingSafeEqual(Buffer.from(intento, 'hex'), Buffer.from(datos.hash, 'hex'));

    if (!iguales) {
      fallos += 1;
      if (fallos >= INTENTOS_MAX) {
        fallos = 0;
        bloqueadoHasta = Date.now() + ESPERA_TRAS_FALLOS;
        throw new Error(`Demasiados intentos. Espera ${ESPERA_TRAS_FALLOS / 1000} s.`);
      }
      throw new Error(`Contraseña incorrecta. Te quedan ${INTENTOS_MAX - fallos} intentos.`);
    }

    fallos = 0;
    return { perfil: datos.perfil };
  };
}

// --- bloqueo por inactividad ----------------------------------------------
// No se pide la contraseña en cada arranque: solo cuando pasan minutos sin que
// nadie toque la app. Se guarda la marca de la última actividad firmada con el
// hash, así que editar el archivo a mano no sirve para saltarse la contraseña.
const ARCHIVO_SESION = (dirDatos) => path.join(dirDatos, 'sesion.json');

function firmaActividad(datos, cuando) {
  return crypto.createHmac('sha256', `${datos.hash}:${datos.sal}`)
    .update(String(cuando)).digest('hex');
}

function guardarActividad(dirDatos, cuando = Date.now()) {
  const datos = leerAcceso(dirDatos);
  if (!datos) return false;
  try {
    const marca = { cuando, firma: firmaActividad(datos, cuando) };
    fs.writeFileSync(ARCHIVO_SESION(dirDatos), JSON.stringify(marca), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Milisegundos desde la última actividad registrada, o Infinity si no hay marca válida. */
function inactividadMs(dirDatos) {
  const datos = leerAcceso(dirDatos);
  if (!datos) return Infinity;
  try {
    const marca = JSON.parse(fs.readFileSync(ARCHIVO_SESION(dirDatos), 'utf8'));
    if (!marca || !marca.cuando || !marca.firma) return Infinity;
    const esperada = firmaActividad(datos, marca.cuando);
    if (!crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(marca.firma))) return Infinity;
    return Math.max(0, Date.now() - Number(marca.cuando));
  } catch {
    return Infinity;
  }
}

function olvidarActividad(dirDatos) {
  try { fs.unlinkSync(ARCHIVO_SESION(dirDatos)); } catch { /* no había */ }
}

module.exports = {
  leerAcceso, configurar, crearVerificador, ARCHIVO_ACCESO,
  guardarActividad, inactividadMs, olvidarActividad
};
