import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: 'SSH Bridger',
    icon,
    // Matches --bg, so a dark theme doesn't flash white while the page loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // A crashed renderer would leave a blank window; the layout is saved, so reloading is cheap.
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) win.webContents.reload()
  })

  // Never open new Electron windows; hand http(s) links to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Never navigate away from the app's own page.
  win.webContents.on('will-navigate', (event, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!(dev && url.startsWith(dev))) event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  return win
}

// Deny all permission requests (camera, geolocation, ...); the app needs none.
app.on('web-contents-created', (_event, contents) => {
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
})

let shutdownConnections: () => Promise<void> = async () => {}

void app.whenReady().then(async () => {
  shutdownConnections = await registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void shutdownConnections()
})

app.on('window-all-closed', () => {
  app.quit()
})
