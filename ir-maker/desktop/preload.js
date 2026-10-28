const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('AndroidBridge', {
  saveFile: (name, b64, mime, open) => ipcRenderer.sendSync('save-file', { name, b64, open }),
  openFolder: () => ipcRenderer.send('open-folder'),
  platform: 'desktop'
});
