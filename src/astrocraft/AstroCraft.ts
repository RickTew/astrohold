// AstroCraft - mini real-time-strategy mission (prototype).
// Self-contained 2D-canvas game gated behind /?astrocraft so the main
// AstroHold game (and the frozen HUD) are never touched. Reuses existing
// pixel sprites for every unit; "buildings" are those structure sprites
// standing on procedural vector FOUNDATION PADS (glowing outline + corner
// brackets) so no new building art is needed - construction renders as a
// hologram fill on the pad. Mouse-only per the project hard rule:
// left-click / drag to select, right-click to move / attack / harvest,
// command-card buttons to build and train, minimap click to jump.
//
// One mission: "First Claim". Mine credit shards, build up, survive the
// cyborg waves, destroy the Cyborg Core on the right side of the map.

type Team = 'robot' | 'cyborg'

interface UnitDef {
  key: string
  label: string
  sprite: string
  hp: number
  speed: number // px/s
  dmg: number
  range: number // px, 0 = melee-ish short
  cooldown: number // s between shots
  radius: number
  drawSize: number
  cost: number
  supply: number
  buildTime: number // s to train
  worker?: boolean
}

interface BuildingDef {
  key: string
  label: string
  sprite: string
  hp: number
  cells: number // footprint is cells x cells
  cost: number
  buildTime: number
  supplyGrant: number
  drawSize: number
  trains?: string[] // unit keys
  dmg?: number
  range?: number
  cooldown?: number
  desc: string
}

const CELL = 48
const COLS = 44
const ROWS = 26
const WORLD_W = COLS * CELL
const WORLD_H = ROWS * CELL
const SUPPLY_CAP = 40

const UNITS: Record<string, UnitDef> = {
  drone: { key: 'drone', label: 'Sphere Drone', sprite: 'sphere', hp: 60, speed: 95, dmg: 3, range: 30, cooldown: 1.0, radius: 12, drawSize: 40, cost: 50, supply: 1, buildTime: 6, worker: true },
  dog: { key: 'dog', label: 'Combat Dog', sprite: 'dog', hp: 90, speed: 150, dmg: 8, range: 30, cooldown: 0.7, radius: 13, drawSize: 46, cost: 50, supply: 1, buildTime: 7 },
  marine: { key: 'marine', label: 'Marine', sprite: 'doublegun', hp: 120, speed: 90, dmg: 10, range: 150, cooldown: 0.9, radius: 14, drawSize: 50, cost: 80, supply: 2, buildTime: 10 },
  heavy: { key: 'heavy', label: 'Heavy', sprite: 'cannon', hp: 220, speed: 60, dmg: 26, range: 215, cooldown: 1.6, radius: 16, drawSize: 54, cost: 120, supply: 3, buildTime: 14 },
  // cyborg side (AI only in this mission)
  gatling: { key: 'gatling', label: 'Cyborg Gatling', sprite: 'cyborg_gatling', hp: 110, speed: 85, dmg: 9, range: 140, cooldown: 0.8, radius: 14, drawSize: 50, cost: 0, supply: 0, buildTime: 0 },
  hulk: { key: 'hulk', label: 'Cyborg Hulk', sprite: 'hulk', hp: 320, speed: 55, dmg: 30, range: 34, cooldown: 1.2, radius: 17, drawSize: 56, cost: 0, supply: 0, buildTime: 0 },
}

const BUILDINGS: Record<string, BuildingDef> = {
  core: { key: 'core', label: 'Command Core', sprite: 'powercore', hp: 1500, cells: 2, cost: 400, buildTime: 40, supplyGrant: 10, drawSize: 92, trains: ['drone'], desc: 'HQ. Trains Sphere Drones, receives credits.' },
  fab: { key: 'fab', label: 'Fabricator', sprite: 'defense', hp: 900, cells: 2, cost: 150, buildTime: 20, supplyGrant: 0, drawSize: 84, trains: ['dog', 'marine', 'heavy'], desc: 'Trains combat units.' },
  pylon: { key: 'pylon', label: 'Relay Pylon', sprite: 'signal', hp: 400, cells: 1, cost: 100, buildTime: 12, supplyGrant: 8, drawSize: 44, desc: '+8 supply.' },
  turret: { key: 'turret', label: 'Sentry Turret', sprite: 'tower', hp: 500, cells: 1, cost: 120, buildTime: 15, supplyGrant: 0, drawSize: 48, dmg: 14, range: 200, cooldown: 0.9, desc: 'Automated defense gun.' },
}

const DIR_NAMES = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east']

interface Shard {
  x: number
  y: number
  amount: number
  seed: number
}

let nextId = 1

class Entity {
  id = nextId++
  team: Team
  x: number
  y: number
  hp: number
  maxHp: number
  dead = false
  // unit fields
  unit?: UnitDef
  vx = 0
  vy = 0
  dir = 2 // south
  moveTarget: { x: number; y: number } | null = null
  attackMove = false
  targetId: number | null = null
  cool = 0
  // worker state
  carrying = 0
  harvestShard: Shard | null = null
  mineTimer = 0
  // building fields
  bld?: BuildingDef
  buildProgress = 1 // 0..1, <1 = under construction
  queue: { key: string; t: number }[] = []
  rallyX = 0
  rallyY = 0

