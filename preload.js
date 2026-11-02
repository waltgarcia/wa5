const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wa', {
  estado: () => ipcRenderer.invoke('cuentas:estado'),
  agregar: (nombre) => ipcRenderer.invoke('cuentas:agregar', nombre),
  renombrar: (id, nombre) => ipcRenderer.invoke('cuentas:renombrar', id, nombre),
  eliminar: (id, borrar) => ipcRenderer.invoke('cuentas:eliminar', id, borrar),
  activar: (id) => ipcRenderer.invoke('cuentas:activar', id),
  recargar: (id) => ipcRenderer.invoke('cuentas:recargar', id),
  cerrarSesion: (id) => ipcRenderer.invoke('cuentas:cerrarSesion', id),
  menu: (id) => ipcRenderer.invoke('cuentas:menu', id),
  alCambiarCuentas: (fn) => ipcRenderer.on('estado:cuentas', (_e, data) => fn(data)),
  alCambiarNoLeidos: (fn) => ipcRenderer.on('estado:noLeidos', (_e, data) => fn(data)),
  alCambiarCarga: (fn) => ipcRenderer.on('estado:carga', (_e, data) => fn(data)),
  actividad: () => ipcRenderer.send('wa5:actividad'),
  alPedirRenombrar: (fn) => ipcRenderer.on('ui:renombrar', (_e, id) => fn(id))
});
