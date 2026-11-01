const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('AndroidBridge', {
  printPdf: (name) => ipcRenderer.invoke('print-pdf', name).then((p) => { if (!p) alert('Could not save the PDF.'); }),
  platform: 'desktop'
});
