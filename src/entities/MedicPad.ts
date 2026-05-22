import * as THREE from 'three'
import { Config } from '../game/GameConfig'
import { nextActorId } from '../game/TurnTypes'
import { SpriteUnit } from './SpriteUnit'

// Deployable healing station dropped by the Cyborg Medic during BATTLE.
// Sits on a single grid cell, heals damaged cyborg allies in an N-cell
// radius each turn, costs 1 charge per heal-cycle. Destroyed when its
// charges run out or HP hits zero.
//
// Architecturally a battlefield-spawned mini-structure — NOT a regular
// Structure (those are defender-side, placed during BUILD). Lives in
// Game.medicPads[] and gets ticked from RevealPhase between actor steps.

const DEFAULT_HP = 60
const DEFAULT_CHARGES = 4         // total heal cycles before self-destruct
const HEAL_PER_CYCLE = 15         // HP restored per adjacent cyborg per cycle
const HEAL_RADIUS_CELLS = 1.6     // ~adjacent + diagonal
const PAD_SPRITE_SIZE = 38        // world units (cell is 50, leaves border)

let padTexture: THREE.CanvasTexture | null = null

// Procedural pad texture — a white pad with a green medical cross and a
// soft glowing border. Drawn once at module load and shared by every pad.
function getPadTexture(): THREE.CanvasTexture {
  if (padTexture) return padTexture
  const c = document.createElement('canvas')
  c.width = 64; c.height = 64
  const ctx = c.getContext('2d')!
  // Outer glow halo
  const grad = ctx.createRadialGradient(32, 32, 18, 32, 32, 32)
  grad.addColorStop(0, 'rgba(80, 230, 120, 0.45)')
  grad.addColorStop(1, 'rgba(80, 230, 120, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 64, 64)
  // Pad base — white panel with dark outline
  ctx.fillStyle = '#e8f4ff'
  ctx.fillRect(8, 8, 48, 48)
  ctx.strokeStyle = '#1a3040'
  ctx.lineWidth = 3
  ctx.strokeRect(8, 8, 48, 48)
  // Inner shadow line for depth
  ctx.strokeStyle = '#a0b8c8'
  ctx.lineWidth = 1
  ctx.strokeRect(10, 10, 44, 44)
  // Green medical cross
  ctx.fillStyle = '#3dd955'
  ctx.fillRect(26, 16, 12, 32)
  ctx.fillRect(16, 26, 32, 12)
  ctx.strokeStyle = '#1a3040'
  ctx.lineWidth = 2
  ctx.strokeRect(26, 16, 12, 32)
  ctx.strokeRect(16, 26, 32, 12)
  padTexture = new THREE.CanvasTexture(c)
  padTexture.magFilter = THREE.NearestFilter
  padTexture.minFilter = THREE.NearestFilter
  padTexture.colorSpace = THREE.SRGBColorSpace
  return padTexture
}

export class MedicPad {
  readonly id: string
  readonly side: 'attacker' = 'attacker'
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
    this.id = nextActorId('pad')
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

  // Tick from the reveal loop — heal every damaged ally inside the heal
  // radius, then burn one charge. Returns { healed, killed-by-charges }
  // counts so the caller can log a summary. Self-destructs when charges
  // hit zero (caller removes the pad from the array).
  tick(allies: SpriteUnit[]): { healed: number; expired: boolean } {
    if (this.isDead || this.chargesRemaining <= 0) {
      return { healed: 0, expired: true }
    }
    const radius = HEAL_RADIUS_CELLS * Config.GRID_CELL
    let healed = 0
    for (const a of allies) {
      if (a.isDead || a.hp >= a.maxHp) continue
      const d = Math.hypot(a.worldX - this.worldX, a.worldY - this.worldY)
      if (d > radius) continue
      if (a.heal(HEAL_PER_CYCLE)) healed++
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

  // Soft pulse on the sprite material — animates per-frame from RevealPhase
  // so the pad reads as "active station" rather than a placed decal.
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
