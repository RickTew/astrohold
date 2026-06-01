import * as THREE from 'three'
import { Config, StructureType, TEAM_TINT } from '../game/GameConfig'
import { QueuedAction, STATIONARY_INITIATIVE, nextActorId } from '../game/TurnTypes'
import { playExplosion } from '../audio/sfx'
import { spawnHealVfx, HealVfxVariant } from './HealVfx'
import { spawnSpeechBubble, SpeechTrigger } from './SpeechBubble'
import { makeShadowSprite } from '../scene/Shadow'

// Pixel-sprite atlases for sprite-based structures. Walls/mines stay
// geometric (Box / Sphere). The five "preview" pieces (defense/dog/gun/laser/
// signal) ship with only a single south.png each — they're in the shop so the
// player can preview them in-game and decide which to commission full
// 8-direction renders for.
const STRUCTURE_SPRITE_FOLDERS: Partial<Record<StructureType, string>> = {
  turret:  'tower',    // Robot_Tower — single canonical tower (replaces tower1/tower2)
  bomber:  'bomber',   // Robot_Bomber — AoE grenade-thrower
  sentry:  'sentry',   // Robot_Wall art — heavy-armor turret (8 rotations, no anims)
  defense: 'defense',  // geodesic dome (preview, no rotations)
  gun:     'gun',      // twin-barrel turret (preview)
  // S17.2 Cannon structure reuses the 'gun' twin-barrel sprite as a
  // visual stand-in — read as a heavy gun emplacement. Replace with
  // dedicated cannon art when commissioned. (The /sprites/cannon/ folder
  // is the cyborg Cannon UNIT, a humanoid — not appropriate here.)
  cannon:  'gun',
  laser:   'laser',    // twin-laser turret
  signal:  'signal',   // satellite dish — EMP emitter
  mine:    'robot_mine',  // spiky proximity mine (matches the HUD tile sprite)
}
// Structures that ship with an explosion sequence (folder/explosion/).
// Frame count defaults to 4; override per type via STRUCTURE_EXPLOSION_FRAMES
// for pieces that ship more frames (sentry's PixelLab export is 9 frames).
const STRUCTURE_HAS_EXPLOSION: Partial<Record<StructureType, true>> = {
  turret: true,
  bomber: true,
  sentry: true,
}
const DEFAULT_EXPLOSION_FRAMES = 4
const STRUCTURE_EXPLOSION_FRAMES: Partial<Record<StructureType, number>> = {
  sentry: 9,
}
function explosionFrameCountFor(type: StructureType): number {
  return STRUCTURE_EXPLOSION_FRAMES[type] ?? DEFAULT_EXPLOSION_FRAMES
}

// Structures that ship with a walking animation. Frames live at
// /sprites/<folder>/walking/<dir>/frame_NNN.png. Only the sentry today —
// it's the one mobile structure with proper walk anim assets.
const STRUCTURE_HAS_WALK: Partial<Record<StructureType, true>> = {
  sentry: true,
}
const WALK_FRAMES = 9
const WALK_FRAME_INTERVAL = 0.06   // seconds per frame (~540ms total)
// Walking frames keyed by (type → direction → frame[]).
const structureWalkTextures: Map<StructureType, Map<string, THREE.Texture[]>> = new Map()
const WALK_DIRS = ['north', 'south', 'east', 'west'] as const
type WalkDir = (typeof WALK_DIRS)[number]
// S21 native 1:1. Per-type sprite size is the source PNG's native pixel
// width, cached at preload time. Visual hierarchy (Bomber bigger than
// Laser, Tower bigger than Gun) comes from the artist's chosen canvas
// per piece, not from runtime scale multiplication. Defaults to 64 for
// any type whose texture hasn't loaded yet (defensive only).
const NATIVE_SIZE = new Map<StructureType, number>()
// S22b: a few sprites read too large next to the rest because their source
// art has almost no transparent padding (e.g. robot_mine fills 62 of its 64
// canvas). Render those at a smaller, still pixel-perfect step. At PPWU=2 the
// only crisp step below the default 2x is 1x, so the only value that keeps
// the art razor-sharp is 0.5 (source texel = 1 screen pixel). Keep entries
// at integer / PPWU values; other fractions resample and soften the pixels.
const STRUCTURE_RENDER_SCALE: Partial<Record<StructureType, number>> = {
  mine: 0.5,
}
function structureSizeFor(type: StructureType): number {
  return (NATIVE_SIZE.get(type) ?? 64) * (STRUCTURE_RENDER_SCALE[type] ?? 1)
}

// Per-type foot fraction for shadow placement: the % of PNG height
// where each sprite's visible content ends. Default in Shadow.ts is
// 0.74 which works for tower/sentry/bomber/cannon/defense. The
// short-pedestal pieces below extend much further down — without an
// override the shadow lands inside the opaque body and disappears.
// Values measured with PIL on /public/sprites/*/south.png.
const STRUCTURE_FOOT_FRACTION: Partial<Record<StructureType, number>> = {
  laser:  0.91,
  gun:    0.97,
  // robot_mine sprite has its content extending all the way to the
  // PNG bottom (100%), so the shadow sits at the sprite quad bottom.
  mine:   1.00,
  // Signal pedestal also reaches near the PNG bottom. We pull the
  // shadow up to 0.92 instead of the measured 0.98 so the halo stays
  // visible IN the cell instead of extending past the grid line below.
  signal: 0.92,
}
// Per-type default facing. Tower has full 8 rotations and ships pointing
// EAST per the planned directional-arc mechanic (player pays to add more
// facing directions later). Preview pieces only have a single south.png so
// they stay south.
const STRUCTURE_DEFAULT_DIR: Partial<Record<StructureType, string>> = {
  turret: 'east',
  bomber: 'east',
  // Sentry ships with 8 rotations — faces east toward incoming cyborgs
  // by default; the compass-rose buys extra fire arcs.
  sentry: 'east',
}
const EXPLOSION_FRAME_INTERVAL = 0.09

