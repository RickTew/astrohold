import * as THREE from 'three'
import { Config } from '../game/GameConfig'
import { nextActorId } from '../game/TurnTypes'
import { SpriteUnit } from './SpriteUnit'
import { Structure } from './Structure'
import { SphereDefender } from './SphereDefender'
import { PixelPowerCore } from './PixelPowerCore'

// Deployable repair station dropped by the Robot Repair unit during BATTLE.
// Defender-side twin of MedicPad — sits on a single grid cell, ticks repairs
// to adjacent defender pieces (structures, dog, sphere, power-core sub-cells)
// each turn, consumes 1 charge per cycle, self-destructs at zero.
//
// The art is a wrench-on-anvil pad with a warm amber glow so it reads as
// "engineering" rather than the medic-pad's green-cross "medical."

const DEFAULT_HP = 60
const DEFAULT_CHARGES = 4
const REPAIR_PER_CYCLE = 15
const REPAIR_RADIUS_CELLS = 1.6     // ~adjacent + diagonal
const PAD_SPRITE_SIZE = 38

export interface RepairTarget {
  readonly isDead: boolean
  readonly worldX: number
  readonly worldY: number
  heal(amount: number): boolean
}

let padTexture: THREE.CanvasTexture | null = null

function getPadTexture(): THREE.CanvasTexture {
  if (padTexture) return padTexture
  const c = document.createElement('canvas')
  c.width = 64; c.height = 64
  const ctx = c.getContext('2d')!
  // Warm amber halo so the engineering identity reads at a glance
  const grad = ctx.createRadialGradient(32, 32, 18, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255, 180, 70, 0.50)')
  grad.addColorStop(1, 'rgba(255, 180, 70, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 64, 64)
  // Pad base — steel-blue panel with a darker outline
  ctx.fillStyle = '#c8d4e0'
  ctx.fillRect(8, 8, 48, 48)
  ctx.strokeStyle = '#1a2030'
  ctx.lineWidth = 3
  ctx.strokeRect(8, 8, 48, 48)
  ctx.strokeStyle = '#7080a0'
  ctx.lineWidth = 1
  ctx.strokeRect(10, 10, 44, 44)
  // Wrench-and-anvil glyph — two crossed wrenches in amber
  ctx.fillStyle = '#ffa84a'
  ctx.strokeStyle = '#1a2030'
  ctx.lineWidth = 2
  ctx.save()
  ctx.translate(32, 32)
  ctx.rotate(Math.PI / 4)
  ctx.fillRect(-14, -3, 28, 6)
  ctx.strokeRect(-14, -3, 28, 6)
  ctx.fillRect(-3, -14, 6, 28)
  ctx.strokeRect(-3, -14, 6, 28)
  ctx.restore()
  // Bolt heads at the corners — pure visual flavor
  ctx.fillStyle = '#5a6878'
  ctx.fillRect(12, 12, 4, 4)
  ctx.fillRect(48, 12, 4, 4)
  ctx.fillRect(12, 48, 4, 4)
  ctx.fillRect(48, 48, 4, 4)
  padTexture = new THREE.CanvasTexture(c)
  padTexture.magFilter = THREE.NearestFilter
  padTexture.minFilter = THREE.NearestFilter
  padTexture.colorSpace = THREE.SRGBColorSpace
  return padTexture
}

export class RepairPad {
  readonly id: string
  readonly side: 'defender' = 'defender'
  readonly worldX: number
  readonly worldY: number
  readonly col: number
  readonly row: number
  hp: number
  readonly maxHp = DEFAULT_HP
  chargesRemaining: number
  isDead = false
  sprite: THREE.Sprite
  private scene: THREE.Scene
  private pulseTime = 0

  constructor(scene: THREE.Scene, col: number, row: number) {
    this.id = nextActorId('rpad')
    this.col = col
    this.row = row
    this.scene = scene
    const cs = Config.GRID_CELL
    this.worldX = Config.WORLD.LEFT + col * cs + cs / 2
    this.worldY = Config.WORLD.BOTTOM + row * cs + cs / 2
    this.hp = DEFAULT_HP
    this.chargesRemaining = DEFAULT_CHARGES

    const mat = new THREE.SpriteMaterial({
      map: getPadTexture(),
      transparent: true,
      depthTest: false,
      depthWrite: false,
      alphaTest: 0.05,
    })
    this.sprite = new THREE.Sprite(mat)
    this.sprite.position.set(this.worldX, this.worldY, 1)
    this.sprite.scale.set(PAD_SPRITE_SIZE, PAD_SPRITE_SIZE, 1)
    this.sprite.renderOrder = 8
    scene.add(this.sprite)
  }

  // Tick from the reveal loop. Caller passes everything defender-side that
  // can take a repair (structures, defender mobile units, the sphere array,
  // and the power core represented by its 4 cell centers). Each in-radius
  // damaged target gets one REPAIR_PER_CYCLE pulse. Returns hits + expired
  // flag so RevealPhase can log + sweep.
  tick(
    structures: Structure[],
    defenderUnits: SpriteUnit[],
    spheres: SphereDefender[],
    core: PixelPowerCore,
  ): { healed: number; expired: boolean } {
    if (this.isDead || this.chargesRemaining <= 0) {
      return { healed: 0, expired: true }
    }
    const radius = REPAIR_RADIUS_CELLS * Config.GRID_CELL
    let healed = 0
    const tryHeal = (t: RepairTarget) => {
      if (t.isDead) return
      const d = Math.hypot(t.worldX - this.worldX, t.worldY - this.worldY)
      if (d > radius) return
      if (t.heal(REPAIR_PER_CYCLE)) healed++
    }
    for (const s of structures)    tryHeal(s)
    for (const u of defenderUnits) tryHeal(u)
    for (const s of spheres)       tryHeal(s)
    // Power Core occupies four cells; the closest sub-cell drives the
    // adjacency check, but a successful heal applies to the core as a
    // whole (so we count it as one healed target, not four).
    if (!core.isDead) {
      let nearest = Infinity
      for (const cc of core.cellCenters()) {
        const d = Math.hypot(cc.x - this.worldX, cc.y - this.worldY)
        if (d < nearest) nearest = d
      }
      if (nearest <= radius && core.heal(REPAIR_PER_CYCLE)) healed++
    }
    this.chargesRemaining--
    const expired = this.chargesRemaining <= 0
    return { healed, expired }
  }

  takeDamage(amount: number) {
    if (this.isDead) return
    this.hp = Math.max(0, this.hp - amount)
    if (this.hp <= 0) this.kill()
  }

  kill() {
    if (this.isDead) return
    this.isDead = true
    this.dispose()
  }

  // Soft pulse so the pad reads as an active station.
  animate(delta: number) {
    if (this.isDead) return
    this.pulseTime += delta
    const k = 1 + 0.08 * Math.sin(this.pulseTime * 3.2)
    this.sprite.scale.set(PAD_SPRITE_SIZE * k, PAD_SPRITE_SIZE * k, 1)
  }

  dispose() {
    if (this.sprite.parent) this.sprite.removeFromParent()
    this.sprite.material.dispose()
  }
}
