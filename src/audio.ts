export const ROWS = 16

export const SCALES = [
  { name: 'Major', detail: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  { name: 'Minor', detail: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  { name: 'Hirajōshi', detail: 'Hirajōshi, a Japanese koto tuning', steps: [0, 2, 3, 7, 8] },
  { name: 'In', detail: 'In, the Miyako-bushi scale', steps: [0, 1, 5, 7, 8] },
] as const

const ROOT_HZ = 146.83 // D3

/** Semitones above D3 for a row. Row 0 is the top of the grid and the highest pitch. */
export function rowSemis(row: number, scale: readonly number[]) {
  const n = ROWS - 1 - row
  return Math.floor(n / scale.length) * 12 + scale[n % scale.length]
}

export const rowFreq = (row: number, scale: readonly number[]) =>
  ROOT_HZ * 2 ** (rowSemis(row, scale) / 12)

export type Instrument = 'bell' | 'pluck' | 'pad' | 'bass' | 'drums'

export type NoteEvent = {
  section: number
  instrument: Instrument
  row: number
  /** The step inside its section. */
  local: number
  vel: number
}

export type Tick = { step: number; time: number; events: NoteEvent[] }

function impulse(ctx: AudioContext, seconds: number, decay: number) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay
  }
  return buf
}

export class Engine {
  ctx: AudioContext | null = null
  queue: Tick[] = []
  bpm = 108
  scale: readonly number[] = SCALES[0].steps
  /** What to play at a step. */
  source: (step: number) => NoteEvent[] = () => []
  /** How many steps before playback wraps back to the start. */
  length: () => number = () => 16

  private wet: GainNode | null = null
  private dry: GainNode | null = null
  private delay: DelayNode | null = null
  private noise: AudioBuffer | null = null
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
    comp.threshold.value = -14
    comp.ratio.value = 4
    comp.attack.value = 0.004
    comp.release.value = 0.2
    comp.connect(ctx.destination)

    const master = ctx.createGain()
    master.gain.value = 0.85
    master.connect(comp)

    const verb = ctx.createConvolver()
    verb.buffer = impulse(ctx, 2.8, 2.6)
    verb.connect(master)

    // Wet: melodic voices, softened and sent to the echo and the reverb.
    const wetTone = ctx.createBiquadFilter()
    wetTone.type = 'lowpass'
    wetTone.frequency.value = 6000
    wetTone.connect(master)
    const wet = ctx.createGain()
    wet.connect(wetTone)
    const wetVerb = ctx.createGain()
    wetVerb.gain.value = 0.34
    wet.connect(wetVerb).connect(verb)

    const delay = ctx.createDelay(2)
    const feedback = ctx.createGain()
    feedback.gain.value = 0.3
    const damp = ctx.createBiquadFilter()
    damp.type = 'lowpass'
    damp.frequency.value = 2200
    const delaySend = ctx.createGain()
    delaySend.gain.value = 0.18
    wet.connect(delaySend).connect(delay).connect(damp)
    damp.connect(feedback).connect(delay)
    damp.connect(wetTone)

    // Dry: drums and bass, full range, with only a touch of room.
    const dry = ctx.createGain()
    dry.connect(master)
    const dryVerb = ctx.createGain()
    dryVerb.gain.value = 0.07
    dry.connect(dryVerb).connect(verb)

    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const n = noise.getChannelData(0)
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1

