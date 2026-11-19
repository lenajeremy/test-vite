import { ROWS, SCALES, rowSemis } from './audio'
import type { Instrument, NoteEvent } from './audio'

export const INSTRUMENTS: { id: Instrument; name: string }[] = [
  { id: 'bell', name: 'Bell' },
  { id: 'pluck', name: 'Pluck' },
  { id: 'pad', name: 'Pad' },
  { id: 'bass', name: 'Bass' },
  { id: 'drums', name: 'Drums' },
]

/** Section lengths in steps. A step is an eighth note, so 8 steps make a bar. */
export const LENGTHS = [16, 32, 64] as const
export type Length = (typeof LENGTHS)[number]
export const STEPS_PER_BAR = 8

/** The song timeline is cut into slots of two bars. */
export const SLOT_STEPS = 16
export const SLOTS = 32
export const LANES = 4
export const MAX_SECTIONS = 8
export const MIN_BPM = 60
export const MAX_BPM = 180

export type Section = {
  /** 0 to 7. Also picks the section's colour. */
  id: number
  name: string
  instrument: Instrument
  steps: Length
  /** ROWS × steps, row-major. */
  notes: boolean[]
  volume: number
  muted: boolean
}

export type Placement = { lane: number; slot: number; section: number }
export type Span = Placement & { span: number }

export type Song = {
  bpm: number
  scale: number
  sections: Section[]
  placements: Placement[]
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const pitchRow = (pitch: number) => ROWS - 1 - pitch
const rand = (n: number) => Math.floor(Math.random() * n)

export const sectionSlots = (s: Section) => s.steps / SLOT_STEPS
export const barsOf = (steps: number) => steps / STEPS_PER_BAR
export const defaultName = (id: number) => `Section ${'ABCDEFGH'[id] ?? id + 1}`
export const findSection = (song: Song, id: number) => song.sections.find((s) => s.id === id)

export function emptyNotes(steps: number) {
  return new Array<boolean>(ROWS * steps).fill(false)
}

export function newSection(id: number, instrument: Instrument = 'bell', steps: Length = 16): Section {
  return { id, name: defaultName(id), instrument, steps, notes: emptyNotes(steps), volume: 0.8, muted: false }
}

export function freeId(song: Song) {
  for (let id = 0; id < MAX_SECTIONS; id++) if (!song.sections.some((s) => s.id === id)) return id
  return -1
}

/** Lengthening repeats what's there; shortening keeps the start. */
export function resize(s: Section, steps: Length): Section {
  const notes = emptyNotes(steps)
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < steps; c++) notes[r * steps + c] = s.notes[r * s.steps + (c % s.steps)]
  }
  return { ...s, steps, notes }
}

// ---- the timeline ----------------------------------------------------------

const spanCache = new WeakMap<Song, Span[]>()

/** Each placement's length on the timeline. A block stops early if the next block in its lane starts first. */
export function spansOf(song: Song): Span[] {
  const hit = spanCache.get(song)
  if (hit) return hit
  const out: Span[] = []
  for (let lane = 0; lane < LANES; lane++) {
    const list = song.placements
      .filter((p) => p.lane === lane && findSection(song, p.section))
      .sort((a, b) => a.slot - b.slot)
    list.forEach((p, i) => {
      const next = list[i + 1]?.slot ?? SLOTS
      const full = sectionSlots(findSection(song, p.section)!)
      out.push({ ...p, span: Math.max(1, Math.min(full, next - p.slot, SLOTS - p.slot)) })
    })
  }
  spanCache.set(song, out)
  return out
}

/** The slot where the song ends, or 0 when nothing is placed. */
export function songEnd(song: Song) {
  let end = 0
  for (const p of spansOf(song)) end = Math.max(end, p.slot + p.span)
  return end
}

export function spanAt(song: Song, lane: number, slot: number) {
  return spansOf(song).find((p) => p.lane === lane && slot >= p.slot && slot < p.slot + p.span)
}

const BASE_VEL: Record<Instrument, number> = { bell: 0.32, pluck: 0.22, pad: 0.085, bass: 0.36, drums: 0.9 }

export function sectionEvents(sec: Section, local: number, out: NoteEvent[]) {
  const rows: number[] = []
  for (let r = 0; r < ROWS; r++) if (sec.notes[r * sec.steps + local]) rows.push(r)
  if (!rows.length || sec.volume <= 0) return
  // Chords share a fixed loudness so stacking notes doesn't get louder; drums don't.
  const vel =
    sec.instrument === 'drums'
      ? BASE_VEL.drums * sec.volume
      : (BASE_VEL[sec.instrument] * sec.volume) / Math.sqrt(rows.length)
  for (const row of rows) out.push({ section: sec.id, instrument: sec.instrument, row, local, vel })
}

export function previewEvent(sec: Section, row: number, local: number): NoteEvent {
  return { section: sec.id, instrument: sec.instrument, row, local, vel: BASE_VEL[sec.instrument] * Math.max(sec.volume, 0.3) }
}

