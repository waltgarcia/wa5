const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ask', {
  init: () => ipcRenderer.invoke('ask:init'),
  answer: (value) => ipcRenderer.send('ask:answer', value)
});
