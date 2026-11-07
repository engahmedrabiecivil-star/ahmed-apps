const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('alarm', {
  info: () => ipcRenderer.invoke('alarm-info'),
  snooze: () => ipcRenderer.send('alarm-snooze'),
  dismiss: () => ipcRenderer.send('alarm-dismiss')
});
