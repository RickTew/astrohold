import * as THREE from 'three'

// Pre-rendered pixel-art sphere: 8 directions. Cycling through them on a
// timer creates the "spinning" effect — far cheaper than the 60 MB GLB.
const SPHERE_DIRECTIONS = [
  'south', 'south-east', 'east', 'north-east',
  'north', 'north-west', 'west', 'south-west',
] as const
const SPHERE_FRAME_INTERVAL = 0.4    // seconds per direction = ~3.2 s per full spin
const SPHERE_SCREEN_SIZE = 44        // sprite world-units (slightly larger than the old GLB at 36)

const sphereTextures: THREE.Texture[] = []
let sphereTexturesLoaded = false

export async function preloadSphereSprites(): Promise<void> {
  const loader = new THREE.TextureLoader()
  await Promise.all(SPHERE_DIRECTIONS.map((dir, i) =>
    new Promise<void>((resolve, reject) => {
      loader.load(
        `/sprites/sphere/${dir}.png`,
        tex => {
          tex.magFilter = THREE.NearestFilter   // crisp pixel-art scaling
          tex.minFilter = THREE.NearestFilter
          tex.colorSpace = THREE.SRGBColorSpace
          sphereTextures[i] = tex
          resolve()
        },
        undefined,
        reject
      )
    })
  ))
  sphereTexturesLoaded = true
}

export class SphereDefender {
  readonly mesh: THREE.Group
  worldX: number
  worldY: number
  hp: number
  readonly maxHp = 300
  isDead = false
  readonly range = 300
  readonly damage = 10

  private sprite: THREE.Sprite
  private hpBarGroup: THREE.Group
  private hpBarFill: THREE.Mesh
  private spinTime = 0
  private frameIndex = 0

  constructor(scene: THREE.Scene, x: number, y: number) {
    this.worldX = x
    this.worldY = y
    this.hp = this.maxHp

    this.mesh = new THREE.Group()
    this.mesh.position.set(x, y, 0)

    const firstTex = sphereTexturesLoaded ? sphereTextures[0] : null
    // depthWrite: false stops the sprite quad's transparent pixels from
    // blocking the cyan zone tint behind it (would leave brown rectangles).
    // alphaTest discards fully transparent pixels for clean edges.
    const mat = new THREE.SpriteMaterial({
      map: firstTex,
      transparent: true,
      depthWrite: false,
      alphaTest: 0.1,
    })
    this.sprite = new THREE.Sprite(mat)
    this.sprite.scale.set(SPHERE_SCREEN_SIZE, SPHERE_SCREEN_SIZE, 1)
    this.sprite.position.set(0, 0, 5)
    this.mesh.add(this.sprite)

    const { group, fill } = this.buildHpBar()
    this.hpBarGroup = group
    this.hpBarFill = fill

    scene.add(this.mesh)
  }

  update(delta: number) {
    if (!sphereTexturesLoaded) return
    this.spinTime += delta
    const next = Math.floor(this.spinTime / SPHERE_FRAME_INTERVAL) % SPHERE_DIRECTIONS.length
    if (next !== this.frameIndex) {
      this.frameIndex = next
      this.sprite.material.map = sphereTextures[next]
      this.sprite.material.needsUpdate = true
    }
  }

  faceCamera(camera: THREE.Camera) {
    this.hpBarGroup.quaternion.copy(camera.quaternion)
  }

  takeDamage(amount: number) {
    if (this.isDead) return
    this.hp = Math.max(0, this.hp - amount)
    const ratio = this.hp / this.maxHp
    this.hpBarFill.scale.x = ratio
    this.hpBarFill.position.x = -(1 - ratio) * 15
    const mat = this.hpBarFill.material as THREE.MeshBasicMaterial
    mat.color.setHex(ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
    if (this.hp <= 0) {
      this.isDead = true
      this.mesh.visible = false
    }
  }

  private buildHpBar(): { group: THREE.Group; fill: THREE.Mesh } {
    const group = new THREE.Group()
    group.position.set(0, 32, 0)

    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 4),
      new THREE.MeshBasicMaterial({ color: 0xcc2222 })
    )
    bg.position.z = 0.1
    group.add(bg)

    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 4),
      new THREE.MeshBasicMaterial({ color: 0x00cc44 })
    )
    fill.position.z = 0.2
    group.add(fill)

    this.mesh.add(group)
    return { group, fill }
  }
}
