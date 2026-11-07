// The app page already knows how to talk to the Android app through `window.Android`.
// This gives it the same bridge on Windows, so alarms live in the main process and
// ring with the window closed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('Android', {
  platform: 'windows',
  schedule: (json) => ipcRenderer.send('schedule', json),
  setPrefs: (json) => ipcRenderer.send('setPrefs', json),
  setSound: (dataUrl) => ipcRenderer.send('setSound', dataUrl),
  testAlarm: (title, body) => ipcRenderer.send('testAlarm', title, body),
  copy: (text) => ipcRenderer.send('copy', text),
  permissions: () => '{"notif":true,"exact":true,"full":true,"battery":true}',
  fix: () => {}
});
