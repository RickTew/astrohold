import * as THREE from 'three'

const SPEED = 450  // units per second

// Anything trackable as a projectile target must expose these. Keeping this as
// a structural type avoids importing Unit/SpriteUnit (which would couple the
// projectile to the body classes and risk circular imports).
type Trackable = { readonly worldX: number; readonly worldY: number; readonly isDead: boolean }

export class Projectile {
  // Default = a small sphere mesh. If a sprite texture is supplied (used by
  // the Bomber's grenade-ball projectile), `visual` becomes a THREE.Sprite
  // that we can rotate as it flies for a tumbling/spinning effect.
  private visual: THREE.Mesh | THREE.Sprite
  isDone = false
  targetX: number
  targetY: number
  onHit: (() => void) | null = null
  // Sprite-projectile arc: scale up then shrink so a top-down lob reads as a
  // toss (Y-axis arc is invisible from straight above).
  private arcBaseSize = 0
  private arcStartX = 0
  private arcStartY = 0
  private arcTotalDist = 0

  constructor(
    private scene: THREE.Scene,
    startX: number,
    startY: number,
    private targetUnit: Trackable | null,
    fixedTargetX: number,
    fixedTargetY: number,
    readonly damage: number,
    readonly isAoe: boolean = false,
    readonly aoeRadius: number = 0,
    baseColor: number = 0xffee00,   // yellow = structure shots; cyan = unit shots
    spriteTexture: THREE.Texture | null = null,
  ) {
    this.targetX = fixedTargetX
    this.targetY = fixedTargetY

    if (spriteTexture) {
      const mat = new THREE.SpriteMaterial({
        map: spriteTexture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        alphaTest: 0.1,
      })
      const sprite = new THREE.Sprite(mat)
      const size = isAoe ? 22 : 14
      sprite.scale.set(size, size, 1)
      sprite.position.set(startX, startY, 1.5)
      sprite.renderOrder = 12
      this.visual = sprite
      this.arcBaseSize = size
      this.arcStartX = startX
      this.arcStartY = startY
      const adx = fixedTargetX - startX
      const ady = fixedTargetY - startY
      this.arcTotalDist = Math.sqrt(adx * adx + ady * ady)
    } else {
      const geo = new THREE.SphereGeometry(isAoe ? 6 : 4, 6, 6)
      const mat = new THREE.MeshBasicMaterial({ color: isAoe ? 0xff4400 : baseColor })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(startX, startY, 1)
      this.visual = mesh
    }
    scene.add(this.visual)
  }

  // Returns true when it reaches the target
  update(delta: number): boolean {
    if (this.targetUnit && !this.targetUnit.isDead) {
      this.targetX = this.targetUnit.worldX
      this.targetY = this.targetUnit.worldY
    }

    const dx = this.targetX - this.visual.position.x
    const dy = this.targetY - this.visual.position.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    const step = SPEED * delta

    if (dist <= step) {
      this.isDone = true
      this.visual.removeFromParent()
      if (this.visual instanceof THREE.Mesh) {
        this.visual.geometry.dispose()
        ;(this.visual.material as THREE.MeshBasicMaterial).dispose()
      } else {
        // Sprite: dispose the SpriteMaterial we created. Don't dispose the
        // shared map texture — it's reused across projectiles.
        this.visual.material.dispose()
      }
      return true
    }

    this.visual.position.x += (dx / dist) * step
    this.visual.position.y += (dy / dist) * step

    // Spin sprite projectiles (bowling-ball grenade tumble) — gives a sense
    // of motion top-down where lobbed arcs are hard to convey.
    if (this.visual instanceof THREE.Sprite) {
      this.visual.material.rotation += delta * 6
      // Lob arc: scale up at apex, shrink back near landing. sin(π·t) peaks
      // at t=0.5 — combined with the spin this reads as "thrown high".
      if (this.arcTotalDist > 0) {
        const dxs = this.visual.position.x - this.arcStartX
        const dys = this.visual.position.y - this.arcStartY
        const traveled = Math.sqrt(dxs * dxs + dys * dys)
        const t = Math.min(1, traveled / this.arcTotalDist)
        const k = 1 + 0.7 * Math.sin(Math.PI * t)
        const s = this.arcBaseSize * k
        this.visual.scale.set(s, s, 1)
      }
    }
    return false
  }
}