export function songEventsAt(song: Song, step: number) {
  const slot = Math.floor(step / SLOT_STEPS)
  const out: NoteEvent[] = []
  for (const p of spansOf(song)) {
    if (slot < p.slot || slot >= p.slot + p.span) continue
    const sec = findSection(song, p.section)
    if (!sec || sec.muted) continue
    sectionEvents(sec, step - p.slot * SLOT_STEPS, out)
  }
  return out
}

/** Where a section is inside its own bars at a song step, or -1 if it isn't playing. */
export function localStepIn(song: Song, id: number, step: number) {
  const slot = Math.floor(step / SLOT_STEPS)
  for (const p of spansOf(song)) {
    if (p.section === id && slot >= p.slot && slot < p.slot + p.span) return step - p.slot * SLOT_STEPS
  }
  return -1
}

// ---- labels ----------------------------------------------------------------

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const DRUM_LABELS = [
  'Ping', 'Block', 'Wood', 'Open hat', 'Tight hat', 'Hat', 'Shaker', 'Clap',
  'Rim', 'Snare', 'High tom', 'Mid tom', 'Low tom', 'Punch', 'Kick', 'Sub kick',
]

/** Row labels from the top: drum names, or note names like F♯4. */
export function rowLabels(instrument: Instrument, scale: number) {
  if (instrument === 'drums') return DRUM_LABELS
  const steps = SCALES[scale].steps
  return Array.from({ length: ROWS }, (_, r) => {
    const midi = 50 + rowSemis(r, steps) - (instrument === 'bass' ? 12 : 0)
    return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
  })
}

// ---- random sections ---------------------------------------------------------

export function randomNotes(instrument: Instrument, steps: Length) {
  const notes = emptyNotes(steps)
  const put = (step: number, pitch: number) => {
    notes[pitchRow(clamp(pitch, 0, ROWS - 1)) * steps + step] = true
  }
  const bars = steps / STEPS_PER_BAR

  if (instrument === 'drums') {
    for (let b = 0; b < bars; b++) {
      const o = b * STEPS_PER_BAR
      put(o, 1)
      if (Math.random() < 0.7) put(o + 4, 1)
      if (Math.random() < 0.35) put(o + 3 + rand(2) * 4, 1)
      put(o + 2, 6)
      put(o + 6, 6)
      for (let s = 1; s < STEPS_PER_BAR; s += 2) if (Math.random() < 0.85) put(o + s, 10)
      if (Math.random() < 0.3) put(o + rand(8), 9)
    }
    if (Math.random() < 0.6) put(steps - 1, 12)
    if (Math.random() < 0.5) {
      const o = steps - STEPS_PER_BAR
      put(o + 4, 5)
      put(o + 5, 4)
      put(o + 6, 3)
    }
    return notes
  }

  if (instrument === 'pad') {
    for (let b = 0; b < bars; b++) {
      const root = 3 + rand(5)
      for (const d of [0, 2, 3]) put(b * STEPS_PER_BAR, root + d)
    }
    return notes
  }

  if (instrument === 'bass') {
    for (let b = 0; b < bars; b++) {
      const o = b * STEPS_PER_BAR
      const root = rand(5)
      put(o, root)
      if (Math.random() < 0.8) put(o + 3, root)
      if (Math.random() < 0.8) put(o + 6, root + 5)
      if (Math.random() < 0.25) put(o + 7, root + 2)
    }
    return notes
  }

  // Bell and pluck: a wandering melody kept above the bass.
  let pitch = 9 + rand(3)
  for (let c = 0; c < steps; c++) {
    if (Math.random() < 0.62) {
      pitch = clamp(pitch + rand(7) - 3, 6, 15)
      put(c, pitch)
      if (Math.random() < 0.15) put(c, pitch - 2 - rand(2))
    }
  }
  return notes
}

// ---- the demo song -----------------------------------------------------------

function sectionFrom(id: number, name: string, instrument: Instrument, steps: Length, list: [number, number][], volume = 0.8): Section {
  const notes = emptyNotes(steps)
  for (const [step, pitch] of list) notes[pitchRow(pitch) * steps + step] = true
  return { id, name, instrument, steps, notes, volume, muted: false }
}

const hits = (pitch: number, steps: number[]) => steps.map((s) => [s, pitch] as [number, number])

