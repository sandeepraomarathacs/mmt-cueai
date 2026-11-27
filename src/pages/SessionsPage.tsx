import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, Session } from '../api'
import DragRegion from '../components/DragRegion'

export default function SessionsPage() {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<Session[]>([])
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState('interview')
  const [error, setError] = useState('')
  const user = JSON.parse(localStorage.getItem('user') || '{}')

  async function load() {
    try {
      const res = await api.sessions()
      setSessions(res.data || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    }
  }

  useEffect(() => { load() }, [])

  async function createSession(e: FormEvent) {
    e.preventDefault()
    const session = await api.createSession({ title, mode })
    navigate(`/sessions/${session.id}`)
  }

  function logout() {
    localStorage.clear()
    navigate('/login')
  }

  return (
    <div className="overlay-shell">
      <div className="glass" style={{ padding: '0.75rem', overflow: 'auto' }}>
        <DragRegion className="titlebar" style={{ padding: '4px 2px 10px' }}>
          <div>
            <h1 className="brand" style={{ fontSize: '1.5rem' }}>CueAI</h1>
            <p className="muted" style={{ margin: 0 }}>{user.name || 'User'} · desktop overlay</p>
          </div>
          <div className="no-drag" style={{ display: 'flex', gap: 6 }}>
            <button className="icon-btn" title="Minimize" onClick={() => void window.cueaiDesktop?.windowAction?.('minimize')}>–</button>
            <button className="icon-btn" title="Hide to tray" onClick={() => void window.cueaiDesktop?.windowAction?.('hide')}>▭</button>
            <button className="btn secondary" onClick={logout}>Logout</button>
          </div>
        </DragRegion>

        <form className="panel no-drag" style={{ marginBottom: '0.75rem' }} onSubmit={createSession}>
          <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Start overlay session</h2>
          {error && <div className="error">{error}</div>}
          <div className="field">
            <label>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="Interview / Call name" />
          </div>
          <div className="field">
            <label>Mode</label>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="interview">Interview</option>
              <option value="sales">Sales</option>
              <option value="meeting">Meeting</option>
              <option value="regular">Regular</option>
            </select>
          </div>
          <button className="btn">Open as tool</button>
        </form>

        <div className="grid no-drag">
          {sessions.map((s) => (
            <Link key={s.id} to={`/sessions/${s.id}`} className="session-row">
              <div>
                <strong>{s.title}</strong>
                <div className="muted">{s.mode} · {s.status}</div>
              </div>
              <span className="badge">{s.source}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
