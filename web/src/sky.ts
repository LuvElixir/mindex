/**
 * 知识星图渲染器（首页横带）——编辑式精密感的暗夜星图。
 * 定版审美原则（2026-07，与设计规范一致）：
 *  - 极小锐核 + 纤细锥形衍射光芒（菱形轴向渐变，尖端自然消失）
 *  - 链状星座（随机游走折线，主星如 α 星居链中段），不是轮辐网络图
 *  - 发丝级连线且两端留隙不触星（星图排版规矩）
 *  - 幂律星等背景场给纵深；静为常态，偶发单星闪烁是唯一事件级动效
 *  - 蓝色只在「有含义」时出现：可信主星、检索点亮、引用悬停
 * 每个星座 = 一个真实项目；检索命中时星座点亮、光尘流向输入框。
 */

export interface SkyProject {
  id: string
  name: string
  claims: number
  trusted: number
  entities: string[]
}

export interface SkyHandle {
  /** 点亮某项目的星座（null 熄灭）——引用悬停/回答归因用 */
  setFlare(projectId: string | null): void
  /** 从命中项目的星座向输入框方向撒一阵光尘 */
  burst(projectIds: string[]): void
  /** 未命中：一道冷光掠过，无星应答 */
  sweep(): void
  destroy(): void
}

interface StarNode {
  cluster: number
  idx: number
  proj: boolean
  hi: boolean
  hiSat: boolean
  x: number
  y: number
  px: number
  py: number
  r: number
  z: number
  tw: number
  label: string | null
}

const WHITE: [number, number, number] = [224, 232, 246]
const DIMW: [number, number, number] = [190, 200, 220]
const BLUE: [number, number, number] = [110, 156, 255]
const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

