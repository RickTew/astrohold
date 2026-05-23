import * as THREE from 'three'
import { Config, TEAM_TINT } from '../game/GameConfig'
import { QueuedAction, STATIONARY_INITIATIVE, nextActorId } from '../game/TurnTypes'
import { playExplosion } from '../audio/sfx'

// Pre-rendered pixel-art sphere: 8 directions. Cycling through them on a
// timer creates the "spinning" effect — far cheaper than the 60 MB GLB.
const SPHERE_DIRECTIONS = [
  'south', 'south-east', 'east', 'north-east',
  'north', 'north-west', 'west', 'south-west',
] as const
const SPHERE_FRAME_INTERVAL = 0.4    // seconds per direction = ~3.2 s per full spin
const SPHERE_SCREEN_SIZE = 45        // sprite world-units — sized to match other defender units on screen

const sphereTextures: THREE.Texture[] = []
const sphereExplosionTextures: THREE.Texture[] = []
const SPHERE_EXPLOSION_FRAME_COUNT = 4
const SPHERE_EXPLOSION_FRAME_INTERVAL = 0.09   // ~0.36 s total burst
let sphereTexturesLoaded = false

function loadTex(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, tex => {
      tex.magFilter = THREE.NearestFilter   // crisp pixel-art scaling
      tex.minFilter = THREE.NearestFilter
      tex.colorSpace = THREE.SRGBColorSpace
      resolve(tex)
    }, undefined, reject)
  })
}

export async function preloadSphereSprites(): Promise<void> {
  await Promise.all([
    ...SPHERE_DIRECTIONS.map(async (dir, i) => {
      sphereTextures[i] = await loadTex(`/sprites/sphere/${dir}.png`)
    }),
    ...Array.from({ length: SPHERE_EXPLOSION_FRAME_COUNT }, async (_, i) => {
      const num = String(i).padStart(3, '0')
      sphereExplosionTextures[i] = await loadTex(`/sprites/sphere/explosion/frame_${num}.png`)
    }),
  ])
  sphereTexturesLoaded = true
}

export class SphereDefender {
  readonly mesh: THREE.Group
  readonly id: string
  worldX: number
  worldY: number
  hp: number
  readonly maxHp = Config.SPHERE.hp
  isDead = false
  readonly range = Config.SPHERE.range
  readonly damage = Config.SPHERE.damage

  // Stationary piece — always sorts late in initiative. apBudget allows the
  // sphere to queue multiple shots per turn (live behavior: 3 shots).
  readonly initiative = STATIONARY_INITIATIVE
  readonly apBudget = Config.SPHERE.apBudget
  apRemaining = this.apBudget
  // D&D-style ammo budget for the whole game (not per turn). When 0 the
  // sphere is inert (still alive, still a target, just can't shoot).
  ammoRemaining: number = Config.SPHERE.ammo
  queuedActions: QueuedAction[] = []
  get side(): 'defender' { return 'defender' }

  private sprite: THREE.Sprite
  private hpBarGroup: THREE.Group
  private hpBarFill: THREE.Mesh
  private spinTime = 0
  private frameIndex = 0
  private dying = false
  private dyingTime = 0
  private dyingFrame = 0

  constructor(scene: THREE.Scene, x: number, y: number, team: 'player' | 'ai' = 'player') {
    this.id = nextActorId('sphere')
    this.worldX = x
    this.worldY = y
    this.hp = this.maxHp

    this.mesh = new THREE.Group()
    this.mesh.position.set(x, y, 0)

    const firstTex = sphereTexturesLoaded ? sphereTextures[0] : null
    // depthTest: false so the sphere is never occluded by ground / fence
    // line / anything else's depth buffer. depthWrite: false so it doesn't
    // poison the buffer for whatever draws after. alphaTest preserves clean
    // pixel-art edges. renderOrder bumps it after background elements.
    const mat = new THREE.SpriteMaterial({
      map: firstTex,
      color: TEAM_TINT[team],
      transparent: true,
      depthTest: false,
      depthWrite: false,
      alphaTest: 0.1,
    })
    this.sprite = new THREE.Sprite(mat)
    this.sprite.scale.set(SPHERE_SCREEN_SIZE, SPHERE_SCREEN_SIZE, 1)
    this.sprite.position.set(0, 0, 5)
    this.sprite.renderOrder = 10
    this.mesh.add(this.sprite)

    const { group, fill } = this.buildHpBar()
    this.hpBarGroup = group
    this.hpBarFill = fill
    // HP bar hidden — plan-then-watch model. See SpriteUnit for full reasoning.
    this.hpBarGroup.visible = false

    scene.add(this.mesh)
  }

