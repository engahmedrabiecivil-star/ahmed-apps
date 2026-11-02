// Quality Lessons for Windows — opens the online lesson library in its own window.
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

const SITE = 'https://hac-quality-lesson-library.mohamedelbelasy-78.chatgpt.site/';
const HOST = new URL(SITE).host;

const OFFLINE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  `<html dir="rtl"><body style="font-family:Segoe UI,sans-serif;text-align:center;padding-top:30vh;color:#333">
   <h2>مفيش اتصال بالإنترنت</h2><p>اتأكد من الاتصال واضغط إعادة المحاولة</p>
   <button style="font-size:18px;padding:10px 24px" onclick="location.href='${SITE}'">إعادة المحاولة</button></body></html>`);

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    title: 'Quality Lessons',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#f4f8fc',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.loadURL(SITE);
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3) win.loadURL(OFFLINE); });
  // links to other sites open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).host === HOST) { win.loadURL(url); } else { shell.openExternal(url); }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('data:')) return;
    if (new URL(url).host !== HOST) { e.preventDefault(); shell.openExternal(url); }
  });
});

app.on('window-all-closed', () => app.quit());