export function demoSong(): Song {
  const melody = sectionFrom(0, 'Melody', 'bell', 32, [
    [0, 7], [0, 10], [2, 9], [3, 8], [4, 10], [6, 12], [7, 11], [8, 9], [10, 8], [11, 7], [12, 8], [13, 10], [14, 13], [15, 12],
    [16, 10], [16, 7], [18, 12], [19, 11], [20, 10], [22, 9], [23, 8], [24, 7], [26, 9], [27, 10], [28, 12], [29, 11], [30, 10], [31, 9],
  ])
  const pad = sectionFrom(1, 'Pad', 'pad', 32, [
    [0, 5], [0, 7], [0, 8], [8, 4], [8, 5], [8, 7], [16, 3], [16, 6], [16, 8], [24, 6], [24, 8], [24, 9],
  ], 0.7)
  const bass = sectionFrom(2, 'Bass', 'bass', 32, [
    [0, 0], [3, 0], [6, 5], [8, 4], [11, 4], [14, 9], [16, 3], [19, 3], [22, 8], [24, 1], [27, 1], [30, 6],
  ])
  const beat = sectionFrom(3, 'Beat', 'drums', 16, [
    ...hits(1, [0, 4, 8, 11, 12]),
    ...hits(6, [2, 6, 10, 14]),
    ...hits(10, [1, 3, 5, 7, 9, 11, 13]),
    ...hits(12, [15]),
  ], 0.75)

  const placements: Placement[] = [
    ...[4, 6, 8, 10].map((slot) => ({ lane: 0, slot, section: 0 })),
    ...[0, 2, 4, 6, 8, 10, 12, 14].map((slot) => ({ lane: 1, slot, section: 1 })),
    ...[2, 4, 6, 8, 10, 12].map((slot) => ({ lane: 2, slot, section: 2 })),
    ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((slot) => ({ lane: 3, slot, section: 3 })),
  ]
  return { bpm: 108, scale: 0, sections: [melody, pad, bass, beat], placements }
}

// ---- links -------------------------------------------------------------------

const VERSION = 2

function toBase64Url(bytes: number[]) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Array.from(bin, (c) => c.charCodeAt(0))
}

/** Packs a song into a few hundred bytes for the address bar. */
export function encodeSong(song: Song) {
  const bytes = [VERSION, song.bpm, song.scale, song.sections.length]
  for (const s of song.sections) {
    bytes.push(s.id, INSTRUMENTS.findIndex((i) => i.id === s.instrument), LENGTHS.indexOf(s.steps))
    bytes.push(Math.round(s.volume * 100), s.muted ? 1 : 0)
    const name = new TextEncoder().encode(s.name.slice(0, 24))
    bytes.push(name.length, ...name)
    for (let i = 0; i < s.notes.length; i += 8) {
      let b = 0
      for (let k = 0; k < 8; k++) if (s.notes[i + k]) b |= 1 << k
      bytes.push(b)
    }
  }
  const placements = song.placements.filter((p) => findSection(song, p.section))
  bytes.push(placements.length)
  for (const p of placements) bytes.push(p.lane, p.slot, p.section)
  return `s=${toBase64Url(bytes)}`
}

/** Links from the first version of Pond held one 16-step loop. */
function decodeV1(hash: string): Song | null {
  const m = /^#?([0-9a-f]{64})\.(\d)\.(\d{2,3})$/.exec(hash)
  if (!m) return null
  const s = newSection(0, 'bell', 16)
  s.name = 'Melody'
  for (let i = 0; i < 64; i++) {
    const n = parseInt(m[1][i], 16)
    for (let b = 0; b < 4; b++) s.notes[i * 4 + b] = Boolean(n & (1 << b))
  }
  return {
    bpm: clamp(Number(m[3]), MIN_BPM, MAX_BPM),
    scale: clamp(Number(m[2]), 0, SCALES.length - 1),
    sections: [s],
    placements: [{ lane: 0, slot: 0, section: 0 }],
  }
}

export function decodeSong(hash: string): Song | null {
  const v1 = decodeV1(hash)
  if (v1) return v1
  const m = /^#?s=([A-Za-z0-9_-]+)$/.exec(hash)
  if (!m) return null
  try {
    const b = fromBase64Url(m[1])
    let i = 0
    const next = () => {
      if (i >= b.length) throw new Error('short')
      return b[i++]
    }
    if (next() !== VERSION) return null
    const bpm = clamp(next(), MIN_BPM, MAX_BPM)
    const scale = clamp(next(), 0, SCALES.length - 1)
    const count = next()
    const sections: Section[] = []
    for (let n = 0; n < count && n < MAX_SECTIONS; n++) {
      const id = next()
      const instrument = INSTRUMENTS[next()]?.id ?? 'bell'
      const steps = LENGTHS[next()] ?? 16
      const volume = clamp(next(), 0, 100) / 100
      const muted = (next() & 1) === 1
      const nameLen = next()
      const name = new TextDecoder().decode(new Uint8Array(b.slice(i, i + nameLen)))
      i += nameLen
      const notes = emptyNotes(steps)
      for (let k = 0; k < notes.length; k += 8) {
        const byte = next()
        for (let bit = 0; bit < 8; bit++) notes[k + bit] = Boolean(byte & (1 << bit))
      }
      if (id < MAX_SECTIONS && !sections.some((s) => s.id === id)) {
        sections.push({ id, name: name || defaultName(id), instrument, steps, notes, volume, muted })
      }
    }
    if (!sections.length) return null
    const placements: Placement[] = []
    const pc = next()
    for (let n = 0; n < pc; n++) {
      const lane = next()
      const slot = next()
      const section = next()
      const ok = lane < LANES && slot < SLOTS && sections.some((s) => s.id === section)
      if (ok && !placements.some((p) => p.lane === lane && p.slot === slot)) placements.push({ lane, slot, section })
    }
    return { bpm, scale, sections, placements }
  } catch {
    return null
  }
}
