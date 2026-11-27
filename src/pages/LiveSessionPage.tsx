import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, Message, Session } from '../api'
import { LiveAudioSocket } from '../audioWs'
import AnswerMarkdown from '../components/AnswerMarkdown'
import DragRegion from '../components/DragRegion'

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
  const liveAudioRef = useRef<LiveAudioSocket | null>(null)
  const askRef = useRef<HTMLTextAreaElement | null>(null)

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
    // Stop live WebSocket mic stream
    if (recording) {
      setBusy(true)
      try {
        await liveAudioRef.current?.stop(true)
      } finally {
        liveAudioRef.current = null
        setRecording(false)
        setBusy(false)
      }
      return
    }

    try {
      setError('')
      setBusy(true)
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
            void api.storeMessage(sessionId, {
              channel: 'voice',
              input: '[live audio chunk]',
              answer: payload.answer,
            }).then((message) => {
              setMessages((prev) => [message, ...prev])
            }).catch(() => {
              // still show answer even if history save fails
            })
          },
          onError: (message) => setError(message),
        },
        cfg.chunk_process_seconds || 12,
      )
      await socket.start()
      liveAudioRef.current = socket
      setRecording(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Live mic failed')
      await liveAudioRef.current?.stop(false).catch(() => {})
      liveAudioRef.current = null
      setRecording(false)
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
            <div className="muted">{session?.mode} · {busy ? 'processing…' : recording ? 'listening' : 'ready'}</div>
          </div>
          <div className="no-drag" style={{ display: 'flex', gap: 6 }}>
            <button
              className={`icon-btn ${showToolbar ? 'active' : ''}`}
              title="Toolbar (Ctrl+Shift+T)"
              onClick={() => setShowToolbar((v) => !v)}
            >
              ☰
            </button>
            <button
              className={`icon-btn ${showHistory ? 'active' : ''}`}
              title="History (Ctrl+Shift+H)"
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
              title="Hide to tray (Ctrl+Shift+Space)"
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
              {recording ? 'Stop live mic' : 'Live mic (WS)'}
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
              title="Hide from screen share (Ctrl+Shift+P)"
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
              title="Click-through (Ctrl+Shift+C)"
            >
              Click-through
            </button>
            <div className="opacity-row" title="Ctrl+Shift+Up/Down">
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

        {error && <div className="error no-drag">{error}</div>}

        <div className="answer-box no-drag">
          {answer ? (
            <AnswerMarkdown content={answer} />
          ) : (
            <div className="answer muted">Overlay ready. Use shortcuts or open toolbar.</div>
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
          Drag top bar · Space hide · P stealth · T toolbar · H history · M mic · S screen
          {stealth ? ' · stealth ON' : ' · stealth OFF'}
          {clickThrough ? ' · click-through' : ''}
        </DragRegion>
      </div>
    </div>
  )
}
