import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, Message, Session } from '../api'
import { LiveAudioSocket } from '../audioWs'
import AnswerMarkdown from '../components/AnswerMarkdown'
import DragRegion from '../components/DragRegion'

function detectIsMac() {
  const ua = navigator.userAgent || ''
  const platform = navigator.platform || ''
  return /Mac|iPhone|iPad|iPod/i.test(ua) || /Mac/i.test(platform)
}

type ShortcutRow = { action: string; win: string; mac: string }

const SHORTCUTS: ShortcutRow[] = [
  { action: 'Show / hide overlay', win: 'Ctrl + Shift + Space', mac: '⌘ + Shift + Space' },
  { action: 'Toggle toolbar', win: 'Ctrl + Shift + T', mac: '⌘ + Shift + T' },
  { action: 'Toggle history', win: 'Ctrl + Shift + H', mac: '⌘ + Shift + H' },
  { action: 'Open ask box', win: 'Ctrl + Shift + A', mac: '⌘ + Shift + A' },
  { action: 'Screen start / stop (same key)', win: 'Ctrl + Shift + S', mac: '⌘ + Shift + S' },
  { action: 'Mic start / stop (same key)', win: 'Ctrl + Shift + M', mac: '⌘ + Shift + M' },
  { action: 'Opacity up', win: 'Ctrl + Shift + ↑', mac: '⌘ + Shift + ↑' },
  { action: 'Opacity down', win: 'Ctrl + Shift + ↓', mac: '⌘ + Shift + ↓' },
  { action: 'Click-through on / off', win: 'Ctrl + Shift + C', mac: '⌘ + Shift + C' },
  { action: 'Stealth (hide from screen share)', win: 'Ctrl + Shift + P', mac: '⌘ + Shift + P' },
]

function base64ToBlob(base64: string, mime = 'image/png'): Blob {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

type ScreenShot = { image: string; sig: string }

function sigDistance(a: string, b: string): number {
  let x = ''
  let y = ''
  try {
    x = atob(a)
    y = atob(b)
  } catch {
    return 1
  }
  const n = Math.min(x.length, y.length)
  if (!n) return 1
  let diff = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(x.charCodeAt(i) - y.charCodeAt(i)) > 18) diff++
  }
  return diff / n
}

function rememberShot(shots: ScreenShot[], shot: ScreenShot, max = 8) {
  if (shots.length > 0 && sigDistance(shots[shots.length - 1].sig, shot.sig) < 0.06) return
  shots.push(shot)
  while (shots.length > max) {
    let drop = 1
    let best = Infinity
    for (let i = 1; i < shots.length - 1; i++) {
      const d = sigDistance(shots[i - 1].sig, shots[i].sig)
      if (d < best) {
        best = d
        drop = i
      }
    }
    shots.splice(drop, 1)
  }
}

