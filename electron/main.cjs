const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
} = require('electron')
const path = require('path')

const isDev = !app.isPackaged
let mainWindow
let tray = null
let clickThrough = false
/** Always exclude from Zoom/Teams/Meet AND browser getDisplayMedia / full-screen share */
let contentProtected = true
let currentOpacity = 0.92
let isQuitting = false
let dragState = null
let protectTimer = null

function applyCaptureExclusion() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // Electron maps this to WDA_EXCLUDEFROMCAPTURE on Win10 2004+
  // so browser "Entire screen" / app screen-share should not show this window.
  try {
    mainWindow.setContentProtection(!!contentProtected)
  } catch (e) {
    console.warn('setContentProtection failed', e)
  }
}

function keepCaptureExclusionAlive() {
  applyCaptureExclusion()
  if (protectTimer) clearInterval(protectTimer)
  // Some capture sessions start later; re-assert affinity while window lives
  protectTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(protectTimer)
      protectTimer = null
      return
    }
    if (contentProtected) applyCaptureExclusion()
  }, 2000)
}

function showOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  applyCaptureExclusion()
  mainWindow.focus()
}

function hideOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.hide()
}

function createTray() {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMElEQVQ4T2NkYGD4z0ABYBzVMKoBAwMjAwMDAwPDf3QAwyigUQMYgQb8Z2Bg+M9Ahv8DAJ0mBBVwH6Y6AAAAAElFTkSuQmCC',
    'base64',
  )
  const icon = nativeImage.createFromBuffer(png)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('CueAI Desktop')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show overlay', click: () => showOverlay() },
      { label: 'Hide overlay', click: () => hideOverlay() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('double-click', () => showOverlay())
}

function createWindow() {
  const display = screen.getPrimaryDisplay()
  const { width: sw } = display.workAreaSize

  mainWindow = new BrowserWindow({
    width: 460,
    height: 520,
    x: sw - 480,
    y: 40,
    minWidth: 320,
    minHeight: 180,
    show: false,
    frame: false,
    // transparent:true breaks WDA_EXCLUDEFROMCAPTURE on many Windows builds
    // (browser full-screen share still shows the overlay). Use opaque + opacity instead.
    transparent: false,
    backgroundColor: '#080f16',
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: true,
    focusable: true,
    title: 'CueAI Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.setOpacity(currentOpacity)

  mainWindow.once('ready-to-show', () => {
    applyCaptureExclusion()
    mainWindow.show()
    keepCaptureExclusionAlive()
  })

  mainWindow.on('show', () => applyCaptureExclusion())
  mainWindow.on('restore', () => applyCaptureExclusion())
  mainWindow.on('focus', () => applyCaptureExclusion())

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      hideOverlay()
    }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5174'
  if (isDev) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function registerShortcuts() {
  const map = {
    'CommandOrControl+Shift+Space': () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (mainWindow.isVisible() && !mainWindow.isMinimized()) hideOverlay()
      else showOverlay()
    },
    'CommandOrControl+Shift+T': () => send('shortcut', { action: 'toggle-toolbar' }),
    'CommandOrControl+Shift+H': () => send('shortcut', { action: 'toggle-history' }),
    'CommandOrControl+Shift+A': () => send('shortcut', { action: 'focus-ask' }),
    'CommandOrControl+Shift+S': () => send('shortcut', { action: 'capture-screen' }),
    'CommandOrControl+Shift+M': () => send('shortcut', { action: 'toggle-mic' }),
    'CommandOrControl+Shift+Up': () => {
      currentOpacity = Math.min(1, +(currentOpacity + 0.05).toFixed(2))
      if (mainWindow) mainWindow.setOpacity(currentOpacity)
      send('opacity', { value: currentOpacity })
    },
    'CommandOrControl+Shift+Down': () => {
      currentOpacity = Math.max(0.25, +(currentOpacity - 0.05).toFixed(2))
      if (mainWindow) mainWindow.setOpacity(currentOpacity)
      send('opacity', { value: currentOpacity })
    },
    'CommandOrControl+Shift+C': () => {
      clickThrough = !clickThrough
      if (mainWindow) {
        mainWindow.setIgnoreMouseEvents(clickThrough, { forward: true })
      }
      send('click-through', { enabled: clickThrough })
    },
    'CommandOrControl+Shift+P': () => {
      contentProtected = !contentProtected
      applyCaptureExclusion()
      send('content-protection', { enabled: contentProtected })
    },
  }

  for (const [accel, handler] of Object.entries(map)) {
    try {
      globalShortcut.register(accel, handler)
    } catch (e) {
      console.warn('Failed shortcut', accel, e)
    }
  }
}

app.whenReady().then(() => {
  createWindow()
  createTray()
  registerShortcuts()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showOverlay()
  })
})