const structureTextures: Map<StructureType, THREE.Texture> = new Map()
const structureExplosionTextures: Map<StructureType, THREE.Texture[]> = new Map()
// Per-direction rotation textures for structures that swap sprite based on
// fire facing (currently just the Sentry). Map key is the StructureType,
// value is a Map keyed by direction name (matches SpriteUnit's DIRECTIONS).
const structureRotationTextures: Map<StructureType, Map<string, THREE.Texture>> = new Map()
// Structures whose sprite rotates to match their fire facing. Add a type
// here AND make sure all 8 rotation PNGs ship in /public/sprites/<folder>/.
const STRUCTURE_HAS_ROTATIONS: Partial<Record<StructureType, true>> = {
  sentry: true,
}
const STRUCTURE_DIRS = [
  'east', 'north-east', 'north', 'north-west',
  'west', 'south-west', 'south', 'south-east',
] as const
type StructureDir = (typeof STRUCTURE_DIRS)[number]
// Pick the 8-way direction bucket closest to `angle` (math angle, 0=east,
// π/2=north). Mirrors SpriteUnit's refreshDirection math.
function angleToStructureDir(angle: number): StructureDir {
  const norm = ((angle / (Math.PI / 4)) + 16) % 8
  return STRUCTURE_DIRS[Math.round(norm) % 8]
}

// Space_Grenade texture — bomber projectile visual. Loaded alongside the
// structure sprites so it's ready by the time the first reveal fires.
let grenadeTexture: THREE.Texture | null = null
export function getGrenadeTexture(): THREE.Texture | null { return grenadeTexture }

// Med-pack texture — drawn procedurally to a 32×32 canvas (white pad with
// green cross) so we don't have to ship a separate PNG asset. The Medic's
// heal-throw projectile uses this in place of the grenade sprite.
let medPackTexture: THREE.Texture | null = null
export function getMedPackTexture(): THREE.Texture | null { return medPackTexture }
function makeMedPackTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 32; c.height = 32
  const ctx = c.getContext('2d')!
  // White pad with dark outline
  ctx.fillStyle = '#f0f6ff'
  ctx.fillRect(4, 4, 24, 24)
  ctx.strokeStyle = '#1a3040'
  ctx.lineWidth = 2
  ctx.strokeRect(4, 4, 24, 24)
  // Green cross
  ctx.fillStyle = '#3dd955'
  ctx.fillRect(13, 8, 6, 16)
  ctx.fillRect(8, 13, 16, 6)
  // Cross outline for crispness
  ctx.strokeStyle = '#1a3040'
  ctx.lineWidth = 1
  ctx.strokeRect(13, 8, 6, 16)
  ctx.strokeRect(8, 13, 16, 6)
  const tex = new THREE.CanvasTexture(c)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function loadTex(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, tex => {
      tex.magFilter = THREE.NearestFilter
      tex.minFilter = THREE.NearestFilter
      tex.colorSpace = THREE.SRGBColorSpace
      resolve(tex)
    }, undefined, reject)
  })
}

export async function preloadStructureSprites(): Promise<void> {
  // Use the south-facing rotation for every directional structure — stationary
  // pieces don't change facing yet. (Directional firing arcs will introduce
  // per-piece chosen rotation in a follow-up pass.)
  await Promise.all([
    ...(Object.keys(STRUCTURE_SPRITE_FOLDERS) as StructureType[]).map(async type => {
      const folder = STRUCTURE_SPRITE_FOLDERS[type]!
      const dir = STRUCTURE_DEFAULT_DIR[type] ?? 'south'
      const tex = await loadTex(`/sprites/${folder}/${dir}.png`)
      structureTextures.set(type, tex)
      // S21: cache native pixel size for structureSizeFor(). Source PNG
      // is the size authority — no per-type runtime scaling.
      NATIVE_SIZE.set(type, (tex.image as HTMLImageElement | undefined)?.width ?? 64)
      if (STRUCTURE_HAS_EXPLOSION[type]) {
        const count = explosionFrameCountFor(type)
        const frames: THREE.Texture[] = []
        for (let i = 0; i < count; i++) {
          const num = String(i).padStart(3, '0')
          frames.push(await loadTex(`/sprites/${folder}/explosion/frame_${num}.png`))
        }
        structureExplosionTextures.set(type, frames)
      }
      // Sprite-rotation structures preload all 8 directional PNGs so the
      // setSpriteDirection swap is instant when the player picks a facing
      // in the compass rose.
      if (STRUCTURE_HAS_ROTATIONS[type]) {
        const rotMap = new Map<string, THREE.Texture>()
        await Promise.all(STRUCTURE_DIRS.map(async d => {
          rotMap.set(d, await loadTex(`/sprites/${folder}/${d}.png`))
        }))
        structureRotationTextures.set(type, rotMap)
      }
      // S20 — walking animation preload. Sentry only today. 4 cardinal
      // directions × 9 frames each. Cycled in Structure.update while
      // the unit is in its "walking" state (set by moveTo).
      if (STRUCTURE_HAS_WALK[type]) {
        const dirMap = new Map<string, THREE.Texture[]>()
        await Promise.all(WALK_DIRS.map(async d => {
          const frames: THREE.Texture[] = []
          for (let i = 0; i < WALK_FRAMES; i++) {
            const num = String(i).padStart(3, '0')
            frames.push(await loadTex(`/sprites/${folder}/walking/${d}/frame_${num}.png`))
          }
          dirMap.set(d, frames)
        }))
        structureWalkTextures.set(type, dirMap)
      }
    }),
    loadTex('/sprites/grenade.png').then(tex => { grenadeTexture = tex }),
  ])
  // Med-pack is procedural; no network fetch needed.
  medPackTexture = makeMedPackTexture()
}

