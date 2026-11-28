/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface CueaiDesktop {
  captureScreen: () => Promise<string>
  captureFrame: () => Promise<{ image: string; sig: string }>
  setOpacity: (value: number) => Promise<number>
  getOpacity: () => Promise<number>
  windowAction: (action: 'minimize' | 'hide' | 'close' | 'show') => Promise<void>
  setClickThrough: (enabled: boolean) => Promise<boolean>
  setContentProtection: (enabled: boolean) => Promise<boolean>
  getContentProtection: () => Promise<boolean>
  resizeOverlay: (size: { width: number; height: number }) => Promise<void>
  dragStart: (pos: { screenX: number; screenY: number }) => void
  dragMove: (pos: { screenX: number; screenY: number }) => void
  dragEnd: () => void
  onShortcut: (cb: (payload: { action: string }) => void) => () => void
  onOpacity: (cb: (payload: { value: number }) => void) => () => void
  onClickThrough: (cb: (payload: { enabled: boolean }) => void) => () => void
  onContentProtection: (cb: (payload: { enabled: boolean }) => void) => () => void
}

interface Window {
  cueaiDesktop?: CueaiDesktop
}
