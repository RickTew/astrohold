import * as THREE from 'three'
import { spawnHealVfx, HealVfxVariant } from './HealVfx'
import { spawnSpeechBubble } from './SpeechBubble'
import { Config, TEAM_TINT } from '../game/GameConfig'
import { playExplosion } from '../audio/sfx'

// 2D-sprite alternative to the GLB PowerCore. Billboarded, so it cannot be
// occluded by its own geometry the way the 3D Meshy export was.
//
// State machine:
//   - alive:  cycles through 8 rotation PNGs (~4 s full spin)
//   - dying:  one-shot 9-frame explosion (south direction), then hides

const DIRECTIONS = [
  'south', 'south-east', 'east', 'north-east',
  'north', 'north-west', 'west', 'south-west',
] as const
// Core no longer rotates — user preferred a static, planted look. We just
// pick one direction at construction (south, facing camera) and stay there.
const DEFAULT_DIRECTION_INDEX = 0      // 'south'
const EXPLOSION_FRAME_COUNT = 9
const EXPLOSION_FRAME_INTERVAL = 0.09  // ~0.8 s total death animation

const rotTextures: THREE.Texture[] = []
const explosionTextures: THREE.Texture[] = []
let loaded = false

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

export async function preloadPixelPowerCore(): Promise<void> {
  await Promise.all([
    ...DIRECTIONS.map(async (dir, i) => {
      rotTextures[i] = await loadTex(`/sprites/powercore/${dir}.png`)
    }),
    ...Array.from({ length: EXPLOSION_FRAME_COUNT }, async (_, i) => {
      const num = String(i).padStart(3, '0')
      explosionTextures[i] = await loadTex(`/sprites/powercore/explosion/frame_${num}.png`)
    }),
  ])
  loaded = true
}

export class PixelPowerCore {
  readonly mesh: THREE.Group
  hp: number
  readonly maxHp: number
  readonly size: number
  private sprite: THREE.Sprite
  private hpBarGroup: THREE.Group
  private hpBar: THREE.Mesh
  private dying = false
  private dyingTime = 0
  private dyingFrame = 0

  constructor(scene: THREE.Scene, x: number, y: number, size = 130, team: 'player' | 'ai' = 'player') {
    this.size = size
    this.hp = this.maxHp = Config.POWER_CORE.HP
    this.mesh = new THREE.Group()
    this.mesh.position.set(x, y, 0)

    const firstTex = loaded ? rotTextures[DEFAULT_DIRECTION_INDEX] : null
    const mat = new THREE.SpriteMaterial({
      map: firstTex,
      color: TEAM_TINT[team],
      transparent: true,
      depthTest: false,
      depthWrite: false,
      alphaTest: 0.1,
    })
    this.sprite = new THREE.Sprite(mat)
    this.sprite.scale.set(size, size, 1)
    // Centered on mesh.position — top-down board view, piece sits in its cell.
    this.sprite.position.set(0, 0, 5)
    this.sprite.renderOrder = 10
    this.mesh.add(this.sprite)

    this.hpBarGroup = new THREE.Group()
    // Bar sits just above the top of the core sprite. Lowered from 0.55 → 0.40
    // per user feedback ("lower health bar") — closer to the piece, less
    // floating-overhead UI feel.
    this.hpBarGroup.position.set(0, size * 0.40, 0)
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(50, 5),
      new THREE.MeshBasicMaterial({ color: 0xcc2222 })
    )
    bg.position.z = 0.1
    this.hpBarGroup.add(bg)
    this.hpBar = new THREE.Mesh(
      new THREE.PlaneGeometry(50, 5),
      new THREE.MeshBasicMaterial({ color: 0x00ff88 })
    )
    this.hpBar.position.z = 0.2
    this.hpBarGroup.add(this.hpBar)
    this.mesh.add(this.hpBarGroup)
    // HP bar hidden — plan-then-watch model. Core death triggers the
    // explosion animation + AoE blast, so the player still gets a clear
    // "the core just blew" signal.
    this.hpBarGroup.visible = false

