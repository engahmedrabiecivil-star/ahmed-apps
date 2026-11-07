// Cube Crush Alert for Windows.
// The window shows the same page as the Android app. The page sends its alarm list here,
// and this process rings them from the system tray, with the window closed.
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, clipboard, shell, nativeImage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setAppUserModelId('com.ahmedrabie.cubecrush');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const STATE = () => path.join(app.getPath('userData'), 'alarms.json');
const SOUND = () => path.join(app.getPath('userData'), 'alarm_sound');
let state = { schedule: [], prefs: { ring: 60, vol: 0.9, snooze: 10 }, fired: {}, custom: false, extra: [] };
let win = null, tray = null, alarmWin = null, alarmInfo = null, quitting = false, toldTray = false;

function load() {
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE(), 'utf8'))); } catch (e) {}
  state.extra = state.extra || [];
}
function save() {
  try { fs.writeFileSync(STATE(), JSON.stringify(state)); } catch (e) {}
}

function createWindow(show) {
  win = new BrowserWindow({
    width: 900, height: 900, minWidth: 420, minHeight: 600, show,
    title: 'Cube Crush Alert', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false }
  });
  win.loadFile(path.join(__dirname, 'www', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (/^https?:/.test(url)) { e.preventDefault(); shell.openExternal(url); } });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (!toldTray) {
      toldTray = true;
      new Notification({ title: 'Cube Crush Alert is still running', body: 'Alarms will ring from here. Right-click the icon near the clock to open or quit.', icon: path.join(__dirname, 'icon.png') }).show();
    }
  });
  win.on('show', refreshPage);
  win.on('focus', refreshPage);
}
function refreshPage() {
  if (win) win.webContents.executeJavaScript('window.onNativeResume&&window.onNativeResume()').catch(() => {});
}
function openWindow() {
  if (!win) createWindow(true);
  win.show(); if (win.isMinimized()) win.restore(); win.focus();
}

function soundUrl() {
  const f = SOUND();
  if (state.custom && fs.existsSync(f)) return pathToFileURL(f).href;
  return pathToFileURL(path.join(__dirname, 'siren.wav')).href;
}

function ring(a) {
  alarmInfo = { title: a.title, body: a.body, ring: state.prefs.ring || 60, vol: state.prefs.vol || 0.9, snooze: state.prefs.snooze || 10, sound: soundUrl() };
  if (alarmWin && !alarmWin.isDestroyed()) alarmWin.destroy();
  alarmWin = new BrowserWindow({
    width: 560, height: 640, alwaysOnTop: true, resizable: true, minimizable: false, show: false,
    title: 'Cube Crush Alert', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'alarm-preload.js'), contextIsolation: true, backgroundThrottling: false }
  });
  alarmWin.setAlwaysOnTop(true, 'screen-saver');
  alarmWin.loadFile(path.join(__dirname, 'alarm.html'));
  alarmWin.once('ready-to-show', () => { alarmWin.show(); alarmWin.focus(); alarmWin.flashFrame(true); });
  new Notification({ title: a.title, body: a.body, icon: path.join(__dirname, 'icon.png'), urgency: 'critical' }).show();
}

function check() {
  const now = Date.now();
  const due = state.schedule.concat(state.extra).filter((a) => a.at <= now && a.at > now - 6 * 3600e3 && !state.fired[a.id + '@' + a.at]);
  if (!due.length) return;
  due.forEach((a) => { state.fired[a.id + '@' + a.at] = 1; });
  for (const k of Object.keys(state.fired)) { if (+k.split('@')[1] < now - 7 * 864e5) delete state.fired[k]; }
  state.extra = state.extra.filter((a) => a.at > now);
  save();
  ring(due[due.length - 1]);
}

ipcMain.on('schedule', (e, json) => { try { state.schedule = JSON.parse(json); save(); updateTray(); } catch (err) {} });
ipcMain.on('setPrefs', (e, json) => { try { state.prefs = Object.assign(state.prefs, JSON.parse(json)); save(); } catch (err) {} });
ipcMain.on('setSound', (e, dataUrl) => {
  if (!dataUrl) { state.custom = false; save(); return; }
  try { fs.writeFileSync(SOUND(), Buffer.from(dataUrl.split(',')[1], 'base64')); state.custom = true; } catch (err) { state.custom = false; }
  save();
});
ipcMain.on('testAlarm', (e, title, body) => {
  state.extra.push({ id: 999002, at: Date.now() + 10000, title, body });
  save();
});
ipcMain.on('copy', (e, text) => clipboard.writeText(text));
ipcMain.handle('alarm-info', () => alarmInfo);
ipcMain.on('alarm-dismiss', () => { if (alarmWin && !alarmWin.isDestroyed()) alarmWin.destroy(); });
ipcMain.on('alarm-snooze', () => {
  const mins = state.prefs.snooze || 10;
  state.extra.push({ id: 999001, at: Date.now() + mins * 60e3, title: 'Snoozed · ' + alarmInfo.title, body: alarmInfo.body });
  save();
  if (alarmWin && !alarmWin.isDestroyed()) alarmWin.destroy();
});

function nextAlarmText() {
  const n = state.schedule.concat(state.extra).filter((a) => a.at > Date.now()).sort((a, b) => a.at - b.at)[0];
  if (!n) return 'No crushing scheduled';
  return 'Next alarm: ' + new Date(n.at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function updateTray() {
  if (!tray) return;
  tray.setToolTip('Cube Crush Alert\n' + nextAlarmText());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Cube Crush Alert', click: openWindow },
    { label: nextAlarmText(), enabled: false },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked, args: ['--hidden'] }) },
    { label: 'Quit (alarms stop)', click: () => { quitting = true; app.quit(); } }
  ]));
}

app.on('second-instance', openWindow);
app.whenReady().then(() => {
  load();
  if (!state.startSet) { app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] }); state.startSet = true; save(); }
  const hidden = process.argv.includes('--hidden');
  createWindow(!hidden);
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 }));
  tray.on('click', openWindow);
  updateTray();
  setInterval(() => { check(); updateTray(); }, 15000);
  powerMonitor.on('resume', check);
  check();
});
app.on('window-all-closed', (e) => { /* keep running in the tray */ });
app.on('before-quit', () => { quitting = true; });
