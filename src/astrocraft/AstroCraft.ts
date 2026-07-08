// AstroCraft - mini real-time-strategy mission (prototype).
// Self-contained 2D-canvas game gated behind /?astrocraft so the main
// AstroHold game (and the frozen HUD) are never touched. Reuses existing
// pixel sprites for every unit; "buildings" are those structure sprites
// standing on procedural vector FOUNDATION PADS (glowing outline + corner
// brackets) so no new building art is needed - construction renders as a
// hologram fill on the pad. Mouse-only per the project hard rule:
// left-click / drag to select, right-click to move / attack / harvest,
// middle-drag or minimap-drag to pan, mouse wheel to zoom,
// command-card buttons to build and train, minimap click to jump.
//
// One mission: "First Claim". Mine credit shards, build up, survive the
// cyborg waves AND roaming Scavenger raiders, race the enemy for neutral
// supply drops, destroy the Cyborg Core on the right side of the map.

type Team = 'robot' | 'cyborg' | 'raider'

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
  desc: string
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

const TEAM_COLOR: Record<Team, string> = { robot: '#5ad0ff', cyborg: '#ff5a4a', raider: '#c85aff' }
const TEAM_SHADOW: Record<Team, string> = {
  robot: 'rgba(60,140,220,0.30)',
  cyborg: 'rgba(220,70,60,0.30)',
  raider: 'rgba(180,80,220,0.30)',
}

const UNITS: Record<string, UnitDef> = {
  drone: { key: 'drone', label: 'Sphere Drone', sprite: 'sphere', hp: 60, speed: 95, dmg: 3, range: 30, cooldown: 1.0, radius: 12, drawSize: 40, cost: 50, supply: 1, buildTime: 6, worker: true, desc: 'Worker. Right-click a shard to mine credits.' },
  dog: { key: 'dog', label: 'Combat Dog', sprite: 'dog', hp: 90, speed: 150, dmg: 8, range: 30, cooldown: 0.7, radius: 13, drawSize: 46, cost: 50, supply: 1, buildTime: 7, desc: 'Fast, cheap melee attacker. Good for swarms.' },
  marine: { key: 'marine', label: 'Marine', sprite: 'doublegun', hp: 120, speed: 90, dmg: 10, range: 150, cooldown: 0.9, radius: 14, drawSize: 50, cost: 80, supply: 2, buildTime: 10, desc: 'All-round ranged infantry. Backbone of your army.' },
  heavy: { key: 'heavy', label: 'Heavy', sprite: 'cannon', hp: 220, speed: 60, dmg: 26, range: 215, cooldown: 1.6, radius: 16, drawSize: 54, cost: 120, supply: 3, buildTime: 14, desc: 'Slow siege cannon. Outranges enemy sentries.' },
  // cyborg side (AI only in this mission)
  gatling: { key: 'gatling', label: 'Cyborg Gatling', sprite: 'cyborg_gatling', hp: 110, speed: 85, dmg: 9, range: 140, cooldown: 0.8, radius: 14, drawSize: 50, cost: 100, supply: 0, buildTime: 12, desc: 'Cyborg ranged trooper.' },
  hulk: { key: 'hulk', label: 'Cyborg Hulk', sprite: 'hulk', hp: 320, speed: 55, dmg: 30, range: 34, cooldown: 1.2, radius: 17, drawSize: 56, cost: 220, supply: 0, buildTime: 20, desc: 'Cyborg melee bruiser.' },
  // scavenger raiders (neutral hostiles, attack both sides)
  scavenger: { key: 'scavenger', label: 'Scavenger', sprite: 'human_marine', hp: 100, speed: 105, dmg: 9, range: 130, cooldown: 0.85, radius: 14, drawSize: 50, cost: 0, supply: 0, buildTime: 0, desc: 'Neutral raider. Attacks both sides.' },
  scavbrute: { key: 'scavbrute', label: 'Scavenger Brute', sprite: 'grenadier', hp: 200, speed: 75, dmg: 20, range: 160, cooldown: 1.5, radius: 15, drawSize: 52, cost: 0, supply: 0, buildTime: 0, desc: 'Heavy neutral raider. Attacks both sides.' },
}

const BUILDINGS: Record<string, BuildingDef> = {
  core: { key: 'core', label: 'Command Core', sprite: 'powercore', hp: 1500, cells: 2, cost: 400, buildTime: 40, supplyGrant: 10, drawSize: 92, trains: ['drone'], desc: 'HQ. Trains Sphere Drones, receives credits.' },
  fab: { key: 'fab', label: 'Fabricator', sprite: 'defense', hp: 900, cells: 2, cost: 150, buildTime: 20, supplyGrant: 0, drawSize: 84, trains: ['dog', 'marine', 'heavy'], desc: 'War factory. Trains Combat Dogs, Marines and Heavies.' },
  pylon: { key: 'pylon', label: 'Relay Pylon', sprite: 'signal', hp: 400, cells: 1, cost: 100, buildTime: 12, supplyGrant: 8, drawSize: 44, desc: 'Grants +8 supply so you can train a bigger army.' },
  turret: { key: 'turret', label: 'Sentry Turret', sprite: 'tower', hp: 500, cells: 1, cost: 120, buildTime: 15, supplyGrant: 0, drawSize: 48, dmg: 14, range: 200, cooldown: 0.9, desc: 'Automated defense gun. Protects your base.' },
}

const DIR_NAMES = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east']

interface Shard {
  x: number
  y: number
  amount: number
  seed: number
}

