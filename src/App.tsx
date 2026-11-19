import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import { Engine, ROWS, SCALES } from './audio'
import type { NoteEvent } from './audio'
import { Water } from './water'
import type { RGB } from './water'
import {
  INSTRUMENTS,
  LANES,
  LENGTHS,
  MAX_BPM,
  MAX_SECTIONS,
  MIN_BPM,
  SLOTS,
  SLOT_STEPS,
  STEPS_PER_BAR,
  barsOf,
  decodeSong,
  defaultName,
  demoSong,
  emptyNotes,
  encodeSong,
  findSection,
  freeId,
  localStepIn,
  newSection,
  previewEvent,
  randomNotes,
  resize,
  rowLabels,
  sectionEvents,
  sectionSlots,
  songEnd,
  songEventsAt,
  spanAt,
  spansOf,
} from './song'
import type { Length, Section, Song } from './song'
import './App.css'

type Mode = 'section' | 'song'

const SIM = 6 // CSS pixels per water cell
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// The sound, the water and the note flashes live outside React: they change
// every frame and nothing on screen re-renders from them directly.
const engine = new Engine()
const water = new Water()
const flash = new Float32Array(ROWS * 64)
const view = { board: null as HTMLDivElement | null, reduce: false, cols: 16, pageStart: 0 }

const amp = (strength: number) => (view.reduce ? strength * 0.35 : strength)

function dropAtCell(row: number, col: number, strength: number) {
  const el = view.board
  if (!el) return
  const r = el.getBoundingClientRect()
  const cw = r.width / view.cols
  const ch = r.height / ROWS
  const x = r.left + (col + 0.5) * cw
  const y = r.top + (row + 0.5) * ch
  water.drop(x / SIM + 0.5, y / SIM + 0.5, (Math.min(cw, ch) / SIM) * 0.55 + 0.6, amp(strength))
}

function rippleStrength(e: NoteEvent) {
  if (e.instrument !== 'drums') return { bell: 6, pluck: 5, pad: 4, bass: 6 }[e.instrument]
  const n = ROWS - 1 - e.row
  if (n <= 2) return 9 // kicks
  if (n <= 5) return 6 // toms
  if (n <= 8) return 5 // snare, rim, clap
  if (n <= 12) return 2.2 // shaker and hats
  return 3.5
}

function hexToRgb(hex: string): RGB {
  const h = hex.trim().replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function readPalette() {
  const s = getComputedStyle(document.documentElement)
  const v = (name: string) => s.getPropertyValue(name).trim()
  return {
    water: hexToRgb(v('--water')),
    hi: hexToRgb(v('--water-hi')),
    lo: hexToRgb(v('--water-lo')),
    dot: v('--ink'),
    flash: v('--flash'),
    sections: Array.from({ length: MAX_SECTIONS }, (_, i) => v(`--s${i}`)),
  }
}

function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function saveToUrl(song: Song) {
  window.history.replaceState(null, '', `#${encodeSong(song)}`)
}

const tint = (id: number) => ({ '--c': `var(--s${id})` }) as CSSProperties

function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {playing ? (
        <>
          <rect x="3" y="2.5" width="3.5" height="11" rx="1" fill="currentColor" />
          <rect x="9.5" y="2.5" width="3.5" height="11" rx="1" fill="currentColor" />
        </>
      ) : (
        <path d="M4.5 2.6v10.8a.8.8 0 0 0 1.2.7l8.6-5.4a.8.8 0 0 0 0-1.4L5.7 1.9a.8.8 0 0 0-1.2.7z" fill="currentColor" />
      )}
    </svg>
  )
}