export default function LiveSessionPage() {
  const { id } = useParams()
  const sessionId = Number(id)
  const [session, setSession] = useState<Session | null>(null)
  const [text, setText] = useState('')
  const [answer, setAnswer] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recording, setRecording] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [screenFrames, setScreenFrames] = useState(0)
  const [statusText, setStatusText] = useState('ready')
  const [showToolbar, setShowToolbar] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showAsk, setShowAsk] = useState(false)
  const [opacity, setOpacity] = useState(0.92)
  const [clickThrough, setClickThrough] = useState(false)
  const [stealth, setStealth] = useState(true)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [isMac] = useState(() => detectIsMac())
  const liveAudioRef = useRef<LiveAudioSocket | null>(null)
  const askRef = useRef<HTMLTextAreaElement | null>(null)
  const lastSavedAnswerRef = useRef('')
  const shotsRef = useRef<ScreenShot[]>([])
  const captureTokenRef = useRef(0)
  const captureTimerRef = useRef<number | null>(null)
  const captureInflightRef = useRef<Promise<void> | null>(null)
  const modLabel = isMac ? '⌘' : 'Ctrl'

  async function load() {
    const s = await api.getSession(sessionId)
    setSession(s)
    setMessages(s.messages || [])
    if (s.status === 'ready') await api.startSession(sessionId)
  }

  useEffect(() => {
    load().catch((e) => setError(e.message))
  }, [sessionId])

  useEffect(() => {
    void window.cueaiDesktop?.getOpacity?.()
      ?.then((v) => setOpacity(v))
      .catch(() => {})
    void window.cueaiDesktop?.getContentProtection?.()
      ?.then((v) => setStealth(v))
      .catch(() => {})
  }, [])

  const grabFrame = useCallback(async () => {
    if (!window.cueaiDesktop?.captureFrame) {
      throw new Error('Restart the desktop app so screen capture can collect multiple frames.')
    }
    const frame = await window.cueaiDesktop.captureFrame()
    if (!frame?.image) return
    rememberShot(shotsRef.current, frame)
    setScreenFrames(shotsRef.current.length)
  }, [])

  const toggleScreen = useCallback(async () => {
    if (capturing) {
      captureTokenRef.current += 1
      if (captureTimerRef.current != null) {
        window.clearTimeout(captureTimerRef.current)
        captureTimerRef.current = null
      }
      if (captureInflightRef.current) await captureInflightRef.current
      const shots = shotsRef.current.splice(0)
      setCapturing(false)
      setScreenFrames(0)
      if (!shots.length) {
        setError('No screen captured')
        setStatusText(recording ? 'recording…' : 'ready')
        return
      }
      setBusy(true)
      setError('')
      setStatusText('thinking…')
      try {
        const blobs = shots.map((shot) => base64ToBlob(shot.image, 'image/jpeg'))
        const res = await api.askScreens(sessionId, blobs)
        setAnswer(res.answer || '')
        setMessages((prev) => [res.message, ...prev])
        setStatusText(recording ? 'recording…' : 'answer ready')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Screen capture failed')
        setStatusText(recording ? 'recording…' : 'ready')
      } finally {
        setBusy(false)
      }
      return
    }

    if (!window.cueaiDesktop?.captureFrame) {
      setError('Restart the desktop app so screen capture can collect multiple frames.')
      return
    }

    shotsRef.current = []
    setScreenFrames(0)
    setError('')
    setCapturing(true)
    setStatusText('capturing screen…')
    const token = captureTokenRef.current

    const tick = async () => {
      if (captureTokenRef.current !== token) return
      const job = grabFrame().catch((err) => {
        setError(err instanceof Error ? err.message : 'Screen grab failed')
      })
      captureInflightRef.current = job
      await job
      if (captureInflightRef.current === job) captureInflightRef.current = null
      if (captureTokenRef.current !== token) return
      captureTimerRef.current = window.setTimeout(() => {
        void tick()
      }, 800)
    }
    void tick()
  }, [capturing, grabFrame, recording, sessionId])

  const toggleMic = useCallback(async () => {
    // STOP -> answer from this recording (answer stays on screen)
    if (recording) {
      setBusy(true)
      setStatusText('thinking…')
      try {
        await liveAudioRef.current?.stop(true)
      } finally {
        liveAudioRef.current = null
        setRecording(false)
        setBusy(false)
        setStatusText((prev) => (prev === 'thinking…' ? 'ready' : prev))
      }
      return
    }

    // START -> record only
    try {
      setError('')
      setBusy(true)
      setStatusText('recording…')
      const cfg = await api.realtimeConfig()
      const socket = new LiveAudioSocket(
        cfg.ws_url,
        {
          mode: session?.mode || 'interview',
          language: 'English',
        },
        {
          onAnswer: (payload) => {
            if (!payload.answer) return
            // Replace only when a new stop-answer arrives. Never clear on stop.
            setAnswer(payload.answer)
            setStatusText('answer ready')
            if (payload.answer !== lastSavedAnswerRef.current) {
              lastSavedAnswerRef.current = payload.answer
              void api.storeMessage(sessionId, {
                channel: 'voice',
                input: '[mic segment]',
                answer: payload.answer,
              }).then((message) => {
                setMessages((prev) => [message, ...prev])
              }).catch(() => {})
            }
          },
          onTurnStatus: (payload) => {
            if (payload.message) setStatusText(payload.message)
            else if (payload.state === 'processing') setStatusText('thinking…')
            else if (payload.state === 'recording') setStatusText('recording…')
          },
          onError: (message) => setError(message),
        },
      )
      await socket.start()
      liveAudioRef.current = socket
      setRecording(true)
      setStatusText('recording…')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Mic failed')
      await liveAudioRef.current?.stop(false).catch(() => {})
      liveAudioRef.current = null
      setRecording(false)
      setStatusText('ready')
    } finally {
      setBusy(false)
    }
  }, [recording, session?.mode, sessionId])

  useEffect(() => () => {
    captureTokenRef.current += 1
    if (captureTimerRef.current != null) window.clearTimeout(captureTimerRef.current)
    void liveAudioRef.current?.stop(false)
  }, [])

  useEffect(() => {
    const desktop = window.cueaiDesktop
    if (!desktop) return

    const offShortcut = desktop.onShortcut((payload) => {
      if (payload.action === 'toggle-toolbar') setShowToolbar((v) => !v)
      if (payload.action === 'toggle-history') setShowHistory((v) => !v)
      if (payload.action === 'focus-ask') {
        setShowAsk(true)
        setShowToolbar(true)
        setTimeout(() => askRef.current?.focus(), 50)
      }
      if (payload.action === 'capture-screen') void toggleScreen()
      if (payload.action === 'toggle-mic') void toggleMic()
    })
    const offOpacity = desktop.onOpacity((payload) => setOpacity(payload.value))
    const offClick = desktop.onClickThrough((payload) => setClickThrough(payload.enabled))
    const offStealth = desktop.onContentProtection?.((payload) => setStealth(payload.enabled))

    return () => {
      offShortcut()
      offOpacity()
      offClick()
      offStealth?.()
    }
  }, [toggleScreen, toggleMic])

  async function askText(e: FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    setError('')
    try {
      const res = await api.askText(sessionId, text)
      setAnswer(res.answer || '')
      setMessages((prev) => [res.message, ...prev])
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ask failed')
    } finally {
      setBusy(false)
    }
  }

  async function onOpacityChange(value: number) {
    setOpacity(value)
    await window.cueaiDesktop?.setOpacity?.(value)
  }

  return (
    <div className="overlay-shell">
      <div className="glass" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
        <DragRegion className="titlebar">
          <div style={{ minWidth: 0 }}>
            <h1>{session?.title || 'Live session'}</h1>
            <div className="muted">
              {session?.mode} · {capturing ? `capturing screen… ${screenFrames}` : busy && !recording ? 'working…' : statusText}
            </div>
          </div>
          <div className="no-drag" style={{ display: 'flex', gap: 6 }}>
            <button
              className={`icon-btn ${showToolbar ? 'active' : ''}`}
              title={`Toolbar (${modLabel}+Shift+T)`}
              onClick={() => setShowToolbar((v) => !v)}
            >
              ☰
            </button>
            <button
              className={`icon-btn ${showShortcuts ? 'active' : ''}`}
              title="Keyboard shortcuts"
              onClick={() => setShowShortcuts((v) => !v)}
            >
              ?
            </button>
            <button
              className={`icon-btn ${showHistory ? 'active' : ''}`}
              title={`History (${modLabel}+Shift+H)`}
              onClick={() => setShowHistory((v) => !v)}
            >
              H
            </button>
            <button
              className="icon-btn"
              title="Minimize to taskbar"
              onClick={() => void window.cueaiDesktop?.windowAction?.('minimize')}
            >
              –
            </button>
            <button
              className="icon-btn"
              title={`Hide (${modLabel}+Shift+Space)`}
              onClick={() => void window.cueaiDesktop?.windowAction?.('hide')}
            >
              ▭
            </button>
            <Link className="icon-btn" to="/" title="Sessions">↩</Link>
          </div>
        </DragRegion>

        {showToolbar && (
          <div className="toolbar no-drag">
            <button
              className={`chip ${recording ? 'on' : ''}`}
              onClick={() => void toggleMic()}
              disabled={busy && !recording}
              title={`${modLabel}+Shift+M`}
            >
              {recording ? 'Stop mic → answer' : 'Start mic'}
            </button>
            <button
              className={`chip ${capturing ? 'on' : ''}`}
              onClick={() => void toggleScreen()}
              disabled={busy && !capturing}
              title={`${modLabel}+Shift+S`}
            >
              {capturing ? `Stop screen → answer (${screenFrames})` : 'Start screen'}
            </button>
            <button className={`chip ${showAsk ? 'on' : ''}`} onClick={() => setShowAsk((v) => !v)}>Ask</button>
            <button
              className={`chip ${stealth ? 'on' : ''}`}
              onClick={async () => {
                const next = !stealth
                setStealth(next)
                await window.cueaiDesktop?.setContentProtection?.(next)
              }}
            >
              {stealth ? 'Stealth ON' : 'Stealth OFF'}
            </button>
            <button
              className={`chip ${clickThrough ? 'on' : ''}`}
              onClick={async () => {
                const next = !clickThrough
                setClickThrough(next)
                await window.cueaiDesktop?.setClickThrough?.(next)
              }}
            >
              Click-through
            </button>
            <div className="opacity-row">
              <span className="muted">Opacity</span>
              <input
                type="range"
                min={0.25}
                max={1}
                step={0.05}
                value={opacity}
                onChange={(e) => void onOpacityChange(Number(e.target.value))}
              />
              <span className="muted">{Math.round(opacity * 100)}%</span>
            </div>
            <button className="chip danger" onClick={() => api.endSession(sessionId).then(load)}>End</button>
          </div>
        )}

        {showShortcuts && (
          <div className="shortcuts-panel no-drag">
            <div className="shortcuts-head">
              <div>
                <strong>Keyboard shortcuts</strong>
                <div className="muted">This device: {isMac ? 'Mac (⌘)' : 'Windows (Ctrl)'}</div>
              </div>
              <button className="chip" onClick={() => setShowShortcuts(false)}>Close</button>
            </div>
            <div className="shortcuts-table">
              <div className="shortcuts-row shortcuts-row-head">
                <span>Action</span>
                <span>Windows</span>
                <span>Mac</span>
              </div>
              {SHORTCUTS.map((row) => (
                <div key={row.action} className="shortcuts-row">
                  <span>{row.action}</span>
                  <kbd className={!isMac ? 'kbd-active' : ''}>{row.win}</kbd>
                  <kbd className={isMac ? 'kbd-active' : ''}>{row.mac}</kbd>
                </div>
              ))}
            </div>
            <div className="muted" style={{ marginTop: 8 }}>
              Flow: Start mic → talk → Stop mic → answer stays.
              <br />
              Screen: Start screen → scroll or open other windows → Stop screen → one answer.
            </div>
          </div>
        )}

        {error && <div className="error no-drag">{error}</div>}

        <div className="answer-box no-drag">
          {answer ? (
            <AnswerMarkdown content={answer} />
          ) : (
            <div className="answer muted">
              {capturing
                ? `Capturing… ${screenFrames} frame${screenFrames === 1 ? '' : 's'}. Scroll or open other windows, then press Stop screen (${modLabel}+Shift+S).`
                : recording
                ? 'Recording… press Stop mic (same key) when the question/segment is done.'
                : <>Ready. Mic {modLabel}+Shift+M. Screen {modLabel}+Shift+S — start, scroll or switch windows, press the same key to stop. <button className="linkish" type="button" onClick={() => setShowShortcuts(true)}>?</button></>}
            </div>
          )}
        </div>

        {showAsk && (
          <form className="ask-row no-drag" onSubmit={askText}>
            <textarea
              ref={askRef}
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (!busy && text.trim()) e.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder="Type a question… (Enter to send)"
            />
            <button className="btn" disabled={busy}>{busy ? '…' : 'Ask'}</button>
          </form>
        )}

        {showHistory && (
          <div className="history-panel no-drag">
            <div className="muted" style={{ marginBottom: 4 }}>History</div>
            {messages.length === 0 && <div className="muted">No messages yet</div>}
            {messages.map((m) => (
              <div key={m.id} className="history-item">
                <span className="badge">{m.channel}</span>
                {m.answer ? (
                  <AnswerMarkdown content={m.answer} className="history-answer" />
                ) : (
                  <p className="muted" style={{ margin: '0.35rem 0 0' }}>No answer</p>
                )}
              </div>
            ))}
          </div>
        )}

        <DragRegion className="hint-bar">
          {capturing
            ? `${modLabel}+Shift+S stop → answer (${screenFrames})`
            : recording
              ? `${modLabel}+Shift+M stop → answer`
              : `${modLabel}+Shift+M mic · ${modLabel}+Shift+S screen · same key stops`}
          {stealth ? ' · stealth ON' : ''}
        </DragRegion>
      </div>
    </div>
  )
}