export class Structure {
  readonly mesh: THREE.Group
  readonly id: string
  hp: number
  readonly maxHp: number
  readonly type: StructureType
  // S17.16: col/row are no longer readonly. Most structures stay put,
  // but a few types (sentry currently) carry a speed in Config and are
  // moved by the reveal engine via moveTo(). worldX/Y derive from col
  // /row so updating those is the only state change needed.
  col: number
  row: number

  // Stationary by default; sorts late in initiative. apBudget=0 for
  // wall/mine means the reveal engine will skip them. Mobile structures
  // (sentry) override the initiative via the speed getter so they
  // interleave with other mobile pieces instead of always sorting last.
  get initiative(): number {
    return Math.max(STATIONARY_INITIATIVE, this.speed)
  }
  readonly apBudget: number
  apRemaining: number
  // D&D-style total ammo budget for the whole game. Once 0, the structure
  // stops auto-firing (it just sits there). Walls / Defense / Signal have
  // ammo 0 since they don't shoot.
  ammoRemaining: number
  // Fire-arc facings (math angles, 0=east, π/2=north, π=west, 3π/2=south).
  // Defender towers ship facing EAST (toward incoming cyborgs). RevealPhase
  // only auto-fires at targets that fall within ±FIRE_ARC_HALF of any
  // direction in this array. Player can pay credits during BUILD to add
  // extra facings via the compass-rose popup; see Structure.addFacing.
  fireFacings: number[] = [0]
  queuedActions: QueuedAction[] = []
  get side(): 'defender' { return 'defender' }
  // Hacked (Cyborg Nerd mechanic). While > 0, this tower fires on OTHER
  // robots instead of cyborgs, and cyborgs stop targeting it. Decremented
  // once per reveal by RevealPhase.tickHack until it reverts to loyal.
  hackedTurnsRemaining = 0
  get isHacked(): boolean { return this.hackedTurnsRemaining > 0 }

  private hpBarGroup!: THREE.Group
  private hpBar: THREE.Mesh
  // For walls only: the laser-wall visual is a Group containing two emitter
  // plates and a beam plane between them. takeDamage/heal scale + dim the
  // beam and dim the emitter sockets; update() runs a subtle per-frame pulse.
  private wallBody: THREE.Group | null = null
  private wallParts: {
    beam: THREE.Mesh
    beamMat: THREE.MeshBasicMaterial
    socketMats: THREE.MeshBasicMaterial[]
    plateMats: THREE.MeshBasicMaterial[]
  } | null = null
  private wallPulse = 0
  // Shield dome overlay (Variant C from the sandbox). Sprite painted with
  // a translucent cyan radial gradient plus a highlight band so it reads
  // as a force-field bubble even under a top-down camera. Created in the
  // constructor when type === 'defense'. Pulsed in update() for a soft
  // breathing animation; opacity fades to zero when the shield is dying.
  private shieldDomeSprite: THREE.Sprite | null = null
  private shieldDomeMat: THREE.SpriteMaterial | null = null
  private shieldDomePulse = 0
  // Grow-on-place state. Dome scales from 0 to full diameter over
  // shieldGrowDuration seconds, then settles into the breathing pulse.
  // Synced visually with the shield_placement sample so the dome
  // "blooms" alongside the placement sound.
  private shieldGrowTime = 0
  private readonly shieldGrowDuration = 2.5
  private shieldFullScale = 0
  // Wall orientation. Default = vertical (plates at top/bottom, beam runs
  // north-south, blocks the east-west cyborg corridor). When set to true
  // the entire wallBody Group rotates 90° on Z so plates sit left/right
  // and the beam runs east-west — useful for walls placed in a horizontal
  // row at a single row index. Toggled by right-click during BUILD, also
  // auto-set on placement based on neighbor cells.
  private wallHorizontal = false
  // S20 walk animation state (sentry only today). Set when moveTo runs;
  // cleared when the WALK_FRAMES * WALK_FRAME_INTERVAL duration elapses
  // in update(), at which point the static rotation texture is restored.
  private walking = false
  private walkTime = 0
  private walkFrame = 0
  private walkDir: WalkDir = 'south'
  // For sprite structures: kept so the death animation can swap textures.
  private sprite: THREE.Sprite | null = null
  // Death/explosion state — for sprite structures with an explosion sequence.
  private dying = false
  private dyingTime = 0
  private dyingFrame = 0
  private removed = false

  // Team identity (player / ai) controls the multiplicative blue/red tint
  // applied to the sprite material. Defaults to 'player' for non-AI spawns.
  private team: 'player' | 'ai' = 'player'

  constructor(scene: THREE.Scene, type: StructureType, col: number, row: number, team: 'player' | 'ai' = 'player') {
    this.type = type
    this.team = team
    this.id = nextActorId('struct')
    this.col = col
    this.row = row
    this.hp = this.maxHp = Config.STRUCTURES[type].hp
    this.apBudget = Config.STRUCTURES[type].apBudget
    this.apRemaining = this.apBudget
    this.ammoRemaining = Config.STRUCTURES[type].ammo

    this.mesh = new THREE.Group()
    this.mesh.position.set(this.worldX, this.worldY, 0)
    this.hpBar = this.buildVisual()
    // Shield generator gets a translucent dome overlay attached so the
    // aura coverage reads visually without inspecting the HUD. The dome
    // covers the same 1.5-grid-cell radius the damage-reduction aura
    // uses, so what you see is what gets protected.
    if (type === 'defense') {
      const dome = makeShieldDomeSprite()
      this.shieldDomeSprite = dome
      this.shieldDomeMat = dome.material as THREE.SpriteMaterial
      // Capture the dome's full diameter so the grow animation can lerp
      // toward it; start at zero so the dome blooms outward on place.
      this.shieldFullScale = dome.scale.x
      dome.scale.set(0, 0, 1)
      this.shieldDomeMat.opacity = 0
      this.mesh.add(dome)
    }
    scene.add(this.mesh)
  }