  update(delta: number) {
    if (!sphereTexturesLoaded) return

    if (this.dying) {
      this.dyingTime += delta
      const next = Math.min(
        SPHERE_EXPLOSION_FRAME_COUNT - 1,
        Math.floor(this.dyingTime / SPHERE_EXPLOSION_FRAME_INTERVAL),
      )
      if (next !== this.dyingFrame) {
        this.dyingFrame = next
        this.sprite.material.map = sphereExplosionTextures[next] ?? null
        this.sprite.material.needsUpdate = true
      }
      // Hide once the burst has held the final frame for a beat.
      if (this.dyingFrame === SPHERE_EXPLOSION_FRAME_COUNT - 1
          && this.dyingTime > SPHERE_EXPLOSION_FRAME_COUNT * SPHERE_EXPLOSION_FRAME_INTERVAL + 0.4) {
        this.mesh.visible = false
      }
      return
    }

    this.spinTime += delta
    const next = Math.floor(this.spinTime / SPHERE_FRAME_INTERVAL) % SPHERE_DIRECTIONS.length
    if (next !== this.frameIndex) {
      this.frameIndex = next
      this.sprite.material.map = sphereTextures[next]
      this.sprite.material.needsUpdate = true
    }
  }

  private startDying() {
    this.dying = true
    this.hpBarGroup.visible = false
    if (sphereExplosionTextures[0]) {
      this.sprite.material.map = sphereExplosionTextures[0]
      this.sprite.material.needsUpdate = true
    }
    playExplosion()
  }

  faceCamera(camera: THREE.Camera) {
    this.hpBarGroup.quaternion.copy(camera.quaternion)
  }

  clearPlan() {
    this.queuedActions = []
    this.apRemaining = this.apBudget
  }
  refillAp() { this.apRemaining = this.apBudget }
  queueAction(action: QueuedAction, apCost: number) {
    this.queuedActions.push(action)
    this.apRemaining -= apCost
  }

  takeDamage(amount: number) {
    if (this.isDead) return
    this.hp = Math.max(0, this.hp - amount)
    const ratio = this.hp / this.maxHp
    this.hpBarFill.scale.x = ratio
    this.hpBarFill.position.x = -(1 - ratio) * 12   // half of new bar width 24
    const mat = this.hpBarFill.material as THREE.MeshBasicMaterial
    mat.color.setHex(ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
    if (this.hp <= 0 && !this.dying) {
      this.isDead = true
      this.startDying()
    }
  }

  // Repair-bot heal target. Returns true iff any HP was restored. Skips if
  // dead or already-full.
  heal(amount: number): boolean {
    if (this.isDead || this.hp >= this.maxHp) return false
    const before = this.hp
    this.hp = Math.min(this.maxHp, this.hp + amount)
    const restored = this.hp - before
    if (restored <= 0) return false
    const ratio = this.hp / this.maxHp
    this.hpBarFill.scale.x = ratio
    this.hpBarFill.position.x = -(1 - ratio) * 12
    const mat = this.hpBarFill.material as THREE.MeshBasicMaterial
    mat.color.setHex(ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
    this.pulseRepairVfx()
    return true
  }

  private repairPulseTimer: number | null = null
  private pulseRepairVfx() {
    const m = this.sprite.material
    const before = m.color.getHex()
    if (this.repairPulseTimer !== null) clearTimeout(this.repairPulseTimer)
    m.color.setHex(0xffcc66)
    this.repairPulseTimer = window.setTimeout(() => {
      m.color.setHex(before)
      this.repairPulseTimer = null
    }, 280)
  }

  private buildHpBar(): { group: THREE.Group; fill: THREE.Mesh } {
    const group = new THREE.Group()
    // Sphere body fills rows 29..80 of the 108px sprite (~52px / 108 ≈ 48% of
    // the sprite). At SPHERE_SCREEN_SIZE=45 the body half-height in screen-up
    // is ~11 world units; local y=15 lands the bar just above the body with a
    // small gap, and stays inside the +Y fence at the edge of the defender zone.
    group.position.set(0, 15, 0)

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
