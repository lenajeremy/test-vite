export const ROWS = 16
export const COLS = 16

export const SCALES = [
  { name: 'Major', detail: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  { name: 'Minor', detail: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  { name: 'Hirajōshi', detail: 'Hirajōshi, a Japanese koto tuning', steps: [0, 2, 3, 7, 8] },
  { name: 'In', detail: 'In, the Miyako-bushi scale', steps: [0, 1, 5, 7, 8] },
] as const

const ROOT_HZ = 146.83 // D3

/** Row 0 is the top of the grid and the highest pitch. */
export function rowFreq(row: number, scale: readonly number[]) {
  const n = ROWS - 1 - row
  const octave = Math.floor(n / scale.length)
  const semis = octave * 12 + scale[n % scale.length]
  return ROOT_HZ * 2 ** (semis / 12)
}

export type Tick = { step: number; time: number; rows: number[] }

function impulse(ctx: AudioContext, seconds: number, decay: number) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay
    }
  }
  return buf
}

export class Engine {
  ctx: AudioContext | null = null
  queue: Tick[] = []
  bpm = 108
  scale: readonly number[] = SCALES[0].steps
  getColumn: (step: number) => number[] = () => []

  private bus: GainNode | null = null
  private delay: DelayNode | null = null
  private timer = 0
  private nextTime = 0
  private step = 0

  get stepDur() {
    return 60 / this.bpm / 2
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return this.ctx
    }
    const ctx = new AudioContext()

    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -16
    comp.ratio.value = 4
    comp.connect(ctx.destination)

    const tone = ctx.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = 5200
    tone.connect(comp)

    const bus = ctx.createGain()
    bus.connect(tone)

    const verb = ctx.createConvolver()
    verb.buffer = impulse(ctx, 2.8, 2.6)
    const verbSend = ctx.createGain()
    verbSend.gain.value = 0.34
    bus.connect(verbSend).connect(verb).connect(tone)

    const delay = ctx.createDelay(2)
    const feedback = ctx.createGain()
    feedback.gain.value = 0.3
    const damp = ctx.createBiquadFilter()
    damp.type = 'lowpass'
    damp.frequency.value = 2200
    const delaySend = ctx.createGain()
    delaySend.gain.value = 0.2
    bus.connect(delaySend).connect(delay).connect(damp)
    damp.connect(feedback).connect(delay)
    damp.connect(tone)

    this.ctx = ctx
    this.bus = bus
    this.delay = delay
    this.retime()
    return ctx
  }

  /** Keep the echo locked to a dotted-eighth of the current tempo. */
  retime() {
    if (this.delay && this.ctx) {
      this.delay.delayTime.setTargetAtTime(this.stepDur * 3, this.ctx.currentTime, 0.05)
    }
  }

  note(row: number, col: number, time: number, vel: number) {
    const ctx = this.ctx
    if (!ctx || !this.bus) return
    const f = rowFreq(row, this.scale)
    const n = ROWS - 1 - row
    const dur = 2.1 - n * 0.07

    const out = ctx.createGain()
    out.gain.setValueAtTime(0.0001, time)
    out.gain.exponentialRampToValueAtTime(vel, time + 0.006)
    out.gain.exponentialRampToValueAtTime(0.0001, time + dur)

    const pan = ctx.createStereoPanner()
    pan.pan.value = (col / (COLS - 1)) * 1.1 - 0.55
    out.connect(pan).connect(this.bus)

    const body = ctx.createOscillator()
    body.type = 'sine'
    body.frequency.value = f
    body.connect(out)

    // A bright overtone that dies quickly gives the attack a struck, bell-like edge.
    const shimmer = ctx.createOscillator()
    shimmer.type = 'sine'
    shimmer.frequency.value = f * 2.005
    const shimmerGain = ctx.createGain()
    shimmerGain.gain.setValueAtTime(0.45, time)
    shimmerGain.gain.exponentialRampToValueAtTime(0.001, time + 0.32)
    shimmer.connect(shimmerGain).connect(out)

    const warmth = ctx.createOscillator()
    warmth.type = 'triangle'
    warmth.frequency.value = f
    const warmthGain = ctx.createGain()
    warmthGain.gain.value = 0.18
    warmth.connect(warmthGain).connect(out)

    for (const osc of [body, shimmer, warmth]) {
      osc.start(time)
      osc.stop(time + dur + 0.05)
    }
    body.onended = () => pan.disconnect()
  }

  preview(row: number, col: number) {
    const ctx = this.ensure()
    this.note(row, col, ctx.currentTime + 0.005, 0.2)
  }

  start() {
    const ctx = this.ensure()
    this.step = 0
    this.queue = []
    this.nextTime = ctx.currentTime + 0.06
    this.tick()
    this.timer = window.setInterval(() => this.tick(), 25)
  }

  stop() {
    window.clearInterval(this.timer)
    this.queue = []
  }

  private tick() {
    const ctx = this.ctx
    if (!ctx) return
    while (this.nextTime < ctx.currentTime + 0.12) {
      const rows = this.getColumn(this.step)
      const vel = rows.length ? 0.32 / Math.sqrt(rows.length) : 0
      for (const r of rows) this.note(r, this.step, this.nextTime, vel)
      this.queue.push({ step: this.step, time: this.nextTime, rows })
      this.nextTime += this.stepDur
      this.step = (this.step + 1) % COLS
    }
  }
}