    this.ctx = ctx
    this.wet = wet
    this.dry = dry
    this.delay = delay
    this.noise = noise
    this.retime()
    return ctx
  }

  /** Keep the echo locked to a dotted eighth at the current tempo. */
  retime() {
    if (this.delay && this.ctx) {
      this.delay.delayTime.setTargetAtTime(this.stepDur * 3, this.ctx.currentTime, 0.05)
    }
  }

  play(e: NoteEvent, t: number) {
    if (!this.ctx || e.vel < 0.0005) return
    switch (e.instrument) {
      case 'bell':
        return this.bell(e, t)
      case 'pluck':
        return this.pluck(e, t)
      case 'pad':
        return this.pad(e, t)
      case 'bass':
        return this.bass(e, t)
      case 'drums':
        return this.drum(e, t)
    }
  }

  preview(e: NoteEvent) {
    const ctx = this.ensure()
    this.play({ ...e, vel: e.vel * 0.7 }, ctx.currentTime + 0.005)
  }

  start(from = 0) {
    const ctx = this.ensure()
    window.clearInterval(this.timer)
    this.step = from
    this.queue = []
    this.nextTime = ctx.currentTime + 0.06
    this.tick()
    this.timer = window.setInterval(() => this.tick(), 25)
  }

  stop() {
    window.clearInterval(this.timer)
    this.queue = []
  }

  /** Jump while playing. Notes already scheduled in the next few milliseconds still sound. */
  seek(step: number) {
    this.step = step
    this.queue = []
  }

  private tick() {
    const ctx = this.ctx
    if (!ctx) return
    while (this.nextTime < ctx.currentTime + 0.12) {
      if (this.step >= this.length()) this.step = 0
      const events = this.source(this.step)
      for (const e of events) this.play(e, this.nextTime)
      this.queue.push({ step: this.step, time: this.nextTime, events })
      this.nextTime += this.stepDur
      this.step++
    }
  }

  // ---- voices -------------------------------------------------------------

  private out(bus: GainNode | null, pan: number) {
    const ctx = this.ctx!
    const g = ctx.createGain()
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    g.connect(p).connect(bus ?? ctx.destination)
    return { g, p }
  }

  private osc(type: OscillatorType, freq: number) {
    const o = this.ctx!.createOscillator()
    o.type = type
    o.frequency.value = freq
    return o
  }

  private run(nodes: (OscillatorNode | AudioBufferSourceNode)[], t: number, end: number, p: AudioNode) {
    for (const n of nodes) {
      n.start(t)
      n.stop(end)
    }
    nodes[0].onended = () => p.disconnect()
  }

  private sweepPan(e: NoteEvent, width = 1.1) {
    return ((e.local % 16) / 15) * width - width / 2
  }

  /** A struck bell: a sine body, a quick bright overtone and a little triangle warmth. */
  private bell(e: NoteEvent, t: number) {
    const f = rowFreq(e.row, this.scale)
    const dur = 2.1 - (ROWS - 1 - e.row) * 0.07
    const { g, p } = this.out(this.wet, this.sweepPan(e))
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(e.vel, t + 0.006)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)

    const body = this.osc('sine', f)
    body.connect(g)
    const shimmer = this.osc('sine', f * 2.005)
    const sg = this.ctx!.createGain()
    sg.gain.setValueAtTime(0.45, t)
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.32)
    shimmer.connect(sg).connect(g)
    const warmth = this.osc('triangle', f)
    const wg = this.ctx!.createGain()
    wg.gain.value = 0.18
    warmth.connect(wg).connect(g)
    this.run([body, shimmer, warmth], t, t + dur + 0.05, p)
  }

  /** A plucked string: detuned saws through a filter that snaps shut. */
  private pluck(e: NoteEvent, t: number) {
    const ctx = this.ctx!
    const f = rowFreq(e.row, this.scale)
    const { g, p } = this.out(this.wet, this.sweepPan(e, 0.9))
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(e.vel, t + 0.003)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65)

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.Q.value = 4
    lp.frequency.setValueAtTime(Math.min(f * 9, 10000), t)
    lp.frequency.exponentialRampToValueAtTime(Math.max(f * 1.4, 280), t + 0.22)
    lp.connect(g)

    const a = this.osc('sawtooth', f)
    const b = this.osc('sawtooth', f * 1.006)
    const bg = ctx.createGain()
    bg.gain.value = 0.5
    a.connect(lp)
    b.connect(bg).connect(lp)
    this.run([a, b], t, t + 0.7, p)
  }

  /** A slow pad that swells in, holds for six steps and lets go. */
  private pad(e: NoteEvent, t: number) {
    const ctx = this.ctx!
    const f = rowFreq(e.row, this.scale)
    const hold = this.stepDur * 6
    const { g, p } = this.out(this.wet, (Math.random() - 0.5) * 0.5)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(e.vel, t + 0.35)
    g.gain.setValueAtTime(e.vel, t + hold)
    g.gain.exponentialRampToValueAtTime(0.0001, t + hold + 1.4)

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.Q.value = 0.6
    lp.frequency.setValueAtTime(380, t)
    lp.frequency.linearRampToValueAtTime(420 + f * 2.2, t + 0.5)
    lp.connect(g)

    const a = this.osc('sawtooth', f * 0.996)
    const b = this.osc('sawtooth', f * 1.004)
    const sub = this.osc('sine', f / 2)
    const subGain = ctx.createGain()
    subGain.gain.value = 0.4
    a.connect(lp)
    b.connect(lp)
    sub.connect(subGain).connect(g)
    this.run([a, b, sub], t, t + hold + 1.5, p)
  }

  /** An octave-down bass: a filtered saw over a sine for weight. */
  private bass(e: NoteEvent, t: number) {
    const ctx = this.ctx!
    const f = rowFreq(e.row, this.scale) / 2
    const len = Math.min(this.stepDur * 2.5, 0.8)
    const { g, p } = this.out(this.dry, 0)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(e.vel, t + 0.006)
    g.gain.exponentialRampToValueAtTime(e.vel * 0.55, t + 0.12)
    g.gain.exponentialRampToValueAtTime(0.0001, t + len)

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.Q.value = 2
    lp.frequency.setValueAtTime(Math.min(f * 10, 2400), t)
    lp.frequency.exponentialRampToValueAtTime(f * 2.2, t + 0.18)
    lp.connect(g)

    const saw = this.osc('sawtooth', f)
    saw.connect(lp)
    const body = this.osc('sine', f)
    const bodyGain = ctx.createGain()
    bodyGain.gain.value = 0.8
    body.connect(bodyGain).connect(g)
    this.run([saw, body], t, t + len + 0.05, p)
  }

  /** Each row of a drum section is its own instrument, kicks at the bottom. */
  private drum(e: NoteEvent, t: number) {
    const v = e.vel
    switch (ROWS - 1 - e.row) {
      case 0:
        return this.kick(t, v, 0.8)
      case 1:
        return this.kick(t, v, 1)
      case 2:
        return this.kick(t, v, 1.3)
      case 3:
        return this.tom(t, v, 82, -0.3)
      case 4:
        return this.tom(t, v, 117, 0)
      case 5:
        return this.tom(t, v, 165, 0.3)
      case 6:
        return this.snare(t, v)
      case 7:
        return this.rim(t, v)
      case 8:
        return this.clap(t, v)
      case 9:
        return this.hiss(t, v * 0.5, 'bandpass', 6500, 1.2, 0.07, -0.25)
      case 10:
        return this.hiss(t, v * 0.55, 'highpass', 8000, 0.7, 0.05, 0.2)
      case 11:
        return this.hiss(t, v * 0.45, 'highpass', 10000, 0.7, 0.025, 0.25)
      case 12:
        return this.hiss(t, v * 0.42, 'highpass', 7200, 0.7, 0.38, 0.2)
      case 13:
        return this.wood(t, v, 620, -0.2)
      case 14:
        return this.wood(t, v, 940, 0.2)
      default:
        return this.ping(t, v)
    }
  }

  private noiseSource() {
    const src = this.ctx!.createBufferSource()
    src.buffer = this.noise
    return src
  }

  private kick(t: number, v: number, tune: number) {
    const { g, p } = this.out(this.dry, 0)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(v * 1.5, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42)
    const o = this.osc('sine', 160 * tune)
    o.frequency.setValueAtTime(160 * tune, t)
    o.frequency.exponentialRampToValueAtTime(45 * tune, t + 0.13)
    o.connect(g)
    this.run([o], t, t + 0.45, p)
  }

  private tom(t: number, v: number, f: number, pan: number) {
    const { g, p } = this.out(this.dry, pan)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(v, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38)
    const o = this.osc('sine', f * 1.5)
    o.frequency.setValueAtTime(f * 1.5, t)
    o.frequency.exponentialRampToValueAtTime(f, t + 0.2)
    o.connect(g)
    this.run([o], t, t + 0.4, p)
  }

  private hiss(
    t: number,
    v: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    decay: number,
    pan: number,
  ) {
    const ctx = this.ctx!
    const { g, p } = this.out(this.dry, pan)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(v, t + 0.002)
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    f.connect(g)
    const src = this.noiseSource()
    src.connect(f)
    src.start(t, Math.random() * 0.5)
    src.stop(t + decay + 0.05)
    src.onended = () => p.disconnect()
  }

  private snare(t: number, v: number) {
    this.hiss(t, v * 0.8, 'bandpass', 1900, 0.7, 0.18, 0)
    const { g, p } = this.out(this.dry, 0)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(v * 0.5, t + 0.003)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1)
    const o = this.osc('triangle', 185)
    o.connect(g)
    this.run([o], t, t + 0.12, p)
  }

  private rim(t: number, v: number) {
    this.hiss(t, v * 0.35, 'bandpass', 3200, 2, 0.02, 0.1)
    const { g, p } = this.out(this.dry, 0.1)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(v * 0.5, t + 0.001)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03)
    const o = this.osc('triangle', 1650)
    o.connect(g)
    this.run([o], t, t + 0.05, p)
  }

  private clap(t: number, v: number) {
    const ctx = this.ctx!
    const { g, p } = this.out(this.dry, 0)
    g.gain.setValueAtTime(0.0001, t)
    for (const d of [0, 0.011, 0.022]) {
      g.gain.setValueAtTime(v * 0.8, t + d)
      g.gain.exponentialRampToValueAtTime(v * 0.1, t + d + 0.01)
    }
    g.gain.setValueAtTime(v * 0.7, t + 0.033)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = 1150
    f.Q.value = 1.1
    f.connect(g)
    const src = this.noiseSource()
    src.connect(f)
    this.run([src], t, t + 0.25, p)
  }

  private wood(t: number, v: number, f: number, pan: number) {
    const { g, p } = this.out(this.dry, pan)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(v * 0.6, t + 0.001)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08)
    const a = this.osc('triangle', f)
    const b = this.osc('sine', f * 2.7)
    a.connect(g)
    b.connect(g)
    this.run([a, b], t, t + 0.1, p)
  }

  private ping(t: number, v: number) {
    const { g, p } = this.out(this.wet, 0.3)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(v * 0.35, t + 0.002)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6)
    const o = this.osc('sine', 1175)
    o.connect(g)
    this.run([o], t, t + 0.65, p)
  }
}
