import * as THREE from 'three'
import { Config, StructureType } from '../game/GameConfig'
import { QueuedAction, STATIONARY_INITIATIVE, nextActorId } from '../game/TurnTypes'

// Pixel-sprite atlases for the directional structures. Walls/mines stay
// geometric (Box / Sphere) — they don't need a turret look.
const STRUCTURE_SPRITE_FOLDERS: Partial<Record<StructureType, string>> = {
  turret: 'tower1',   // Robot_Tower_1 — compact directional gun
  cannon: 'tower2',   // Robot_Tower_2 — heavier/glowing core
}
const SPRITE_SIZE = 50   // one cell

const structureTextures: Map<StructureType, THREE.Texture> = new Map()

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
  await Promise.all(
    (Object.keys(STRUCTURE_SPRITE_FOLDERS) as StructureType[]).map(async type => {
      const folder = STRUCTURE_SPRITE_FOLDERS[type]!
      structureTextures.set(type, await loadTex(`/sprites/${folder}/south.png`))
    })
  )
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
  queuedActions: QueuedAction[] = []
  get side(): 'defender' { return 'defender' }

  private hpBarGroup!: THREE.Group
  private hpBar: THREE.Mesh
  // For walls only: the body mesh itself shrinks as it takes damage (the wall
  // IS the HP bar). Stored so takeDamage() can scale it.
  private wallBody: THREE.Mesh | null = null
  private wallBodyHeight = 0

  constructor(scene: THREE.Scene, type: StructureType, col: number, row: number) {
    this.type = type
    this.id = nextActorId('struct')
    this.col = col
    this.row = row
    this.hp = this.maxHp = Config.STRUCTURES[type].hp
    this.apBudget = Config.STRUCTURES[type].apBudget
    this.apRemaining = this.apBudget

    this.mesh = new THREE.Group()
    this.mesh.position.set(this.worldX, this.worldY, 0)
    this.hpBar = this.buildVisual()
    scene.add(this.mesh)
  }

  private buildVisual(): THREE.Mesh {
    switch (this.type) {
      case 'turret':
      case 'cannon': {
        // Pixel sprite (Robot_Tower_1 / Robot_Tower_2). Same SpriteMaterial
        // flags as cyborgs/spheres — depthTest off so we sit cleanly above
        // the ground without z-fighting.
        const tex = structureTextures.get(this.type) ?? null
        const mat = new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          depthTest: false,
          depthWrite: false,
          alphaTest: 0.1,
        })
        const sprite = new THREE.Sprite(mat)
        sprite.scale.set(SPRITE_SIZE, SPRITE_SIZE, 1)
        sprite.position.set(0, 0, 5)
        sprite.renderOrder = 10
        this.mesh.add(sprite)
        break
      }
      case 'wall': {
        // Wall body acts as its own HP indicator — scaled in takeDamage().
        // Fills most of the cell (40×40) so its shrink reads cleanly.
        const H = 40
        this.wallBodyHeight = H
        this.wallBody = new THREE.Mesh(
          new THREE.BoxGeometry(40, H, 12),
          new THREE.MeshBasicMaterial({ color: 0x996633 })
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
    this.hpBarGroup.position.set(0, 34, 0)
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 5),
      new THREE.MeshBasicMaterial({ color: 0x222222 })
    )
    bg.position.z = 0.1
    this.hpBarGroup.add(bg)

    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 5),
      new THREE.MeshBasicMaterial({ color: 0x00cc44 })
    )
    fill.position.z = 0.2
    this.hpBarGroup.add(fill)
    this.mesh.add(this.hpBarGroup)
    if (this.type === 'wall') this.hpBarGroup.visible = false
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
      // Tint darker as the wall takes a beating.
      const mat = this.wallBody.material as THREE.MeshBasicMaterial
      const tint = 0.5 + 0.5 * ratio
      mat.color.setRGB(0.6 * tint, 0.4 * tint, 0.2 * tint)
    } else {
      this.hpBar.scale.x = ratio
      this.hpBar.position.x = -(1 - ratio) * 20
      const mat = this.hpBar.material as THREE.MeshBasicMaterial
      mat.color.setHex(ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
    }

    if (this.isDead) this.mesh.removeFromParent()
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
