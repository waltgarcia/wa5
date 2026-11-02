const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('access', {
  state: () => ipcRenderer.invoke('access:state'),
  configure: (profile, password) => ipcRenderer.invoke('access:configure', { profile, password }),
  unlock: (password) => ipcRenderer.invoke('access:unlock', { password }),
  touchId: () => ipcRenderer.invoke('access:touchid')
});
