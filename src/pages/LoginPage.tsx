import { FormEvent, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { api } from '../api'
import DragRegion from '../components/DragRegion'

export default function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('sandeep@gmail.com')
  const [password, setPassword] = useState('test@1234')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (localStorage.getItem('token')) return <Navigate to="/" replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await api.login(email, password)
      localStorage.setItem('token', res.token)
      localStorage.setItem('user', JSON.stringify(res.user))
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="glass login-card" style={{ padding: '1.25rem' }} onSubmit={onSubmit}>
        <DragRegion style={{ marginBottom: '0.75rem' }}>
          <h1 className="brand">CueAI</h1>
          <p className="muted">Desktop overlay assistant</p>
        </DragRegion>
        {error && <div className="error">{error}</div>}
        <div className="field no-drag">
          <label>Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        </div>
        <div className="field no-drag">
          <label>Password</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
        </div>
        <button className="btn no-drag" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}
