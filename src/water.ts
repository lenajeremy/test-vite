export type RGB = [number, number, number]

/**
 * A height-field wave simulation. Each step a point's next height is
 * the average of its neighbours minus its previous height, so drops spread as rings
 * and slowly calm down.
 */
export class Water {
  w = 0
  h = 0
  cur = new Float32Array(0)
  prev = new Float32Array(0)
  damping = 0.985

  resize(w: number, h: number) {
    this.w = w
    this.h = h
    this.cur = new Float32Array(w * h)
    this.prev = new Float32Array(w * h)
  }

  drop(x: number, y: number, radius: number, amp: number) {
    const { w, h, cur } = this
    const r = Math.ceil(radius)
    const cx = Math.round(x)
    const cy = Math.round(y)
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = cx + dx
        const py = cy + dy
        if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) continue
        const d = Math.hypot(dx, dy) / radius
        if (d > 1) continue
        cur[py * w + px] += amp * (0.5 + 0.5 * Math.cos(d * Math.PI))
      }
    }
  }

  step() {
    const { w, h, cur, prev, damping } = this
    for (let y = 1; y < h - 1; y++) {
      const row = y * w
      for (let x = 1; x < w - 1; x++) {
        const i = row + x
        prev[i] = ((cur[i - 1] + cur[i + 1] + cur[i - w] + cur[i + w]) * 0.5 - prev[i]) * damping
      }
    }
    this.prev = cur
    this.cur = prev
  }

  /** Shade the surface as if lit from the top left. */
  paint(data: Uint8ClampedArray, base: RGB, hi: RGB, lo: RGB, gain: number) {
    const { w, h, cur } = this
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        let s = 0
        if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
          s = (cur[i - 1] - cur[i + 1] + cur[i - w] - cur[i + w]) * gain
        }
        const j = i * 4
        if (s >= 0) {
          const t = s > 1 ? 1 : s
          data[j] = base[0] + (hi[0] - base[0]) * t
          data[j + 1] = base[1] + (hi[1] - base[1]) * t
          data[j + 2] = base[2] + (hi[2] - base[2]) * t
        } else {
          const t = s < -1 ? 1 : -s
          data[j] = base[0] + (lo[0] - base[0]) * t
          data[j + 1] = base[1] + (lo[1] - base[1]) * t
          data[j + 2] = base[2] + (lo[2] - base[2]) * t
        }
        data[j + 3] = 255
      }
    }
  }
}
