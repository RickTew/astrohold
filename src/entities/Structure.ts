import * as THREE from 'three'
import { Config, StructureType, TEAM_TINT } from '../game/GameConfig'
import { QueuedAction, STATIONARY_INITIATIVE, nextActorId } from '../game/TurnTypes'
import { playExplosion } from '../audio/sfx'

// Pixel-sprite atlases for sprite-based structures. Walls/mines stay
// geometric (Box / Sphere). The five "preview" pieces (defense/dog/gun/laser/
// signal) ship with only a single south.png each — they're in the shop so the
// player can preview them in-game and decide which to commission full
// 8-direction renders for.
const STRUCTURE_SPRITE_FOLDERS: Partial<Record<StructureType, string>> = {
  turret:  'tower',    // Robot_Tower — single canonical tower (replaces tower1/tower2)
  bomber:  'bomber',   // Robot_Bomber — AoE grenade-thrower
  defense: 'defense',  // geodesic dome (preview, no rotations)
  gun:     'gun',      // twin-barrel turret (preview)
  laser:   'laser',    // twin-laser turret (preview)
  signal:  'signal',   // satellite dish (preview)
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
}
const EXPLOSION_FRAME_COUNT = 4
const EXPLOSION_FRAME_INTERVAL = 0.09

const structureTextures: Map<StructureType, THREE.Texture> = new Map()
const structureExplosionTextures: Map<StructureType, THREE.Texture[]> = new Map()

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
  // For walls only: the body mesh itself shrinks as it takes damage (the wall
  // IS the HP bar). Stored so takeDamage() can scale it.
  private wallBody: THREE.Mesh | null = null
  private wallBodyHeight = 0
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
    scene.add(this.mesh)
  }

  private buildVisual(): THREE.Mesh {
    switch (this.type) {
      case 'turret':
      case 'bomber':
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
        // Wall body acts as its own HP indicator — scaled in takeDamage().
        // Fills most of the cell (40×40) so its shrink reads cleanly.
        // Base brown × team tint so wall ownership is visible at a glance.
        const H = 40
        this.wallBodyHeight = H
        const wallColor = new THREE.Color(0x996633)
          .multiply(new THREE.Color(TEAM_TINT[this.team]))
        this.wallBody = new THREE.Mesh(
          new THREE.BoxGeometry(40, H, 12),
          new THREE.MeshBasicMaterial({ color: wallColor })
        )
        this.mesh.add(this.wallBody)
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

  takeDamage(amount: number) {
    this.hp = Math.max(0, this.hp - amount)
    const ratio = this.hp / this.maxHp

    if (this.type === 'wall' && this.wallBody) {
      // Wall IS the HP bar — shrink the body from the top down so the base
      // stays planted in the cell. ratio clamped to a sliver so a deeply
      // damaged wall is still visible (and clickable for the player to
      // notice it's almost gone) until it actually dies.
      const s = Math.max(0.05, ratio)
      this.wallBody.scale.y = s
      this.wallBody.position.y = -(1 - s) * (this.wallBodyHeight / 2)
      // Tint darker as the wall takes a beating, but multiply with the
      // team color so ownership stays visible all the way through.
      const mat = this.wallBody.material as THREE.MeshBasicMaterial
      const dim = 0.5 + 0.5 * ratio
      const base = new THREE.Color(0.6 * dim, 0.4 * dim, 0.2 * dim)
        .multiply(new THREE.Color(TEAM_TINT[this.team]))
      mat.color.copy(base)
    } else {
      this.hpBar.scale.x = ratio
      this.hpBar.position.x = -(1 - ratio) * 14   // half of new bar width 28
      const mat = this.hpBar.material as THREE.MeshBasicMaterial
      mat.color.setHex(ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
    }

    if (this.isDead && !this.dying) this.startDying()
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
    const TAU = Math.PI * 2
    const norm = ((angle % TAU) + TAU) % TAU
    const EPS = 0.01
    for (const f of this.fireFacings) {
      const fn = ((f % TAU) + TAU) % TAU
      if (Math.abs(fn - norm) < EPS) return false
    }
    this.fireFacings.push(norm)
    return true
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