export function mountSky(canvas: HTMLCanvasElement, projects: SkyProject[], onClickProject?: (id: string) => void): SkyHandle {
  const ctx = canvas.getContext('2d')!
  const box = canvas.parentElement!
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches

  let W = 0, H = 0, DPR = 1
  let stars: StarNode[] = []
  let segs: { a: StarNode; b: StarNode; cluster: number }[] = []
  let field: { x: number; y: number; r: number; a: number; z: number; tw: number; sp: number }[] = []
  let particles: { x0: number; y0: number; x1: number; y1: number; t: number; life: number; ph: number }[] = []
  const flare = { cluster: -1, k: 0 }
  const sweepSt = { on: false, x: -1e4 }
  let glintStar: StarNode | null = null, glintT0 = 0, nextGlint = 3000
  let raf = 0, dead = false

  const idToCluster = new Map(projects.map((p, i) => [p.id, i]))

  // 每个项目一个稳定种子（名字哈希）——布局不随刷新跳动
  function hash(s: string): number {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
    return h >>> 0
  }
  function makeRnd(seed0: number) {
    let seed = seed0 || 1
    return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  }

  function build() {
    stars = []; segs = []; field = []
    const n = projects.length
    projects.forEach((p, i) => {
      const rnd = makeRnd(hash(p.id))
      // 少项目时向中心收拢，避免两颗星孤悬两角
      const spacing = n <= 1 ? 0 : Math.min(0.26, 0.80 / (n - 1))
      const fx = 0.5 + (i - (n - 1) / 2) * spacing
      const ax = fx * W - 30
      const ay = H * (0.40 + (i % 2 ? 0.16 : -0.04)) + (rnd() - 0.5) * 20
      const chainN = Math.min(6, Math.max(3, p.entities.length + 1))
      const chain: { x: number; y: number }[] = []
      let x = ax, y = ay, ang = rnd() * 6.283
      for (let j = 0; j < chainN; j++) {
        chain.push({ x, y })
        ang += (rnd() - 0.5) * 1.6
        const step = 34 + rnd() * 26
        x += Math.cos(ang) * step; y += Math.sin(ang) * step * 0.62
      }
      const alphaIdx = 1 + Math.floor(rnd() * Math.min(2, chainN - 2))
      const hi = p.claims >= 2 && p.trusted / Math.max(1, p.claims) >= 0.5
      const out: StarNode[] = []
      chain.forEach((pt, j) => {
        const isA = j === alphaIdx
        out.push({
          cluster: i, idx: j, proj: isA, hi: hi && isA, hiSat: hi && j === alphaIdx + 1,
          x: pt.x, y: pt.y, px: pt.x, py: pt.y,
          r: isA ? 1.9 : 0.85 + rnd() * 0.6,
          z: 0.75 + rnd() * 0.45, tw: rnd() * 6.283,
          label: isA ? p.name : null,
        })
        if (j > 0) segs.push({ a: out[j - 1]!, b: out[j]!, cluster: i })
      })
      if (rnd() < 0.4 && chainN >= 5) {
        const from = out[alphaIdx]!
        const ba = rnd() * 6.283
        const bs: StarNode = { cluster: i, idx: chainN, proj: false, hi: false, hiSat: false,
          x: from.x + Math.cos(ba) * 40, y: from.y + Math.sin(ba) * 26, px: 0, py: 0,
          r: 0.8 + rnd() * 0.4, z: 0.7 + rnd() * 0.4, tw: rnd() * 6.283, label: null }
        out.push(bs); segs.push({ a: from, b: bs, cluster: i })
      }
      stars.push(...out)
    })
    const rnd = makeRnd(97)
    const cnt = Math.floor((W * H) / 1900)
    for (let k = 0; k < cnt; k++) {
      const m = rnd() ** 2.6
      field.push({ x: rnd() * W, y: rnd() * H, r: 0.25 + m, a: 0.04 + m * 0.42, z: 0.15 + rnd() * 0.5, tw: rnd() * 6.283, sp: 0.25 + rnd() * 0.7 })
    }
  }

  function resize() {
    DPR = Math.min(devicePixelRatio || 1, 2)
    W = box.clientWidth; H = box.clientHeight
    canvas.width = W * DPR; canvas.height = H * DPR
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    build()
  }
  const ro = new ResizeObserver(resize)
  ro.observe(box)

  /** 锥形衍射光芒：细长菱形 + 轴向渐变 */
  function taperedSpike(x: number, y: number, L: number, hw: number, color: [number, number, number], alpha: number) {
    for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
      const g = ctx.createLinearGradient(x - dx * L, y - dy * L, x + dx * L, y + dy * L)
      g.addColorStop(0, rgba(color, 0)); g.addColorStop(0.5, rgba(color, alpha)); g.addColorStop(1, rgba(color, 0))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.moveTo(x - dx * L, y - dy * L)
      ctx.lineTo(x - dy * hw, y - dx * hw)
      ctx.lineTo(x + dx * L, y + dy * L)
      ctx.lineTo(x + dy * hw, y + dx * hw)
      ctx.closePath(); ctx.fill()
    }
  }

  let t0 = performance.now()
  function frame(now: number) {
    if (dead) return
    const dt = Math.min(40, now - t0); t0 = now; const t = now / 1000
    ctx.clearRect(0, 0, W, H)

    const hz = ctx.createLinearGradient(0, H - 90, 0, H)
    hz.addColorStop(0, 'rgba(70,100,170,0)'); hz.addColorStop(1, 'rgba(70,100,170,0.045)')
    ctx.fillStyle = hz; ctx.fillRect(0, H - 90, W, 90)

    const dx = reduce ? 0 : Math.sin(t * 0.05) * 6, dy = reduce ? 0 : Math.cos(t * 0.045) * 4
    for (const s of stars) { s.px = s.x + dx * s.z; s.py = s.y + dy * s.z }
    flare.k += ((flare.cluster >= 0 ? 1 : 0) - flare.k) * Math.min(1, dt / 300)

    for (const f of field) {
      const tw = reduce ? 1 : 0.75 + 0.25 * Math.sin(t * f.sp + f.tw)
      ctx.fillStyle = rgba(DIMW, f.a * tw)
      ctx.beginPath(); ctx.arc(f.x + dx * f.z, f.y + dy * f.z, f.r, 0, 6.283); ctx.fill()
    }

    for (const sg of segs) {
      const lit = flare.cluster === sg.cluster
      const dim = flare.cluster >= 0 && !lit ? 1 - 0.55 * flare.k : 1
      const ax = sg.a.px, ay = sg.a.py, bx = sg.b.px, by = sg.b.py
      const dxx = bx - ax, dyy = by - ay, len = Math.hypot(dxx, dyy)
      if (len < 18) continue
      const gap = 7, ux = dxx / len, uy = dyy / len
      ctx.strokeStyle = rgba(lit ? BLUE : DIMW, (lit ? 0.07 + 0.18 * flare.k : 0.075) * dim)
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(ax + ux * gap, ay + uy * gap)
      ctx.lineTo(bx - ux * gap, by - uy * gap)
      ctx.stroke()
    }

    if (!reduce && glintStar === null && now > nextGlint && stars.length > 0) {
      const cands = stars.filter((s) => s.proj || s.hiSat)
      if (cands.length) { glintStar = cands[Math.floor(Math.random() * cands.length)]!; glintT0 = now }
    }
    let gk = 0
    if (glintStar) {
      const gt = (now - glintT0) / 1700
      if (gt >= 1) { glintStar = null; nextGlint = now + 5200 + Math.random() * 4600 }
      else gk = Math.sin(gt * Math.PI)
    }

    ctx.globalCompositeOperation = 'lighter'
    for (const s of stars) {
      const isFlare = flare.cluster === s.cluster
      const isGl = glintStar === s
      const dim = flare.cluster >= 0 && !isFlare ? 1 - 0.45 * flare.k : 1
      const boost = (isFlare ? 1 + 0.45 * flare.k : 1) * (isGl ? 1 + 0.9 * gk : 1)
      const col = isGl && s.hiSat ? BLUE : s.hi ? BLUE : s.proj ? WHITE : DIMW
      const tw = reduce ? 1 : 0.84 + 0.16 * Math.sin(t * (s.proj ? 1.1 : 1.7) + s.tw)

      if (s.proj) {
        const halo = 11 * boost
        const hg = ctx.createRadialGradient(s.px, s.py, 0, s.px, s.py, halo)
        hg.addColorStop(0, rgba(col, 0.30 * dim)); hg.addColorStop(1, rgba(col, 0))
        ctx.fillStyle = hg
        ctx.beginPath(); ctx.arc(s.px, s.py, halo, 0, 6.283); ctx.fill()
      }
      ctx.fillStyle = rgba(col, Math.min(1, (s.proj ? 0.98 : 0.8) * dim))
      ctx.beginPath(); ctx.arc(s.px, s.py, s.r * Math.sqrt(boost), 0, 6.283); ctx.fill()

      if (s.proj) {
        const breathe = reduce ? 1 : 1 + 0.05 * Math.sin(t * 0.7 + s.tw)
        const L = (s.hi ? 34 : 26) * breathe * boost * (1 + (isGl ? 0.5 * gk : 0))
        const a = (s.hi ? 0.5 : 0.38) * dim * (1 + (isGl ? 0.5 * gk : 0)) * tw
        taperedSpike(s.px, s.py, L, 0.7, col, Math.min(0.85, a))
      } else if (isGl && gk > 0) {
        taperedSpike(s.px, s.py, 22 * gk, 0.55, s.hiSat ? BLUE : WHITE, 0.55 * gk * dim)
      }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!
      p.t += dt / p.life
      if (p.t >= 1) { particles.splice(i, 1); continue }
      const e = p.t * p.t * (3 - 2 * p.t)
      const x = p.x0 + (p.x1 - p.x0) * e + Math.sin(p.t * 7 + p.ph) * 4 * (1 - p.t)
      const y = p.y0 + (p.y1 - p.y0) * e
      const g = ctx.createRadialGradient(x, y, 0, x, y, 4.5)
      g.addColorStop(0, rgba(BLUE, 0.55 * (1 - p.t * 0.5))); g.addColorStop(1, rgba(BLUE, 0))
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 6.283); ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'

    if (sweepSt.on) {
      sweepSt.x += dt * 0.8
      const g = ctx.createLinearGradient(sweepSt.x - 50, 0, sweepSt.x + 50, 0)
      g.addColorStop(0, 'rgba(170,185,210,0)'); g.addColorStop(0.5, 'rgba(170,185,210,0.10)'); g.addColorStop(1, 'rgba(170,185,210,0)')
      ctx.fillStyle = g; ctx.fillRect(sweepSt.x - 50, 0, 100, H)
      if (sweepSt.x > W + 60) sweepSt.on = false
    }

    ctx.textAlign = 'center'
    ctx.font = '500 10px "IBM Plex Mono", "PingFang SC", monospace'
    for (const s of stars) {
      if (!s.label) continue
      const isFlare = flare.cluster === s.cluster
      const dim = flare.cluster >= 0 && !isFlare ? 1 - 0.5 * flare.k : 1
      ctx.fillStyle = rgba([168, 180, 202], (isFlare ? 0.95 : 0.55) * dim)
      ctx.fillText(s.label, s.px, s.py + 50)
    }
    raf = requestAnimationFrame(frame)
  }

  // 主星点击 → 进入项目；悬停给 pointer
  function pick(e: MouseEvent): StarNode | null {
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    for (const s of stars) {
      if (!s.proj) continue
      if ((s.px - mx) ** 2 + (s.py - my) ** 2 < 16 * 16) return s
    }
    return null
  }
  const onMove = (e: MouseEvent) => { canvas.style.cursor = pick(e) ? 'pointer' : 'default' }
  const onClick = (e: MouseEvent) => {
    const s = pick(e)
    if (s && onClickProject) onClickProject(projects[s.cluster]!.id)
  }
  canvas.addEventListener('mousemove', onMove)
  canvas.addEventListener('click', onClick)

  resize()
  raf = requestAnimationFrame(frame)

  return {
    setFlare(projectId) {
      flare.cluster = projectId === null ? -1 : (idToCluster.get(projectId) ?? -1)
    },
    burst(projectIds) {
      const sinkX = W / 2, sinkY = H + 4
      const from = stars.filter((s) => projectIds.some((id) => idToCluster.get(id) === s.cluster))
      if (from.length === 0) return
      let i = 0
      const iv = setInterval(() => {
        if (dead || i++ >= 12) return clearInterval(iv)
        const s = from[Math.floor(Math.random() * from.length)]!
        particles.push({ x0: s.px, y0: s.py, x1: sinkX, y1: sinkY, t: 0, life: 800 + Math.random() * 400, ph: Math.random() * 6.283 })
      }, 70)
    },
    sweep() { sweepSt.on = true; sweepSt.x = -50 },
    destroy() {
      dead = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('click', onClick)
    },
  }
}