interface Crate {
  x: number
  y: number
  t: number // countdown while incoming, age while landed
  landed: boolean
  amount: number
  claimT: number // progress of a claim in seconds
  claimTeam: Team | null
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
  assist = 0 // helpers speeding up construction (display only)
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
interface Spark {
  x: number; y: number; vx: number; vy: number; t: number; max: number; c: string
}
interface FloatText {
  x: number; y: number; t: number; text: string; c: string
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
  const tintedCache = new Map<string, HTMLCanvasElement>()
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
  function tint(name: string, dir: string, color: string): CanvasImageSource | null {
    const base = img(name, dir)
    if (!base) return null
    const key = `${name}/${dir}/${color}`
    let c = tintedCache.get(key)
    if (!c) {
      c = document.createElement('canvas')
      c.width = base.naturalWidth
      c.height = base.naturalHeight
      const t = c.getContext('2d')!
      t.drawImage(base, 0, 0)
      t.globalCompositeOperation = 'source-atop'
      t.fillStyle = color
      t.fillRect(0, 0, c.width, c.height)
      tintedCache.set(key, c)
    }
    return c
  }
  const redTint = (name: string, dir: string) => tint(name, dir, 'rgba(255,60,50,0.38)')
  const purpleTint = (name: string, dir: string) => tint(name, dir, 'rgba(190,70,255,0.34)')

  // ---------- audio ----------
  // Reuses AstroHold's existing audio files. A small dial in the bottom-right
  // corner cycles sound ON -> LOW -> OFF. Music starts on the first click
  // (browser autoplay policy).
  const SFX: Record<string, string> = {
    shotRobot: '/audio/Astrohold3 Suno Sounds/Laser Shot.mp3',
    shotCyborg: '/audio/Astrohold3 Suno Sounds/Cyborg shot.mp3',
    boomSmall: '/audio/Astrohold3 Suno Sounds/Cyborge Grenade Explosion small.mp3',
    boomBig: '/audio/Astrohold3 Suno Sounds/Distant explosion.mp3',
    place: '/audio/Astrohold3 Suno Sounds/Robot placement.mp3',
  }
  let soundMode = 0 // 0 = on, 1 = low, 2 = off
  const soundGain = () => [1, 0.35, 0][soundMode]
  const music = new Audio('/audio/robots.mp3')
  music.loop = true
  let musicStarted = false
  function updateMusicVolume() { music.volume = 0.30 * soundGain() }
  function startMusic() {
    if (musicStarted || soundGain() === 0) return
    musicStarted = true
    updateMusicVolume()
    music.play().catch(() => { musicStarted = false })
  }
  const sfxLast = new Map<string, number>()
  function playSfx(key: string, vol = 0.5) {
    if (soundGain() === 0) return
    const now = performance.now()
    if (now - (sfxLast.get(key) ?? 0) < 120) return
    sfxLast.set(key, now)
    const a = new Audio(SFX[key])
    a.volume = Math.min(1, vol * soundGain())
    a.play().catch(() => {})
  }

  // ---------- world state ----------
  const ents: Entity[] = []
  const shards: Shard[] = []
  const shots: Shot[] = []
  const booms: Boom[] = []
  const sparks: Spark[] = []
  const floats: FloatText[] = []
  const crates: Crate[] = []
  let credits = 200
  let cyCredits = 50 // the red side has a REAL economy now
  let gameTime = 0
  let over: 'win' | 'lose' | null = null
  let msg = 'Mission: FIRST CLAIM. Mine shards, build a FABRICATOR to train your army, destroy the Cyborg Core.'
  let msgT = 12
  let banner = ''
  let bannerT = 0
  let shake = 0

