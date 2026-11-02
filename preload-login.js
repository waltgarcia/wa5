const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('acceso', {
  estado: () => ipcRenderer.invoke('acceso:estado'),
  configurar: (perfil, contrasena) => ipcRenderer.invoke('acceso:configurar', { perfil, contrasena }),
  desbloquear: (contrasena) => ipcRenderer.invoke('acceso:desbloquear', { contrasena }),
  touchid: () => ipcRenderer.invoke('acceso:touchid')
});
