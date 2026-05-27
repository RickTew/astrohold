import * as THREE from 'three'
import { Config, UnitType, TEAM_TINT } from '../game/GameConfig'
import { QueuedAction, nextActorId } from '../game/TurnTypes'
import { spawnHealVfx, HealVfxVariant } from './HealVfx'
import { spawnSpeechBubble, SpeechTrigger, SpeechVoice } from './SpeechBubble'
import { makeShadowSprite } from '../scene/Shadow'

// Pixel-sprite attacker unit. Same public shape as Unit (so BattlePhase + Game
// treat them interchangeably). Body is an 8-direction sprite with per-state
// frame animation (idle / walking / shoot|throw / die).

const DIRECTIONS = [
  'east', 'north-east', 'north', 'north-west',
  'west', 'south-west', 'south', 'south-east',
] as const
type Direction = (typeof DIRECTIONS)[number]
const ALL_DIRS = DIRECTIONS as readonly Direction[]

export type AnimState = 'idle' | 'walking' | 'shoot' | 'throw' | 'die' | 'repair' | 'aim'

// Sprite world size — matches the perceived height of the prior 3D cyborg.
const SPRITE_SIZE = 60
// Per-type size overrides. Hulk is a bruiser — visually larger than a
// rank-and-file cyborg so his presence on the field is unmistakable.
const SPRITE_SIZE_OVERRIDE: Partial<Record<UnitType, number>> = {
  hulk:    84,
  // Stalker is a heavy bruiser too — bigger than rank-and-file cyborgs
  // (60) but visibly smaller than the Hulk so silhouette difference is
  // still readable on the field.
  stalker: 76,
}
function spriteSizeFor(type: UnitType): number {
  return SPRITE_SIZE_OVERRIDE[type] ?? SPRITE_SIZE
}

// Per-unit shadow foot fraction override. Default 0.74 in Shadow.ts
// matches the bulk of the cyborg roster. Small per-piece nudges only.
// Going further than +/-0.04 from the default produces visible
// shadow-sprite misalignment (0.68 pulled the dog shadow off-piece
// in S20 testing).
const UNIT_FOOT_FRACTION: Partial<Record<UnitType, number>> = {
  dog:  0.72,
  hulk: 0.78,
}

