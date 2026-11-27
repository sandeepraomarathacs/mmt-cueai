import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, Message, Session } from '../api'
import { LiveAudioSocket, TurnState } from '../audioWs'
import AnswerMarkdown from '../components/AnswerMarkdown'
import DragRegion from '../components/DragRegion'

function statusLabel(recording: boolean, busy: boolean, turnState: TurnState | string, turnMessage: string) {
  if (busy && !recording) return 'processing…'
  if (!recording) return 'ready'
  if (turnState === 'processing') return 'thinking…'
  if (turnState === 'stable') return turnMessage || 'answer ready'
  if (recording) return turnMessage || 'listening…'
  return 'ready'
}

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
  { action: 'Capture screen → AI', win: 'Ctrl + Shift + S', mac: '⌘ + Shift + S' },
  { action: 'Live mic on / off', win: 'Ctrl + Shift + M', mac: '⌘ + Shift + M' },
  { action: 'Refresh answer now', win: 'Ctrl + Shift + G', mac: '⌘ + Shift + G' },
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
  const [showToolbar, setShowToolbar] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showAsk, setShowAsk] = useState(false)
  const [opacity, setOpacity] = useState(0.92)
  const [clickThrough, setClickThrough] = useState(false)
  const [stealth, setStealth] = useState(true)
  const [turnState, setTurnState] = useState<TurnState | string>('listening')
  const [turnMessage, setTurnMessage] = useState('')
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [isMac] = useState(() => detectIsMac())
  const liveAudioRef = useRef<LiveAudioSocket | null>(null)
  const askRef = useRef<HTMLTextAreaElement | null>(null)
  const lastSavedAnswerRef = useRef('')
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

  const captureScreen = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      if (!window.cueaiDesktop?.captureScreen) {
        throw new Error('Desktop capture bridge unavailable')
      }
      const base64 = await window.cueaiDesktop.captureScreen()
      const blob = base64ToBlob(base64)
      const res = await api.askScreen(sessionId, blob)
      setAnswer(res.answer || '')
      setMessages((prev) => [res.message, ...prev])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Screen capture failed')
    } finally {
      setBusy(false)
    }
  }, [sessionId])

  const toggleMic = useCallback(async () => {
    if (recording) {
      setBusy(true)
      try {
        await liveAudioRef.current?.stop(true)
      } finally {
        liveAudioRef.current = null
        setRecording(false)
        setTurnState('stopped')
        setTurnMessage('')
        setBusy(false)
      }
      return
    }

    try {
      setError('')
      setBusy(true)
      setTurnState('listening')
      setTurnMessage('listening…')
      lastSavedAnswerRef.current = ''
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
            setAnswer(payload.answer)
            setTurnState('stable')
            setTurnMessage('answer ready')
            if (payload.answer !== lastSavedAnswerRef.current) {
              lastSavedAnswerRef.current = payload.answer
              void api.storeMessage(sessionId, {
                channel: 'voice',
                input: '[live audio]',
                answer: payload.answer,
              }).then((message) => {
                setMessages((prev) => [message, ...prev])
              }).catch(() => {})
            }
          },
          onTurnStatus: (payload) => {
            setTurnState(payload.state)
            if (payload.message) setTurnMessage(payload.message)
          },
          onError: (message) => setError(message),
        },
        cfg.chunk_process_seconds || 10,
      )
      await socket.start()
      liveAudioRef.current = socket
      setRecording(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Live mic failed')
      await liveAudioRef.current?.stop(false).catch(() => {})
      liveAudioRef.current = null
      setRecording(false)
      setTurnState('stopped')
    } finally {
      setBusy(false)
    }
  }, [recording, session?.mode, sessionId])

  useEffect(() => () => {
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
      if (payload.action === 'capture-screen') void captureScreen()
      if (payload.action === 'toggle-mic') void toggleMic()
      if (payload.action === 'answer-now') {
        // Optional force refresh only — normal use is continuous auto.
        liveAudioRef.current?.refresh()
        setTurnState('processing')
        setTurnMessage('thinking…')
      }
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
  }, [captureScreen, toggleMic])

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
              {session?.mode} · {statusLabel(recording, busy, turnState, turnMessage)}
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
              title={`Hide to tray (${modLabel}+Shift+Space)`}
              onClick={() => void window.cueaiDesktop?.windowAction?.('hide')}
            >
              ▭
            </button>
            <Link className="icon-btn" to="/" title="Sessions">↩</Link>
          </div>
        </DragRegion>

        {showToolbar && (
          <div className="toolbar no-drag">
            <button className={`chip ${recording ? 'on' : ''}`} onClick={() => void toggleMic()} disabled={busy}>
              {recording ? 'Stop mic' : 'Start mic'}
            </button>
            <button className="chip" onClick={() => void captureScreen()} disabled={busy}>Screen</button>
            <button className={`chip ${showAsk ? 'on' : ''}`} onClick={() => setShowAsk((v) => !v)}>Ask</button>
            <button
              className={`chip ${stealth ? 'on' : ''}`}
              onClick={async () => {
                const next = !stealth
                setStealth(next)
                await window.cueaiDesktop?.setContentProtection?.(next)
              }}
              title={`Hide from screen share (${modLabel}+Shift+P)`}
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
              title={`Click-through (${modLabel}+Shift+C)`}
            >
              Click-through
            </button>
            <div className="opacity-row" title={`${modLabel}+Shift+Up/Down`}>
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
                <div className="muted">
                  This device: {isMac ? 'Mac (⌘ Command)' : 'Windows (Ctrl)'}
                </div>
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
              Normal use: Start mic and keep it on. Answers update automatically.
            </div>
          </div>
        )}

        {error && <div className="error no-drag">{error}</div>}

        <div className={`answer-box no-drag ${recording && turnState === 'stable' ? 'answer-locked' : ''}`}>
          {answer ? (
            <AnswerMarkdown content={answer} />
          ) : (
            <div className="answer muted">
              {recording
                ? 'Listening… ask your question, answer will appear here.'
                : <>Ready. Start mic from toolbar ({modLabel}+Shift+M), or press <button className="linkish" type="button" onClick={() => setShowShortcuts(true)}>?</button> for shortcuts.</>}
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
                  if (!busy && text.trim()) {
                    e.currentTarget.form?.requestSubmit()
                  }
                }
              }}
              placeholder="Type a question… (Enter to send, Shift+Enter for new line)"
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
          {recording ? 'Mic on · answers auto-update after a short stable hold' : `${modLabel}+Shift+M mic · ? shortcuts · T toolbar`}
          {stealth ? ' · stealth ON' : ''}
        </DragRegion>
      </div>
    </div>
  )
}