    scene.add(this.mesh)
  }

  faceCamera(camera: THREE.Camera) {
    this.hpBarGroup.quaternion.copy(camera.quaternion)
  }

  // Switch the core's team tint after construction. Called by Game once the
  // side picker resolves — until then the default 'player' tint applies.
  setTeam(team: 'player' | 'ai') {
    (this.sprite.material as THREE.SpriteMaterial).color.setHex(TEAM_TINT[team])
  }

  takeDamage(amount: number) {
    if (this.dying) return
    this.hp = Math.max(0, this.hp - amount)
    const ratio = this.hp / this.maxHp
    this.hpBar.scale.x = ratio
    this.hpBar.position.x = -(1 - ratio) * 25   // half of new bar width 50
    const mat = this.hpBar.material as THREE.MeshBasicMaterial
    mat.color.setHex(ratio > 0.5 ? 0x00ff88 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
    if (this.hp <= 0) this.startDying()
    // Power Core status callouts (robot voice, low_hp only — no ammo).
    if (!this.dying && ratio <= 0.25 && !this.spokenLowHp) {
      this.spokenLowHp = true
      const scene = this.mesh.parent
      if (scene instanceof THREE.Scene) {
        spawnSpeechBubble(scene, this.mesh.position.x, this.mesh.position.y, 'robot', 'low_hp')
      }
    }
  }
  private spokenLowHp = false

  // Repair-bot heal target. Refuses to restore HP once the core has started
  // dying — the death animation is final. Returns true iff any HP was added.
  heal(amount: number, vfxVariant: HealVfxVariant = 'plus'): boolean {
    if (this.dying || this.hp >= this.maxHp) return false
    const before = this.hp
    this.hp = Math.min(this.maxHp, this.hp + amount)
    const restored = this.hp - before
    if (restored <= 0) return false
    const ratio = this.hp / this.maxHp
    this.hpBar.scale.x = ratio
    this.hpBar.position.x = -(1 - ratio) * 25
    const mat = this.hpBar.material as THREE.MeshBasicMaterial
    mat.color.setHex(ratio > 0.5 ? 0x00ff88 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
    this.pulseRepairVfx()
    const scene = this.mesh.parent
    if (scene instanceof THREE.Scene) {
      // Core occupies a 2x2 cell footprint — pass a larger scale so the
      // heal VFX (number / bubbles / plus stamps) AND the cell glow are
      // sized to match the big piece. Default 1.0 = single-cell scale.
      spawnHealVfx(scene, this.mesh.position.x, this.mesh.position.y, restored, vfxVariant, 1.8)
    }
    return true
  }

  showHpBar() { this.hpBarGroup.visible = true }
  hideHpBar() { this.hpBarGroup.visible = false }

  private repairPulseTimer: number | null = null
  private pulseRepairVfx() {
    const m = this.sprite.material as THREE.SpriteMaterial
    const before = m.color.getHex()
    if (this.repairPulseTimer !== null) clearTimeout(this.repairPulseTimer)
    m.color.setHex(0xffcc66)
    this.repairPulseTimer = window.setTimeout(() => {
      m.color.setHex(before)
      this.repairPulseTimer = null
    }, 280)
  }

  private startDying() {
    this.dying = true
    this.dyingTime = 0
    this.dyingFrame = 0
    if (explosionTextures[0]) {
      this.sprite.material.map = explosionTextures[0]
      this.sprite.material.needsUpdate = true
    }
    // Hide the HP bar during the death animation.
    this.hpBarGroup.visible = false
    playExplosion()
  }

  get isDead() { return this.hp <= 0 }

  // Power Core is a "large" piece — occupies a 2x2 block of grid cells. Its
  // mesh.position is the centroid (a grid intersection), so the 4 cell
  // centers are ±half-cell away in both axes.
  cellCenters(): Array<{ x: number; y: number }> {
    const cx = this.mesh.position.x
    const cy = this.mesh.position.y
    const half = Config.GRID_CELL / 2
    return [
      { x: cx - half, y: cy - half },
      { x: cx + half, y: cy - half },
      { x: cx - half, y: cy + half },
      { x: cx + half, y: cy + half },
    ]
  }

  // Electric-defense danger zone — 4×4 cells centered on the core. The
  // inner 2×2 is the core itself; the outer ring is the kill zone.
  // Returns the 12 OUTER ring cells (not including core cells) so the
  // visual overlay + AoE both target the right tiles. World-clipped:
  // cells off-map are omitted.
  defenseZoneCells(): Array<{ x: number; y: number }> {
    const cs = Config.GRID_CELL
    const half = cs / 2
    const cx = this.mesh.position.x
    const cy = this.mesh.position.y
    const out: Array<{ x: number; y: number }> = []
    // Core centroid sits at a grid intersection. Cell centers offset
    // ±0.5 and ±1.5 cells in each axis form the 4×4 footprint.
    for (let dx = -1.5; dx <= 1.5; dx += 1) {
      for (let dy = -1.5; dy <= 1.5; dy += 1) {
        // Skip the inner 2×2 (the core itself).
        if (Math.abs(dx) === 0.5 && Math.abs(dy) === 0.5) continue
        const x = cx + dx * cs
        const y = cy + dy * cs
        // World clip — north/south edges and the west side could fall off.
        if (x < Config.WORLD.LEFT + half || x > Config.WORLD.RIGHT - half) continue
        if (y < Config.WORLD.BOTTOM + half || y > Config.WORLD.TOP - half) continue
        out.push({ x, y })
      }
    }
    return out
  }

  update(delta: number) {
    if (!loaded) return

    if (!this.dying) return   // Static when alive — no rotation cycle.

    this.dyingTime += delta
    const next = Math.min(
      EXPLOSION_FRAME_COUNT - 1,
      Math.floor(this.dyingTime / EXPLOSION_FRAME_INTERVAL)
    )
    if (next !== this.dyingFrame) {
      this.dyingFrame = next
      const tex = explosionTextures[next]
      if (tex) {
        this.sprite.material.map = tex
        this.sprite.material.needsUpdate = true
      }
    }
    // Hide the sprite once we've held the final frame for a beat.
    if (this.dyingFrame === EXPLOSION_FRAME_COUNT - 1
        && this.dyingTime > EXPLOSION_FRAME_COUNT * EXPLOSION_FRAME_INTERVAL + 0.4) {
      this.sprite.visible = false
    }
  }
}