// Per-type colour tints — kept empty so cyborgs render with their natural
// sprite-art colours instead of the previous Grenadier-green / Doublegun-
// orange / Sniper-olive multiplicative washes. Removed at user request:
// the washes made unit identity ambiguous on the battlefield. Differentiation
// now comes from the source art alone.
const SPRITE_TINT: Partial<Record<UnitType, number>> = {}
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
  // Cyborg Sniper — precision-strike unit. Asset coverage:
  //  - No idle clip — the PixelLab "standing_still" export is actually a
  //    kneel-with-rifle-grounded pose that read as "still aiming" to the
  //    player, so we let refreshDirection fall back to the upright static
  //    rotation PNGs when the sniper is at rest after their one shot.
  //  - walking: 4 cardinal dirs; diagonals mirror off N/S.
  //  - shoot (sniper-rifle pose): 7 directions — E/W use the crouches clip,
  //    N/NE/NW use the back-aiming clip, SE/SW use the holding clip. South
  //    is the only gap; mirror logic + static south.png covers it.
  //  - die: full 8 directions, 9-frame ragdoll.
  sniper: {
    walking: { fps: 8,  loop: true,  presentDirs: ['east', 'west', 'north', 'south'], frameCount: 9 },
    shoot:   { fps: 12, loop: false, presentDirs: ['east', 'west', 'north', 'north-east', 'north-west', 'south-east', 'south-west'], frameCount: 9 },
    die:     { fps: 10, loop: false, presentDirs: ALL_DIRS, frameCount: 9 },
    // Crouched-aiming "in position" pose — one static frame per direction
    // (final frame of the PixelLab crouches_and_prepares clip). Only east
    // and west ship; other facings fall back to static rotation via the
    // refreshDirection chain. loop:true so the single frame holds.
    aim:     { fps: 1,  loop: true,  presentDirs: ['east', 'west'], frameCount: 1 },
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
  // Cyborg Medic — support unit. PixelLab export ships three animation states:
  //  - idle (Breathing_Idle): 4 frames × all 8 directions.
  //  - walking: 6 frames × all 8 directions.
  //  - die (stops_and_drops_dead): 9 frames × all 8 directions.
  // No throw / shoot clip — the medic snaps to the static rotation pose
  // for the brief throw moment.
  medic: {
    idle:    { fps: 6,  loop: true,  presentDirs: ALL_DIRS, frameCount: 4 },
    walking: { fps: 10, loop: true,  presentDirs: ALL_DIRS, frameCount: 6 },
    die:     { fps: 10, loop: false, presentDirs: ALL_DIRS, frameCount: 9 },
  },
  // Robot Repair — defender-side support unit. PixelLab export ships:
  //  - Moving: 9 frames × all 8 directions (we copy the cd902ba1 NW variant —
  //    the export bundled two; the 5d69b613 one is staged on disk but unused).
  //  - Repair: 9-frame action clip × all 8 directions — currently unused at
  //    runtime since SpriteUnit has no 'repair' AnimState; staged on disk for
  //    a future visual pass. The repair-* actions snap to static rotation
  //    just like the medic does for heal-*.
  //  - die: explodes ships only N + S; we duplicated north-frames into every
  //    direction folder during extract (matches the Combat Dog's death pattern).
  // No idle clip ships — rest falls back to the static rotation PNGs.
  repair: {
    walking: { fps: 10, loop: true,  presentDirs: ALL_DIRS, frameCount: 9 },
    // Welding/working pose — one-shot played when the bot drops a pad or
    // attaches a tether. PixelLab ships 9 frames × all 8 directions.
    repair:  { fps: 12, loop: false, presentDirs: ALL_DIRS, frameCount: 9 },
    die:     { fps: 10, loop: false, presentDirs: ALL_DIRS, frameCount: 4 },
  },
  // Cyborg Stalker — cloaked melee unit. MANIFEST is keyed by FOLDER
  // name (matches preloadSpriteUnit's `folder` arg), so the key here is
  // 'cyborg_stalker', not 'stalker'. PixelLab export ships:
  //  - walking: 9 frames × all 8 directions.
  //  - shoot (strike): 9 frames × east + west only — other dirs mirror.
  // No idle clip — refreshDirection falls back to static rotation PNGs.
  // No die anim either — defaults to instant-hide on death.
  cyborg_stalker: {
    walking: { fps: 10, loop: true,  presentDirs: ALL_DIRS, frameCount: 9 },
    shoot:   { fps: 14, loop: false, presentDirs: ['east', 'west'], frameCount: 9 },
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
    idle: undefined, walking: undefined, shoot: undefined, throw: undefined, die: undefined, repair: undefined, aim: undefined,
  }
  // All states + all directions + all frames load concurrently. HTTP/2 lets
  // the browser multiplex these, so total wall-clock load time drops from
  // serial-frame-count × per-request-latency to roughly one request worth.
  await Promise.all((Object.keys(manifest) as AnimState[]).map(async state => {
    const def = manifest[state]!
    const frames = new Map<Direction, THREE.Texture[]>()
    // Only request directories that exist on disk; mirroring resolves the rest.
    await Promise.all(def.presentDirs.map(async dir => {
      const count = def.frameCountByDir?.[dir] ?? def.frameCount
      const dirFrames = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          loadTexture(`/sprites/${folder}/${state}/${dir}/frame_${String(i).padStart(3, '0')}.png`)
        )
      )
      frames.set(dir, dirFrames)
    }))
    anims[state] = { state, fps: def.fps, loop: def.loop, presentDirs: def.presentDirs, frameCount: def.frameCount, frames }
  }))

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
  // Hulk-only — slam attack uses its own ammo counter so a Hulk who's
  // burned through slams can still punch. Non-Hulks default to 0 and
  // never trigger the slam branch.
  slamAmmoRemaining: number
  // Repair-only. Separate pool tracking how many ammo refills the bot
  // can dispense to adjacent friendly defender pieces before it has
  // to dock at the Power Core to top up. Non-repair units default to
  // 0 and never trigger the refill code path. Config.UNITS.repair
  // declares the starting value via the optional refillCharges field.
  refillRemaining: number

  // Medic tether reference. Non-null on BOTH the medic and the target
  // while a Tether is active between them. RevealPhase reads this to
  // pin both units (default-action returns 'hold') and ticks the
  // tether at the start of each reveal. Cleared when the tether ends.
  // Typed as `unknown` here to avoid a circular import with Tether.ts;
  // RevealPhase casts at the read site.
  tether: unknown = null

  // Cell the unit came FROM on its most recent move. Persists across
  // reveals so pickStepTowardPoint can avoid backtracking — a unit that
  // sidestepped north past a wall should keep heading north rather than
  // oscillating N → S → N. Default -999 = "never moved" so the first step
  // has no backtrack restriction. Updated in moveTo.
  lastTraversedCol = -999
  lastTraversedRow = -999

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
  // Sniper-only: tracks whether the unit has spent a turn settling into the
  // crouched aim pose. Sniper rule — can NOT crouch and shoot the same turn;
  // the first turn in range is spent crouching (no fire), the next turn fires.
  // Reset by moveTo (walking breaks the crouch) and standUpFromAim.
  private _crouched = false
  // EMP stun: while > 0, the unit's default action returns 'hold' and
  // decrements by 1. Set by Signal EMP strikes (RevealPhase). Survives
  // through walks/fires since it's a forced inaction — the cyborg's
  // systems are disabled regardless of intent.
  stunnedTurns = 0
  // Cloak (Stalker mechanic). Starts true for stalker spawn; drops to
  // false PERMANENTLY on the first damage-dealing action this unit
  // makes. While cloaked, defender targeting AI skips this unit (see
  // RevealPhase.pickNearestEnemyOf et al). AoE/splash damage still
  // hits — geometry-based, not targeting-based. Sprite renders at 35%
  // opacity while cloaked so the player can still see them but they
  // read as stealth-mode.
  cloaked = false

  constructor(
    scene: THREE.Scene,
    type: UnitType,
    spawnX: number,
    spawnY?: number,
    side: 'attacker' | 'defender' = 'attacker',
    team: 'player' | 'ai' = 'player',
  ) {
    this.type = type
    this._side = side
    this.id = nextActorId(side === 'defender' ? 'robot' : 'cyborg')
    this.hp = this.maxHp = Config.UNITS[type].hp
    this.apBudget = Config.UNITS[type].apBudget
    this.apRemaining = this.apBudget
    this.ammoRemaining = Config.UNITS[type].ammo
    this.slamAmmoRemaining = (Config.UNITS[type] as { slamAmmo?: number }).slamAmmo ?? 0
    this.refillRemaining = (Config.UNITS[type] as { refillCharges?: number }).refillCharges ?? 0
    this.moveSpeedPS = Config.UNITS[type].speed / Config.TURN_INTERVAL
    // Stalker spawns cloaked — drops on first damage-dealing action.
    if (type === 'stalker') this.cloaked = true
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
    // Per-type colour tint × team tint. Per-type gives the role a green wash
    // (grenadier) or warm orange (doublegun); team tint stacks on top so
    // player pieces feel cool-blue and AI pieces feel warm-red. The two
    // multiply, so a player grenadier reads green-leaning-teal and an AI
    // grenadier reads green-leaning-olive — visually distinct in any matchup.
    const tintColor = new THREE.Color(SPRITE_TINT[type] ?? 0xffffff)
      .multiply(new THREE.Color(TEAM_TINT[team]))
    const mat = new THREE.SpriteMaterial({
      map: set?.staticTextures.get('west') ?? null,
      color: tintColor,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      alphaTest: 0.1,
    })
    this.sprite = new THREE.Sprite(mat)
    this.sprite.scale.set(spriteSizeFor(this.type), spriteSizeFor(this.type), 1)
    // Centered on mesh.position — top-down grid: piece sits in its cell, not
    // anchored at the feet.
    this.sprite.position.set(0, 0, 5)
    this.sprite.renderOrder = 10
    this.mesh.add(this.sprite)
    // Stalker spawns visibly ghosted (35% opacity) to telegraph the cloak.
    if (this.cloaked) this.sprite.material.opacity = 0.35
    // Side-themed grounded drop shadow. Defenders blue, attackers red.
    // Moves with the mesh group as the unit walks. See src/scene/Shadow.ts.
    this.mesh.add(makeShadowSprite({
      size: spriteSizeFor(this.type),
      side: this._side,
      footFraction: UNIT_FOOT_FRACTION[this.type],
    }))

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
    // Walking breaks the sniper crouch — must re-settle before next shot.
    this._crouched = false
    // Remember where we came from so occupancy checks block the source cell
    // until our mesh visually reaches the new logical position.
    this.prevX = this.logicalX
    this.prevY = this.logicalY
    // Persistent "came-from" memory for anti-backtrack in pickStepTowardPoint
    // (kept across reveals, unlike prevX/Y which resets when the walk
    // animation completes).
    this.lastTraversedCol = Math.floor((this.prevX - Config.WORLD.LEFT) / Config.GRID_CELL)
    this.lastTraversedRow = Math.floor((this.prevY - Config.WORLD.BOTTOM) / Config.GRID_CELL)
    this.logicalX = x
    this.logicalY = y
    this.isMoving = true
    // Only start walking if we're not in the middle of a one-shot (shoot/throw).
    if (this.currentState !== 'shoot' && this.currentState !== 'throw' && this.currentState !== 'repair' && this.currentState !== 'die') {
      this.playState('walking')
    }
  }

  takeDamage(amount: number) {
    if (this.isDead) return
    // Stalker cloak drop on incoming damage. Direct fire never reaches a
    // cloaked Stalker (defender targeting skips them), so any takeDamage
    // call on a cloaked Stalker means AoE / splash / mine — which makes
    // a lot of noise and reveals their position. Drop the cloak.
    if (this.cloaked) this.dropCloak()
    this.hp = Math.max(0, this.hp - amount)
    const ratio = this.hp / this.maxHp
    this.hpBarFill.scale.x = ratio
    this.hpBarFill.position.x = -(1 - ratio) * 12   // half of new bar width 24
    const mat = this.hpBarFill.material as THREE.MeshBasicMaterial
    mat.color.setHex(ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
    if (this.hpRing) this.updateHpRing(ratio)
    if (this.hp <= 0) this.kill()
    this.checkSpeechTriggers()
  }

  // Status callout system — once per unit per condition. Triggered after
  // damage (HP threshold) and after ammo decrement (RevealPhase calls
  // notifyAmmoChanged). Cyborg voice for attackers, robot voice for
  // defender mobile units (dog, repair bot).
  private spokenSet = new Set<SpeechTrigger>()
  checkSpeechTriggers() {
    if (this.isDead) return
    if (this.hp / this.maxHp <= 0.25) this.maybeSpeak('low_hp')
    // Melee-only units (hulk, stalker) skip the ammo callouts. Their
    // ammo field is ignored at the engine level (RevealPhase treats
    // them as meleeUnlimited), so "out of ammo" / "low ammo" would
    // be a lie. Stalker's "bonus" is stealth, not a finite weapon
    // pool. Hulk's slamAmmo is tracked separately.
    if (this.type === 'hulk' || this.type === 'stalker') return
    // Medic + Repair: ammo represents heal charges. Different callout
    // ("X packs left" instead of "X rounds left") to match the mechanic.
    if (this.type === 'medic' || this.type === 'repair') {
      if (this.ammoRemaining === 2) this.maybeSpeak('medic_low_packs', { n: 2 })
      else if (this.ammoRemaining === 1) this.maybeSpeak('medic_low_packs', { n: 1 })
      else if (this.ammoRemaining === 0) this.maybeSpeak('out_of_ammo')
      return
    }
    // Offensive units. Show actual round count in the low-ammo bubble.
    if (this.ammoRemaining > 0 && this.ammoRemaining <= 2) {
      this.maybeSpeak('low_ammo', { n: this.ammoRemaining })
    } else if (this.ammoRemaining === 0) {
      this.maybeSpeak('out_of_ammo')
    }
  }
  notifyAmmoChanged() { this.checkSpeechTriggers() }
  // One-shot announcement (fires once per battle). Used by RevealPhase
  // to call out specific events like "sniper takes the shot."
  announceOnce(trigger: SpeechTrigger) {
    this.maybeSpeak(trigger)
  }
  // Always-announce (no dedupe). Used for callouts that should fire
  // each time the event happens — ammo crate spotted / picked up, etc.
  announce(trigger: SpeechTrigger) {
    const scene = this.mesh.parent
    if (!(scene instanceof THREE.Scene)) return
    const voice: SpeechVoice = this._side === 'attacker' ? 'cyborg' : 'robot'
    spawnSpeechBubble(scene, this.logicalX, this.logicalY, voice, trigger)
  }
  private maybeSpeak(trigger: SpeechTrigger, context?: { n?: number }) {
    // Each (trigger + n value) is gated independently so we can say
    // "3 shots left" then later "1 shot left" — same trigger, different
    // counts. The key includes the substituted value.
    const key = (context && context.n !== undefined ? `${trigger}:${context.n}` : trigger) as SpeechTrigger
    if (this.spokenSet.has(key)) return
    this.spokenSet.add(key)
    const scene = this.mesh.parent
    if (!(scene instanceof THREE.Scene)) return
    const voice: SpeechVoice = this._side === 'attacker' ? 'cyborg' : 'robot'
    spawnSpeechBubble(scene, this.logicalX, this.logicalY, voice, trigger, context)
  }

  // Medic heal target — restore HP up to maxHp, trigger green pulse VFX on
  // the sprite material. Returns true if any HP was actually restored
  // (used by the medic AI to decide whether the action was worth it).
  heal(amount: number, vfxVariant: HealVfxVariant = 'plus'): boolean {
    if (this.isDead || this.hp >= this.maxHp) return false
    const before = this.hp
    this.hp = Math.min(this.maxHp, this.hp + amount)
    const restored = this.hp - before
    if (restored > 0) {
      const ratio = this.hp / this.maxHp
      this.hpBarFill.scale.x = ratio
      this.hpBarFill.position.x = -(1 - ratio) * 12
      const mat = this.hpBarFill.material as THREE.MeshBasicMaterial
      mat.color.setHex(ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
      if (this.hpRing) this.updateHpRing(ratio)
      this.pulseHealVfx()
      // Floating heal VFX — variant chosen by the caller so each heal
      // mechanic has its own signature visual (tether=plus, throw=number,
      // pad=bubble).
      const scene = this.mesh.parent
      if (scene instanceof THREE.Scene) {
        spawnHealVfx(scene, this.logicalX, this.logicalY, restored, vfxVariant)
      }
    }
    return restored > 0
  }

  // Expose HP bar toggle so tethers can show a temp bar during a heal-link
  // and hide it when the link ends. Other code paths keep the bar hidden
  // per the plan-then-watch design rule.
  showHpBar() { this.hpBarGroup.visible = true }
  hideHpBar() { this.hpBarGroup.visible = false }

  // Briefly tint the sprite material green to signal the heal landed.
  // SpriteMaterial.color multiplies the texture, so 0x88ff88 + alpha-mix
  // reads as a soft green flash. Restores after 280ms.
  private healPulseTimer: number | null = null
  private pulseHealVfx() {
    const mat = this.sprite.material
    if (this.healPulseTimer !== null) clearTimeout(this.healPulseTimer)
    mat.color.setHex(0x88ff88)
    this.healPulseTimer = window.setTimeout(() => {
      mat.color.setHex(0xffffff)
      this.healPulseTimer = null
    }, 280)
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

  // Hulk slam-front one-shot. The PixelLab export reuses the 'throw' slot
  // for the slam (4 cardinal dirs); diagonals mirror to the nearest
  // cardinal. Falls back silently if the clip isn't loaded for this type.
  playSlamAnim() {
    if (this.isDead) return
    if (!animSets.get(this.type)?.anims['throw']) return
    this.playState('throw')
  }

  // Robot Repair one-shot — welding/working pose triggered when the bot
  // drops a pad or attaches a tether. Returns to walking/idle after the
  // clip finishes (handled by advanceFrame). No-op for units without a
  // 'repair' clip in their manifest (currently only the repair bot has one).
  playRepairAnim() {
    if (this.isDead) return
    if (!animSets.get(this.type)?.anims['repair']) return
    this.playState('repair')
  }

  // Force a sniper out of the crouched 'aim' pose into the upright
  // standing rotation. Used when the sniper is fully done (at retreat
  // edge with no ammo + no opponent in view) — gives the player the
  // "stand up, gun's empty" visual cue.
  standUpFromAim() {
    if (this.type === 'sniper' && this.currentState === 'aim' && !this.isMoving) {
      this.playState('idle')
    }
    this._crouched = false
  }

  // Stalker rule: cloak drops permanently on first damage-dealing
  // action. RevealPhase calls this from the executeAttack/slam/etc
  // sites right before applying damage. Idempotent — no-op if already
  // uncloaked. Restores sprite opacity to full.
  dropCloak() {
    if (!this.cloaked) return
    this.cloaked = false
    this.sprite.material.opacity = 1
  }

  // Sniper rule: spend a turn settling into the crouched aim pose before
  // firing. Sets the crouched flag and plays the aim anim (E/W ship the
  // crouch frame; other facings fall back to static rotation via
  // refreshDirection). Reveal-phase default action calls this when a target
  // first comes into range — the same turn returns 'hold' so no shot fires.
  crouch() {
    if (this.type !== 'sniper' || this.isDead || this.isMoving) return
    this._crouched = true
    if (animSets.get(this.type)?.anims['aim']) {
      this.playState('aim')
    }
  }

  get crouched() { return this._crouched }

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
      this.sprite.scale.set(spriteSizeFor(this.type), spriteSizeFor(this.type), 1)
      return
    }

    this.currentFrames = frames
    // Clamp frame index so re-resolving mid-clip doesn't try to address past
    // the new direction's frame count (most states are uniform, but defensive).
    if (this.frameIndex >= frames.length) this.frameIndex = frames.length - 1
    this.sprite.material.map = frames[this.frameIndex]
    this.sprite.material.needsUpdate = true
    const size = spriteSizeFor(this.type)
    this.sprite.scale.set(mirrored ? -size : size, size, 1)
    this.applySpriteOffset()
  }

  // Per-state sprite position offset. Most states sit centered on the cell;
  // a few PixelLab clips render the unit's body off-center because of a
  // protruding rifle / weapon (e.g. sniper aim pose — body on the left,
  // rifle extending right). Shift the sprite along the facing axis so the
  // BODY lands at the cell center even when the rifle adds extra width.
  private applySpriteOffset() {
    let dx = 0
    if (this.type === 'sniper' && this.currentState === 'aim') {
      // Empirical fix (measured the source PNG): aim/east/frame_000.png
      // is 104×104 px; non-transparent bbox is x=[36..88], center 62 —
      // i.e. the visible content sits +10 px east of the canvas center
      // because the rifle extends past the body. To center the visible
      // mass on the cell, shift WEST by 10 px × (60/104 world-per-px)
      // ≈ 5.8 world units = 0.10 × size. Earlier guesses of 0.22 / 0.30
      // overshot by 2-3× — that's why every adjustment looked worse.
      const size = spriteSizeFor(this.type)
      if (this.currentDir === 'east') dx = -size * 0.10
      else if (this.currentDir === 'west') dx = +size * 0.10
    }
    this.sprite.position.set(dx, 0, 5)
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
          if (this.currentState === 'shoot' || this.currentState === 'throw' || this.currentState === 'repair') {
            // Sniper post-shot: ALWAYS drop into the 'aim' state (crouched
            // pose) as long as we're not moving. Previously gated on
            // ammoRemaining > 0, but with ammo=1 the crouch never had a
            // frame on-screen — sniper fired and jumped straight to
            // standing. Holding aim regardless of ammo means the player
            // sees the crouched pose between shots / after a one-and-done
            // shot. The "moving on" visual is the walking anim when the
            // sniper retreats — clearer than the brief standing pose.
            if (this.type === 'sniper' && this.currentState === 'shoot' && !this.isMoving) {
              this.playState('aim')
              this._crouched = true
              return
            }
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
