const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cueaiDesktop', {
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  captureFrame: () => ipcRenderer.invoke('capture-frame'),
  setOpacity: (value) => ipcRenderer.invoke('set-opacity', value),
  getOpacity: () => ipcRenderer.invoke('get-opacity'),
  windowAction: (action) => ipcRenderer.invoke('window-action', action),
  setClickThrough: (enabled) => ipcRenderer.invoke('set-click-through', enabled),
  setContentProtection: (enabled) => ipcRenderer.invoke('set-content-protection', enabled),
  getContentProtection: () => ipcRenderer.invoke('get-content-protection'),
  resizeOverlay: (size) => ipcRenderer.invoke('resize-overlay', size),
  dragStart: (pos) => ipcRenderer.send('drag-start', pos),
  dragMove: (pos) => ipcRenderer.send('drag-move', pos),
  dragEnd: () => ipcRenderer.send('drag-end'),
  onShortcut: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('shortcut', listener)
    return () => ipcRenderer.removeListener('shortcut', listener)
  },
  onOpacity: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('opacity', listener)
    return () => ipcRenderer.removeListener('opacity', listener)
  },
  onClickThrough: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('click-through', listener)
    return () => ipcRenderer.removeListener('click-through', listener)
  },
  onContentProtection: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('content-protection', listener)
    return () => ipcRenderer.removeListener('content-protection', listener)
  },
})
