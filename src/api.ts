const API_URL = import.meta.env.VITE_API_URL || 'https://api.cueai.manmayitech.com/api'

function token(): string | null {
  return localStorage.getItem('token')
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {})
  if (!(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', 'application/json')
  } else {
    headers.set('Accept', 'application/json')
  }
  const t = token()
  if (t) headers.set('Authorization', `Bearer ${t}`)

  const res = await fetch(`${API_URL}${path}`, { ...options, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = data.message || data.email?.[0] || 'Request failed'
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message))
  }
  return data as T
}

export type User = { id: number; name: string; email: string; role: string }
export type Session = {
  id: number
  title: string
  mode: string
  language: string
  source: string
  status: string
  messages?: Message[]
}
export type Message = {
  id: number
  channel: string
  input?: string
  answer?: string
  created_at?: string
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, device_name: 'desktop' }),
    }),
  sessions: () => request<{ data: Session[] }>('/sessions'),
  createSession: (payload: { title: string; mode: string }) =>
    request<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ ...payload, source: 'desktop' }),
    }),
  getSession: (id: number) => request<Session>(`/sessions/${id}`),
  startSession: (id: number) => request<Session>(`/sessions/${id}/start`, { method: 'POST' }),
  endSession: (id: number) => request<Session>(`/sessions/${id}/end`, { method: 'POST' }),
  askText: (id: number, text: string) =>
    request<{ answer: string; message: Message }>(`/sessions/${id}/ask/text`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  askAudio: async (id: number, file: Blob) => {
    const form = new FormData()
    form.append('file', file, 'audio.webm')
    return request<{ answer: string; message: Message }>(`/sessions/${id}/ask/audio`, {
      method: 'POST',
      body: form,
    })
  },
  askScreen: async (id: number, file: Blob, prompt?: string) => {
    const form = new FormData()
    form.append('file', file, 'screen.png')
    if (prompt) form.append('prompt', prompt)
    return request<{ answer: string; message: Message }>(`/sessions/${id}/ask/screen`, {
      method: 'POST',
      body: form,
    })
  },
  askScreens: async (id: number, files: Blob[], prompt?: string) => {
    const form = new FormData()
    files.forEach((file, i) => form.append('files[]', file, `screen-${i}.jpg`))
    if (prompt) form.append('prompt', prompt)
    return request<{ answer: string; message: Message }>(`/sessions/${id}/ask/screen`, {
      method: 'POST',
      body: form,
    })
  },
  realtimeConfig: () =>
    request<{ ws_url: string; chunk_process_seconds: number; sample_rate: number }>('/realtime-config'),
  storeMessage: (id: number, payload: { channel: string; input?: string; answer?: string; model?: string }) =>
    request<Message>(`/sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
}
