import * as THREE from 'three'
import { Config, StructureType, TEAM_TINT } from '../game/GameConfig'
import { QueuedAction, STATIONARY_INITIATIVE, nextActorId } from '../game/TurnTypes'
import { playExplosion } from '../audio/sfx'
import { spawnHealVfx, HealVfxVariant } from './HealVfx'
import { spawnSpeechBubble, SpeechTrigger } from './SpeechBubble'

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
}
// Structures that ship with a 4-frame explosion sequence (folder/explosion/).
const STRUCTURE_HAS_EXPLOSION: Partial<Record<StructureType, true>> = {
  turret: true,
  bomber: true,
}
// Per-type sprite size override. Default = 50 (one cell). Towers render
// slightly bigger so they read as the dominant defender pieces; Gun preview
// is smaller per user feedback (sprite was overflowing its cell).
const STRUCTURE_SPRITE_SIZE: Partial<Record<StructureType, number>> = {
  turret: 64,
  bomber: 60,
  // Sentry renders as tall as the Hulk (84) so the heavy-tower piece
  // reads as a real bruiser on the field, not a slightly bigger tower.
  // Hulk's override in SpriteUnit.ts is also 84 — kept in sync.
  sentry: 84,
  gun:    40,
}
const SPRITE_SIZE = 50   // default — one cell
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
const EXPLOSION_FRAME_COUNT = 4
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
      structureTextures.set(type, await loadTex(`/sprites/${folder}/${dir}.png`))
      if (STRUCTURE_HAS_EXPLOSION[type]) {
        const frames: THREE.Texture[] = []
        for (let i = 0; i < EXPLOSION_FRAME_COUNT; i++) {
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
  readonly col: number
  readonly row: number

  // Stationary; sorts late in initiative. apBudget=0 for wall/mine means the
  // reveal engine will skip them — they stay passive. Turrets/cannons get
  // apBudget=1 and the reveal engine auto-fires them at their initiative tick
  // (defender does not queue actions for them in the planning UI).
  readonly initiative = STATIONARY_INITIATIVE
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
  // Wall orientation. Default = vertical (plates at top/bottom, beam runs
  // north-south, blocks the east-west cyborg corridor). When set to true
  // the entire wallBody Group rotates 90° on Z so plates sit left/right
  // and the beam runs east-west — useful for walls placed in a horizontal
  // row at a single row index. Toggled by right-click during BUILD, also
  // auto-set on placement based on neighbor cells.
  private wallHorizontal = false
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
      case 'signal': {
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
        const sz = STRUCTURE_SPRITE_SIZE[this.type] ?? SPRITE_SIZE
        sprite.scale.set(sz, sz, 1)
        sprite.position.set(0, 0, 5)
        sprite.renderOrder = 10
        this.mesh.add(sprite)
        this.sprite = sprite
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
      case 'mine': {
        this.mesh.add(new THREE.Mesh(
          new THREE.SphereGeometry(10, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xffcc00 })
        ))
        this.mesh.add(new THREE.Mesh(
          new THREE.TorusGeometry(14, 2, 6, 20),
          new THREE.MeshBasicMaterial({ color: 0xff6600 })
        ))
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
    if (this.type === 'defense' && this.shieldDomeMat) {
      this.shieldDomePulse += delta
      const baseOp = this.dying || this.removed ? 0 : 1
      // Slow ~0.33 Hz pulse between 0.65 and 1.0 of base. Subtle enough
      // not to draw the eye away from the action.
      const k = 0.82 + 0.18 * Math.sin(this.shieldDomePulse * 2.0)
      this.shieldDomeMat.opacity = baseOp * k
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
    if (!this.dying || this.removed) return
    const frames = structureExplosionTextures.get(this.type)
    if (!frames || !this.sprite) return
    this.dyingTime += delta
    const next = Math.min(EXPLOSION_FRAME_COUNT - 1, Math.floor(this.dyingTime / EXPLOSION_FRAME_INTERVAL))
    if (next !== this.dyingFrame) {
      this.dyingFrame = next
      this.sprite.material.map = frames[next]
      this.sprite.material.needsUpdate = true
    }
    if (this.dyingFrame === EXPLOSION_FRAME_COUNT - 1
        && this.dyingTime > EXPLOSION_FRAME_COUNT * EXPLOSION_FRAME_INTERVAL + 0.3) {
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

function makeShieldDomeSprite(): THREE.Sprite {
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
