import * as THREE from 'three'
import { nextActorId } from '../game/TurnTypes'
import { SpriteUnit } from './SpriteUnit'
import { Structure } from './Structure'
import { SphereDefender } from './SphereDefender'
import { PixelPowerCore } from './PixelPowerCore'

// Sustained repair-beam between the Robot Repair unit and a damaged
// defender-side piece. Defender-side twin of Tether.ts — same lifecycle
// (pin both endpoints, heal per turn, burn 1 ammo per turn, end on
// medic death / target full HP / target death / ammo zero) but the
// target may be a Structure, SphereDefender, SpriteUnit (the Combat
// Dog), or the PixelPowerCore. Visual is an amber/orange beam so the
// engineering identity reads at a glance.

const BEAM_WIDTH = 5
const HALO_WIDTH = 14
const REPAIR_PER_TICK = 20
// Hard cap on weld duration. After this many ticks the channel auto-ends
// so the bot can re-target instead of staying pinned to a piece that
// keeps taking damage faster than it heals — also keeps the amber beam
// visual from feeling permanently "stuck on" to the player.
const MAX_TICKS = 5

export type RepairTetherTarget = Structure | SphereDefender | SpriteUnit | PixelPowerCore

// Read worldX/Y off any of the four target types. PixelPowerCore stores its
// centroid on mesh.position; the others all expose worldX/Y getters.
function targetX(t: RepairTetherTarget): number {
  return t instanceof PixelPowerCore ? t.mesh.position.x : t.worldX
}
function targetY(t: RepairTetherTarget): number {
  return t instanceof PixelPowerCore ? t.mesh.position.y : t.worldY
}

export class RepairTether {
  readonly id: string
  readonly bot: SpriteUnit
  readonly target: RepairTetherTarget
  readonly healPerTick = REPAIR_PER_TICK
  readonly maxTicks = MAX_TICKS
  ticksActive = 0
  isDead = false

  private scene: THREE.Scene
  private beamMesh: THREE.Mesh
  private haloMesh: THREE.Mesh
  private pulseTime = 0

  constructor(scene: THREE.Scene, bot: SpriteUnit, target: RepairTetherTarget) {
    this.id = nextActorId('rteth')
    this.bot = bot
    this.target = target
    this.scene = scene

    const haloGeo = new THREE.PlaneGeometry(1, HALO_WIDTH)
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xff9933,
      transparent: true,
      opacity: 0.20,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.haloMesh = new THREE.Mesh(haloGeo, haloMat)
    this.haloMesh.renderOrder = 9
    scene.add(this.haloMesh)

    const beamGeo = new THREE.PlaneGeometry(1, BEAM_WIDTH)
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a8,
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

  update(delta: number) {
    if (this.isDead) return
    // Target died mid-reveal (or the bot itself) — kill the beam visual
    // immediately so we don't leave a weld dangling to a corpse. Bookkeeping
    // (bot.tether=null, target.tether=null) catches up at next reveal via
    // tickRepairTethers.
    if (this.bot.isDead || this.target.isDead) {
      this.beamMesh.visible = false
      this.haloMesh.visible = false
      return
    }
    this.pulseTime += delta
    this.refreshGeometry()
    const k = 0.78 + 0.18 * Math.sin(this.pulseTime * 6)
    ;(this.beamMesh.material as THREE.MeshBasicMaterial).opacity = k
    ;(this.haloMesh.material as THREE.MeshBasicMaterial).opacity = 0.16 + 0.10 * Math.sin(this.pulseTime * 4)
  }

  private refreshGeometry() {
    const ax = this.bot.worldX, ay = this.bot.worldY
    const bx = targetX(this.target), by = targetY(this.target)
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
    this.beamMesh.position.set(cx, cy, 1)
    this.beamMesh.rotation.z = angle
    this.beamMesh.scale.set(dist, 1, 1)
    this.haloMesh.position.set(cx, cy, 0.9)
    this.haloMesh.rotation.z = angle
    this.haloMesh.scale.set(dist, 1, 1)
  }

  // Returns the target's current HP/maxHp ratio; used by RevealPhase to
  // decide whether to end the tether (target topped up to full).
  targetIsFull(): boolean {
    return this.target.hp >= this.target.maxHp
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