  private buildVisual(): THREE.Mesh {
    switch (this.type) {
      case 'turret':
      case 'bomber':
      case 'cannon':
      case 'sentry':
      case 'defense':
      case 'gun':
      case 'laser':
      case 'signal':
      case 'mine': {
        // Pixel sprite — same SpriteMaterial flags as cyborgs/spheres.
        // depthTest off so we sit cleanly above the ground without z-fighting.
        // Team tint is multiplicative so structures shared between factions
        // (towers / bombers / etc) still read which side owns them.
        const tex = structureTextures.get(this.type) ?? null
        const mat = new THREE.SpriteMaterial({
          map: tex,
          color: TEAM_TINT[this.team],
          transparent: true,
          depthTest: false,
          depthWrite: false,
          alphaTest: 0.1,
        })
        const sprite = new THREE.Sprite(mat)
        const sz = structureSizeFor(this.type)
        sprite.scale.set(sz, sz, 1)
        sprite.position.set(0, 0, 5)
        sprite.renderOrder = 10
        this.mesh.add(sprite)
        this.sprite = sprite
        // Grounded side-themed drop shadow. All structures are defender
        // pieces (blue) today; mapping leaves room for cyborg-placed
        // structures (red) if that mechanic lands later. Pieces with
        // pedestals reaching close to the bottom of their PNG need an
        // explicit foot fraction so the shadow doesn't hide inside
        // the opaque sprite body.
        this.mesh.add(makeShadowSprite({
          size: sz,
          side: this.team === 'player' ? 'defender' : 'attacker',
          footFraction: STRUCTURE_FOOT_FRACTION[this.type],
        }))
        break
      }
      case 'wall': {
        // Procedural "laser wall" — two metallic emitter plates at the top
        // and bottom of the cell, a glowing energy beam between them.
        // Reads as an active force-field barrier rather than a static brick.
        // Orientation is fixed (north-south emitters, vertical beam) so the
        // wall blocks the east-west cyborg corridor; rotation per facing
        // isn't wired since walls have no fireFacings concept yet.
        // HP feedback: beam scale.x shrinks and beamMat dims; emitter
        // sockets fade. update() ticks a subtle pulse so it feels alive.
        const group = new THREE.Group()
        const CELL_HALF = 24      // just inside the 50-cell border
        const PLATE_W = 36
        const PLATE_H = 8
        const BEAM_W = 10
        const BEAM_GAP = CELL_HALF * 2 - PLATE_H * 2  // beam height between plates
        // Team-tinted dark steel for the emitter plates so player vs AI
        // walls still read at a glance.
        const plateColor = new THREE.Color(0x4a5c6a)
          .multiply(new THREE.Color(TEAM_TINT[this.team]))
        const plateMat = new THREE.MeshBasicMaterial({ color: plateColor })
        const plateMat2 = plateMat.clone()
        const topPlate = new THREE.Mesh(
          new THREE.BoxGeometry(PLATE_W, PLATE_H, 10), plateMat,
        )
        topPlate.position.set(0,  CELL_HALF - PLATE_H / 2, 0.5)
        const bottomPlate = new THREE.Mesh(
          new THREE.BoxGeometry(PLATE_W, PLATE_H, 10), plateMat2,
        )
        bottomPlate.position.set(0, -CELL_HALF + PLATE_H / 2, 0.5)
        group.add(topPlate)
        group.add(bottomPlate)
        // Glowing emitter sockets on the inner faces of the plates. Color
        // is BLUE-leaning cyan (not white-leaning) because additive blending
        // adds to the dark map bg and the green/blue channels saturate fast
        // — using a more blue base keeps the result obviously blue instead
        // of blowing out to near-white.
        const socketMat1 = new THREE.MeshBasicMaterial({
          color: 0x66ccff, transparent: true, opacity: 0.95,
          blending: THREE.AdditiveBlending, depthWrite: false,
        })
        const socketMat2 = socketMat1.clone()
        const topSocket = new THREE.Mesh(
          new THREE.PlaneGeometry(PLATE_W - 6, 2), socketMat1,
        )
        topSocket.position.set(0,  CELL_HALF - PLATE_H, 6)
        const bottomSocket = new THREE.Mesh(
          new THREE.PlaneGeometry(PLATE_W - 6, 2), socketMat2,
        )
        bottomSocket.position.set(0, -CELL_HALF + PLATE_H, 6)
        group.add(topSocket)
        group.add(bottomSocket)
        // The laser beam — saturated blue-cyan (NOT pale cyan: white channels
        // get added on top of the brown ground and washed the beam out to
        // near-white in the first cut). Lower opacity caps the additive
        // contribution so the beam stays blue at full HP.
        const beamMat = new THREE.MeshBasicMaterial({
          color: 0x33aaff, transparent: true, opacity: 0.75,
          blending: THREE.AdditiveBlending, depthWrite: false,
        })
        const beam = new THREE.Mesh(
          new THREE.PlaneGeometry(BEAM_W, BEAM_GAP), beamMat,
        )
        beam.position.set(0, 0, 5)
        group.add(beam)
        // Wider, dimmer halo behind the beam — deeper blue so the spill
        // reads as colored light, not white fog.
        const haloMat = new THREE.MeshBasicMaterial({
          color: 0x2266cc, transparent: true, opacity: 0.32,
          blending: THREE.AdditiveBlending, depthWrite: false,
        })
        const halo = new THREE.Mesh(
          new THREE.PlaneGeometry(BEAM_W + 14, BEAM_GAP + 4), haloMat,
        )
        halo.position.set(0, 0, 4.5)
        group.add(halo)

        this.wallBody = group
        this.wallParts = {
          beam,
          beamMat,
          socketMats: [socketMat1, socketMat2, haloMat],
          plateMats: [plateMat, plateMat2],
        }
        this.mesh.add(group)
        break
      }
    }

    // HP bar — grouped so we can billboard the group to face the camera.
    // Walls use their own body as the HP indicator, so the bar stays hidden.
    this.hpBarGroup = new THREE.Group()
    this.hpBarGroup.position.set(0, 28, 0)
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(28, 3),
      new THREE.MeshBasicMaterial({ color: 0x222222 })
    )
    bg.position.z = 0.1
    this.hpBarGroup.add(bg)

    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(28, 3),
      new THREE.MeshBasicMaterial({ color: 0x00cc44 })
    )
    fill.position.z = 0.2
    this.hpBarGroup.add(fill)
    this.mesh.add(this.hpBarGroup)
    // HP bar hidden globally — plan-then-watch model. Wall already had its
    // bar hidden because the wall body shrinks instead; that behaviour stays
    // (it's a property of the wall sprite, not an overlay).
    this.hpBarGroup.visible = false
    return fill
  }

  faceCamera(camera: THREE.Camera) {
    this.hpBarGroup.quaternion.copy(camera.quaternion)
  }

  // Toggle / set the wall's orientation. Vertical (default) = beam runs
  // north-south; horizontal = beam runs east-west. The whole wallBody
  // Group rotates 90° on Z — geometry stays the same, including the
  // damage-feedback scale.x (which thins the beam perpendicular to its
  // length in either orientation). No-op for non-wall structures.
  rotateWall() { this.setWallHorizontal(!this.wallHorizontal) }
  setWallHorizontal(value: boolean) {
    if (this.type !== 'wall' || !this.wallBody) return
    this.wallHorizontal = value
    this.wallBody.rotation.z = value ? Math.PI / 2 : 0
  }
  get isWallHorizontal() { return this.wallHorizontal }

  takeDamage(amount: number) {
    this.hp = Math.max(0, this.hp - amount)
    const ratio = this.hp / this.maxHp

    if (this.type === 'wall' && this.wallParts) {
      this.applyWallDamageVisual(ratio)
    } else {
      this.hpBar.scale.x = ratio
      this.hpBar.position.x = -(1 - ratio) * 14   // half of new bar width 28
      const mat = this.hpBar.material as THREE.MeshBasicMaterial
      mat.color.setHex(ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
      // HP bars are hidden globally, so without sprite tinting the player
      // sees zero visual change on a sentry/tower/bomber as it takes hits.
      // Shift the sprite color toward a darker red-tinted tone as ratio
      // drops — same idea as the wall body dimming, applied to the sprite
      // material's multiplicative color channel.
      this.applySpriteDamageTint(ratio)
    }

    if (this.isDead && !this.dying) this.startDying()
    this.checkSpeechTriggers()
  }

  // Status callout — robot voice ("SYSTEMS CRITICAL", "AMMUNITION LOW").
  // One bubble per condition per structure. Skip walls/mines/preview
  // pieces — a wall "speaking" reads as wrong (it's a force-field, not
  // a sentient turret).
  private spokenSet = new Set<SpeechTrigger>()
  checkSpeechTriggers() {
    if (this.isDead) return
    if (this.type === 'wall' || this.type === 'mine' || this.type === 'defense' || this.type === 'signal') return
    if (this.hp / this.maxHp <= 0.25) this.maybeSpeak('low_hp')
    if (Config.STRUCTURES[this.type].ammo > 0) {
      if (this.ammoRemaining > 0 && this.ammoRemaining <= 2) {
        this.maybeSpeak('low_ammo', { n: this.ammoRemaining })
      } else if (this.ammoRemaining === 0) {
        this.maybeSpeak('out_of_ammo')
      }
    }
  }
  notifyAmmoChanged() { this.checkSpeechTriggers() }
  private maybeSpeak(trigger: SpeechTrigger, context?: { n?: number }) {
    const key = (context && context.n !== undefined ? `${trigger}:${context.n}` : trigger) as SpeechTrigger
    if (this.spokenSet.has(key)) return
    this.spokenSet.add(key)
    const scene = this.mesh.parent
    if (!(scene instanceof THREE.Scene)) return
    spawnSpeechBubble(scene, this.worldX, this.worldY, 'robot', trigger, context)
  }

  // Sprite-based damage feedback for non-wall structures. Builds a tinted
  // color that starts at the team tint (full HP) and shifts toward a
  // red-warm multiplier as HP drops. Tuned lighter than the first cut —
  // damage should be CLEARLY VISIBLE but not turn the sprite black.
  // Skipped if there's no sprite to tint (legacy mine + wall paths handle
  // their own visuals).
  private applySpriteDamageTint(ratio: number) {
    if (!this.sprite) return
    if (this.repairPulseTimer !== null) return
    const r = Math.max(0.05, ratio)
    // RGB multiplier: green + blue dim more than red so the sprite reads
    // orange → red as HP drops, but minimum brightness is high enough
    // that the sprite art stays readable. At 100% HP this is (1,1,1)
    // no-op; at 50% HP roughly (0.85, 0.67, 0.67) = clear warm tint;
    // at 5% HP (0.715, 0.36, 0.36) = strong red but still visible.
    const rChan = 0.7 + 0.3 * r
    const gChan = 0.35 + 0.65 * r
    const bChan = 0.35 + 0.65 * r
    const damageColor = new THREE.Color(rChan, gChan, bChan)
      .multiply(new THREE.Color(TEAM_TINT[this.team]))
    this.sprite.material.color.copy(damageColor)
  }

  // Wall HP feedback — the beam thins + dims, emitter sockets fade. Called
  // from both takeDamage (lower HP) and heal (higher HP). Clamped to a
  // visible sliver so a deeply-damaged wall still reads in the cell.
  private applyWallDamageVisual(ratio: number) {
    if (!this.wallParts) return
    const s = Math.max(0.10, ratio)
    // Beam thins horizontally — the gap between emitters stays the same
    // height so the structure still "fills" the cell visually.
    this.wallParts.beam.scale.x = 0.4 + 0.6 * s
    // Beam alpha drops faster than s so a 25%-HP wall reads as dim+thin.
    this.wallParts.beamMat.opacity = 0.20 + 0.55 * s * s
    // Socket + halo alpha follow beam alpha at slightly lower magnitudes.
    for (const m of this.wallParts.socketMats) {
      m.opacity = 0.08 + 0.85 * s
    }
    // Plates stay structurally visible but get a subtle dim at low HP so
    // the whole assembly reads as "battered" near death.
    const dim = 0.55 + 0.45 * s
    const plateColor = new THREE.Color(0x4a5c6a)
      .multiplyScalar(dim)
      .multiply(new THREE.Color(TEAM_TINT[this.team]))
    for (const m of this.wallParts.plateMats) m.color.copy(plateColor)
  }

  // Repair-bot heal target — restore HP up to maxHp, refresh the HP bar (or
  // wall scale) the same way takeDamage does. Returns true iff any HP was
  // actually restored. Refuses to repair a dead/dying structure (no Lazarus).
  heal(amount: number, vfxVariant: HealVfxVariant = 'plus'): boolean {
    if (this.isDead || this.dying || this.hp >= this.maxHp) return false
    const before = this.hp
    this.hp = Math.min(this.maxHp, this.hp + amount)
    const restored = this.hp - before
    if (restored <= 0) return false
    const ratio = this.hp / this.maxHp
    if (this.type === 'wall' && this.wallParts) {
      this.applyWallDamageVisual(ratio)
    } else {
      this.hpBar.scale.x = ratio
      this.hpBar.position.x = -(1 - ratio) * 14
      const mat = this.hpBar.material as THREE.MeshBasicMaterial
      mat.color.setHex(ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
      // Mirror takeDamage — restore the damage-tint toward white as HP
      // climbs. The repair flash (pulseRepairVfx) handles the amber pulse,
      // and after it expires the timer restores to the BASE color which
      // we now compute from current HP rather than always TEAM_TINT.
      this.applySpriteDamageTint(ratio)
    }
    this.pulseRepairVfx()
    const scene = this.mesh.parent
    if (scene instanceof THREE.Scene) {
      spawnHealVfx(scene, this.worldX, this.worldY, restored, vfxVariant)
    }
    return true
  }

  // Tether visibility toggle — Repair-bot welds show a temp HP bar on
  // the target so the player sees the bar climb until the link ends.
  showHpBar() { this.hpBarGroup.visible = true }
  hideHpBar() { this.hpBarGroup.visible = false }

  // Brief warm-orange material flash on the structure's main sprite so the
  // player can see a repair just landed. Wall has no sprite — skipped there.
  // The post-flash restore re-applies the damage tint at the CURRENT HP
  // ratio, so a partially-damaged structure stays visibly dim/red after
  // the flash instead of snapping back to full-health team color.
  private repairPulseTimer: number | null = null
  private pulseRepairVfx() {
    const s = this.sprite
    if (!s) return
    if (this.repairPulseTimer !== null) clearTimeout(this.repairPulseTimer)
    s.material.color.setHex(0xffcc66)
    this.repairPulseTimer = window.setTimeout(() => {
      this.repairPulseTimer = null
      this.applySpriteDamageTint(this.hp / this.maxHp)
    }, 280)
  }

  private startDying() {
    this.dying = true
    if (this.hpBarGroup) this.hpBarGroup.visible = false
    if (STRUCTURE_HAS_EXPLOSION[this.type] && this.sprite) {
      const frames = structureExplosionTextures.get(this.type)
      if (frames && frames[0]) {
        this.sprite.material.map = frames[0]
        this.sprite.material.needsUpdate = true
      }
    } else {
      // No explosion sequence — remove immediately like the old behavior.
      this.mesh.removeFromParent()
      this.removed = true
      return
    }
    playExplosion()
  }

  update(delta: number) {
    // Shield dome pulse. Runs every frame while the shield is alive so
    // the force-field reads as breathing. Fades to near-zero opacity
    // during the dying animation so the dome collapses with the piece.
    if (this.type === 'defense' && this.shieldDomeMat && this.shieldDomeSprite) {
      this.shieldDomePulse += delta
      // Grow animation. Scale + opacity lerp from 0 to full over
      // shieldGrowDuration with an ease-out-cubic so the dome flicks out
      // fast and settles. Once at 1.0 the breathing pulse takes over.
      let growT = 1
      if (this.shieldGrowTime < this.shieldGrowDuration) {
        this.shieldGrowTime += delta
        const u = Math.min(1, this.shieldGrowTime / this.shieldGrowDuration)
        growT = 1 - Math.pow(1 - u, 3)   // ease-out cubic
        const s = this.shieldFullScale * growT
        this.shieldDomeSprite.scale.set(s, s, 1)
      } else if (this.shieldDomeSprite.scale.x !== this.shieldFullScale) {
        // Snap to exact full scale once the grow window closes (avoids
        // drifting due to floating-point accumulation in the lerp).
        this.shieldDomeSprite.scale.set(this.shieldFullScale, this.shieldFullScale, 1)
      }
      const baseOp = this.dying || this.removed ? 0 : 1
      // Slow ~0.33 Hz pulse between 0.65 and 1.0 of base. Subtle enough
      // not to draw the eye away from the action. During the grow window
      // we multiply by growT so the opacity ramps in alongside the scale.
      const k = 0.82 + 0.18 * Math.sin(this.shieldDomePulse * 2.0)
      this.shieldDomeMat.opacity = baseOp * k * growT
    }
    // Wall pulse: runs every frame while the wall is alive so the beam +
    // sockets shimmer subtly. Sits outside the dying gate because we want
    // the pulse to keep running even while taking damage.
    if (this.type === 'wall' && this.wallParts && !this.dying && !this.removed) {
      this.wallPulse += delta
      const ratio = this.hp / this.maxHp
      const sBase = Math.max(0.10, ratio)
      const k = 0.85 + 0.18 * Math.sin(this.wallPulse * 5.0)
      // Multiply the static base opacity (set in applyWallDamageVisual) by
      // the pulse factor — beam never goes completely dark, just dims/glows.
      const baseOp = 0.20 + 0.55 * sBase * sBase
      this.wallParts.beamMat.opacity = baseOp * k
      // Sockets get a faster pulse out of phase with the beam — reads as
      // "energy flowing into the emitter ports."
      const socketK = 0.78 + 0.20 * Math.sin(this.wallPulse * 7.0 + 1.0)
      const socketBase = 0.08 + 0.85 * sBase
      const haloBase   = 0.10 + 0.20 * sBase
      this.wallParts.socketMats[0].opacity = socketBase * socketK
      this.wallParts.socketMats[1].opacity = socketBase * socketK
      this.wallParts.socketMats[2].opacity = haloBase   * socketK
    }
    // S20 mobile-structure motion. Lerp the mesh position toward the
    // current cell's worldX/worldY at the type's speed (per second),
    // identical to how SpriteUnit slides cyborgs / dog / etc. While
    // in motion, cycle through the directional walking-frame texture
    // pack. On arrival, restore the static rotation.
    if (this.walking && this.sprite && !this.dying && !this.removed) {
      const dx = this.worldX - this.mesh.position.x
      const dy = this.worldY - this.mesh.position.y
      const dist = Math.hypot(dx, dy)
      const speed = (Config.STRUCTURES[this.type] as { speed?: number }).speed ?? 0
      const moveSpeedPS = speed / Config.TURN_INTERVAL
      const step = moveSpeedPS * delta
      if (step >= dist) {
        // Arrived.
        this.mesh.position.x = this.worldX
        this.mesh.position.y = this.worldY
        this.walking = false
        const baseTex = structureTextures.get(this.type)
        if (baseTex) {
          this.sprite.material.map = baseTex
          this.sprite.material.needsUpdate = true
        }
      } else if (dist > 0) {
        this.mesh.position.x += (dx / dist) * step
        this.mesh.position.y += (dy / dist) * step
      }
      // Cycle walking frames while still moving.
      if (this.walking) {
        const dirMap = structureWalkTextures.get(this.type)
        const frames = dirMap?.get(this.walkDir)
        if (frames) {
          this.walkTime += delta
          const idx = Math.floor(this.walkTime / WALK_FRAME_INTERVAL) % WALK_FRAMES
          if (idx !== this.walkFrame) {
            this.walkFrame = idx
            this.sprite.material.map = frames[idx]
            this.sprite.material.needsUpdate = true
          }
        }
      }
    }
    if (!this.dying || this.removed) return
    const frames = structureExplosionTextures.get(this.type)
    if (!frames || !this.sprite) return
    const fc = frames.length
    this.dyingTime += delta
    const next = Math.min(fc - 1, Math.floor(this.dyingTime / EXPLOSION_FRAME_INTERVAL))
    if (next !== this.dyingFrame) {
      this.dyingFrame = next
      this.sprite.material.map = frames[next]
      this.sprite.material.needsUpdate = true
    }
    if (this.dyingFrame === fc - 1 && this.dyingTime > fc * EXPLOSION_FRAME_INTERVAL + 0.3) {
      this.mesh.removeFromParent()
      this.removed = true
    }
  }

  get isDead() { return this.hp <= 0 }
  get worldX() { return Config.WORLD.LEFT   + this.col * Config.GRID_CELL + Config.GRID_CELL / 2 }
  get worldY() { return Config.WORLD.BOTTOM + this.row * Config.GRID_CELL + Config.GRID_CELL / 2 }
  get range()        { return Config.STRUCTURES[this.type].range }
  get damage()       { return Config.STRUCTURES[this.type].damage }
  get fireInterval() { return Config.STRUCTURES[this.type].fireInterval }
  // S17.16: speed for mobile structures (sentry today). Most types
  // have no speed field and stay at 0 = stationary.
  get speed(): number {
    return (Config.STRUCTURES[this.type] as { speed?: number }).speed ?? 0
  }

  // S17.16: cell-based logical movement. col/row updates immediately so
  // collision / targeting reads the unit at its new cell right away.
  //
  // S20: position used to snap; now lerps for types with walk anims
  // (sentry today). The mesh slides toward the new worldX/worldY over
  // the per-turn interval, matching how SpriteUnit moves cyborgs / dog
  // / etc. The walking animation cycles while the lerp is in progress
  // and stops when the sprite arrives.
  moveTo(col: number, row: number) {
    if (this.isDead) return
    const prevCol = this.col
    const prevRow = this.row
    this.col = col
    this.row = row
    if (STRUCTURE_HAS_WALK[this.type] && structureWalkTextures.has(this.type)) {
      // Defer the visual position to update()'s lerp loop. Pick walking
      // direction from the (col, row) delta.
      const dCol = col - prevCol
      const dRow = row - prevRow
      let dir: WalkDir = 'south'
      if (Math.abs(dRow) >= Math.abs(dCol)) dir = dRow > 0 ? 'north' : 'south'
      else dir = dCol > 0 ? 'east' : 'west'
      this.walking = true
      this.walkTime = 0
      this.walkFrame = 0
      this.walkDir = dir
    } else {
      // Snap for everything else (stationary structures that won't lerp).
      this.mesh.position.set(this.worldX, this.worldY, this.mesh.position.z)
    }
  }

  clearPlan() {
    this.queuedActions = []
    this.apRemaining = this.apBudget
  }
  refillAp() { this.apRemaining = this.apBudget }

  // Add a new fire-arc facing (math angle, radians). No-op if the structure
  // already covers that direction. Caller is responsible for charging credits.
  // Returns true if a new facing was added, false if it was a duplicate.
  addFacing(angle: number): boolean {
    // Normalize to [0, 2π) so duplicate detection is consistent regardless of
    // which side of zero the caller passes.
    const norm = normAngle(angle)
    const EPS = 0.01
    for (const f of this.fireFacings) {
      if (Math.abs(normAngle(f) - norm) < EPS) return false
    }
    this.fireFacings.push(norm)
    return true
  }

  // Remove an existing fire-arc facing (math angle, radians). Refuses if the
  // facing isn't currently active OR if it's the last remaining facing
  // (a structure with zero fire arcs can't shoot anything). Caller is
  // responsible for refunding credits.
  removeFacing(angle: number): boolean {
    if (this.fireFacings.length <= 1) return false
    const norm = normAngle(angle)
    const EPS = 0.01
    for (let i = 0; i < this.fireFacings.length; i++) {
      if (Math.abs(normAngle(this.fireFacings[i]) - norm) < EPS) {
        this.fireFacings.splice(i, 1)
        return true
      }
    }
    return false
  }

  // Single-facing override — replaces the entire fireFacings array with
  // [angle]. Used by single-facing structures (e.g. the Sentry, which has
  // exactly one fire direction at a time). Returns true if the angle is
  // a CHANGE from the current single facing; false if it's already set.
  // For sprite-rotation structures, ALSO swaps the sprite texture to the
  // 8-way rotation matching the new facing so the gun visually turns.
  setSingleFacing(angle: number): boolean {
    const norm = normAngle(angle)
    if (this.fireFacings.length === 1 && Math.abs(normAngle(this.fireFacings[0]) - norm) < 0.01) {
      return false
    }
    this.fireFacings = [norm]
    this.refreshSpriteDirection()
    return true
  }

  // Swap the structure's sprite to the rotation PNG matching its current
  // primary fire facing. No-op for structures without rotation textures
  // (i.e. anything not in STRUCTURE_HAS_ROTATIONS). The sprite mesh keeps
  // its tint + size; only the texture map changes.
  private refreshSpriteDirection() {
    if (!this.sprite) return
    const rotMap = structureRotationTextures.get(this.type)
    if (!rotMap) return
    const dir = angleToStructureDir(this.fireFacings[0] ?? 0)
    const tex = rotMap.get(dir)
    if (!tex) return
    this.sprite.material.map = tex
    this.sprite.material.needsUpdate = true
  }
  queueAction(action: QueuedAction, apCost: number) {
    this.queuedActions.push(action)
    this.apRemaining -= apCost
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        ;(obj.material as THREE.MeshBasicMaterial).dispose()
      }
    })
  }
}

