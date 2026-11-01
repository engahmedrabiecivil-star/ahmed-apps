// Concrete SPC for Windows — the same app as the Android version, in a desktop window.
// "Save report as PDF" writes an A4 PDF to Documents\Concrete SPC and opens it.
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let win;
function outDir() {
  const dir = path.join(app.getPath('documents'), 'Concrete SPC');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('print-pdf', async (event, name) => {
  const base = String(name || 'Concrete SPC report').replace(/[\\/:*?"<>|]/g, '_');
  const data = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
  let target = path.join(outDir(), base + '.pdf');
  for (let i = 1; i <= 50; i++) {
    try { fs.writeFileSync(target, data); shell.openPath(target); return target; }
    catch (e) { target = path.join(outDir(), `${base} (${i}).pdf`); } // the PDF is open in a viewer
  }
  return '';
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1180, height: 950, minWidth: 420,
    title: 'Concrete SPC',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#eef1f0',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});

app.on('window-all-closed', () => app.quit());
