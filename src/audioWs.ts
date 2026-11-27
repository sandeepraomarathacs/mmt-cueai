/**
 * Live mic → Python /ws/audio as PCM16 mono chunks (low server load vs full-file upload).
 */
export type AudioWsHandlers = {
  onAnswer?: (payload: { answer?: string; final?: boolean }) => void
  onError?: (message: string) => void
  onStatus?: (message: string) => void
}

function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}

function downsample(buffer: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return buffer
  const ratio = fromRate / toRate
  const newLen = Math.round(buffer.length / ratio)
  const result = new Float32Array(newLen)
  for (let i = 0; i < newLen; i++) {
    const idx = Math.floor(i * ratio)
    result[i] = buffer[idx]
  }
  return result
}

export class LiveAudioSocket {
  private ws: WebSocket | null = null
  private stream: MediaStream | null = null
  private audioCtx: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processTimer: number | null = null
  private readonly targetRate = 16000

  constructor(
    private readonly wsUrl: string,
    private readonly meta: { mode: string; language?: string; context?: string },
    private readonly handlers: AudioWsHandlers,
    private readonly processEverySec = 12,
  ) {}

  async start() {
    this.ws = new WebSocket(this.wsUrl)
    this.ws.binaryType = 'arraybuffer'

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error('WS missing'))
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('WebSocket connection failed'))
      setTimeout(() => reject(new Error('WebSocket timeout')), 10000)
    })

    this.ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'answer') {
          this.handlers.onAnswer?.({ answer: msg.answer, final: !!msg.final })
        } else if (msg.type === 'error') {
          this.handlers.onError?.(msg.message || 'WS error')
        } else if (msg.type === 'info' || msg.type === 'ready' || msg.type === 'started') {
          this.handlers.onStatus?.(msg.type)
        }
      } catch {
        // ignore non-json
      }
    }

    this.ws.send(JSON.stringify({
      type: 'start',
      mode: this.meta.mode || 'interview',
      language: this.meta.language || 'English',
      context: this.meta.context || null,
    }))

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    })

    this.audioCtx = new AudioContext()
    this.source = this.audioCtx.createMediaStreamSource(this.stream)
    // ScriptProcessor is deprecated but widely available in Electron without worklet bundling
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1)
    this.processor.onaudioprocess = (e) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      const input = e.inputBuffer.getChannelData(0)
      const resampled = downsample(input, this.audioCtx!.sampleRate, this.targetRate)
      this.ws.send(floatTo16BitPCM(resampled))
    }
    this.source.connect(this.processor)
    this.processor.connect(this.audioCtx.destination)

    this.processTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'process' }))
      }
    }, Math.max(5, this.processEverySec) * 1000)

    this.handlers.onStatus?.('listening')
  }

  async stop(finalProcess = true) {
    if (this.processTimer) {
      clearInterval(this.processTimer)
      this.processTimer = null
    }
    try {
      if (finalProcess && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'stop' }))
      }
    } catch {
      // ignore
    }

    this.processor?.disconnect()
    this.source?.disconnect()
    this.processor = null
    this.source = null

    await this.audioCtx?.close().catch(() => {})
    this.audioCtx = null

    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close()
    }
    this.ws = null
    this.handlers.onStatus?.('stopped')
  }
}
