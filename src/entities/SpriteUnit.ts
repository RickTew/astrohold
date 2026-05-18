import * as THREE from 'three'
import { Config, UnitType } from '../game/GameConfig'
import { QueuedAction, nextActorId } from '../game/TurnTypes'

// Pixel-sprite attacker unit. Same public shape as Unit (so BattlePhase + Game
// treat them interchangeably). Body is an 8-direction sprite with per-state
// frame animation (idle / walking / shoot|throw / die).

const DIRECTIONS = [
  'east', 'north-east', 'north', 'north-west',
  'west', 'south-west', 'south', 'south-east',
] as const
type Direction = (typeof DIRECTIONS)[number]
const ALL_DIRS = DIRECTIONS as readonly Direction[]

export type AnimState = 'idle' | 'walking' | 'shoot' | 'throw' | 'die'

// Sprite world size — matches the perceived height of the prior 3D cyborg.
const SPRITE_SIZE = 60

// Per-cyborg-type colour tint. Grenadier gets a green wash so it doesn't
// read as the same dark-armoured cyborg as Cannon. Doublegun gets warm
// orange. Untinted types use 0xffffff (multiplicative identity).
const SPRITE_TINT: Partial<Record<UnitType, number>> = {
  grenadier: 0xb0ffb0,
  doublegun: 0xffd0a0,
}
// How far ahead of the unit a projectile should leave from. Tuned so shots
// emerge from the weapon hand, not the chest/stomach.
const MUZZLE_FORWARD = 26

// Horizontal-mirror partner for each direction. Used when a sprite state is
// missing the literal direction — we play the partner and flip sprite.scale.x.
const MIRROR: Record<Direction, Direction> = {
  east:        'west',
  west:        'east',
  'north-east': 'north-west',
  'north-west': 'north-east',
  'south-east': 'south-west',
  'south-west': 'south-east',
  // North and south face directly toward/away from the camera — flipping does
  // not produce a different view, so they're their own mirror (no flip applied).
  north: 'north',
  south: 'south',
}

interface AnimDef {
  state: AnimState
  fps: number
  loop: boolean
  /** Directions that exist on disk for this state. Missing dirs fall back via MIRROR. */
  presentDirs: readonly Direction[]
  frameCount: number
  /** Resolved at preload: every direction → either real frames or [] (use mirror). */
  frames: Map<Direction, THREE.Texture[]>
}

interface UnitAnimSet {
  folder: string
  /** Static fallback for instants where no anim state is set yet. */
  staticTextures: Map<Direction, THREE.Texture>
  anims: Record<AnimState, AnimDef | undefined>
}

const animSets: Map<UnitType, UnitAnimSet> = new Map()

