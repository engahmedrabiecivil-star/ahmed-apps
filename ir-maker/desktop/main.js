// IR Maker for Windows — the same app as the Android version, in a desktop window.
// Files are saved in Documents\IR Maker; the IR form opens in Word for printing.
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

function outDir() {
  const dir = path.join(app.getPath('documents'), 'IR Maker');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_');
}

// Same interface the Android app uses: saveFile(name, base64, mime, open) -> saved path
ipcMain.on('save-file', (event, { name, b64, open }) => {
  const dir = outDir();
  const base = safeName(name);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const data = Buffer.from(b64, 'base64');
  let target = path.join(dir, base);
  for (let i = 1; i <= 50; i++) {
    try {
      fs.writeFileSync(target, data);
      if (open) shell.openPath(target);
      event.returnValue = target;
      return;
    } catch (err) {
      // the file is open in Excel/Word: save next to it with a number instead
      target = path.join(dir, `${stem} (${i})${ext}`);
    }
  }
  event.returnValue = '';
});

ipcMain.on('open-folder', () => { shell.openPath(outDir()); });

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 900,
    height: 1000,
    minWidth: 420,
    title: 'IR Maker',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#f4f8fc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});

app.on('window-all-closed', () => app.quit());
