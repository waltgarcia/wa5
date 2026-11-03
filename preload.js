const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wa', {
  state: () => ipcRenderer.invoke('accounts:state'),
  add: (name) => ipcRenderer.invoke('accounts:add', name),
  uiLog: (message) => ipcRenderer.send('wa5:ui-log', message),
  platform: process.platform,
  rename: (id, name) => ipcRenderer.invoke('accounts:rename', id, name),
  remove: (id, wipe) => ipcRenderer.invoke('accounts:remove', id, wipe),
  activate: (id) => ipcRenderer.invoke('accounts:activate', id),
  reload: (id) => ipcRenderer.invoke('accounts:reload', id),
  logout: (id) => ipcRenderer.invoke('accounts:logout', id),
  menu: (id) => ipcRenderer.invoke('accounts:menu', id),
  onAccounts: (fn) => ipcRenderer.on('state:accounts', (_e, data) => fn(data)),
  onUnread: (fn) => ipcRenderer.on('state:unread', (_e, data) => fn(data)),
  onLoadState: (fn) => ipcRenderer.on('state:load', (_e, data) => fn(data)),
  activity: () => ipcRenderer.send('wa5:activity'),
  onRenameRequest: (fn) => ipcRenderer.on('ui:rename', (_e, id) => fn(id))
});