// Per-unit manifest — frame counts and FPS chosen to look right at 1.0s-ish
// loops, matching the per-state frame inventory in /public/sprites/<unit>/.
// `frameCountByDir` lets one direction override the default count when a
// re-rendered clip ships fewer/more frames than the rest (e.g. doublegun's
// north walk is 6 frames vs the other directions' 9).
type AnimManifest = Partial<Record<AnimState, {
  fps: number
  loop: boolean
  presentDirs: readonly Direction[]
  frameCount: number
  frameCountByDir?: Partial<Record<Direction, number>>
}>>
const MANIFEST: Record<string, AnimManifest> = {
  cannon: {
    // Updated Cyborg_Canon_Hand zip ships all 8 idle directions. Walking
    // now also covers all 8 (the user re-exported the WEST clip into a
    // separate folder which we merged in alongside the rest).
    idle:    { fps: 6,  loop: true,  presentDirs: ALL_DIRS, frameCount: 4 },
    walking: { fps: 10, loop: true,  presentDirs: ALL_DIRS, frameCount: 9 },
    // 7 directions on disk (north-east missing → mirrored from north-west).
    shoot:   { fps: 14, loop: false, presentDirs: ['east', 'north', 'north-west', 'south', 'south-east', 'south-west', 'west'], frameCount: 9 },
    die:     { fps: 8,  loop: false, presentDirs: ALL_DIRS, frameCount: 9 },
  },
  grenadier: {
    // BOTH 'east' and 'west' deliberately omitted from idle's presentDirs.
    // The exported east + west idle PNGs are both broken (content faces the
    // wrong direction — visible as "grenadier faces east when placed" since
    // a west-facing unit pulled mirrored east frames and ended up facing
    // east anyway). With both dropped, refreshDirection falls back to the
    // static rotation PNGs (east.png / west.png) which are correctly oriented.
    // Trade-off: no idle animation on E/W facings, but other directions still
    // animate. Other states (walking/throw) are unaffected.
    idle:    { fps: 6,  loop: true,  presentDirs: ['north-east', 'north', 'north-west', 'south', 'south-east', 'south-west'], frameCount: 4 },
    walking: { fps: 10, loop: true,  presentDirs: ALL_DIRS, frameCount: 6 },
    // Throw is two Meshy clips merged: lean_back covers E/NE/NW/W, Medium_Throw
    // covers N/S/SE/SW. Each direction's 9 frames are the right clip for that
    // angle, so the visual reads consistently per facing.
    throw:   { fps: 12, loop: false, presentDirs: ALL_DIRS, frameCount: 9 },
    die:     { fps: 8,  loop: false, presentDirs: ALL_DIRS, frameCount: 4 },
  },
  doublegun: {
    // Full 8 directions per state — no mirroring fallback needed.
    idle:    { fps: 6,  loop: true,  presentDirs: ALL_DIRS, frameCount: 4 },
    // North walk was re-rendered separately at 6 frames (different Meshy
    // export than the other directions' 9-frame walking clip).
    walking: { fps: 10, loop: true,  presentDirs: ALL_DIRS, frameCount: 9, frameCountByDir: { north: 6 } },
    shoot:   { fps: 14, loop: false, presentDirs: ALL_DIRS, frameCount: 9 },
    die:     { fps: 8,  loop: false, presentDirs: ALL_DIRS, frameCount: 9 },
  },
  // Combat Dog (defender). No idle clip — static rotations are used at rest.
  // No shoot — dog has range 0 and never fires. die uses the 4-frame
  // explosion copied into every direction folder (reads the same from any
  // facing since the burst is omnidirectional).
  dog: {
    walking: { fps: 8,  loop: true,  presentDirs: ALL_DIRS, frameCount: 4 },
    die:     { fps: 12, loop: false, presentDirs: ALL_DIRS, frameCount: 4 },
  },
  // Cyborg Hulk — bruiser. Sparse asset coverage (PixelLab export):
  //  - walking: 4 cardinal dirs (diagonals mirror-fallback off N/S)
  //  - shoot (punch): east + west only (others mirror)
  //  - throw (slam-front): 4 cardinal dirs — reserved for the follow-up
  //    special action; currently unused in gameplay
  //  - die (exosuit falls apart): east only — mirrored elsewhere
  // No idle clip — refreshDirection falls back to the static rotation PNGs.
  hulk: {
    walking: { fps: 8,  loop: true,  presentDirs: ['east', 'west', 'north', 'south'], frameCount: 9 },
    shoot:   { fps: 14, loop: false, presentDirs: ['east', 'west'], frameCount: 9 },
    throw:   { fps: 12, loop: false, presentDirs: ['east', 'west', 'north', 'south'], frameCount: 9 },
    die:     { fps: 10, loop: false, presentDirs: ['east'], frameCount: 9 },
  },
}

function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      tex => {
        tex.magFilter = THREE.NearestFilter
        tex.minFilter = THREE.NearestFilter
        tex.colorSpace = THREE.SRGBColorSpace
        resolve(tex)
      },
      undefined,
      reject
    )
  })
}

