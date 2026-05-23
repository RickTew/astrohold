import * as THREE from 'three'
import { Config, UnitType } from '../game/GameConfig'
import { nextActorId } from '../game/TurnTypes'

// Resupply crate that drops randomly into the battlefield during BATTLE.
// A unit walking onto the crate's cell consumes it for +2 of its ammo
// type. Self-managed visual + lifecycle; Game owns the array.
//
// Four kit types — each tops up a different unit family so a Medic
// can't refill from a generic bullet crate (and vice versa).
//
//   'ammo'       — rifle/cannon/pistol rounds. Most direct-fire units.
//   'grenade'    — explosive shells. Grenadier and Bomber.
//   'medkit'     — medic packs. Medic only.
//   'repair_kit' — repair charges. Repair bot only.

export type AmmoKitType = 'ammo' | 'grenade' | 'medkit' | 'repair_kit'

export const KIT_AMOUNT = 2   // shots/charges granted per pickup

// Map a unit type to the crate type that refills it. Anything not in the
// map (e.g., hulk — unlimited fists already) can't pick up crates.
const UNIT_KIT: Partial<Record<UnitType, AmmoKitType>> = {
  cannon:    'ammo',
  doublegun: 'ammo',
  sniper:    'ammo',
  scout:     'ammo',
  tank:      'ammo',
  drone:     'ammo',
  dog:       'ammo',
  grenadier: 'grenade',
  bomber:    'grenade',
  medic:     'medkit',
  repair:    'repair_kit',
}

export function kitForUnit(type: UnitType): AmmoKitType | null {
  return UNIT_KIT[type] ?? null
}

// Per-type procedural textures. Drawn once at first request and shared
// across every spawn — small canvases, but no point re-rendering.
const textureCache: Record<AmmoKitType, THREE.Texture | null> = {
  ammo: null, grenade: null, medkit: null, repair_kit: null,
}

function makeBoxTexture(type: AmmoKitType): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 32; c.height = 32
  const ctx = c.getContext('2d')!
  // Per-type palette
  let bg: string, accent: string, glyphColor: string
  switch (type) {
    case 'ammo':       bg = '#3a3a1c'; accent = '#dcc44c'; glyphColor = '#fff2a8'; break
    case 'grenade':    bg = '#1c3a1c'; accent = '#4cdc4c'; glyphColor = '#caffca'; break
    case 'medkit':     bg = '#f0f6ff'; accent = '#cc2222'; glyphColor = '#cc2222'; break
    case 'repair_kit': bg = '#2a3344'; accent = '#ffa84a'; glyphColor = '#ffd9a8'; break
  }
  // Crate body — chamfered square
  ctx.fillStyle = bg
  ctx.fillRect(3, 3, 26, 26)
  ctx.strokeStyle = accent
  ctx.lineWidth = 2
  ctx.strokeRect(3, 3, 26, 26)
  // Inner border for depth
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'
  ctx.lineWidth = 1
  ctx.strokeRect(5, 5, 22, 22)
  // Bolt heads at corners
  ctx.fillStyle = accent
  ctx.fillRect(4, 4, 3, 3)
  ctx.fillRect(25, 4, 3, 3)
  ctx.fillRect(4, 25, 3, 3)
  ctx.fillRect(25, 25, 3, 3)
  // Per-type icon — drawn explicitly so the symbol is perfectly centered.
  // Unicode glyphs had varying baselines that shifted the icon off-center
  // depending on the font fallback.
  ctx.fillStyle = glyphColor
  ctx.strokeStyle = glyphColor
  switch (type) {
    case 'ammo': {
      // Sniper-style crosshair: + with a center dot
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(16, 8);  ctx.lineTo(16, 24)
      ctx.moveTo(8, 16);  ctx.lineTo(24, 16)
      ctx.stroke()
      ctx.beginPath(); ctx.arc(16, 16, 2, 0, Math.PI * 2); ctx.fill()
      break
    }
    case 'grenade': {
      // Round grenade body with a short fuse on top
      ctx.beginPath(); ctx.arc(16, 17, 6, 0, Math.PI * 2); ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = glyphColor
      ctx.beginPath(); ctx.moveTo(16, 10); ctx.lineTo(16, 7); ctx.stroke()
      // Small spark above the fuse
      ctx.beginPath(); ctx.arc(16, 6, 1.5, 0, Math.PI * 2); ctx.fill()
      break
    }
    case 'medkit': {
      // Red cross, thick centered bars
      const arm = 3, len = 12
      ctx.fillRect(16 - arm, 16 - len / 2, arm * 2, len)
      ctx.fillRect(16 - len / 2, 16 - arm, len, arm * 2)
      break
    }
    case 'repair_kit': {
      // Stylized wrench — two crossed bars at 45° with a circle handle
      ctx.save(); ctx.translate(16, 16); ctx.rotate(Math.PI / 4)
      ctx.fillRect(-1.5, -8, 3, 16)
      ctx.fillRect(-8, -1.5, 16, 3)
      ctx.restore()
      break
    }
  }

  const tex = new THREE.CanvasTexture(c)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function getBoxTexture(type: AmmoKitType): THREE.Texture {
  if (!textureCache[type]) textureCache[type] = makeBoxTexture(type)
  return textureCache[type]!
}

export class AmmoBox {
  readonly id: string
  readonly type: AmmoKitType
  readonly worldX: number
  readonly worldY: number
  // 1 HP — any direct hit or AoE shrapnel destroys the crate. Defenders
  // can shoot them to deny enemy reloads (spending a round to deny ~2),
  // and a grenade landing on or near a crate vaporizes its contents.
  hp = 1
  readonly maxHp = 1
  isDead = false
  sprite: THREE.Sprite
  private pulseTime = 0

  constructor(scene: THREE.Scene, col: number, row: number, type: AmmoKitType) {
    this.id = nextActorId('box')
    this.type = type
    const cs = Config.GRID_CELL
    this.worldX = Config.WORLD.LEFT + col * cs + cs / 2
    this.worldY = Config.WORLD.BOTTOM + row * cs + cs / 2
    const mat = new THREE.SpriteMaterial({
      map: getBoxTexture(type),
      transparent: true,
      depthTest: false,
      depthWrite: false,
      alphaTest: 0.05,
    })
    this.sprite = new THREE.Sprite(mat)
    this.sprite.scale.set(28, 28, 1)
    this.sprite.position.set(this.worldX, this.worldY, 1.5)
    this.sprite.renderOrder = 9
    scene.add(this.sprite)
  }

  // True if this crate can refill `unitType`'s ammunition pool.
  canBePickedUpBy(unitType: UnitType): boolean {
    return kitForUnit(unitType) === this.type
  }

  takeDamage(amount: number) {
    if (this.isDead) return
    this.hp = Math.max(0, this.hp - amount)
    if (this.hp <= 0) this.dispose()
  }

  // Soft pulse so the crate stands out against the terrain.
  animate(delta: number) {
    if (this.isDead) return
    this.pulseTime += delta
    const k = 1 + 0.08 * Math.sin(this.pulseTime * 3.6)
    this.sprite.scale.set(28 * k, 28 * k, 1)
  }

  dispose() {
    if (this.isDead) return
    this.isDead = true
    this.sprite.removeFromParent()
    this.sprite.material.dispose()
  }
}