  constructor(team: Team, x: number, y: number, unit?: UnitDef, bld?: BuildingDef) {
    this.team = team
    this.x = x
    this.y = y
    this.unit = unit
    this.bld = bld
    this.maxHp = unit ? unit.hp : bld!.hp
    this.hp = this.maxHp
    this.rallyX = x
    this.rallyY = y + CELL * 1.6
  }
  get radius() {
    return this.unit ? this.unit.radius : (this.bld!.cells * CELL) / 2
  }
  get done() {
    return this.buildProgress >= 1
  }
}

interface Shot {
  x1: number; y1: number; x2: number; y2: number; t: number; team: Team
}
interface Boom {
  x: number; y: number; t: number; big: boolean
}

export function mountAstroCraft() {
  document.title = 'AstroCraft'
  const root = document.createElement('div')
  root.style.cssText = 'position:fixed;inset:0;background:#07090d;z-index:5000;overflow:hidden;font-family:"Courier New",monospace;user-select:none;cursor:default'
  document.body.appendChild(root)
  const cv = document.createElement('canvas')
  cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'
  root.appendChild(cv)
  const ctx = cv.getContext('2d')!

  // ---------- sprites ----------
  const images = new Map<string, HTMLImageElement>()
  const tinted = new Map<string, HTMLCanvasElement>()
  function img(name: string, dir: string): HTMLImageElement | null {
    const key = `${name}/${dir}`
    if (!images.has(key)) {
      const im = new Image()
      im.src = `/sprites/${name}/${dir}.png`
      im.onerror = () => im.setAttribute('data-bad', '1')
      images.set(key, im)
    }
    const im = images.get(key)!
    if (im.getAttribute('data-bad')) return name && dir !== 'south' ? img(name, 'south') : null
    return im.complete && im.naturalWidth > 0 ? im : null
  }
  function redTint(name: string, dir: string): CanvasImageSource | null {
    const base = img(name, dir)
    if (!base) return null
    const key = `${name}/${dir}`
    let c = tinted.get(key)
    if (!c) {
      c = document.createElement('canvas')
      c.width = base.naturalWidth
      c.height = base.naturalHeight
      const t = c.getContext('2d')!
      t.drawImage(base, 0, 0)
      t.globalCompositeOperation = 'source-atop'
      t.fillStyle = 'rgba(255,60,50,0.38)'
      t.fillRect(0, 0, c.width, c.height)
      tinted.set(key, c)
    }
    return c
  }

  // ---------- world state ----------
  const ents: Entity[] = []
  const shards: Shard[] = []
  const shots: Shot[] = []
  const booms: Boom[] = []
  let credits = 200
  let gameTime = 0
  let over: 'win' | 'lose' | null = null
  let msg = 'Mission: FIRST CLAIM. Mine shards, build an army, destroy the Cyborg Core.'
  let msgT = 12

  function say(s: string, t = 6) { msg = s; msgT = t }

  function shardCluster(cx: number, cy: number, n: number) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      shards.push({ x: cx + Math.cos(a) * (26 + (i % 3) * 22), y: cy + Math.sin(a) * (22 + ((i * 7) % 3) * 20), amount: 300, seed: i * 137 + cx })
    }
  }

  // player base, left side
  const pCore = new Entity('robot', CELL * 4, WORLD_H / 2, undefined, BUILDINGS.core)
  ents.push(pCore)
  shardCluster(CELL * 4, WORLD_H / 2 - CELL * 5, 6)
  shardCluster(CELL * 4, WORLD_H / 2 + CELL * 5, 6)
  // expansion shards mid-map
  shardCluster(WORLD_W / 2, CELL * 4, 7)
  shardCluster(WORLD_W / 2, WORLD_H - CELL * 4, 7)
  for (let i = 0; i < 3; i++) {
    const d = new Entity('robot', CELL * 6 + i * 30, WORLD_H / 2 - 40 + i * 40, UNITS.drone)
    ents.push(d)
  }

  // enemy base, right side
  const eCore = new Entity('cyborg', WORLD_W - CELL * 4, WORLD_H / 2, undefined, BUILDINGS.core)
  ents.push(eCore)
  const eTurretDef: BuildingDef = { ...BUILDINGS.turret, sprite: 'cyborg_sentry', label: 'Cyborg Sentry', hp: 450 }
  for (const dy of [-CELL * 3.5, CELL * 3.5]) {
    ents.push(new Entity('cyborg', WORLD_W - CELL * 6.5, WORLD_H / 2 + dy, undefined, eTurretDef))
  }
  for (let i = 0; i < 4; i++) {
    ents.push(new Entity('cyborg', WORLD_W - CELL * 8 - (i % 2) * 40, WORLD_H / 2 - 60 + i * 44, UNITS.gatling))
  }

  // waves
  const waves = [
    { at: 75, units: ['gatling', 'gatling'] },
    { at: 170, units: ['gatling', 'gatling', 'gatling'] },
    { at: 280, units: ['gatling', 'gatling', 'hulk'] },
    { at: 400, units: ['gatling', 'gatling', 'gatling', 'hulk', 'hulk'] },
    { at: 540, units: ['gatling', 'gatling', 'gatling', 'gatling', 'hulk', 'hulk', 'hulk'] },
  ]
  let waveIdx = 0

  // ---------- camera + input ----------
  let camX = 0
  let camY = WORLD_H / 2 - innerHeight / 2
  let mx = 0, my = 0 // screen mouse
  let dragging = false
  let dragX0 = 0, dragY0 = 0
  const selected = new Set<number>()
  let placing: BuildingDef | null = null
  let mouseIn = true

  const wx = () => mx + camX
  const wy = () => my + camY

  function resize() {
    cv.width = innerWidth * devicePixelRatio
    cv.height = innerHeight * devicePixelRatio
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
    ctx.imageSmoothingEnabled = false
  }
  resize()
  addEventListener('resize', resize)

  // ---------- HUD geometry ----------
  const MINI_W = 200
  const mini = () => ({ x: 12, y: innerHeight - MINI_W * (ROWS / COLS) - 12, w: MINI_W, h: MINI_W * (ROWS / COLS) })
  interface Btn { x: number; y: number; w: number; h: number; label: string; sub: string; act: () => void; on: () => boolean }
  let btns: Btn[] = []

  function trainableBuilding(): Entity | null {
    for (const id of selected) {
      const e = ents.find(v => v.id === id && !v.dead)
      if (e?.bld?.trains && e.done) return e
    }
    return null
  }
  function selectedWorkers(): Entity[] {
    return ents.filter(e => selected.has(e.id) && !e.dead && e.unit?.worker)
  }

  function rebuildBtns() {
    btns = []
    const bw = 118, bh = 52, gap = 8
    const baseY = innerHeight - bh - 12
    let x = innerWidth - 12 - (bw + gap) * 4
    const add = (label: string, sub: string, act: () => void, on: () => boolean) => {
      btns.push({ x, y: baseY, w: bw, h: bh, label, sub, act, on })
      x += bw + gap
    }
    const tb = trainableBuilding()
    if (tb) {
      for (const uk of tb.bld!.trains!) {
        const u = UNITS[uk]
        add(u.label, `${u.cost}cr  ${u.supply}sup`, () => {
          if (credits < u.cost) return say('Not enough credits.')
          if (supplyUsed() + u.supply > supplyMax()) return say('Supply blocked. Build a Relay Pylon.')
          credits -= u.cost
          tb.queue.push({ key: uk, t: u.buildTime })
        }, () => true)
      }
    } else if (selectedWorkers().length) {
      for (const bk of ['fab', 'pylon', 'turret'] as const) {
        const b = BUILDINGS[bk]
        add(b.label, `${b.cost}cr`, () => {
          if (credits < b.cost) return say('Not enough credits.')
          placing = b
        }, () => true)
      }
    }
  }

  function supplyUsed() {
    let s = 0
    for (const e of ents) if (!e.dead && e.team === 'robot' && e.unit) s += e.unit.supply
    for (const e of ents) if (!e.dead && e.team === 'robot' && e.bld) for (const q of e.queue) s += UNITS[q.key].supply
    return s
  }
  function supplyMax() {
    let s = 0
    for (const e of ents) if (!e.dead && e.team === 'robot' && e.bld && e.done) s += e.bld.supplyGrant
    return Math.min(SUPPLY_CAP, s)
  }

  // ---------- commands ----------
  function issueRightClick(x: number, y: number) {
    const foe = ents.find(e => !e.dead && e.team === 'cyborg' && Math.hypot(e.x - x, e.y - y) < e.radius + 10)
    const shard = shards.find(s => s.amount > 0 && Math.hypot(s.x - x, s.y - y) < 20)
    let any = false
    for (const id of selected) {
      const e = ents.find(v => v.id === id && !v.dead)
      if (!e) continue
      if (e.unit) {
        any = true
        e.harvestShard = null
        e.targetId = null
        e.attackMove = false
        e.moveTarget = { x, y }
        if (foe) { e.targetId = foe.id; e.attackMove = true }
        else if (shard && e.unit.worker) { e.harvestShard = shard; e.moveTarget = null }
      } else if (e.bld?.trains && e.done) {
        e.rallyX = x; e.rallyY = y
      }
    }
    if (any) ping(x, y, foe ? '#ff5a4a' : '#5ad0ff')
  }

  const pings: { x: number; y: number; t: number; c: string }[] = []
  function ping(x: number, y: number, c: string) { pings.push({ x, y, t: 0.6, c }) }

  function canPlaceAt(b: BuildingDef, x: number, y: number): boolean {
    const half = (b.cells * CELL) / 2
    if (x - half < 0 || y - half < 0 || x + half > WORLD_W || y + half > WORLD_H) return false
    for (const e of ents) {
      if (e.dead) continue
      const r = e.radius + half
      if (Math.abs(e.x - x) < r && Math.abs(e.y - y) < r) return false
    }
    for (const s of shards) if (s.amount > 0 && Math.hypot(s.x - x, s.y - y) < half + 24) return false
    return true
  }

  cv.addEventListener('contextmenu', e => e.preventDefault())
  cv.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY })
  cv.addEventListener('mouseleave', () => { mouseIn = false })
  cv.addEventListener('mouseenter', () => { mouseIn = true })
  cv.addEventListener('mousedown', e => {
    mx = e.clientX; my = e.clientY
    if (over) { location.href = '/?astrocraft'; return }
    const m = mini()
    if (mx >= m.x && mx <= m.x + m.w && my >= m.y && my <= m.y + m.h) {
      camX = ((mx - m.x) / m.w) * WORLD_W - innerWidth / 2
      camY = ((my - m.y) / m.h) * WORLD_H - innerHeight / 2
      return
    }
    if (e.button === 0) {
      for (const b of btns) {
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h && b.on()) { b.act(); rebuildBtns(); return }
      }
      if (placing) {
        const x = Math.round(wx() / CELL) * CELL + (placing.cells % 2 ? CELL / 2 : 0)
        const y = Math.round(wy() / CELL) * CELL + (placing.cells % 2 ? CELL / 2 : 0)
        if (!canPlaceAt(placing, x, y)) return say('Cannot build there.')
        if (credits < placing.cost) { placing = null; return say('Not enough credits.') }
        credits -= placing.cost
        const b = new Entity('robot', x, y, undefined, placing)
        b.buildProgress = 0
        ents.push(b)
        // send one selected worker to "build" (stands by it while it constructs)
        const w = selectedWorkers()[0]
        if (w) { w.harvestShard = null; w.moveTarget = { x: x + b.radius + 20, y } }
        placing = null
        rebuildBtns()
        return
      }
      dragging = true
      dragX0 = mx; dragY0 = my
    } else if (e.button === 2) {
      if (placing) { placing = null; return }
      issueRightClick(wx(), wy())
    }
  })
  cv.addEventListener('mouseup', e => {
    if (e.button !== 0 || !dragging) return
    dragging = false
    const x0 = Math.min(dragX0, mx) + camX, x1 = Math.max(dragX0, mx) + camX
    const y0 = Math.min(dragY0, my) + camY, y1 = Math.max(dragY0, my) + camY
    const isClick = x1 - x0 < 6 && y1 - y0 < 6
    selected.clear()
    if (isClick) {
      const hit = ents.find(en => !en.dead && en.team === 'robot' && Math.hypot(en.x - wx(), en.y - wy()) < en.radius + 8)
      if (hit) selected.add(hit.id)
    } else {
      for (const en of ents) {
        if (en.dead || en.team !== 'robot' || !en.unit) continue
        if (en.x >= x0 && en.x <= x1 && en.y >= y0 && en.y <= y1) selected.add(en.id)
      }
    }
    rebuildBtns()
  })

  // ---------- simulation ----------
  function nearestFoe(e: Entity, range: number): Entity | null {
    let best: Entity | null = null
    let bd = range
    for (const o of ents) {
      if (o.dead || o.team === e.team) continue
      const d = Math.hypot(o.x - e.x, o.y - e.y) - o.radius
      if (d < bd) { bd = d; best = o }
    }
    return best
  }

  function fireAt(e: Entity, t: Entity, dmg: number) {
    shots.push({ x1: e.x, y1: e.y, x2: t.x, y2: t.y, t: 0.12, team: e.team })
    t.hp -= dmg
    if (t.hp <= 0 && !t.dead) {
      t.dead = true
      booms.push({ x: t.x, y: t.y, t: 0.5, big: !!t.bld })
      selected.delete(t.id)
      if (t === eCore) over = 'win'
      if (t === pCore) over = 'lose'
    }
  }

  function step(dt: number) {
    gameTime += dt
    if (msgT > 0) msgT -= dt

    // waves
    if (waveIdx < waves.length && gameTime >= waves[waveIdx].at) {
      const w = waves[waveIdx++]
      say('Cyborg raiding party inbound!', 5)
      w.units.forEach((k, i) => {
        const u = new Entity('cyborg', WORLD_W - CELL * 2, WORLD_H / 2 - 80 + i * 40, UNITS[k])
        u.moveTarget = { x: pCore.x, y: pCore.y }
        u.attackMove = true
        ents.push(u)
      })
    }

    // edge scroll
    const EDGE = 24, SCROLL = 620
    if (mouseIn && !dragging) {
      if (mx < EDGE) camX -= SCROLL * dt
      if (mx > innerWidth - EDGE) camX += SCROLL * dt
      if (my < EDGE) camY -= SCROLL * dt
      if (my > innerHeight - EDGE) camY += SCROLL * dt
    }
    camX = Math.max(0, Math.min(WORLD_W - innerWidth, camX))
    camY = Math.max(0, Math.min(WORLD_H - innerHeight, camY))

    for (const e of ents) {
      if (e.dead) continue
      // buildings
      if (e.bld) {
        if (!e.done) {
          e.buildProgress = Math.min(1, e.buildProgress + dt / e.bld.buildTime)
          if (e.done) { say(`${e.bld.label} online.`); rebuildBtns() }
          continue
        }
        // production queue
        if (e.queue.length) {
          e.queue[0].t -= dt
          if (e.queue[0].t <= 0) {
            const u = UNITS[e.queue.shift()!.key]
            const spawned = new Entity(e.team, e.x, e.y + e.radius + u.radius + 4, u)
            spawned.moveTarget = { x: e.rallyX, y: e.rallyY }
            ents.push(spawned)
            rebuildBtns()
          }
        }
        // turret fire
        if (e.bld.dmg) {
          e.cool -= dt
          const foe = nearestFoe(e, e.bld.range!)
          if (foe && e.cool <= 0) { e.cool = e.bld.cooldown!; fireAt(e, foe, e.bld.dmg) }
        }
        continue
      }

      // units
      const u = e.unit!
      e.cool -= dt

      // worker harvest loop
      if (u.worker && e.harvestShard) {
        const s = e.harvestShard
        if (s.amount <= 0 && e.carrying === 0) {
          const next = shards.find(v => v.amount > 0 && Math.hypot(v.x - s.x, v.y - s.y) < CELL * 4)
          e.harvestShard = next ?? null
          if (!next) say('Shard patch depleted.')
          continue
        }
        if (e.carrying > 0) {
          // return to core
          const d = Math.hypot(pCore.x - e.x, pCore.y - e.y)
          if (d < pCore.radius + e.radius + 6) {
            credits += e.carrying
            e.carrying = 0
          } else moveToward(e, pCore.x, pCore.y, dt)
        } else {
          const d = Math.hypot(s.x - e.x, s.y - e.y)
          if (d < 26) {
            e.mineTimer += dt
            if (e.mineTimer >= 1.4) {
              e.mineTimer = 0
              const take = Math.min(10, s.amount)
              s.amount -= take
              e.carrying = take
            }
          } else moveToward(e, s.x, s.y, dt)
        }
        continue
      }

      // combat targeting
      let target = e.targetId ? ents.find(v => v.id === e.targetId && !v.dead) ?? null : null
      if (!target && (e.attackMove || !e.moveTarget)) {
        target = nearestFoe(e, u.worker ? 0 : 220)
        if (target) e.targetId = target.id
      }
      if (target) {
        const d = Math.hypot(target.x - e.x, target.y - e.y) - target.radius
        if (d <= u.range) {
          faceToward(e, target.x, target.y)
          if (e.cool <= 0) { e.cool = u.cooldown; fireAt(e, target, u.dmg) }
        } else moveToward(e, target.x, target.y, dt)
        continue
      } else e.targetId = null

      if (e.moveTarget) {
        const d = Math.hypot(e.moveTarget.x - e.x, e.moveTarget.y - e.y)
        if (d < 14) { e.moveTarget = null; e.attackMove = false }
        else moveToward(e, e.moveTarget.x, e.moveTarget.y, dt)
      }
    }

    // separation (units push off each other and buildings)
    for (const a of ents) {
      if (a.dead || !a.unit) continue
      for (const b of ents) {
        if (b.dead || a === b) continue
        const dx = a.x - b.x, dy = a.y - b.y
        const min = a.radius + b.radius
        const d = Math.hypot(dx, dy)
        if (d > 0 && d < min) {
          const push = (min - d) * (b.unit ? 0.5 : 1)
          a.x += (dx / d) * push
          a.y += (dy / d) * push
        }
      }
      a.x = Math.max(a.radius, Math.min(WORLD_W - a.radius, a.x))
      a.y = Math.max(a.radius, Math.min(WORLD_H - a.radius, a.y))
    }

    for (let i = shots.length - 1; i >= 0; i--) { shots[i].t -= dt; if (shots[i].t <= 0) shots.splice(i, 1) }
    for (let i = booms.length - 1; i >= 0; i--) { booms[i].t -= dt; if (booms[i].t <= 0) booms.splice(i, 1) }
    for (let i = pings.length - 1; i >= 0; i--) { pings[i].t -= dt; if (pings[i].t <= 0) pings.splice(i, 1) }
  }

  function moveToward(e: Entity, x: number, y: number, dt: number) {
    const dx = x - e.x, dy = y - e.y
    const d = Math.hypot(dx, dy)
    if (d < 1) return
    faceToward(e, x, y)
    e.x += (dx / d) * e.unit!.speed * dt
    e.y += (dy / d) * e.unit!.speed * dt
  }
  function faceToward(e: Entity, x: number, y: number) {
    const a = Math.atan2(y - e.y, x - e.x)
    e.dir = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8
  }

  // ---------- rendering ----------
  function drawPad(x: number, y: number, half: number, color: string, progress: number) {
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.globalAlpha = 0.9
    ctx.strokeRect(x - half, y - half, half * 2, half * 2)
    // corner brackets
    ctx.lineWidth = 3
    const L = Math.max(8, half * 0.35)
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath()
      ctx.moveTo(x + sx * half, y + sy * half - sy * L)
      ctx.lineTo(x + sx * half, y + sy * half)
      ctx.lineTo(x + sx * half - sx * L, y + sy * half)
      ctx.stroke()
    }
    ctx.globalAlpha = 0.12
    ctx.fillStyle = color
    ctx.fillRect(x - half, y - half, half * 2, half * 2)
    if (progress < 1) {
      // hologram construction fill, bottom-up
      ctx.globalAlpha = 0.30
      const h = half * 2 * progress
      ctx.fillRect(x - half, y + half - h, half * 2, h)
    }
    ctx.globalAlpha = 1
  }

  function drawShard(s: Shard) {
    const x = s.x - camX, y = s.y - camY
    const sz = 7 + (s.amount / 300) * 8
    const rot = ((s.seed % 60) / 60) * Math.PI
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    ctx.fillStyle = '#39e6ff'
    ctx.strokeStyle = '#b7f6ff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(0, -sz)
    ctx.lineTo(sz * 0.7, 0)
    ctx.lineTo(0, sz)
    ctx.lineTo(-sz * 0.7, 0)
    ctx.closePath()
    ctx.globalAlpha = 0.85
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.stroke()
    ctx.restore()
  }

  function draw() {
    const W = innerWidth, H = innerHeight
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0a0e14'
    ctx.fillRect(0, 0, W, H)

    // grid
    ctx.strokeStyle = 'rgba(90,140,190,0.10)'
    ctx.lineWidth = 1
    for (let gx = -(camX % CELL); gx < W; gx += CELL) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke() }
    for (let gy = -(camY % CELL); gy < H; gy += CELL) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke() }

    for (const s of shards) if (s.amount > 0) drawShard(s)

    // pings
    for (const p of pings) {
      ctx.strokeStyle = p.c
      ctx.globalAlpha = p.t / 0.6
      ctx.beginPath()
      ctx.arc(p.x - camX, p.y - camY, 10 + (0.6 - p.t) * 40, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    const sorted = [...ents].filter(e => !e.dead).sort((a, b) => a.y - b.y)
    for (const e of sorted) {
      const x = e.x - camX, y = e.y - camY
      if (x < -120 || x > W + 120 || y < -120 || y > H + 120) continue
      const color = e.team === 'robot' ? '#5ad0ff' : '#ff5a4a'
      if (selected.has(e.id)) {
        ctx.strokeStyle = '#8dffb0'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(x, y + (e.bld ? 0 : e.radius * 0.4), e.radius + 5, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (e.bld) {
        drawPad(x, y, e.radius, color, e.buildProgress)
        const sp = e.team === 'cyborg' ? redTint(e.bld.sprite, 'south') : img(e.bld.sprite, 'south')
        if (sp && e.buildProgress > 0.15) {
          ctx.globalAlpha = e.done ? 1 : 0.35 + e.buildProgress * 0.5
          const sz = e.bld.drawSize
          ctx.drawImage(sp, x - sz / 2, y - sz / 2, sz, sz)
          ctx.globalAlpha = 1
        }
      } else {
        const u = e.unit!
        const sp = img(u.sprite, DIR_NAMES[e.dir]) ?? img(u.sprite, 'south')
        const sz = u.drawSize
        // drop shadow tinted by side (per visual style)
        ctx.fillStyle = e.team === 'robot' ? 'rgba(60,140,220,0.30)' : 'rgba(220,70,60,0.30)'
        ctx.beginPath()
        ctx.ellipse(x, y + sz * 0.34, sz * 0.32, sz * 0.12, 0, 0, Math.PI * 2)
        ctx.fill()
        if (sp) ctx.drawImage(sp, x - sz / 2, y - sz / 2, sz, sz)
        if (e.carrying > 0) {
          ctx.fillStyle = '#39e6ff'
          ctx.fillRect(x - 3, y - sz / 2 - 8, 6, 6)
        }
      }
      // hp bar when damaged or selected
      if (e.hp < e.maxHp || selected.has(e.id)) {
        const w = Math.max(26, e.radius * 1.6)
        const yy = y - e.radius - 12
        ctx.fillStyle = 'rgba(0,0,0,0.6)'
        ctx.fillRect(x - w / 2, yy, w, 4)
        ctx.fillStyle = e.hp / e.maxHp > 0.4 ? '#69e07c' : '#ffb03a'
        ctx.fillRect(x - w / 2, yy, w * Math.max(0, e.hp / e.maxHp), 4)
      }
      // production bar
      if (e.bld && e.queue.length) {
        const u = UNITS[e.queue[0].key]
        const w = e.radius * 1.6
        ctx.fillStyle = 'rgba(0,0,0,0.6)'
        ctx.fillRect(x - w / 2, y + e.radius + 6, w, 4)
        ctx.fillStyle = '#5ad0ff'
        ctx.fillRect(x - w / 2, y + e.radius + 6, w * (1 - e.queue[0].t / u.buildTime), 4)
      }
    }

    // shots
    for (const s of shots) {
      ctx.strokeStyle = s.team === 'robot' ? '#9fe4ff' : '#ffb0a0'
      ctx.lineWidth = 2
      ctx.globalAlpha = Math.min(1, s.t / 0.12)
      ctx.beginPath()
      ctx.moveTo(s.x1 - camX, s.y1 - camY)
      ctx.lineTo(s.x2 - camX, s.y2 - camY)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    // booms
    for (const b of booms) {
      const r = (0.5 - b.t) * (b.big ? 140 : 60) + 8
      ctx.strokeStyle = '#ffcf5a'
      ctx.lineWidth = 3
      ctx.globalAlpha = b.t / 0.5
      ctx.beginPath()
      ctx.arc(b.x - camX, b.y - camY, r, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // placement ghost
    if (placing) {
      const x = Math.round(wx() / CELL) * CELL + (placing.cells % 2 ? CELL / 2 : 0)
      const y = Math.round(wy() / CELL) * CELL + (placing.cells % 2 ? CELL / 2 : 0)
      const ok = canPlaceAt(placing, x, y)
      drawPad(x - camX, y - camY, (placing.cells * CELL) / 2, ok ? '#8dffb0' : '#ff5a4a', 1)
      const sp = img(placing.sprite, 'south')
      if (sp) {
        ctx.globalAlpha = 0.5
        ctx.drawImage(sp, x - camX - placing.drawSize / 2, y - camY - placing.drawSize / 2, placing.drawSize, placing.drawSize)
        ctx.globalAlpha = 1
      }
    }

    // drag box
    if (dragging) {
      ctx.strokeStyle = '#8dffb0'
      ctx.lineWidth = 1
      ctx.strokeRect(Math.min(dragX0, mx), Math.min(dragY0, my), Math.abs(mx - dragX0), Math.abs(my - dragY0))
    }

    drawHud()
    if (over) drawOver()
  }

  function drawHud() {
    const W = innerWidth, H = innerHeight
    // top bar
    ctx.fillStyle = 'rgba(8,12,18,0.85)'
    ctx.fillRect(0, 0, W, 34)
    ctx.strokeStyle = 'rgba(90,208,255,0.25)'
    ctx.beginPath(); ctx.moveTo(0, 34); ctx.lineTo(W, 34); ctx.stroke()
    ctx.font = 'bold 15px "Courier New",monospace'
    ctx.fillStyle = '#39e6ff'
    ctx.fillText(`CREDITS ${credits}`, 14, 22)
    const su = supplyUsed(), sm = supplyMax()
    ctx.fillStyle = su >= sm ? '#ffb03a' : '#9fd8ef'
    ctx.fillText(`SUPPLY ${su}/${sm}`, 170, 22)
    ctx.fillStyle = '#6c8aa3'
    ctx.fillText(`ASTROCRAFT - FIRST CLAIM   ${Math.floor(gameTime / 60)}:${String(Math.floor(gameTime % 60)).padStart(2, '0')}`, 320, 22)
    if (waveIdx < waves.length) {
      const t = Math.max(0, waves[waveIdx].at - gameTime)
      ctx.fillStyle = t < 15 ? '#ff5a4a' : '#6c8aa3'
      ctx.fillText(`NEXT RAID ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`, W - 190, 22)
    }

    // message
    if (msgT > 0 && msg) {
      ctx.font = '14px "Courier New",monospace'
      ctx.fillStyle = '#cfe9f5'
      const tw = ctx.measureText(msg).width
      ctx.fillStyle = 'rgba(8,12,18,0.8)'
      ctx.fillRect(W / 2 - tw / 2 - 12, 44, tw + 24, 26)
      ctx.fillStyle = '#cfe9f5'
      ctx.fillText(msg, W / 2 - tw / 2, 62)
    }

    // selection panel
    const selEnts = ents.filter(e => selected.has(e.id) && !e.dead)
    if (selEnts.length) {
      ctx.font = '13px "Courier New",monospace'
      const label = selEnts.length === 1
        ? `${(selEnts[0].unit?.label ?? selEnts[0].bld!.label)}  ${Math.ceil(selEnts[0].hp)}/${selEnts[0].maxHp} hp${selEnts[0].bld && !selEnts[0].done ? '  (constructing)' : ''}`
        : `${selEnts.length} units selected`
      ctx.fillStyle = 'rgba(8,12,18,0.85)'
      ctx.fillRect(W / 2 - 160, H - 34, 320, 24)
      ctx.fillStyle = '#9fd8ef'
      ctx.fillText(label, W / 2 - 150, H - 17)
    }

    // command card
    for (const b of btns) {
      ctx.fillStyle = 'rgba(12,20,30,0.92)'
      ctx.fillRect(b.x, b.y, b.w, b.h)
      ctx.strokeStyle = 'rgba(90,208,255,0.45)'
      ctx.lineWidth = 1
      ctx.strokeRect(b.x, b.y, b.w, b.h)
      ctx.fillStyle = '#cfe9f5'
      ctx.font = 'bold 12px "Courier New",monospace'
      ctx.fillText(b.label, b.x + 8, b.y + 20)
      ctx.fillStyle = '#39e6ff'
      ctx.font = '11px "Courier New",monospace'
      ctx.fillText(b.sub, b.x + 8, b.y + 38)
    }

    // minimap
    const m = mini()
    ctx.fillStyle = 'rgba(8,12,18,0.9)'
    ctx.fillRect(m.x, m.y, m.w, m.h)
    ctx.strokeStyle = 'rgba(90,208,255,0.4)'
    ctx.strokeRect(m.x, m.y, m.w, m.h)
    for (const s of shards) if (s.amount > 0) {
      ctx.fillStyle = '#39e6ff'
      ctx.fillRect(m.x + (s.x / WORLD_W) * m.w - 1, m.y + (s.y / WORLD_H) * m.h - 1, 2, 2)
    }
    for (const e of ents) {
      if (e.dead) continue
      ctx.fillStyle = e.team === 'robot' ? '#5ad0ff' : '#ff5a4a'
      const sz = e.bld ? 4 : 2
      ctx.fillRect(m.x + (e.x / WORLD_W) * m.w - sz / 2, m.y + (e.y / WORLD_H) * m.h - sz / 2, sz, sz)
    }
    ctx.strokeStyle = '#cfe9f5'
    ctx.strokeRect(m.x + (camX / WORLD_W) * m.w, m.y + (camY / WORLD_H) * m.h, (innerWidth / WORLD_W) * m.w, (innerHeight / WORLD_H) * m.h)
  }

  function drawOver() {
    const W = innerWidth, H = innerHeight
    ctx.fillStyle = 'rgba(4,6,10,0.82)'
    ctx.fillRect(0, 0, W, H)
    ctx.textAlign = 'center'
    ctx.font = 'bold 44px "Courier New",monospace'
    ctx.fillStyle = over === 'win' ? '#8dffb0' : '#ff5a4a'
    ctx.fillText(over === 'win' ? 'MISSION COMPLETE' : 'CORE LOST', W / 2, H / 2 - 20)
    ctx.font = '16px "Courier New",monospace'
    ctx.fillStyle = '#cfe9f5'
    ctx.fillText(over === 'win' ? 'The Cyborg Core is destroyed. First Claim is yours.' : 'The cyborgs overran your Command Core.', W / 2, H / 2 + 18)
    ctx.fillText('Click anywhere to play again.', W / 2, H / 2 + 48)
    ctx.textAlign = 'left'
  }

  // ---------- main loop ----------
  // Fixed-timestep loop with catch-up so the sim tracks wall-clock time even
  // when the browser throttles requestAnimationFrame (background/occluded
  // tab, frame hiccups). Catch-up is capped so a long-hidden tab does not
  // fast-forward the whole battle in one frame.
  // The sim is stepped by BOTH requestAnimationFrame and a setInterval:
  // browsers stop rAF entirely for occluded/background windows, but
  // setInterval keeps firing (clamped to ~1/s), so the battle keeps real
  // time either way. tick() is accumulator-based so double-driving never
  // double-steps.
  let last = performance.now()
  const STEP = 1 / 30
  let acc = 0
  function tick() {
    const now = performance.now()
    acc = Math.min(1.5, acc + (now - last) / 1000)
    last = now
    if (over) { acc = 0; return }
    while (acc >= STEP) {
      step(STEP)
      acc -= STEP
      if (over) { acc = 0; break }
    }
  }
  setInterval(tick, 100)
  function frame() {
    tick()
    draw()
    requestAnimationFrame(frame)
  }
  say('Right-click a shard with your Sphere Drones to start mining.', 12)
  requestAnimationFrame(frame)

  // Playtest/debug handle (same spirit as window.astrohold in the main game).
  ;(window as unknown as Record<string, unknown>).astrocraft = {
    state: () => ({
      time: Math.round(gameTime),
      credits,
      supply: `${supplyUsed()}/${supplyMax()}`,
      over,
      selected: [...selected],
      ents: ents.filter(e => !e.dead).map(e => ({
        id: e.id, team: e.team, kind: e.unit?.key ?? e.bld!.key,
        x: Math.round(e.x), y: Math.round(e.y), hp: Math.round(e.hp),
        carrying: e.carrying, progress: e.buildProgress, queue: e.queue.map(q => q.key),
      })),
      shards: shards.reduce((a, s) => a + s.amount, 0),
    }),
    select: (ids: number[]) => { selected.clear(); ids.forEach(i => selected.add(i)); rebuildBtns() },
    rightClick: (x: number, y: number) => issueRightClick(x, y),
    give: (n: number) => { credits += n },
    place: (key: string, x: number, y: number) => {
      const b = BUILDINGS[key]
      if (!b || !canPlaceAt(b, x, y) || credits < b.cost) return 'rejected'
      credits -= b.cost
      const e = new Entity('robot', x, y, undefined, b)
      e.buildProgress = 0
      ents.push(e)
      return e.id
    },
    train: (bldId: number, unitKey: string) => {
      const e = ents.find(v => v.id === bldId && !v.dead)
      const u = UNITS[unitKey]
      if (!e?.bld?.trains || !u || credits < u.cost) return 'rejected'
      credits -= u.cost
      e.queue.push({ key: unitKey, t: u.buildTime })
      return 'queued'
    },
    ff: (seconds: number) => {
      for (let t = 0; t < seconds && !over; t += STEP) step(STEP)
      draw()
    },
  }
}