export default function App() {
  const [initial] = useState(() => decodeSong(location.hash) ?? demoSong())
  const [song, setSong] = useState(initial)
  const [selectedId, setSelectedId] = useState(initial.sections[0].id)
  const [mode, setMode] = useState<Mode>(initial.placements.length ? 'song' : 'section')
  const [playing, setPlaying] = useState(false)
  const [page, setPage] = useState(0)
  const [viewSteps, setViewSteps] = useState(32)
  const [focusIdx, setFocusIdx] = useState(0)
  const [slotFocus, setSlotFocus] = useState(0)
  const [hover, setHover] = useState<{ lane: number; slot: number } | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [undoState, setUndoState] = useState({ undo: false, redo: false })

  const songRef = useRef(song)
  const selectedRef = useRef(selectedId)
  const modeRef = useRef<Mode>(mode)
  const playingRef = useRef(false)
  const headRef = useRef(-1)
  const cueRef = useRef(0)
  const past = useRef<Song[]>([])
  const future = useRef<Song[]>([])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const songLineRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLParagraphElement>(null)
  const cellEls = useRef<(HTMLButtonElement | null)[]>([])
  const slotEls = useRef<(HTMLButtonElement | null)[]>([])
  const paintRef = useRef<{ value: boolean; last: number; recorded: boolean } | null>(null)
  const stirRef = useRef<{ x: number; y: number } | null>(null)
  const renamingRef = useRef(false)

  const section = findSection(song, selectedId) ?? song.sections[0]
  const cols = Math.min(section.steps, viewSteps)
  const pages = section.steps / cols
  const pageIdx = Math.min(page, pages - 1)
  const pageStart = pageIdx * cols
  const labels = rowLabels(section.instrument, song.scale)
  const spans = spansOf(song)
  const cellFocus = focusIdx < ROWS * cols ? focusIdx : 0

  // ---- keeping the outside world in step ---------------------------------------

  useEffect(() => {
    view.cols = cols
    view.pageStart = pageStart
    selectedRef.current = section.id
  }, [cols, pageStart, section.id])

  useEffect(() => {
    engine.scale = SCALES[song.scale].steps
  }, [song.scale])

  useEffect(() => {
    engine.bpm = song.bpm
    engine.retime()
  }, [song.bpm])

  useEffect(() => {
    saveToUrl(song)
  }, [song])

  useEffect(() => {
    if (copyState === 'idle') return
    const t = window.setTimeout(() => setCopyState('idle'), 1800)
    return () => window.clearTimeout(t)
  }, [copyState])

  // Show 32 steps when the board is wide enough for them, otherwise 16.
  useEffect(() => {
    const el = view.board
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setViewSteps(entry.contentRect.width / 32 >= 20 ? 32 : 16)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ---- editing, with undo ----------------------------------------------------------

  const syncUndo = () => setUndoState({ undo: past.current.length > 0, redo: future.current.length > 0 })

  const apply = (next: Song, record = true) => {
    if (record) {
      past.current.push(songRef.current)
      if (past.current.length > 200) past.current.shift()
      future.current = []
      syncUndo()
    }
    songRef.current = next
    setSong(next)
  }

  // Undo is for notes, sections and the song. Tempo, scale and the mixer stay as they are.
  const keepSettings = (target: Song, cur: Song): Song => ({
    ...target,
    bpm: cur.bpm,
    scale: cur.scale,
    sections: target.sections.map((s) => {
      const c = findSection(cur, s.id)
      return c ? { ...s, volume: c.volume, muted: c.muted } : s
    }),
  })

  const undo = () => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(songRef.current)
    const next = keepSettings(prev, songRef.current)
    songRef.current = next
    setSong(next)
    syncUndo()
  }

  const redo = () => {
    const nxt = future.current.pop()
    if (!nxt) return
    past.current.push(songRef.current)
    const next = keepSettings(nxt, songRef.current)
    songRef.current = next
    setSong(next)
    syncUndo()
  }

  const updateSection = (id: number, fn: (s: Section) => Section, record = true) => {
    const cur = songRef.current
    apply({ ...cur, sections: cur.sections.map((s) => (s.id === id ? fn(s) : s)) }, record)
  }

  const select = (id: number) => {
    setSelectedId(id)
    selectedRef.current = id
    setPage(0)
    setFocusIdx(0)
    flash.fill(0)
  }

  /** k is a cell on screen: row × cols + column. Returns whether anything changed. */
  const setCell = (k: number, value: boolean, record: boolean) => {
    const row = Math.floor(k / cols)
    const col = k % cols
    const step = pageStart + col
    const sec = findSection(songRef.current, section.id)
    if (!sec) return false
    const ni = row * sec.steps + step
    if (sec.notes[ni] === value) return false
    updateSection(
      sec.id,
      (s) => {
        const notes = s.notes.slice()
        notes[ni] = value
        return { ...s, notes }
      },
      record,
    )
    if (value) {
      engine.preview(previewEvent(sec, row, step))
      flash[k] = 0.7
      dropAtCell(row, col, 3)
    }
    return true
  }

  const addSection = () => {
    const cur = songRef.current
    const id = freeId(cur)
    if (id < 0) return
    apply({ ...cur, sections: [...cur.sections, newSection(id)] })
    select(id)
  }

  const duplicateSection = () => {
    const cur = songRef.current
    const id = freeId(cur)
    if (id < 0) return
    const copy: Section = { ...section, id, name: `${section.name} 2`.slice(0, 16), notes: section.notes.slice() }
    const at = cur.sections.findIndex((s) => s.id === section.id)
    const sections = [...cur.sections]
    sections.splice(at + 1, 0, copy)
    apply({ ...cur, sections })
    select(id)
  }

  const deleteSection = () => {
    const cur = songRef.current
    if (cur.sections.length <= 1) return
    const at = cur.sections.findIndex((s) => s.id === section.id)
    const sections = cur.sections.filter((s) => s.id !== section.id)
    apply({ ...cur, sections, placements: cur.placements.filter((p) => p.section !== section.id) })
    select(sections[Math.min(at, sections.length - 1)].id)
  }

  const setLength = (steps: Length) => {
    if (steps === section.steps) return
    updateSection(section.id, (s) => resize(s, steps))
    setPage(0)
  }

  const rename = (name: string) => {
    updateSection(section.id, (s) => ({ ...s, name }), !renamingRef.current)
    renamingRef.current = true
  }

  /** Click an empty slot to place the selected section; click a block to take it out. */
  const toggleSlot = (lane: number, slot: number) => {
    const cur = songRef.current
    const hit = spanAt(cur, lane, slot)
    if (hit) {
      apply({ ...cur, placements: cur.placements.filter((p) => !(p.lane === hit.lane && p.slot === hit.slot)) })
      return
    }
    const len = sectionSlots(section)
    const kept = cur.placements.filter((p) => !(p.lane === lane && p.slot > slot && p.slot < slot + len))
    apply({ ...cur, placements: [...kept, { lane, slot, section: section.id }] })
  }

  // ---- playback --------------------------------------------------------------------

  const togglePlay = () => {
    if (playingRef.current) {
      engine.stop()
      playingRef.current = false
      // Pausing a song keeps your place; Play carries on from there.
      if (modeRef.current === 'song' && headRef.current >= 0) {
        cueRef.current = headRef.current + 1 < engine.length() ? headRef.current + 1 : 0
      }
      headRef.current = -1
      setPlaying(false)
    } else {
      const from = modeRef.current === 'song' && cueRef.current < engine.length() ? cueRef.current : 0
      engine.start(from)
      playingRef.current = true
      setPlaying(true)
    }
  }

  const changeMode = (m: Mode) => {
    if (m === modeRef.current) return
    modeRef.current = m
    setMode(m)
    if (playingRef.current) {
      engine.seek(m === 'song' ? cueRef.current : 0)
      headRef.current = -1
    }
  }

  const playFrom = (slot: number) => {
    cueRef.current = slot * SLOT_STEPS
    if (modeRef.current !== 'song') changeMode('song')
    else if (playingRef.current) {
      engine.seek(cueRef.current)
      headRef.current = -1
    }
  }

  // ---- the water and the board, drawn on one canvas behind the page --------------------

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const off = document.createElement('canvas')
    const offCtx = off.getContext('2d')
    if (!offCtx) return

    engine.source = (step) => {
      const s = songRef.current
      if (modeRef.current === 'section') {
        const sec = findSection(s, selectedRef.current)
        const out: NoteEvent[] = []
        if (sec) sectionEvents(sec, step % sec.steps, out)
        return out
      }
      return songEventsAt(s, step)
    }
    engine.length = () => {
      const s = songRef.current
      if (modeRef.current === 'section') return findSection(s, selectedRef.current)?.steps ?? 16
      return Math.max(1, songEnd(s)) * SLOT_STEPS
    }

    let pal = readPalette()
    const dark = matchMedia('(prefers-color-scheme: dark)')
    const reduce = matchMedia('(prefers-reduced-motion: reduce)')
    const onScheme = () => (pal = readPalette())
    const onReduce = () => (view.reduce = reduce.matches)
    onReduce()
    dark.addEventListener('change', onScheme)
    reduce.addEventListener('change', onReduce)

    let img = offCtx.createImageData(1, 1)
    let dpr = 1
    const resizeCanvas = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(innerWidth * dpr)
      canvas.height = Math.round(innerHeight * dpr)
      const w = Math.ceil(innerWidth / SIM) + 2
      const h = Math.ceil(innerHeight / SIM) + 2
      water.resize(w, h)
      off.width = w
      off.height = h
      img = offCtx.createImageData(w, h)
    }
    resizeCanvas()
    window.addEventListener('resize', resizeCanvas)

    // One drop in the middle of the board when the page opens.
    const opening = window.setTimeout(() => dropAtCell(ROWS / 2, Math.floor(view.cols / 2), 9), 350)

    let raf = 0
    let last = performance.now()
    let acc = 0
    let sincePalette = 0
    let shownTime = ''

    const frame = (now: number) => {
      const dt = Math.min(now - last, 100)
      last = now
      acc += dt

      // Follow theme and stylesheet changes without needing a reload.
      sincePalette += dt
      if (sincePalette > 500) {
        pal = readPalette()
        sincePalette = 0
      }

      const actx = engine.ctx
      if (actx && playingRef.current) {
        while (engine.queue.length && engine.queue[0].time <= actx.currentTime) {
          const t = engine.queue.shift()!
          headRef.current = t.step
          if (actx.currentTime - t.time > 0.25) continue // the tab was hidden; skip stale ripples
          for (const e of t.events) {
            const col = e.local - view.pageStart
            if (e.section === selectedRef.current && col >= 0 && col < view.cols) {
              flash[e.row * view.cols + col] = 1
              dropAtCell(e.row, col, rippleStrength(e))
            } else {
              // Sections you aren't looking at still stir the water, more gently.
              dropAtCell(e.row, e.local % view.cols, rippleStrength(e) * 0.45)
            }
          }
        }
      }

      while (acc >= 1000 / 60) {
        water.step()
        acc -= 1000 / 60
      }

      water.paint(img.data, pal.water, pal.hi, pal.lo, 0.2)
      offCtx.putImageData(img, 0, 0)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(off, -SIM, -SIM, water.w * SIM, water.h * SIM)

      const s = songRef.current
      const sec = findSection(s, selectedRef.current) ?? s.sections[0]
      const board = view.board
      if (board && sec) {
        const rect = board.getBoundingClientRect()
        const { cols: vc, pageStart: ps } = view
        const cw = rect.width / vc
        const ch = rect.height / ROWS
        const size = Math.min(cw, ch)
        const { w, cur } = water
        const decay = Math.exp(-dt / 220)
        const bend = view.reduce ? 0 : 1.6

        let head = -1
        if (playingRef.current && headRef.current >= 0) {
          const local =
            modeRef.current === 'section' ? headRef.current : localStepIn(s, sec.id, headRef.current)
          if (local >= 0) head = local - ps
        }

        const color = pal.sections[sec.id] || pal.dot
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < vc; c++) {
            const k = r * vc + c
            const step = ps + c
            const cx = rect.left + (c + 0.5) * cw
            const cy = rect.top + (r + 0.5) * ch
            const sx = Math.round(cx / SIM + 0.5)
            const sy = Math.round(cy / SIM + 0.5)
            const i = clamp(sy, 1, water.h - 2) * w + clamp(sx, 1, w - 2)
            const lift = Math.min(Math.abs(cur[i]) * 0.22, 1)
            const ox = clamp((cur[i + 1] - cur[i - 1]) * bend, -6, 6)
            const oy = clamp((cur[i + w] - cur[i - w]) * bend, -6, 6)
            const f = flash[k]
            flash[k] = f * decay

            ctx.beginPath()
            if (sec.notes[r * sec.steps + step]) {
              const d = size * (0.6 + f * 0.16 + lift * 0.06)
              ctx.arc(cx + ox, cy + oy, d / 2, 0, Math.PI * 2)
              ctx.globalAlpha = 1
              ctx.fillStyle = color
              ctx.fill()
              if (f > 0.02) {
                ctx.globalAlpha = f * 0.65
                ctx.fillStyle = pal.flash
                ctx.fill()
              }
            } else {
              const onHead = c === head
              const barStart = step % STEPS_PER_BAR === 0
              const d = size * (0.2 + lift * 0.24 + (onHead ? 0.08 : 0))
              ctx.arc(cx + ox, cy + oy, d / 2, 0, Math.PI * 2)
              ctx.globalAlpha = 0.15 + (barStart ? 0.1 : 0) + lift * 0.4 + (onHead ? 0.16 : 0)
              ctx.fillStyle = pal.dot
              ctx.fill()
            }
          }
        }
        ctx.globalAlpha = 1
      }

      // The song's playhead and clock.
      const pos = playingRef.current && modeRef.current === 'song' ? Math.max(headRef.current, 0) : cueRef.current
      const line = songLineRef.current
      if (line) {
        const width = line.parentElement?.clientWidth ?? 0
        line.style.transform = `translateX(${(pos / (SLOTS * SLOT_STEPS)) * width}px)`
      }
      const clock = timeRef.current
      if (clock) {
        const text = `${formatTime(pos * engine.stepDur)} / ${formatTime(songEnd(s) * SLOT_STEPS * engine.stepDur)}`
        if (text !== shownTime) {
          clock.textContent = text
          shownTime = text
        }
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(opening)
      window.removeEventListener('resize', resizeCanvas)
      dark.removeEventListener('change', onScheme)
      reduce.removeEventListener('change', onReduce)
      engine.stop()
    }
  }, [])

  // ---- keyboard shortcuts ------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target
      const typing = t instanceof HTMLInputElement ? t.type === 'text' : t instanceof HTMLTextAreaElement
      const mod = e.metaKey || e.ctrlKey
      if (mod && !typing && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && !typing && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if ((e.key !== ' ' && e.code !== 'Space') || e.repeat) return
      if (t instanceof Element && t.closest('button, input, select, textarea, label')) return
      e.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- the note board ------------------------------------------------------------------

  const cellFromPoint = (e: PointerEvent) => {
    const el = view.board
    if (!el) return -1
    const r = el.getBoundingClientRect()
    const col = Math.floor(((e.clientX - r.left) / r.width) * cols)
    const row = Math.floor(((e.clientY - r.top) / r.height) * ROWS)
    if (col < 0 || row < 0 || col >= cols || row >= ROWS) return -1
    return row * cols + col
  }

  const onBoardDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const k = cellFromPoint(e)
    if (k < 0) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Some synthetic pointers can't be captured; drawing still works without it.
    }
    const step = pageStart + (k % cols)
    const value = !section.notes[Math.floor(k / cols) * section.steps + step]
    const changed = setCell(k, value, true)
    paintRef.current = { value, last: k, recorded: changed }
    setFocusIdx(k)
  }

  const onBoardMove = (e: PointerEvent<HTMLDivElement>) => {
    const paint = paintRef.current
    if (!paint) return
    const k = cellFromPoint(e)
    if (k < 0 || k === paint.last) return
    // Fill every cell between the last one and this one, so a quick stroke leaves no gaps.
    let r0 = Math.floor(paint.last / cols)
    let c0 = paint.last % cols
    const r1 = Math.floor(k / cols)
    const c1 = k % cols
    const dr = Math.abs(r1 - r0)
    const dc = Math.abs(c1 - c0)
    const sr = r0 < r1 ? 1 : -1
    const sc = c0 < c1 ? 1 : -1
    let err = dc - dr
    while (r0 !== r1 || c0 !== c1) {
      const e2 = 2 * err
      if (e2 > -dr) {
        err -= dr
        c0 += sc
      }
      if (e2 < dc) {
        err += dc
        r0 += sr
      }
      if (setCell(r0 * cols + c0, paint.value, !paint.recorded)) paint.recorded = true
    }
    paint.last = k
  }

  const endPaint = () => {
    paintRef.current = null
  }

  const onBoardKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = Math.floor(cellFocus / cols)
    const col = cellFocus % cols
    let next = -1
    if (e.key === 'ArrowUp') next = clamp(row - 1, 0, ROWS - 1) * cols + col
    else if (e.key === 'ArrowDown') next = clamp(row + 1, 0, ROWS - 1) * cols + col
    else if (e.key === 'ArrowLeft') next = row * cols + clamp(col - 1, 0, cols - 1)
    else if (e.key === 'ArrowRight') next = row * cols + clamp(col + 1, 0, cols - 1)
    else if (e.key === 'Home') next = row * cols
    else if (e.key === 'End') next = row * cols + cols - 1
    if (next < 0) return
    e.preventDefault()
    setFocusIdx(next)
    cellEls.current[next]?.focus()
  }

  const onLanesKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const lane = Math.floor(slotFocus / SLOTS)
    const slot = slotFocus % SLOTS
    let next = -1
    if (e.key === 'ArrowUp') next = clamp(lane - 1, 0, LANES - 1) * SLOTS + slot
    else if (e.key === 'ArrowDown') next = clamp(lane + 1, 0, LANES - 1) * SLOTS + slot
    else if (e.key === 'ArrowLeft') next = lane * SLOTS + clamp(slot - 1, 0, SLOTS - 1)
    else if (e.key === 'ArrowRight') next = lane * SLOTS + clamp(slot + 1, 0, SLOTS - 1)
    else if (e.key === 'Home') next = lane * SLOTS
    else if (e.key === 'End') next = lane * SLOTS + SLOTS - 1
    if (next < 0) return
    e.preventDefault()
    setSlotFocus(next)
    slotEls.current[next]?.focus()
  }

  // Stirring the open water with a finger or the mouse.
  const onWaterDown = (e: PointerEvent<HTMLCanvasElement>) => {
    stirRef.current = { x: e.clientX, y: e.clientY }
    water.drop(e.clientX / SIM + 0.5, e.clientY / SIM + 0.5, 3.5, amp(6))
  }

  const onWaterMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const s = stirRef.current
    if (!s) return
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 10) return
    s.x = e.clientX
    s.y = e.clientY
    water.drop(e.clientX / SIM + 0.5, e.clientY / SIM + 0.5, 2.5, amp(1.6))
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  const instrumentName = (s: Section) => INSTRUMENTS.find((i) => i.id === s.instrument)?.name ?? ''
  const ghostLen =
    hover && !spanAt(song, hover.lane, hover.slot) ? Math.min(sectionSlots(section), SLOTS - hover.slot) : 0

  return (
    <>
      <canvas
        ref={canvasRef}
        className="water"
        aria-hidden="true"
        onPointerDown={onWaterDown}
        onPointerMove={onWaterMove}
        onPointerUp={() => (stirRef.current = null)}
        onPointerLeave={() => (stirRef.current = null)}
      />

      <main className="pond">
        <h1 className="title">Pond</h1>

        <div className="studio">
          <div className="transport">
            <button type="button" className="play" onClick={togglePlay}>
              <PlayIcon playing={playing} />
              {playing ? 'Pause' : 'Play'}
            </button>

            <div className="seg" role="group" aria-label="What to play">
              <button
                type="button"
                aria-pressed={mode === 'section'}
                title="Loop the section you're editing"
                onClick={() => changeMode('section')}
              >
                Section
              </button>
              <button
                type="button"
                aria-pressed={mode === 'song'}
                title="Play the whole song"
                onClick={() => changeMode('song')}
              >
                Song
              </button>
            </div>

            <label className="tempo">
              <span>Tempo</span>
              <input
                type="range"
                min={MIN_BPM}
                max={MAX_BPM}
                value={song.bpm}
                onChange={(e) => apply({ ...songRef.current, bpm: Number(e.target.value) }, false)}
              />
              <output>{song.bpm} bpm</output>
            </label>

            <div className="opt" role="group" aria-labelledby="scale-label">
              <span id="scale-label">Scale</span>
              <div className="toggles">
                {SCALES.map((s, i) => (
                  <button
                    key={s.name}
                    type="button"
                    title={s.detail}
                    aria-pressed={song.scale === i}
                    onClick={() => apply({ ...songRef.current, scale: i }, false)}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="editor" style={tint(section.id)}>
            <div className="editor-head">
              <span className="swatch" aria-hidden="true" />
              <input
                className="section-name"
                aria-label="Section name"
                value={section.name}
                maxLength={16}
                spellCheck={false}
                onFocus={() => (renamingRef.current = false)}
                onChange={(e) => rename(e.target.value)}
                onBlur={() => {
                  if (!section.name.trim()) updateSection(section.id, (s) => ({ ...s, name: defaultName(s.id) }), false)
                }}
              />
              <div className="text-actions">
                <button
                  type="button"
                  onClick={() => updateSection(section.id, (s) => ({ ...s, notes: randomNotes(s.instrument, s.steps) }))}
                >
                  Randomize
                </button>
                <button type="button" onClick={() => updateSection(section.id, (s) => ({ ...s, notes: emptyNotes(s.steps) }))}>
                  Clear
                </button>
                <button type="button" onClick={duplicateSection} disabled={song.sections.length >= MAX_SECTIONS}>
                  Duplicate
                </button>
                <button type="button" onClick={deleteSection} disabled={song.sections.length <= 1}>
                  Delete
                </button>
              </div>
            </div>

            <div className="editor-options">
              <div className="opt" role="group" aria-labelledby="sound-label">
                <span id="sound-label">Sound</span>
                <div className="toggles">
                  {INSTRUMENTS.map((inst) => (
                    <button
                      key={inst.id}
                      type="button"
                      aria-pressed={section.instrument === inst.id}
                      onClick={() => updateSection(section.id, (s) => ({ ...s, instrument: inst.id }))}
                    >
                      {inst.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="opt" role="group" aria-labelledby="length-label">
                <span id="length-label">Length</span>
                <div className="toggles">
                  {LENGTHS.map((len) => (
                    <button key={len} type="button" aria-pressed={section.steps === len} onClick={() => setLength(len)}>
                      {barsOf(len)} bars
                    </button>
                  ))}
                </div>
              </div>

              {pages > 1 && (
                <div className="opt" role="group" aria-labelledby="page-label">
                  <span id="page-label">Showing</span>
                  <div className="toggles">
                    {Array.from({ length: pages }, (_, p) => (
                      <button key={p} type="button" aria-pressed={pageIdx === p} onClick={() => setPage(p)}>
                        Bars {barsOf(p * cols) + 1}–{barsOf((p + 1) * cols)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="editor-board">
              <div className="row-labels" aria-hidden="true">
                {labels.map((l, r) => (
                  <span key={r}>{l}</span>
                ))}
              </div>

              {/* Mouse-down is cancelled so cells never take focus from a click, and Space still plays. */}
              <div
                ref={(el) => {
                  view.board = el
                }}
                className="board"
                role="group"
                aria-label={`${section.name} notes`}
                style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={onBoardDown}
                onPointerMove={onBoardMove}
                onPointerUp={endPaint}
                onPointerCancel={endPaint}
                onKeyDown={onBoardKey}
              >
                {Array.from({ length: ROWS * cols }, (_, k) => {
                  const row = Math.floor(k / cols)
                  const step = pageStart + (k % cols)
                  const on = section.notes[row * section.steps + step]
                  return (
                    <button
                      key={k}
                      ref={(el) => {
                        cellEls.current[k] = el
                      }}
                      type="button"
                      className="cell"
                      tabIndex={k === cellFocus ? 0 : -1}
                      aria-pressed={on}
                      aria-label={`${labels[row]}, step ${step + 1}`}
                      onFocus={() => setFocusIdx(k)}
                      onClick={(e) => {
                        // Pointer presses are handled on the board so you can drag to draw.
                        if (e.detail === 0) setCell(k, !on, true)
                      }}
                    />
                  )
                })}
              </div>
            </div>
          </div>

          <section className="song" aria-labelledby="song-label">
            <div className="song-head">
              <h2 id="song-label">Song</h2>
              <p className="song-time" ref={timeRef}>
                0:00 / 0:00
              </p>
            </div>
            <div className="lanes-scroll">
              <div className="lanes" onKeyDown={onLanesKey} onPointerLeave={() => setHover(null)}>
                <div className="ruler">
                  {Array.from({ length: SLOTS }, (_, slot) => (
                    <button
                      key={slot}
                      type="button"
                      tabIndex={-1}
                      data-mark={slot % 4 === 0 || undefined}
                      aria-label={`Play from bar ${slot * 2 + 1}`}
                      onClick={() => playFrom(slot)}
                    >
                      {slot % 4 === 0 ? slot * 2 + 1 : ''}
                    </button>
                  ))}
                </div>

                {Array.from({ length: LANES }, (_, lane) => (
                  <div key={lane} className="lane" role="group" aria-label={`Lane ${lane + 1}`}>
                    {Array.from({ length: SLOTS }, (_, slot) => {
                      const k = lane * SLOTS + slot
                      const hit = spanAt(song, lane, slot)
                      const hitName = hit ? findSection(song, hit.section)?.name : ''
                      return (
                        <button
                          key={slot}
                          ref={(el) => {
                            slotEls.current[k] = el
                          }}
                          type="button"
                          className="slot"
                          style={{ gridColumn: slot + 1 }}
                          data-mark={slot % 4 === 0 || undefined}
                          tabIndex={k === slotFocus ? 0 : -1}
                          aria-label={
                            hit
                              ? `Lane ${lane + 1}, bar ${slot * 2 + 1}, ${hitName}. Remove it`
                              : `Lane ${lane + 1}, bar ${slot * 2 + 1}, empty. Place ${section.name}`
                          }
                          onFocus={() => setSlotFocus(k)}
                          onPointerEnter={() => setHover({ lane, slot })}
                          onClick={() => toggleSlot(lane, slot)}
                        />
                      )
                    })}
                    {spans
                      .filter((p) => p.lane === lane)
                      .map((p) => {
                        const s = findSection(song, p.section)
                        if (!s) return null
                        return (
                          <div
                            key={p.slot}
                            className="block"
                            aria-hidden="true"
                            data-selected={s.id === section.id || undefined}
                            style={{ ...tint(s.id), gridColumn: `${p.slot + 1} / span ${p.span}` }}
                          >
                            <span>{s.name}</span>
                          </div>
                        )
                      })}
                    {hover?.lane === lane && ghostLen > 0 && (
                      <div
                        className="ghost"
                        aria-hidden="true"
                        style={{ ...tint(section.id), gridColumn: `${hover.slot + 1} / span ${ghostLen}` }}
                      />
                    )}
                  </div>
                ))}
                <div
                  className="song-line"
                  ref={songLineRef}
                  data-hidden={mode !== 'song' || undefined}
                  aria-hidden="true"
                />
              </div>
            </div>
          </section>
        </div>

        <aside className="side" aria-labelledby="sections-label">
          <h2 className="side-title" id="sections-label">
            Sections
          </h2>
          <ul className="sections">
            {song.sections.map((s) => (
              <li key={s.id} className="section-row" style={tint(s.id)} data-selected={s.id === section.id || undefined}>
                <button type="button" className="pick" aria-pressed={s.id === section.id} onClick={() => select(s.id)}>
                  <span className="swatch" aria-hidden="true" />
                  <span className="pick-text">
                    <span className="pick-name">{s.name}</span>
                    <span className="pick-meta">
                      {instrumentName(s)}, {barsOf(s.steps)} bars
                    </span>
                  </span>
                </button>
                <div className="mix">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(s.volume * 100)}
                    aria-label={`${s.name} volume`}
                    onChange={(e) =>
                      updateSection(s.id, (x) => ({ ...x, volume: Number(e.target.value) / 100 }), false)
                    }
                  />
                  <button
                    type="button"
                    className="mute"
                    aria-pressed={s.muted}
                    aria-label={`Mute ${s.name}`}
                    onClick={() => updateSection(s.id, (x) => ({ ...x, muted: !x.muted }), false)}
                  >
                    Mute
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <button type="button" className="add" onClick={addSection} disabled={song.sections.length >= MAX_SECTIONS}>
            New section
          </button>

          <div className="side-foot">
            <p className="hint">
              Draw notes on the grid. In the song, click a slot to place the selected section and click a block to take
              it out. Click a bar number to play from there.
            </p>
            <div className="text-actions">
              <button type="button" onClick={undo} disabled={!undoState.undo}>
                Undo
              </button>
              <button type="button" onClick={redo} disabled={!undoState.redo}>
                Redo
              </button>
              <button type="button" onClick={copyLink} aria-live="polite">
                {copyState === 'copied' ? 'Link copied' : copyState === 'failed' ? 'Copy from the address bar' : 'Copy link'}
              </button>
            </div>
          </div>
        </aside>
      </main>
    </>
  )
}