export async function preloadSpriteUnit(type: UnitType, folder: string): Promise<void> {
  // Static rotation poses (8 PNGs in /public/sprites/<folder>/<dir>.png) —
  // kept as fallback for when no animation state has been triggered yet.
  const staticTextures = new Map<Direction, THREE.Texture>()
  await Promise.all(ALL_DIRS.map(async dir => {
    staticTextures.set(dir, await loadTexture(`/sprites/${folder}/${dir}.png`))
  }))

  const manifest = MANIFEST[folder]
  const anims: Record<AnimState, AnimDef | undefined> = {
    idle: undefined, walking: undefined, shoot: undefined, throw: undefined, die: undefined,
  }
  for (const state of Object.keys(manifest) as AnimState[]) {
    const def = manifest[state]!
    const frames = new Map<Direction, THREE.Texture[]>()
    // Only request directories that exist on disk; mirroring resolves the rest.
    await Promise.all(def.presentDirs.map(async dir => {
      const dirFrames: THREE.Texture[] = []
      const count = def.frameCountByDir?.[dir] ?? def.frameCount
      for (let i = 0; i < count; i++) {
        const num = String(i).padStart(3, '0')
        dirFrames.push(await loadTexture(`/sprites/${folder}/${state}/${dir}/frame_${num}.png`))
      }
      frames.set(dir, dirFrames)
    }))
    anims[state] = { state, fps: def.fps, loop: def.loop, presentDirs: def.presentDirs, frameCount: def.frameCount, frames }
  }

  animSets.set(type, { folder, staticTextures, anims })
}

export class SpriteUnit {
  readonly mesh: THREE.Group
  readonly id: string
  hp: number
  readonly maxHp: number
  readonly type: UnitType
  // 'attacker' = cyborg, 'defender' = robot. Assigned in constructor.
  private readonly _side: 'attacker' | 'defender'
  isDead = false

  // Plan-then-play turn state. Phase 2 (Planning UI) writes queuedActions and
  // deducts apRemaining; phase 3 (Reveal engine) consumes them.
  readonly apBudget: number
  apRemaining: number
  queuedActions: QueuedAction[] = []
  // D&D-style ammo budget — number of shots/throws available for the
  // ENTIRE game (not per turn). RevealPhase checks this before firing and
  // decrements on each fired/thrown action. When 0, the unit is inert
  // (still moves, but can't attack).
  ammoRemaining: number

  private sprite: THREE.Sprite
  private hpBarGroup: THREE.Group
  private hpBarFill: THREE.Mesh
  // A/B test: Double Gun uses a circular ring around its sprite instead of
  // the floating bar. Other types keep the bar so the two styles can be
  // compared on the same battlefield.
  private hpRing: THREE.Mesh | null = null

  private logicalX: number
  private logicalY: number
  // Source cell during a walk — kept until the mesh visually reaches the new
  // logical position. BattlePhase reads it via `prevWorldX/Y` so a second
  // unit can't move into a cell whose previous occupant is still walking
  // out of it (fixes the visual overlap bug where two cyborgs briefly shared
  // a tile).
  private prevX: number
  private prevY: number
  private isMoving = false
  private deathTime = 0
  private readonly moveSpeedPS: number

  // Initial facing: cyborgs face west toward the power core; defender mobile
  // units (combat dogs) face east toward incoming cyborgs. Stored as a math
  // angle (0=+X east, π/2=+Y north, π=+X west).
  private facingAngle: number
  private currentDir: Direction

  // Active animation state, frame index, and elapsed time within the frame.
  private currentState: AnimState = 'idle'
  private frameIndex = 0
  private frameTime = 0
  private currentFrames: THREE.Texture[] = []
  // Pending state to enter once the current one-shot finishes (shoot/throw).
  private pendingState: AnimState | null = null