  function say(s: string, t = 6) { msg = s; msgT = t }
  function showBanner(s: string, t = 3.2) { banner = s; bannerT = t }
  function addFloat(x: number, y: number, text: string, c: string) { floats.push({ x, y, t: 1.4, text, c }) }
  function burst(x: number, y: number, n: number, c: string, speed = 130) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const v = speed * (0.3 + Math.random() * 0.9)
      const life = 0.35 + Math.random() * 0.4
      sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: life, max: life, c })
    }
  }

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
  for (let i = 0; i < 3; i++) {
    ents.push(new Entity('cyborg', WORLD_W - CELL * 8 - (i % 2) * 40, WORLD_H / 2 - 60 + i * 44, UNITS.gatling))
  }
  // enemy economy: their own shard patch plus mining drones. Their income is
  // REAL - deposits fill cyCredits, which the Cyborg Core spends on units.
  shardCluster(WORLD_W - CELL * 4, WORLD_H / 2 - CELL * 5, 6)
  const eShard = shards[shards.length - 3]
  for (let i = 0; i < 3; i++) {
    const d = new Entity('cyborg', WORLD_W - CELL * 5 + i * 26, WORLD_H / 2 - CELL * 2 - i * 30, UNITS.drone)
    d.harvestShard = eShard
    ents.push(d)
  }

  // scripted early waves (pressure while both economies spin up)
  const waves = [
    { at: 75, units: ['gatling', 'gatling'] },
    { at: 170, units: ['gatling', 'gatling'] },
    { at: 280, units: ['gatling', 'hulk'] },
  ]
  let waveIdx = 0

  // adaptive cyborg AI (kicks in alongside/after the scripted waves)
  let aiThinkT = 8
  let aiTrainToggle = 0
  // scavenger raiders hit BOTH sides from the top/bottom edges
  let raiderT = 110 + Math.random() * 30
  let raiderWaveN = 0
  // neutral supply drops land near the middle; either side can claim them
  let crateT = 45 + Math.random() * 20

  // ---------- camera + input ----------
  let zoom = 1 // mouse-wheel zoom, world pixels -> screen pixels
  let camX = 0
  let camY = WORLD_H / 2 - innerHeight / 2
  let mx = 0, my = 0 // screen mouse
  let dragging = false
  let dragX0 = 0, dragY0 = 0
  let panning = false // middle-mouse drag pan
  let panX0 = 0, panY0 = 0, panCamX0 = 0, panCamY0 = 0
  let miniDrag = false
  const selected = new Set<number>()
  let placing: BuildingDef | null = null
  let mouseIn = true

  const wx = () => mx / zoom + camX
  const wy = () => my / zoom + camY
  const minZoom = () => Math.max(innerWidth / WORLD_W, innerHeight / WORLD_H, 0.5)
  function clampCam() {
    camX = Math.max(0, Math.min(WORLD_W - innerWidth / zoom, camX))
    camY = Math.max(0, Math.min(WORLD_H - innerHeight / zoom, camY))
  }

  function resize() {
    cv.width = innerWidth * devicePixelRatio
    cv.height = innerHeight * devicePixelRatio
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
    ctx.imageSmoothingEnabled = false
  }
  resize()
  addEventListener('resize', resize)

  // static starfield + nebula, seeded once so it never flickers
  const stars: { x: number; y: number; r: number; a: number }[] = []
  for (let i = 0; i < 260; i++) {
    stars.push({ x: Math.random() * WORLD_W, y: Math.random() * WORLD_H, r: Math.random() < 0.85 ? 1 : 2, a: 0.15 + Math.random() * 0.5 })
  }
  const nebulae: { x: number; y: number; r: number; c: string }[] = []
  for (let i = 0; i < 7; i++) {
    nebulae.push({
      x: Math.random() * WORLD_W, y: Math.random() * WORLD_H,
      r: 220 + Math.random() * 320,
      c: ['rgba(40,70,140,0.10)', 'rgba(110,40,140,0.08)', 'rgba(30,110,120,0.08)'][i % 3],
    })
  }

  // ---------- HUD geometry ----------
  const MINI_W = 200
  const mini = () => ({ x: 12, y: innerHeight - MINI_W * (ROWS / COLS) - 12, w: MINI_W, h: MINI_W * (ROWS / COLS) })
  interface Btn { x: number; y: number; w: number; h: number; label: string; sub: string; tip: string; act: () => void; on: () => boolean }
  let btns: Btn[] = []
  let selPanelW = 320 // actual drawn width, used by the click-through guard

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
    let x = innerWidth - 56 - (bw + gap) * 4 // leaves room for the sound dial
    const add = (label: string, sub: string, tip: string, act: () => void, on: () => boolean) => {
      btns.push({ x, y: baseY, w: bw, h: bh, label, sub, tip, act, on })
      x += bw + gap
    }
    const tb = trainableBuilding()
    if (tb) {
      for (const uk of tb.bld!.trains!) {
        const u = UNITS[uk]
        add(u.label, `${u.cost}cr  ${u.supply}sup`, u.desc, () => {
          if (credits < u.cost) return say('Not enough credits.')
          if (supplyUsed() + u.supply > supplyMax()) return say('Supply blocked. Build a Relay Pylon.')
          credits -= u.cost
          tb.queue.push({ key: uk, t: u.buildTime })
        }, () => true)
      }
    } else if (selectedWorkers().length) {
      for (const bk of ['fab', 'pylon', 'turret'] as const) {
        const b = BUILDINGS[bk]
        add(b.label, `${b.cost}cr`, b.desc, () => {
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
    const foe = ents.find(e => !e.dead && e.team !== 'robot' && Math.hypot(e.x - x, e.y - y) < e.radius + 10)
    const shard = shards.find(s => s.amount > 0 && Math.hypot(s.x - x, s.y - y) < 26)
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

  function miniJump() {
    const m = mini()
    camX = ((mx - m.x) / m.w) * WORLD_W - innerWidth / zoom / 2
    camY = ((my - m.y) / m.h) * WORLD_H - innerHeight / zoom / 2
    clampCam()
  }

  cv.addEventListener('contextmenu', e => e.preventDefault())
  cv.addEventListener('wheel', e => {
    e.preventDefault()
    const px = wx(), py = wy() // keep the world point under the cursor fixed
    zoom = Math.max(minZoom(), Math.min(2, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
    camX = px - mx / zoom
    camY = py - my / zoom
    clampCam()
  }, { passive: false })
  cv.addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY
    if (panning) {
      camX = panCamX0 - (mx - panX0) / zoom
      camY = panCamY0 - (my - panY0) / zoom
      clampCam()
    }
    if (miniDrag) miniJump()
  })
  cv.addEventListener('mouseleave', () => { mouseIn = false })
  cv.addEventListener('mouseenter', () => { mouseIn = true })
  cv.addEventListener('mousedown', e => {
    mx = e.clientX; my = e.clientY
    startMusic()
    if (over) { location.href = '/?astrocraft'; return }
    if (e.button === 1) {
      // middle-mouse drag pans the map (like grabbing it)
      e.preventDefault()
      panning = true
      panX0 = mx; panY0 = my; panCamX0 = camX; panCamY0 = camY
      return
    }
    // sound dial, bottom-right corner
    if (Math.hypot(mx - (innerWidth - 26), my - (innerHeight - 26)) < 17) {
      soundMode = (soundMode + 1) % 3
      updateMusicVolume()
      if (soundMode !== 2) startMusic()
      say(`Sound: ${['ON', 'LOW', 'OFF'][soundMode]}`, 2)
      return
    }
    const m = mini()
    if (mx >= m.x && mx <= m.x + m.w && my >= m.y && my <= m.y + m.h) {
      miniDrag = true
      miniJump()
      return
    }
    // clicks on HUD chrome (top bar, selection panel) must not fall through
    // to the world - that was silently deselecting everything
    const overSelPanel = selected.size > 0
      && mx >= innerWidth / 2 - selPanelW / 2 && mx <= innerWidth / 2 + selPanelW / 2
      && my >= innerHeight - 34 && my <= innerHeight - 10
    if (my <= 34 || overSelPanel) return
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
        playSfx('place', 0.5)
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
    if (e.button === 1) { panning = false; return }
    if (e.button === 0 && miniDrag) { miniDrag = false; return }
    if (e.button !== 0 || !dragging) return
    dragging = false
    const x0 = Math.min(dragX0, mx) / zoom + camX, x1 = Math.max(dragX0, mx) / zoom + camX
    const y0 = Math.min(dragY0, my) / zoom + camY, y1 = Math.max(dragY0, my) / zoom + camY
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
    playSfx(e.team === 'robot' ? 'shotRobot' : 'shotCyborg', 0.18)
    t.hp -= dmg
    burst(t.x, t.y, 2, TEAM_COLOR[e.team], 90)
    if (t.hp <= 0 && !t.dead) {
      t.dead = true
      booms.push({ x: t.x, y: t.y, t: 0.5, big: !!t.bld })
      burst(t.x, t.y, t.bld ? 26 : 10, '#ffcf5a', t.bld ? 220 : 150)
      if (t.bld) shake = Math.max(shake, 9)
      playSfx(t.bld ? 'boomBig' : 'boomSmall', t.bld ? 0.7 : 0.4)
      selected.delete(t.id)
      if (t === eCore) over = 'win'
      if (t === pCore) over = 'lose'
    }
    // call to arms: when a building takes fire, idle friendly combat units
    // nearby converge on the attacker instead of watching the base burn
    if (t.bld && !t.dead) {
      for (const d of ents) {
        if (d.dead || d.team !== t.team || !d.unit || d.unit.worker) continue
        if (d.targetId || d.moveTarget) continue
        if (Math.hypot(d.x - t.x, d.y - t.y) < 640) { d.targetId = e.id; d.attackMove = true }
      }
    }
  }

  function cyborgArmy(): Entity[] {
    return ents.filter(e => !e.dead && e.team === 'cyborg' && e.unit && !e.unit.worker)
  }

  function stepCyborgAI(dt: number) {
    if (eCore.dead) return
    aiThinkT -= dt
    if (aiThinkT > 0) return
    aiThinkT = 6
    // replace lost miners (up to 3) so the red economy keeps running
    const miners = ents.filter(e => !e.dead && e.team === 'cyborg' && e.unit?.worker)
    if (miners.length < 3 && cyCredits >= UNITS.drone.cost && eCore.queue.length < 2) {
      cyCredits -= UNITS.drone.cost
      eCore.queue.push({ key: 'drone', t: UNITS.drone.buildTime })
    }
    // spend the mined credits on an army: alternate gatlings and hulks
    const army = cyborgArmy()
    if (army.length < 8 && eCore.queue.length < 2) {
      const want = aiTrainToggle % 4 === 3 ? UNITS.hulk : UNITS.gatling
      if (cyCredits >= want.cost) {
        cyCredits -= want.cost
        aiTrainToggle++
        eCore.queue.push({ key: want.key, t: want.buildTime })
      }
    }
    // once a strike group is standing around at home, send it at the player.
    // Holds off for the first 4 minutes so the scripted waves stay the only
    // early pressure and the player has time to build defenses.
    const idle = army.filter(e => !e.moveTarget && !e.targetId && e.x > WORLD_W * 0.6)
    if (gameTime > 300 && idle.length >= 6) {
      showBanner('CYBORG ASSAULT DETECTED', 3)
      say('The cyborgs are marching on your base!', 5)
      for (const u of idle) {
        u.moveTarget = { x: pCore.x, y: pCore.y }
        u.attackMove = true
      }
    }
  }

  function spawnRaiders() {
    raiderWaveN++
    const n = Math.min(2 + Math.floor(raiderWaveN / 2), 5)
    const top = Math.random() < 0.5
    const cx = WORLD_W * (0.3 + Math.random() * 0.4)
    showBanner('SCAVENGERS RAIDING', 3.2)
    say('Neutral Scavengers spotted. They attack BOTH sides.', 6)
    for (let i = 0; i < n; i++) {
      const def = i === n - 1 && raiderWaveN >= 2 ? UNITS.scavbrute : UNITS.scavenger
      const u = new Entity('raider', cx + (i - n / 2) * 46, top ? -20 : WORLD_H + 20, def)
      // raiders sweep toward whichever core is closer to their entry point,
      // fighting anything they meet on the way
      const goal = Math.random() < 0.5 ? pCore : eCore
      u.moveTarget = { x: goal.x, y: goal.y }
      u.attackMove = true
      ents.push(u)
    }
  }

  function spawnCrate() {
    const x = WORLD_W * (0.35 + Math.random() * 0.3)
    const y = WORLD_H * (0.2 + Math.random() * 0.6)
    crates.push({ x, y, t: 2.2, landed: false, amount: 150, claimT: 0, claimTeam: null })
    showBanner('SUPPLY DROP INBOUND', 3)
    say('A neutral supply drop is falling near the middle. First side to grab it keeps it.', 7)
    ping(x, y, '#ffcf5a')
  }

  function stepCrates(dt: number) {
    crateT -= dt
    if (crateT <= 0) {
      spawnCrate()
      crateT = 55 + Math.random() * 30
    }
    for (let i = crates.length - 1; i >= 0; i--) {
      const c = crates[i]
      if (!c.landed) {
        c.t -= dt
        if (c.t <= 0) {
          c.landed = true
          c.t = 0
          burst(c.x, c.y, 14, '#ffcf5a', 160)
          playSfx('boomSmall', 0.3)
        }
        continue
      }
      c.t += dt
      // a unit standing next to the crate claims it after a short beat
      let claimer: Entity | null = null
      for (const e of ents) {
        if (e.dead || !e.unit) continue
        if (Math.hypot(e.x - c.x, e.y - c.y) < e.radius + 26) { claimer = e; break }
      }
      if (claimer) {
        if (c.claimTeam !== claimer.team) { c.claimTeam = claimer.team; c.claimT = 0 }
        c.claimT += dt
        if (c.claimT >= 1.2) {
          crates.splice(i, 1)
          burst(c.x, c.y, 18, TEAM_COLOR[claimer.team], 180)
          if (claimer.team === 'robot') {
            credits += c.amount
            addFloat(c.x, c.y, `+${c.amount} SUPPLY DROP`, '#8dffb0')
            say(`Supply drop secured! +${c.amount} credits.`, 5)
          } else if (claimer.team === 'cyborg') {
            cyCredits += c.amount
            addFloat(c.x, c.y, 'CYBORGS TOOK THE DROP', '#ff5a4a')
            say('The cyborgs grabbed the supply drop.', 5)
          } else {
            addFloat(c.x, c.y, 'SCAVENGERS LOOTED IT', '#c85aff')
            say('Scavengers looted the supply drop. Nobody gets it.', 5)
          }
        }
      } else {
        c.claimT = 0
        c.claimTeam = null
      }
      // unclaimed crates evaporate eventually so the map does not clutter
      if (c.t > 75) { crates.splice(i, 1); burst(c.x, c.y, 8, '#6c8aa3', 90) }
    }
  }

  function step(dt: number) {
    gameTime += dt
    if (msgT > 0) msgT -= dt
    if (bannerT > 0) bannerT -= dt
    if (shake > 0) shake = Math.max(0, shake - dt * 18)

    // scripted early waves
    if (waveIdx < waves.length && gameTime >= waves[waveIdx].at) {
      const w = waves[waveIdx++]
      showBanner('CYBORG RAID INBOUND', 3)
      say('Cyborg raiding party inbound!', 5)
      w.units.forEach((k, i) => {
        const u = new Entity('cyborg', WORLD_W - CELL * 2, WORLD_H / 2 - 80 + i * 40, UNITS[k])
        u.moveTarget = { x: pCore.x, y: pCore.y }
        u.attackMove = true
        ents.push(u)
      })
    }

    stepCyborgAI(dt)
    stepCrates(dt)
    raiderT -= dt
    if (raiderT <= 0) {
      spawnRaiders()
      raiderT = 95 + Math.random() * 45
    }

    // edge scroll
    const EDGE = 24, SCROLL = 620 / zoom
    if (mouseIn && !dragging && !panning && !miniDrag) {
      if (mx < EDGE) camX -= SCROLL * dt
      if (mx > innerWidth - EDGE) camX += SCROLL * dt
      if (my < EDGE) camY -= SCROLL * dt
      if (my > innerHeight - EDGE) camY += SCROLL * dt
    }
    clampCam()

    for (const e of ents) {
      if (e.dead) continue
      // buildings
      if (e.bld) {
        if (!e.done) {
          // workers standing next to the site speed construction up:
          // 1x alone, +50% per helper, capped at 2x with two helpers
          let helpers = 0
          if (e.team === 'robot') {
            for (const w of ents) {
              if (!w.dead && w.team === 'robot' && w.unit?.worker && Math.hypot(w.x - e.x, w.y - e.y) < e.radius + 60) helpers++
            }
          }
          e.assist = Math.min(2, helpers)
          const rate = 1 + 0.5 * e.assist
          e.buildProgress = Math.min(1, e.buildProgress + (dt * rate) / e.bld.buildTime)
          if (e.done) {
            say(`${e.bld.label} online.`)
            rebuildBtns()
            // helpers head back to the nearest shard patch on their own
            for (const w of ents) {
              if (w.dead || w.team !== 'robot' || !w.unit?.worker || w.harvestShard || w.targetId) continue
              if (Math.hypot(w.x - e.x, w.y - e.y) > e.radius + 90) continue
              let best: Shard | null = null, bd = Infinity
              for (const s of shards) {
                if (s.amount <= 0) continue
                const d = Math.hypot(s.x - w.x, s.y - w.y)
                if (d < bd) { bd = d; best = s }
              }
              if (best) { w.harvestShard = best; w.moveTarget = null }
            }
          }
          continue
        }
        // production queue
        if (e.queue.length) {
          e.queue[0].t -= dt
          if (e.queue[0].t <= 0) {
            const u = UNITS[e.queue.shift()!.key]
            const spawned = new Entity(e.team, e.x, e.y + e.radius + u.radius + 4, u)
            spawned.moveTarget = { x: e.rallyX, y: e.rallyY }
            if (e.team === 'cyborg' && u.worker) {
              // fresh red miners head straight for their shard patch
              const s = shards.find(v => v.amount > 0 && v.x > WORLD_W * 0.7)
              if (s) { spawned.harvestShard = s; spawned.moveTarget = null }
            }
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
        const home = e.team === 'robot' ? pCore : eCore
        if (home.dead) { e.harvestShard = null; continue }
        if (s.amount <= 0 && e.carrying === 0) {
          const next = shards.find(v => v.amount > 0 && Math.hypot(v.x - s.x, v.y - s.y) < CELL * 4)
          e.harvestShard = next ?? null
          if (!next && e.team === 'robot') say('Shard patch depleted.')
          continue
        }
        if (e.carrying > 0) {
          const d = Math.hypot(home.x - e.x, home.y - e.y)
          if (d < home.radius + e.radius + 6) {
            if (e.team === 'robot') {
              credits += e.carrying
              addFloat(home.x, home.y - home.radius - 8, `+${e.carrying}`, '#39e6ff')
            } else {
              // red income runs at half the player's rate so a decent
              // economy can out-produce the AI
              cyCredits += Math.round(e.carrying * 0.5)
            }
            e.carrying = 0
          } else moveToward(e, home.x, home.y, dt)
        } else {
          const d = Math.hypot(s.x - e.x, s.y - e.y)
          if (d < 26) {
            e.mineTimer += dt
            if (e.mineTimer >= 1.4) {
              e.mineTimer = 0
              const take = Math.min(10, s.amount)
              s.amount -= take
              e.carrying = take
              burst(s.x, s.y, 3, '#39e6ff', 60)
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
      } else if (e.team === 'raider') {
        // idle raiders wander toward the nearest thing worth shooting
        const foe = nearestFoe(e, 4000)
        if (foe) { e.moveTarget = { x: foe.x, y: foe.y }; e.attackMove = true }
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
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]
      s.t -= dt
      if (s.t <= 0) { sparks.splice(i, 1); continue }
      s.x += s.vx * dt
      s.y += s.vy * dt
      s.vx *= 0.94
      s.vy *= 0.94
    }
    for (let i = floats.length - 1; i >= 0; i--) {
      floats[i].t -= dt
      floats[i].y -= 22 * dt
      if (floats[i].t <= 0) floats.splice(i, 1)
    }
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
    const pulse = 0.75 + 0.25 * Math.sin(gameTime * 2 + s.seed)
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    // soft glow halo
    ctx.globalAlpha = 0.10 * pulse
    ctx.fillStyle = '#39e6ff'
    ctx.beginPath()
    ctx.arc(0, 0, sz * 1.9, 0, Math.PI * 2)
    ctx.fill()
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

  function drawCrate(c: Crate) {
    const x = c.x - camX, y = c.y - camY
    if (!c.landed) {
      // falling pod: drop line + pod sliding down + landing ring
      const p = Math.max(0, Math.min(1, 1 - c.t / 2.2))
      const podY = y - (1 - p) * 420
      ctx.strokeStyle = 'rgba(255,207,90,0.35)'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 6])
      ctx.beginPath(); ctx.moveTo(x, podY); ctx.lineTo(x, y); ctx.stroke()
      ctx.setLineDash([])
      ctx.strokeStyle = '#ffcf5a'
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(gameTime * 10)
      ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillStyle = '#ffcf5a'
      ctx.fillRect(x - 8, podY - 8, 16, 16)
      return
    }
    // landed crate: gold container + beacon + claim ring
    const bob = Math.sin(c.t * 3) * 1.5
    ctx.fillStyle = '#c9971f'
    ctx.strokeStyle = '#ffcf5a'
    ctx.lineWidth = 2
    ctx.fillRect(x - 12, y - 10 + bob, 24, 20)
    ctx.strokeRect(x - 12, y - 10 + bob, 24, 20)
    ctx.beginPath(); ctx.moveTo(x, y - 10 + bob); ctx.lineTo(x, y + 10 + bob); ctx.stroke()
    // beacon light
    const blink = 0.4 + 0.6 * Math.abs(Math.sin(c.t * 4))
    ctx.globalAlpha = blink
    ctx.fillStyle = '#ffe9a8'
    ctx.beginPath(); ctx.arc(x, y - 16 + bob, 3, 0, Math.PI * 2); ctx.fill()
    ctx.globalAlpha = 0.15 * blink
    ctx.beginPath(); ctx.arc(x, y - 16 + bob, 10, 0, Math.PI * 2); ctx.fill()
    ctx.globalAlpha = 1
    if (c.claimTeam && c.claimT > 0) {
      ctx.strokeStyle = TEAM_COLOR[c.claimTeam]
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(x, y, 22, -Math.PI / 2, -Math.PI / 2 + (c.claimT / 1.2) * Math.PI * 2)
      ctx.stroke()
    }
  }

  function unitSprite(e: Entity, dir: string): CanvasImageSource | null {
    const u = e.unit!
    if (e.team === 'raider') return purpleTint(u.sprite, dir) ?? purpleTint(u.sprite, 'south')
    if (e.team === 'cyborg' && u.sprite === 'sphere') return redTint(u.sprite, dir) ?? redTint(u.sprite, 'south')
    return img(u.sprite, dir) ?? img(u.sprite, 'south')
  }

  function draw() {
    const W = innerWidth, H = innerHeight
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0a0e14'
    ctx.fillRect(0, 0, W, H)

    // everything until ctx.restore() is drawn in WORLD scale (zoomed)
    ctx.save()
    if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake)
    ctx.scale(zoom, zoom)
    const VW = W / zoom, VH = H / zoom // visible world size

    // nebulae + starfield (world-anchored so they pan with the map)
    for (const n of nebulae) {
      const x = n.x - camX, y = n.y - camY
      if (x < -n.r || x > VW + n.r || y < -n.r || y > VH + n.r) continue
      const g = ctx.createRadialGradient(x, y, 0, x, y, n.r)
      g.addColorStop(0, n.c)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - n.r, y - n.r, n.r * 2, n.r * 2)
    }
    ctx.fillStyle = '#cfe9f5'
    for (const s of stars) {
      const x = s.x - camX, y = s.y - camY
      if (x < 0 || x > VW || y < 0 || y > VH) continue
      ctx.globalAlpha = s.a
      ctx.fillRect(x, y, s.r, s.r)
    }
    ctx.globalAlpha = 1

    // soft team glow under each base corner of the map
    for (const [core, col] of [[pCore, 'rgba(60,140,220,0.05)'], [eCore, 'rgba(220,70,60,0.05)']] as const) {
      if (core.dead) continue
      const x = core.x - camX, y = core.y - camY
      const g = ctx.createRadialGradient(x, y, 0, x, y, CELL * 8)
      g.addColorStop(0, col)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - CELL * 8, y - CELL * 8, CELL * 16, CELL * 16)
    }

    // grid
    ctx.strokeStyle = 'rgba(90,140,190,0.10)'
    ctx.lineWidth = 1 / zoom
    for (let gx = -(camX % CELL); gx < VW; gx += CELL) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, VH); ctx.stroke() }
    for (let gy = -(camY % CELL); gy < VH; gy += CELL) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(VW, gy); ctx.stroke() }
    // world border so the map edge reads when zoomed out
    ctx.strokeStyle = 'rgba(90,208,255,0.30)'
    ctx.lineWidth = 2 / zoom
    ctx.strokeRect(-camX, -camY, WORLD_W, WORLD_H)
    ctx.lineWidth = 1

    for (const s of shards) if (s.amount > 0) drawShard(s)
    for (const c of crates) drawCrate(c)

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
      if (x < -120 || x > VW + 120 || y < -120 || y > VH + 120) continue
      const color = TEAM_COLOR[e.team]
      if (selected.has(e.id)) {
        ctx.strokeStyle = '#8dffb0'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(x, y + (e.bld ? 0 : e.radius * 0.4), e.radius + 5, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (e.bld) {
        // the foundation pad shows only WHILE constructing; finished
        // buildings stand on a soft team-colored glow instead
        if (!e.done) {
          drawPad(x, y, e.radius, color, e.buildProgress)
          if (e.assist > 0) {
            // show that helpers are speeding this up
            ctx.font = 'bold 12px "Courier New",monospace'
            ctx.fillStyle = '#8dffb0'
            ctx.textAlign = 'center'
            ctx.fillText(`BUILD x${(1 + 0.5 * e.assist).toFixed(1).replace('.0', '')}`, x, y - e.radius - 18)
            ctx.textAlign = 'left'
          }
        }
        else {
          ctx.fillStyle = TEAM_SHADOW[e.team].replace('0.30', '0.16')
          ctx.beginPath()
          ctx.ellipse(x, y + e.radius * 0.45, e.radius * 0.85, e.radius * 0.30, 0, 0, Math.PI * 2)
          ctx.fill()
        }
        const sp = e.team === 'cyborg' ? redTint(e.bld.sprite, 'south') : img(e.bld.sprite, 'south')
        if (sp && e.buildProgress > 0.15) {
          ctx.globalAlpha = e.done ? 1 : 0.35 + e.buildProgress * 0.5
          const sz = e.bld.drawSize
          ctx.drawImage(sp, x - sz / 2, y - sz / 2, sz, sz)
          ctx.globalAlpha = 1
        }
      } else {
        const u = e.unit!
        const sp = unitSprite(e, DIR_NAMES[e.dir])
        const sz = u.drawSize
        // drop shadow tinted by side (per visual style)
        ctx.fillStyle = TEAM_SHADOW[e.team]
        ctx.beginPath()
        ctx.ellipse(x, y + sz * 0.34, sz * 0.32, sz * 0.12, 0, 0, Math.PI * 2)
        ctx.fill()
        if (sp) ctx.drawImage(sp, x - sz / 2, y - sz / 2, sz, sz)
        if (e.carrying > 0) {
          ctx.fillStyle = '#39e6ff'
          ctx.fillRect(x - 3, y - sz / 2 - 8, 6, 6)
        }
        // muzzle flash right after firing
        if (e.cool > 0 && u.cooldown - e.cool < 0.08 && !u.worker) {
          ctx.fillStyle = '#fff3c0'
          ctx.globalAlpha = 0.9
          ctx.beginPath()
          ctx.arc(x + Math.cos(e.dir * Math.PI / 4) * (u.radius + 4), y + Math.sin(e.dir * Math.PI / 4) * (u.radius + 4), 4, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
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

    // shots (glowing tracers)
    for (const s of shots) {
      const c = s.team === 'robot' ? '#9fe4ff' : s.team === 'cyborg' ? '#ffb0a0' : '#e0b0ff'
      ctx.globalAlpha = Math.min(1, s.t / 0.12) * 0.35
      ctx.strokeStyle = c
      ctx.lineWidth = 5
      ctx.beginPath()
      ctx.moveTo(s.x1 - camX, s.y1 - camY)
      ctx.lineTo(s.x2 - camX, s.y2 - camY)
      ctx.stroke()
      ctx.globalAlpha = Math.min(1, s.t / 0.12)
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(s.x1 - camX, s.y1 - camY)
      ctx.lineTo(s.x2 - camX, s.y2 - camY)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    // sparks
    for (const s of sparks) {
      ctx.globalAlpha = Math.max(0, s.t / s.max)
      ctx.fillStyle = s.c
      ctx.fillRect(s.x - camX - 1.5, s.y - camY - 1.5, 3, 3)
    }
    ctx.globalAlpha = 1
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
    // floating text
    ctx.font = 'bold 13px "Courier New",monospace'
    ctx.textAlign = 'center'
    for (const f of floats) {
      ctx.globalAlpha = Math.min(1, f.t / 0.5)
      ctx.fillStyle = f.c
      ctx.fillText(f.text, f.x - camX, f.y - camY)
    }
    ctx.globalAlpha = 1
    ctx.textAlign = 'left'

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

    ctx.restore() // back to SCREEN scale

    // drag box (screen space)
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

    // banner (big center alert)
    if (bannerT > 0 && banner) {
      ctx.textAlign = 'center'
      ctx.font = 'bold 28px "Courier New",monospace'
      ctx.globalAlpha = Math.min(1, bannerT / 0.6)
      ctx.fillStyle = 'rgba(8,12,18,0.7)'
      const bw2 = ctx.measureText(banner).width
      ctx.fillRect(W / 2 - bw2 / 2 - 20, 86, bw2 + 40, 44)
      ctx.fillStyle = '#ffcf5a'
      ctx.fillText(banner, W / 2, 116)
      ctx.globalAlpha = 1
      ctx.textAlign = 'left'
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
      const one = selEnts.length === 1 ? selEnts[0] : null
      const label = one
        ? `${(one.unit?.label ?? one.bld!.label)}  ${Math.ceil(one.hp)}/${one.maxHp} hp${one.bld && !one.done ? '  (constructing)' : ''}  -  ${(one.unit ?? one.bld!).desc}`
        : `${selEnts.length} units selected`
      const lw = Math.max(320, ctx.measureText(label).width + 24)
      selPanelW = lw
      ctx.fillStyle = 'rgba(8,12,18,0.85)'
      ctx.fillRect(W / 2 - lw / 2, H - 34, lw, 24)
      ctx.fillStyle = '#9fd8ef'
      ctx.fillText(label, W / 2 - lw / 2 + 10, H - 17)
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
    // hover tooltip above the command card
    const hov = btns.find(b => mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h)
    if (hov?.tip) {
      ctx.font = '12px "Courier New",monospace'
      const tw = ctx.measureText(hov.tip).width
      let tx = Math.min(hov.x, W - tw - 28)
      const ty = hov.y - 34
      ctx.fillStyle = 'rgba(8,12,18,0.95)'
      ctx.fillRect(tx, ty, tw + 16, 24)
      ctx.strokeStyle = 'rgba(90,208,255,0.45)'
      ctx.lineWidth = 1
      ctx.strokeRect(tx, ty, tw + 16, 24)
      ctx.fillStyle = '#cfe9f5'
      ctx.fillText(hov.tip, tx + 8, ty + 16)
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
    for (const c of crates) {
      ctx.fillStyle = '#ffcf5a'
      ctx.fillRect(m.x + (c.x / WORLD_W) * m.w - 2, m.y + (c.y / WORLD_H) * m.h - 2, 4, 4)
    }
    for (const e of ents) {
      if (e.dead) continue
      ctx.fillStyle = TEAM_COLOR[e.team]
      const sz = e.bld ? 4 : 2
      ctx.fillRect(m.x + (e.x / WORLD_W) * m.w - sz / 2, m.y + (e.y / WORLD_H) * m.h - sz / 2, sz, sz)
    }
    ctx.strokeStyle = '#cfe9f5'
    ctx.strokeRect(m.x + (camX / WORLD_W) * m.w, m.y + (camY / WORLD_H) * m.h, (innerWidth / zoom / WORLD_W) * m.w, (innerHeight / zoom / WORLD_H) * m.h)

    // sound dial, bottom-right
    const dx = W - 26, dy = H - 26
    ctx.fillStyle = 'rgba(12,20,30,0.92)'
    ctx.beginPath(); ctx.arc(dx, dy, 15, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = 'rgba(90,208,255,0.45)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(dx, dy, 15, 0, Math.PI * 2); ctx.stroke()
    // speaker body
    ctx.fillStyle = soundMode === 2 ? '#5a6a78' : '#9fd8ef'
    ctx.beginPath()
    ctx.moveTo(dx - 8, dy - 3); ctx.lineTo(dx - 4, dy - 3); ctx.lineTo(dx, dy - 7)
    ctx.lineTo(dx, dy + 7); ctx.lineTo(dx - 4, dy + 3); ctx.lineTo(dx - 8, dy + 3)
    ctx.closePath(); ctx.fill()
    // waves by mode, X when off
    ctx.strokeStyle = ctx.fillStyle
    ctx.lineWidth = 1.5
    if (soundMode === 2) {
      ctx.beginPath(); ctx.moveTo(dx + 3, dy - 4); ctx.lineTo(dx + 9, dy + 4); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(dx + 9, dy - 4); ctx.lineTo(dx + 3, dy + 4); ctx.stroke()
    } else {
      ctx.beginPath(); ctx.arc(dx + 1, dy, 4, -Math.PI / 3, Math.PI / 3); ctx.stroke()
      if (soundMode === 0) { ctx.beginPath(); ctx.arc(dx + 1, dy, 8, -Math.PI / 3, Math.PI / 3); ctx.stroke() }
    }
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
  say('Right-click a shard with your Sphere Drones to mine. Then select a drone and build a FABRICATOR - it trains your attack units.', 14)
  requestAnimationFrame(frame)

  // Playtest/debug handle (same spirit as window.astrohold in the main game).
  ;(window as unknown as Record<string, unknown>).astrocraft = {
    state: () => ({
      time: Math.round(gameTime),
      credits,
      cyCredits: Math.round(cyCredits),
      supply: `${supplyUsed()}/${supplyMax()}`,
      over,
      selected: [...selected],
      crates: crates.map(c => ({ x: Math.round(c.x), y: Math.round(c.y), landed: c.landed })),
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