function normAngle(a: number): number {
  const TAU = Math.PI * 2
  return ((a % TAU) + TAU) % TAU
}

// ── Shield dome overlay ──────────────────────────────────────────────
// Top-down translucent cyan force-field rendered as a Sprite child of
// the Shield generator's mesh. Canvas-painted: radial gradient for the
// dome body, a brighter rim at the edge, and a soft highlight band
// near the top to suggest a hemisphere under the orthographic camera.
// Sized to match the 1.5-grid-cell damage-reduction aura.

let shieldDomeTexture: THREE.CanvasTexture | null = null
function getShieldDomeTexture(): THREE.CanvasTexture {
  if (shieldDomeTexture) return shieldDomeTexture
  const c = document.createElement('canvas')
  c.width = 256; c.height = 256
  const ctx = c.getContext('2d')!
  const cx = 128, cy = 128, r = 124
  // Dome body. Bright cyan core fading to translucent edge. Gradient
  // is now perfectly centered (both inner + outer circles share the
  // same center point) so the highlight sits in the middle of the
  // dome rather than biased toward the top. The earlier off-center
  // gradient + top highlight band were meant to fake a hemisphere
  // under the top-down camera but read as a floating cloud above
  // the dome; user wanted the lighting centered on the piece itself.
  const grad = ctx.createRadialGradient(cx, cy, 12, cx, cy, r)
  grad.addColorStop(0.00, 'rgba(180, 230, 255, 0.42)')
  grad.addColorStop(0.45, 'rgba(107, 217, 255, 0.26)')
  grad.addColorStop(0.78, 'rgba(60, 140, 200, 0.18)')
  grad.addColorStop(1.00, 'rgba(60, 140, 200, 0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  // No outer rim stroke and no top highlight band. The hard cyan ring
  // cut across nearby pieces; the top highlight (curved sliver above
  // center) read as a stray cloud rather than as dome volume. Soft
  // centered gradient alone communicates coverage.
  shieldDomeTexture = new THREE.CanvasTexture(c)
  shieldDomeTexture.magFilter = THREE.LinearFilter
  shieldDomeTexture.minFilter = THREE.LinearFilter
  shieldDomeTexture.colorSpace = THREE.SRGBColorSpace
  return shieldDomeTexture
}

export function makeShieldDomeSprite(): THREE.Sprite {
  const tex = getShieldDomeTexture()
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    opacity: 1.0,
  })
  const sprite = new THREE.Sprite(mat)
  // Dome diameter. Aura is 2.0 grid cells = 100 world units radius
  // (covers the full 3x3 ring of neighbors). The sprite renders a
  // bit larger so the visible rim sits at the actual aura boundary
  // after the canvas-edge alpha falloff (the gradient fades within
  // the last few percent of the bitmap).
  const D = Config.GRID_CELL * 4.4   // ~220 world units across
  sprite.scale.set(D, D, 1)
  // Sit BENEATH the structure sprite but above the ground grid. The
  // structure renderOrder is typically 10; use 5 here.
  sprite.position.set(0, 0, 0.4)
  sprite.renderOrder = 5
  return sprite
}