  constructor(
    scene: THREE.Scene,
    type: UnitType,
    spawnX: number,
    spawnY?: number,
    side: 'attacker' | 'defender' = 'attacker',
  ) {
    this.type = type
    this._side = side
    this.id = nextActorId(side === 'defender' ? 'robot' : 'cyborg')
    this.hp = this.maxHp = Config.UNITS[type].hp
    this.apBudget = Config.UNITS[type].apBudget
    this.apRemaining = this.apBudget
    this.ammoRemaining = Config.UNITS[type].ammo
    this.moveSpeedPS = Config.UNITS[type].speed / Config.TURN_INTERVAL
    // Defenders look east toward the cyborg side; attackers look west toward
    // the core. Drives the initial sprite direction.
    this.facingAngle = side === 'defender' ? 0 : Math.PI
    this.currentDir = side === 'defender' ? 'east' : 'west'

    const spread = Config.WORLD.TOP - Config.WORLD.BOTTOM - 40
    const y = spawnY ?? (Math.random() - 0.5) * spread

    this.logicalX = spawnX
    this.logicalY = y
    this.prevX = spawnX
    this.prevY = y

    this.mesh = new THREE.Group()
    this.mesh.position.set(spawnX, y, 0)

    const set = animSets.get(type)
    const mat = new THREE.SpriteMaterial({
      map: set?.staticTextures.get('west') ?? null,
      // Per-type colour tint so unit roles read clearly even at a glance.
      // Multiplied against the sprite, so grenadier gets a green wash and
      // doublegun gets a warm orange wash without changing the source art.
      // Cannon / dog / etc. stay neutral (white = identity).
      color: SPRITE_TINT[type] ?? 0xffffff,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      alphaTest: 0.1,
    })
    this.sprite = new THREE.Sprite(mat)
    this.sprite.scale.set(SPRITE_SIZE, SPRITE_SIZE, 1)
    // Centered on mesh.position — top-down grid: piece sits in its cell, not
    // anchored at the feet.
    this.sprite.position.set(0, 0, 5)
    this.sprite.renderOrder = 10
    this.mesh.add(this.sprite)

    const { group, fill } = this.buildHpBar()
    this.hpBarGroup = group
    this.hpBarFill = fill
    // Plan-then-watch model: HP overlays add clutter while the player is just
    // watching the reveal play out. Hide them on every piece — death
    // animations still communicate "this thing died." The bar mesh stays in
    // place (and takeDamage still updates it) so flipping visible back on
    // later is one line.
    this.hpBarGroup.visible = false

    this.playState('idle')

    scene.add(this.mesh)
  }