app.on('before-quit', () => {
  isQuitting = true
  if (protectTimer) clearInterval(protectTimer)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit()
})

function frameSignature(image) {
  const tiny = image.resize({ width: 64, height: 36, quality: 'good' })
  const buf = tiny.toBitmap()
  const pixels = Math.min(64 * 36, Math.floor(buf.length / 4))
  const gray = Buffer.alloc(pixels)
  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    gray[i] = Math.round((buf[o + 2] * 3 + buf[o + 1] * 6 + buf[o]) / 10)
  }
  return gray.toString('base64')
}

async function grabDisplayFrame() {
  applyCaptureExclusion()
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const scale = display.scaleFactor || 1
  const srcW = Math.max(1, Math.round(display.size.width * scale))
  const srcH = Math.max(1, Math.round(display.size.height * scale))
  const ratio = Math.min(1, 1600 / srcW)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(1, Math.round(srcW * ratio)),
      height: Math.max(1, Math.round(srcH * ratio)),
    },
  })
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new Error('No screen source')
  return source.thumbnail
}

ipcMain.handle('capture-screen', async () => {
  const image = await grabDisplayFrame()
  return image.toPNG().toString('base64')
})

ipcMain.handle('capture-frame', async () => {
  const image = await grabDisplayFrame()
  return {
    image: image.toJPEG(78).toString('base64'),
    sig: frameSignature(image),
  }
})

ipcMain.handle('set-opacity', (_e, value) => {
  currentOpacity = Math.min(1, Math.max(0.25, Number(value) || 0.92))
  if (mainWindow) mainWindow.setOpacity(currentOpacity)
  applyCaptureExclusion()
  return currentOpacity
})

ipcMain.handle('get-opacity', () => currentOpacity)

ipcMain.handle('window-action', (_e, action) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (action === 'minimize') mainWindow.minimize()
  if (action === 'hide') hideOverlay()
  if (action === 'close') {
    isQuitting = true
    mainWindow.close()
  }
  if (action === 'show') showOverlay()
})

ipcMain.handle('set-click-through', (_e, enabled) => {
  clickThrough = !!enabled
  if (mainWindow) mainWindow.setIgnoreMouseEvents(clickThrough, { forward: true })
  return clickThrough
})

ipcMain.handle('set-content-protection', (_e, enabled) => {
  contentProtected = !!enabled
  applyCaptureExclusion()
  return contentProtected
})

ipcMain.handle('get-content-protection', () => contentProtected)

ipcMain.handle('resize-overlay', (_e, { width, height }) => {
  if (!mainWindow) return
  const [x, y] = mainWindow.getPosition()
  mainWindow.setBounds({ x, y, width: Math.round(width), height: Math.round(height) }, false)
})

ipcMain.on('drag-start', (_event, { screenX, screenY }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const [wx, wy] = mainWindow.getPosition()
  dragState = {
    startMouseX: screenX,
    startMouseY: screenY,
    startWinX: wx,
    startWinY: wy,
  }
})

ipcMain.on('drag-move', (_event, { screenX, screenY }) => {
  if (!mainWindow || mainWindow.isDestroyed() || !dragState) return
  const dx = screenX - dragState.startMouseX
  const dy = screenY - dragState.startMouseY
  mainWindow.setPosition(
    Math.round(dragState.startWinX + dx),
    Math.round(dragState.startWinY + dy),
  )
})

ipcMain.on('drag-end', () => {
  dragState = null
})
