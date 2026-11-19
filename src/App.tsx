import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { COLS, Engine, ROWS, SCALES } from './audio'
import { Water } from './water'
import type { RGB } from './water'
import './App.css'

const CELLS = ROWS * COLS
const SIM = 6 // CSS pixels per water cell
const MIN_BPM = 60
const MAX_BPM = 180

// [step, pitch] where pitch 0 is the lowest row
const OPENING_TUNE: [number, number][] = [
  [0, 0], [0, 7], [0, 10], [2, 9], [3, 8], [4, 3], [4, 10], [6, 12], [7, 11],
  [8, 1], [8, 9], [10, 8], [11, 7], [12, 4], [12, 8], [13, 10], [14, 13], [15, 12],
]

const idx = (row: number, col: number) => row * COLS + col
const pitchRow = (pitch: number) => ROWS - 1 - pitch
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function openingTune() {
  const g = new Array<boolean>(CELLS).fill(false)
  for (const [step, pitch] of OPENING_TUNE) g[idx(pitchRow(pitch), step)] = true
  return g
}

function randomTune() {
  const g = new Array<boolean>(CELLS).fill(false)
  let pitch = 8 + Math.floor(Math.random() * 5) - 2
  for (let c = 0; c < COLS; c++) {
    if (Math.random() < 0.78) {
      pitch = clamp(pitch + Math.floor(Math.random() * 7) - 3, 5, 15)
      g[idx(pitchRow(pitch), c)] = true
      if (Math.random() < 0.2) g[idx(pitchRow(pitch - 2 - Math.round(Math.random())), c)] = true
    }
    if (c % 4 === 0 && Math.random() < 0.85) {
      g[idx(pitchRow(Math.floor(Math.random() * 5)), c)] = true
    }
  }
  return g
}

function encode(grid: boolean[], scale: number, bpm: number) {
  let hex = ''
  for (let i = 0; i < CELLS; i += 4) {
    let n = 0
    for (let b = 0; b < 4; b++) if (grid[i + b]) n |= 1 << b
    hex += n.toString(16)
  }
  return `${hex}.${scale}.${bpm}`
}

function decode(hash: string) {
  const m = /^#?([0-9a-f]{64})\.(\d)\.(\d{2,3})$/.exec(hash)
  if (!m) return null
  const grid = new Array<boolean>(CELLS).fill(false)
  for (let i = 0; i < 64; i++) {
    const n = parseInt(m[1][i], 16)
    for (let b = 0; b < 4; b++) grid[i * 4 + b] = Boolean(n & (1 << b))
  }
  return {
    grid,
    scale: clamp(Number(m[2]), 0, SCALES.length - 1),
    bpm: clamp(Number(m[3]), MIN_BPM, MAX_BPM),
  }
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
    petal: v('--petal'),
    petalHi: v('--petal-hi'),
  }
}

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

// The sound, the water and the note flashes live outside React: they change
// every frame and nothing on screen re-renders from them directly.
const engine = new Engine()
const water = new Water()
const flash = new Float32Array(CELLS)
const view = { board: null as HTMLDivElement | null, reduce: false }

const amp = (strength: number) => (view.reduce ? strength * 0.35 : strength)

function dropAtCell(row: number, col: number, strength: number) {
  const el = view.board
  if (!el) return
  const r = el.getBoundingClientRect()
  const size = r.width / COLS
  const x = r.left + (col + 0.5) * size
  const y = r.top + (row + 0.5) * size
  water.drop(x / SIM + 0.5, y / SIM + 0.5, (size / SIM) * 0.55, amp(strength))
}