  private buildHpRing(ratio: number): THREE.Mesh {
    // Ring sits flat in the X-Y plane (matches the top-down camera). renderOrder
    // is set BELOW the sprite (which is 10) so the sprite covers the inner
    // empty area and the visible ring reads as a halo at the piece's edge.
    const INNER = 28, OUTER = 34
    const theta = Math.max(0, ratio) * Math.PI * 2
    const geo = new THREE.RingGeometry(INNER, OUTER, 32, 1, Math.PI / 2, theta)
    const mat = new THREE.MeshBasicMaterial({
      color: ringColor(ratio),
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(0, 0, 2)
    mesh.renderOrder = 9
    return mesh
  }

  private updateHpRing(ratio: number) {
    if (!this.hpRing) return
    this.hpRing.geometry.dispose()
    const theta = Math.max(0, ratio) * Math.PI * 2
    this.hpRing.geometry = new THREE.RingGeometry(28, 34, 32, 1, Math.PI / 2, theta)
    ;(this.hpRing.material as THREE.MeshBasicMaterial).color.setHex(ringColor(ratio))
  }

  // ── Public API (matches Unit's old surface) ───────────────────────────────

  get worldX() { return this.logicalX }
  get worldY() { return this.logicalY }
  get prevWorldX() { return this.prevX }
  get prevWorldY() { return this.prevY }
  get isWalking() { return this.isMoving }
  get side(): 'attacker' | 'defender' { return this._side }
  get speed()    { return Config.UNITS[this.type].speed }
  get damage()   { return Config.UNITS[this.type].damage }
  get range()    { return Config.UNITS[this.type].range }
  // Initiative = speed verbatim. Higher = acts earlier in the reveal.
  get initiative() { return Config.UNITS[this.type].speed }

  clearPlan() {
    this.queuedActions = []
    this.apRemaining = this.apBudget
  }
  refillAp() { this.apRemaining = this.apBudget }
  queueAction(action: QueuedAction, apCost: number) {
    this.queuedActions.push(action)
    this.apRemaining -= apCost
  }
  get isScout()  { return this.type === 'scout' }
  get isBomber() { return this.type === 'bomber' }

  moveTo(x: number, y: number) {
    // Remember where we came from so occupancy checks block the source cell
    // until our mesh visually reaches the new logical position.
    this.prevX = this.logicalX
    this.prevY = this.logicalY
    this.logicalX = x
    this.logicalY = y
    this.isMoving = true
    // Only start walking if we're not in the middle of a one-shot (shoot/throw).
    if (this.currentState !== 'shoot' && this.currentState !== 'throw' && this.currentState !== 'die') {
      this.playState('walking')
    }
  }

  takeDamage(amount: number) {
    if (this.isDead) return
    this.hp = Math.max(0, this.hp - amount)
    const ratio = this.hp / this.maxHp
    this.hpBarFill.scale.x = ratio
    this.hpBarFill.position.x = -(1 - ratio) * 12   // half of new bar width 24
    const mat = this.hpBarFill.material as THREE.MeshBasicMaterial
    mat.color.setHex(ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
    if (this.hpRing) this.updateHpRing(ratio)
    if (this.hp <= 0) this.kill()
  }

  kill() {
    if (this.isDead) return
    this.isDead = true
    this.isMoving = false
    this.playState('die')
  }

  // Trigger the firing/throwing one-shot. Grenadier throws; everyone else
  // shoots. Returns to walking/idle automatically once the clip completes.
  playAttackAnim() {
    if (this.isDead) return
    const state: AnimState = this.type === 'grenadier' ? 'throw' : 'shoot'
    if (!animSets.get(this.type)?.anims[state]) return  // unit has no shoot/throw clip
    this.playState(state)
  }

  faceTarget(x: number, y: number) {
    const dx = x - this.logicalX
    const dy = y - this.logicalY
    if (dx * dx + dy * dy < 0.01) return
    this.facingAngle = Math.atan2(dy, dx)
    this.refreshDirection()
  }

  getMuzzlePoint(): { x: number; y: number } {
    return {
      x: this.logicalX + Math.cos(this.facingAngle) * MUZZLE_FORWARD,
      y: this.logicalY + Math.sin(this.facingAngle) * MUZZLE_FORWARD,
    }
  }

  faceCamera(camera: THREE.Camera) {
    this.hpBarGroup.quaternion.copy(camera.quaternion)
  }

  update(delta: number) {
    // Always advance the current clip — even when dead, so the death animation
    // plays out before we freeze on the final frame.
    this.advanceFrame(delta)

    if (this.isDead) {
      // Keep the death pose visible for a beat after the clip clamps, then
      // hide the mesh so corpses don't pile up. Game logic still filters by
      // isDead, so hiding the visual is enough.
      this.deathTime += delta
      if (this.deathTime > 2 && this.mesh.visible) this.mesh.visible = false
      return
    }

    if (this.isMoving) {
      const dx = this.logicalX - this.mesh.position.x
      const dy = this.logicalY - this.mesh.position.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const step = this.moveSpeedPS * delta

      if (step >= dist) {
        this.mesh.position.x = this.logicalX
        this.mesh.position.y = this.logicalY
        this.isMoving = false
        // Walk complete — the source cell is no longer occupied by this unit.
        this.prevX = this.logicalX
        this.prevY = this.logicalY
        // Drop back to idle ONLY if we're not in a one-shot — shoot/throw will
        // return to its own resolution.
        if (this.currentState === 'walking') this.playState('idle')
      } else {
        this.mesh.position.x += (dx / dist) * step
        this.mesh.position.y += (dy / dist) * step
      }

      if (dist > 0.1) {
        this.facingAngle = Math.atan2(dy, dx)
        this.refreshDirection()
      }
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private playState(state: AnimState) {
    if (this.currentState === state && this.frameIndex < this.currentFrames.length) return
    this.currentState = state
    this.frameIndex = 0
    this.frameTime = 0
    this.pendingState = null
    this.refreshDirection()
  }

  // Resolve the texture set for the current (state, direction). Handles the
  // missing-direction → MIRROR fallback by flipping sprite.scale.x.
  private refreshDirection() {
    const set = animSets.get(this.type)
    if (!set) return

    // Compute target direction from facing angle. '+ 16' keeps the modulo a
    // multiple of 8 so the bucket maps correctly (a non-integer offset rotates
    // every direction; see session 8 fix).
    const norm = ((this.facingAngle / (Math.PI / 4)) + 16) % 8
    const idx = Math.round(norm) % 8
    this.currentDir = DIRECTIONS[idx]

    const anim = set.anims[this.currentState]
    let frames: THREE.Texture[] | undefined
    let mirrored = false

    if (anim) {
      frames = anim.frames.get(this.currentDir)
      if (!frames) {
        const partner = MIRROR[this.currentDir]
        frames = anim.frames.get(partner)
        mirrored = partner !== this.currentDir   // skip flip if dir is its own mirror (N/S)
      }
    }

    // Final fallback: static rotation pose for the resolved direction.
    if (!frames || frames.length === 0) {
      const tex = set.staticTextures.get(this.currentDir) ?? null
      this.sprite.material.map = tex
      this.sprite.material.needsUpdate = true
      this.currentFrames = []
      this.sprite.scale.set(SPRITE_SIZE, SPRITE_SIZE, 1)
      return
    }

    this.currentFrames = frames
    // Clamp frame index so re-resolving mid-clip doesn't try to address past
    // the new direction's frame count (most states are uniform, but defensive).
    if (this.frameIndex >= frames.length) this.frameIndex = frames.length - 1
    this.sprite.material.map = frames[this.frameIndex]
    this.sprite.material.needsUpdate = true
    this.sprite.scale.set(mirrored ? -SPRITE_SIZE : SPRITE_SIZE, SPRITE_SIZE, 1)
  }

  private advanceFrame(delta: number) {
    const anim = animSets.get(this.type)?.anims[this.currentState]
    if (!anim || this.currentFrames.length === 0) return

    this.frameTime += delta
    const frameDuration = 1 / anim.fps
    while (this.frameTime >= frameDuration) {
      this.frameTime -= frameDuration
      const next = this.frameIndex + 1
      if (next >= this.currentFrames.length) {
        if (anim.loop) {
          this.frameIndex = 0
        } else {
          // Clamp on final frame.
          this.frameIndex = this.currentFrames.length - 1
          // One-shot finished — transition back. Death stays on final frame.
          if (this.currentState === 'shoot' || this.currentState === 'throw') {
            this.playState(this.isMoving ? 'walking' : 'idle')
            return
          }
          break
        }
      } else {
        this.frameIndex = next
      }
      this.sprite.material.map = this.currentFrames[this.frameIndex]
      this.sprite.material.needsUpdate = true
    }
  }

  private buildHpBar(): { group: THREE.Group; fill: THREE.Mesh } {
    const group = new THREE.Group()
    // Sprite is 60 world units but the cyborg body only fills ~70% of that
    // (head reaches ~+20). Bar sits just above the head with a small gap.
    group.position.set(0, 22, 0)

    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 3),
      new THREE.MeshBasicMaterial({ color: 0xcc2222 })
    )
    bg.position.z = 0.1
    group.add(bg)

    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 3),
      new THREE.MeshBasicMaterial({ color: 0x00cc44 })
    )
    fill.position.z = 0.2
    group.add(fill)

    this.mesh.add(group)
    return { group, fill }
  }
}

function ringColor(ratio: number): number {
  return ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200
}
