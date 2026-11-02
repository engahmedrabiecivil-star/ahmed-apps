const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('AndroidBridge', {
  printPdf: (name) => ipcRenderer.invoke('print-pdf', name).then((p) => { if (!p) alert('Could not save the PDF.'); }),
  saveFile: (name, b64, mime, open) => ipcRenderer.invoke('save-file', { name, b64, open }),
  platform: 'desktop'
});
