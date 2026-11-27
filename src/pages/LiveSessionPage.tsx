import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, Message, Session } from '../api'
import { LiveAudioSocket, TurnState } from '../audioWs'
import AnswerMarkdown from '../components/AnswerMarkdown'
import DragRegion from '../components/DragRegion'

function turnLabel(recording: boolean, busy: boolean, turnState: TurnState | string, turnReason: string) {
  if (busy && !recording) return 'processing…'
  if (!recording) return 'ready'
  if (turnState === 'processing') return 'thinking…'
  if (turnState === 'locked') {
    if (turnReason === 'candidate_window') return 'locked · speak your answer'
    return 'locked · answer ready'
  }
  if (turnState === 'armed') return 'ready for next question'
  if (turnState === 'waiting') return 'waiting…'
  return 'listening · press Answer now after question'
}

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
  const [turnReason, setTurnReason] = useState('')
  const [turnMessage, setTurnMessage] = useState('')
  const liveAudioRef = useRef<LiveAudioSocket | null>(null)
  const askRef = useRef<HTMLTextAreaElement | null>(null)
  const lastSavedAnswerRef = useRef('')

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
        setTurnState('stopped')
        setTurnReason('')
        setTurnMessage('')
        setBusy(false)
      }
      return
    }

    try {
      setError('')
      setBusy(true)
      setTurnState('listening')
      setTurnReason('')
      setTurnMessage('mic on — press Answer now after each question')
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
            // Only replace when server emits a real new answer.
            setAnswer(payload.answer)
            setTurnState(payload.state || 'locked')
            setTurnReason(payload.reason || 'new_answer')
            setTurnMessage('answer ready — speak it, then wait / press Answer now')
            if (payload.answer !== lastSavedAnswerRef.current) {
              lastSavedAnswerRef.current = payload.answer
              void api.storeMessage(sessionId, {
                channel: 'voice',
                input: '[answer_now / utterance]',
                answer: payload.answer,
              }).then((message) => {
                setMessages((prev) => [message, ...prev])
              }).catch(() => {
                // still show answer even if history save fails
              })
            }
          },
          onTurnStatus: (payload) => {
            setTurnState(payload.state)
            setTurnReason(payload.reason || '')
            if (payload.message) setTurnMessage(payload.message)
          },
          onError: (message) => setError(message),
        },
        2.5,
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
        if (liveAudioRef.current) {
          setTurnState('processing')
          setTurnMessage('generating answer…')
          liveAudioRef.current.answerNow()
        }
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
              {session?.mode} · {turnLabel(recording, busy, turnState, turnReason)}
            </div>
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
            {recording && (
              <>
                <button
                  className="chip on"
                  title="Generate answer from recent audio (Ctrl+Shift+G). Mic stays on."
                  onClick={() => {
                    setTurnState('processing')
                    setTurnMessage('generating answer…')
                    liveAudioRef.current?.answerNow()
                  }}
                  disabled={turnState === 'processing'}
                >
                  Answer now
                </button>
                <button
                  className={`chip ${turnState === 'armed' ? 'lock' : ''}`}
                  title="Skip waiting — arm listening for the next question"
                  onClick={() => liveAudioRef.current?.unlock()}
                >
                  Next Q
                </button>
              </>
            )}
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

        {recording && (
          <div className="turn-bar no-drag">
            <span
              className={`turn-pill ${
                turnState === 'locked'
                  ? 'locked'
                  : turnState === 'processing'
                    ? 'busy'
                    : turnState === 'armed'
                      ? 'live'
                      : 'live'
              }`}
            >
              {turnState === 'locked'
                ? 'LOCKED'
                : turnState === 'processing'
                  ? 'THINKING'
                  : turnState === 'armed'
                    ? 'ARMED'
                    : 'LIVE'}
            </span>
            <span className="muted">{turnMessage || turnLabel(true, busy, turnState, turnReason)}</span>
            <button
              className="chip on"
              style={{ marginLeft: 'auto' }}
              title="Ctrl+Shift+G"
              onClick={() => {
                setTurnState('processing')
                setTurnMessage('generating answer…')
                liveAudioRef.current?.answerNow()
              }}
              disabled={turnState === 'processing'}
            >
              Answer now
            </button>
          </div>
        )}

        <div className={`answer-box no-drag ${recording && turnState === 'locked' ? 'answer-locked' : ''}`}>
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
          Drag · Space hide · M mic · G answer now · S screen · T toolbar
          {stealth ? ' · stealth ON' : ' · stealth OFF'}
          {clickThrough ? ' · click-through' : ''}
        </DragRegion>
      </div>
    </div>
  )
}