export default function App() {
  const [initial] = useState(() => decode(location.hash) ?? { grid: openingTune(), scale: 0, bpm: 108 })
  const [grid, setGrid] = useState(initial.grid)
  const [scale, setScale] = useState(initial.scale)
  const [bpm, setBpm] = useState(initial.bpm)
  const [playing, setPlaying] = useState(false)
  const [focusIdx, setFocusIdx] = useState(0)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const gridRef = useRef(grid)
  const playingRef = useRef(false)
  const playheadRef = useRef(-1)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cellEls = useRef<(HTMLButtonElement | null)[]>([])
  const paintRef = useRef<{ value: boolean; last: number } | null>(null)
  const stirRef = useRef<{ x: number; y: number } | null>(null)

  const commit = (next: boolean[]) => {
    gridRef.current = next
    setGrid(next)
  }

  const setCell = (k: number, value: boolean) => {
    if (gridRef.current[k] === value) return
    const next = gridRef.current.slice()
    next[k] = value
    commit(next)
    if (value) {
      const row = Math.floor(k / COLS)
      const col = k % COLS
      engine.preview(row, col)
      flash[k] = 0.7
      dropAtCell(row, col, 3)
    }
  }

  // Keep the engine in step with the controls, and the URL in step with the tune.
  useEffect(() => {
    engine.scale = SCALES[scale].steps
  }, [scale])

  useEffect(() => {
    engine.bpm = bpm
    engine.retime()
  }, [bpm])

  useEffect(() => {
    gridRef.current = grid
    history.replaceState(null, '', `#${encode(grid, scale, bpm)}`)
  }, [grid, scale, bpm])

  useEffect(() => {
    if (copyState === 'idle') return
    const t = window.setTimeout(() => setCopyState('idle'), 1800)
    return () => window.clearTimeout(t)
  }, [copyState])

  // The water and the board are drawn on one canvas behind the page.
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const off = document.createElement('canvas')
    const offCtx = off.getContext('2d')
    if (!offCtx) return

    engine.getColumn = (c) => {
      const rows: number[] = []
      for (let r = 0; r < ROWS; r++) if (gridRef.current[idx(r, c)]) rows.push(r)
      return rows
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
    const resize = () => {
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
    resize()
    window.addEventListener('resize', resize)

    // One drop in the middle of the board when the page opens.
    const opening = window.setTimeout(() => {
      dropAtCell(ROWS / 2, COLS / 2, 9)
    }, 350)

    let raf = 0
    let last = performance.now()
    let acc = 0
    let sincePalette = 0
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
          playheadRef.current = t.step
          if (actx.currentTime - t.time > 0.25) continue // the tab was hidden; skip stale ripples
          for (const r of t.rows) {
            flash[idx(r, t.step)] = 1
            dropAtCell(r, t.step, 6)
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

      const board = view.board
      if (board) {
        const rect = board.getBoundingClientRect()
        const size = rect.width / COLS
        const { w, cur } = water
        const decay = Math.exp(-dt / 220)
        const bend = view.reduce ? 0 : 1.6
        const head = playingRef.current ? playheadRef.current : -1

        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            const k = idx(r, c)
            const cx = rect.left + (c + 0.5) * size
            const cy = rect.top + (r + 0.5) * size
            const sx = Math.round(cx / SIM + 0.5)
            const sy = Math.round(cy / SIM + 0.5)
            const i = clamp(sy, 1, water.h - 2) * w + clamp(sx, 1, w - 2)
            const lift = Math.min(Math.abs(cur[i]) * 0.22, 1)
            const ox = clamp((cur[i + 1] - cur[i - 1]) * bend, -6, 6)
            const oy = clamp((cur[i + w] - cur[i - w]) * bend, -6, 6)
            const f = flash[k]
            flash[k] = f * decay

            ctx.beginPath()
            if (gridRef.current[k]) {
              const d = size * (0.58 + f * 0.16 + lift * 0.06)
              ctx.arc(cx + ox, cy + oy, d / 2, 0, Math.PI * 2)
              ctx.globalAlpha = 1
              ctx.fillStyle = pal.petal
              ctx.fill()
              if (f > 0.02) {
                ctx.globalAlpha = f * 0.65
                ctx.fillStyle = pal.petalHi
                ctx.fill()
              }
            } else {
              const d = size * (0.2 + lift * 0.24 + (c === head ? 0.08 : 0))
              ctx.arc(cx + ox, cy + oy, d / 2, 0, Math.PI * 2)
              ctx.globalAlpha = 0.16 + lift * 0.4 + (c === head ? 0.16 : 0)
              ctx.fillStyle = pal.dot
              ctx.fill()
            }
          }
        }
        ctx.globalAlpha = 1
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(opening)
      window.removeEventListener('resize', resize)
      dark.removeEventListener('change', onScheme)
      reduce.removeEventListener('change', onReduce)
      engine.stop()
    }
  }, [])

  const togglePlay = () => {
    if (playingRef.current) {
      engine.stop()
      playingRef.current = false
      playheadRef.current = -1
      setPlaying(false)
    } else {
      engine.start()
      playingRef.current = true
      setPlaying(true)
    }
  }

  // Space plays and pauses unless a control has focus.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.key !== ' ' && e.code !== 'Space') || e.repeat) return
      const t = e.target
      if (t instanceof Element && t.closest('button, input, select, textarea, label')) return
      e.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const cellFromPoint = (e: PointerEvent) => {
    const el = view.board
    if (!el) return -1
    const r = el.getBoundingClientRect()
    const col = Math.floor(((e.clientX - r.left) / r.width) * COLS)
    const row = Math.floor(((e.clientY - r.top) / r.height) * ROWS)
    if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return -1
    return idx(row, col)
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
    const value = !gridRef.current[k]
    paintRef.current = { value, last: k }
    setFocusIdx(k)
    setCell(k, value)
  }

  const onBoardMove = (e: PointerEvent<HTMLDivElement>) => {
    const paint = paintRef.current
    if (!paint) return
    const k = cellFromPoint(e)
    if (k < 0 || k === paint.last) return
    // Fill every cell between the last one and this one, so a quick stroke leaves no gaps.
    let r0 = Math.floor(paint.last / COLS)
    let c0 = paint.last % COLS
    const r1 = Math.floor(k / COLS)
    const c1 = k % COLS
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
      setCell(idx(r0, c0), paint.value)
    }
    paint.last = k
  }

  const endPaint = () => {
    paintRef.current = null
  }

  const onBoardKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = Math.floor(focusIdx / COLS)
    const col = focusIdx % COLS
    let next = -1
    if (e.key === 'ArrowUp') next = idx(clamp(row - 1, 0, ROWS - 1), col)
    else if (e.key === 'ArrowDown') next = idx(clamp(row + 1, 0, ROWS - 1), col)
    else if (e.key === 'ArrowLeft') next = idx(row, clamp(col - 1, 0, COLS - 1))
    else if (e.key === 'ArrowRight') next = idx(row, clamp(col + 1, 0, COLS - 1))
    else if (e.key === 'Home') next = idx(row, 0)
    else if (e.key === 'End') next = idx(row, COLS - 1)
    if (next < 0) return
    e.preventDefault()
    setFocusIdx(next)
    cellEls.current[next]?.focus()
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

  const noteCount = grid.filter(Boolean).length

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

        {/* Mouse-down is cancelled so cells never take focus from a click, and Space still plays. */}
        <div
          ref={(el) => {
            view.board = el
          }}
          className="board"
          role="group"
          aria-label={`Note grid, ${noteCount} notes`}
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={onBoardDown}
          onPointerMove={onBoardMove}
          onPointerUp={endPaint}
          onPointerCancel={endPaint}
          onKeyDown={onBoardKey}
        >
          {grid.map((on, k) => (
            <button
              key={k}
              ref={(el) => {
                cellEls.current[k] = el
              }}
              type="button"
              className="cell"
              tabIndex={k === focusIdx ? 0 : -1}
              aria-pressed={on}
              aria-label={`Step ${(k % COLS) + 1}, pitch ${ROWS - Math.floor(k / COLS)}`}
              onFocus={() => setFocusIdx(k)}
              onClick={(e) => {
                // Pointer presses are handled on the board so you can drag to draw.
                if (e.detail === 0) setCell(k, !on)
              }}
            />
          ))}
        </div>

        <div className="panel">
          <button type="button" className="play" onClick={togglePlay}>
            <PlayIcon playing={playing} />
            {playing ? 'Pause' : 'Play'}
          </button>

          <label className="tempo">
            <span>Tempo</span>
            <input
              type="range"
              min={MIN_BPM}
              max={MAX_BPM}
              value={bpm}
              onChange={(e) => setBpm(Number(e.target.value))}
            />
            <output>{bpm} bpm</output>
          </label>

          <div className="scales">
            <span id="scale-label">Scale</span>
            <div className="scale-options" role="group" aria-labelledby="scale-label">
              {SCALES.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  title={s.detail}
                  aria-pressed={scale === i}
                  onClick={() => setScale(i)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          <p className="hint">
            Draw on the grid to place notes. Higher rows ring higher. Space plays and pauses.
          </p>

          <div className="actions">
            <button type="button" onClick={() => commit(randomTune())}>
              Randomize
            </button>
            <button type="button" onClick={() => commit(new Array<boolean>(CELLS).fill(false))}>
              Clear
            </button>
            <button type="button" onClick={copyLink} aria-live="polite">
              {copyState === 'copied'
                ? 'Link copied'
                : copyState === 'failed'
                  ? 'Copy from the address bar'
                  : 'Copy link'}
            </button>
          </div>
        </div>
      </main>
    </>
  )
}
