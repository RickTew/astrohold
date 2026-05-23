import * as THREE from 'three'
import { nextActorId } from '../game/TurnTypes'
import { SpriteUnit } from './SpriteUnit'

// Sustained healing bond between the Medic and a damaged cyborg ally.
// While the tether is alive: both units are pinned (their default action
// becomes 'hold'), the target heals per turn, the medic spends 1 ammo
// per turn. Ends when the medic runs out of ammo, the target reaches
// full HP, or either dies.
//
// Visual: a thin glowing green strip rendered between the two positions,
// updated per frame so it tracks the units. Drawn as a flat plane with
// additive-blended material so it reads as light, not a solid bar.

const BEAM_WIDTH = 5         // world units
const HALO_WIDTH = 14        // halo width behind the core beam
const HEAL_PER_TICK = 20
// Hard cap on tether duration. After this many ticks the bond auto-ends so
// the medic can re-target instead of staying pinned to a single ally that
// keeps taking damage faster than the tether heals (also stops the visual
// from feeling permanently "stuck on" to the player).
const MAX_TICKS = 5

export class Tether {
  readonly id: string
  readonly medic: SpriteUnit
  readonly target: SpriteUnit
  readonly healPerTick = HEAL_PER_TICK
  readonly maxTicks = MAX_TICKS
  ticksActive = 0
  isDead = false

  private scene: THREE.Scene
  private beamMesh: THREE.Mesh
  private haloMesh: THREE.Mesh
  private pulseTime = 0

  constructor(scene: THREE.Scene, medic: SpriteUnit, target: SpriteUnit) {
    this.id = nextActorId('teth')
    this.medic = medic
    this.target = target
    this.scene = scene

    // Halo — wider, dimmer plane behind the core beam to suggest glow.
    const haloGeo = new THREE.PlaneGeometry(1, HALO_WIDTH)
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x66ff88,
      transparent: true,
      opacity: 0.20,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.haloMesh = new THREE.Mesh(haloGeo, haloMat)
    this.haloMesh.renderOrder = 9
    scene.add(this.haloMesh)

    // Core beam — thin bright plane on top of the halo.
    const beamGeo = new THREE.PlaneGeometry(1, BEAM_WIDTH)
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xc8ffd8,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    })
    this.beamMesh = new THREE.Mesh(beamGeo, beamMat)
    this.beamMesh.renderOrder = 10
    scene.add(this.beamMesh)

    this.refreshGeometry()
  }

  // Per-frame visual update. Recomputes position + rotation + length so
  // the beam stays anchored to both endpoints as they shift (units don't
  // move while tethered today, but if a future mechanic lets them drift
  // a cell or two we already track it).
  update(delta: number) {
    if (this.isDead) return
    // Healing target died mid-reveal (or the medic itself) — collapse the
    // beam visual immediately. The tickTethers cleanup at the next reveal
    // start will fix the bookkeeping (medic.tether=null, target.tether=null);
    // we just want the visual to stop dangling between a medic and a corpse.
    if (this.medic.isDead || this.target.isDead) {
      this.beamMesh.visible = false
      this.haloMesh.visible = false
      return
    }
    this.pulseTime += delta
    this.refreshGeometry()
    // Subtle alpha pulse so the beam reads as "flowing energy" rather
    // than a static line.
    const k = 0.78 + 0.18 * Math.sin(this.pulseTime * 6)
    ;(this.beamMesh.material as THREE.MeshBasicMaterial).opacity = k
    ;(this.haloMesh.material as THREE.MeshBasicMaterial).opacity = 0.16 + 0.10 * Math.sin(this.pulseTime * 4)
  }

  private refreshGeometry() {
    const ax = this.medic.worldX, ay = this.medic.worldY
    const bx = this.target.worldX, by = this.target.worldY
    const dx = bx - ax, dy = by - ay
    const dist = Math.hypot(dx, dy)
    if (dist < 0.1) {
      this.beamMesh.visible = false
      this.haloMesh.visible = false
      return
    }
    this.beamMesh.visible = true
    this.haloMesh.visible = true
    const cx = (ax + bx) / 2
    const cy = (ay + by) / 2
    const angle = Math.atan2(dy, dx)
    // PlaneGeometry(1, w) is 1 wide along X and `w` tall along Y. We want
    // the long axis (X) to run between endpoints. scale.x = dist sets the
    // beam length; rotation.z aligns it with the endpoint angle.
    this.beamMesh.position.set(cx, cy, 1)
    this.beamMesh.rotation.z = angle
    this.beamMesh.scale.set(dist, 1, 1)
    this.haloMesh.position.set(cx, cy, 0.9)
    this.haloMesh.rotation.z = angle
    this.haloMesh.scale.set(dist, 1, 1)
  }

  end() {
    if (this.isDead) return
    this.isDead = true
    this.dispose()
  }

  dispose() {
    if (this.beamMesh.parent) this.beamMesh.removeFromParent()
    if (this.haloMesh.parent) this.haloMesh.removeFromParent()
    this.beamMesh.geometry.dispose()
    ;(this.beamMesh.material as THREE.MeshBasicMaterial).dispose()
    this.haloMesh.geometry.dispose()
    ;(this.haloMesh.material as THREE.MeshBasicMaterial).dispose()
  }
}
