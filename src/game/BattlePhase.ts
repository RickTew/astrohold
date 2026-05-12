import * as THREE from 'three'
import { Config } from './GameConfig'
import { Unit } from '../entities/Unit'
import { Structure } from '../entities/Structure'
import { Projectile } from '../entities/Projectile'
import { Explosion } from '../entities/Explosion'
import { PowerCore } from '../entities/PowerCore'
import { SphereDefender } from '../entities/SphereDefender'

const MINE_DETECT_RADIUS = 65

export class BattlePhase {
  private projectiles: Projectile[] = []
  private explosions: Explosion[] = []
  private turnTimer = Config.TURN_INTERVAL
  private isUnitTurn = true
  private over = false

  onWin: (() => void) | null = null
  onLose: (() => void) | null = null

  faceCamera(camera: THREE.Camera) {
    for (const u of this.units) u.faceCamera(camera)
    for (const s of this.structures) if (!s.isDead) s.faceCamera(camera)
  }

  constructor(
    private scene: THREE.Scene,
    private core: PowerCore,
    private units: Unit[],
    private structures: Structure[],
    private sphere: SphereDefender | null = null
  ) {}

  update(delta: number) {
    // Always update units so death animations and timers finish after game ends
    for (const u of this.units) u.update(delta)

    if (this.over) return

    // Advance projectiles; apply damage on arrival
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const hit = this.projectiles[i].update(delta)
      if (hit) {
        const proj = this.projectiles[i]
        proj.onHit?.()
        this.explosions.push(new Explosion(this.scene, proj.targetX, proj.targetY, proj.isAoe ? proj.aoeRadius : 20, 0.4))
        this.projectiles.splice(i, 1)
      }
    }

    for (let i = this.explosions.length - 1; i >= 0; i--) {
      this.explosions[i].update(delta)
      if (this.explosions[i].isDone) this.explosions.splice(i, 1)
    }

    // Wait for projectiles to land before next turn
    if (this.projectiles.length > 0) return

    this.turnTimer -= delta
    if (this.turnTimer > 0) return
    this.turnTimer = Config.TURN_INTERVAL

    this.executeTurn()
  }

  private executeTurn() {
    const alive = this.units.filter(u => !u.isDead)
    if (!alive.length) { this.over = true; this.onWin?.(); return }
    if (this.core.isDead)  { this.over = true; this.onLose?.(); return }

    if (this.isUnitTurn) {
      for (const u of alive) this.doUnitTurn(u)
    } else {
      const activeStructs = this.structures.filter(s => !s.isDead && s.type !== 'wall' && s.type !== 'mine')
      for (const s of activeStructs) this.doStructureTurn(s, alive)
      if (this.sphere && !this.sphere.isDead) this.doSphereTurn(alive)
    }

    this.isUnitTurn = !this.isUnitTurn

    // Check win/lose after each action
    const stillAlive = this.units.filter(u => !u.isDead)
    if (!stillAlive.length) { this.over = true; this.onWin?.(); return }
    if (this.core.isDead)   { this.over = true; this.onLose?.(); return }
  }

  private doUnitTurn(unit: Unit) {
    if (unit.isDead) return

    // Mine check before anything
    this.checkMines(unit)
    if (unit.isDead) return

    // Blocked by wall? (scouts bypass)
    if (!unit.isScout) {
      const blocking = this.structures.find(s =>
        s.type === 'wall' && !s.isDead &&
        Math.abs(s.worldX - unit.worldX) < 40 &&
        Math.abs(s.worldY - unit.worldY) < 30
      )
      if (blocking) {
        blocking.takeDamage(unit.damage)
        return
      }
    }

    // Check if sphere defender is in range
    if (this.sphere && !this.sphere.isDead) {
      const sdx = this.sphere.worldX - unit.worldX
      const sdy = this.sphere.worldY - unit.worldY
      if (Math.sqrt(sdx * sdx + sdy * sdy) <= unit.range) {
        const proj = new Projectile(
          this.scene, unit.worldX, unit.worldY + 20, null,
          this.sphere.worldX, this.sphere.worldY + 12,
          unit.damage, false, 0, 0x00ccff
        )
        const sphere = this.sphere
        proj.onHit = () => sphere.takeDamage(unit.damage)
        this.projectiles.push(proj)
        return
      }
    }

    // Engage nearest structure within attack range
    let nearestStruct: typeof this.structures[0] | null = null
    let nearestStructDist: number = unit.range
    for (const s of this.structures) {
      if (s.isDead || s.type === 'wall') continue
      const dx = s.worldX - unit.worldX
      const dy = s.worldY - unit.worldY
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d <= nearestStructDist) { nearestStructDist = d; nearestStruct = s }
    }
    if (nearestStruct) {
      const target = nearestStruct
      const proj = new Projectile(
        this.scene, unit.worldX, unit.worldY + 20, null,
        target.worldX, target.worldY,
        unit.damage, unit.isBomber, unit.isBomber ? Config.UNITS.bomber.aoeRadius : 0, 0x00ccff
      )
      if (unit.isBomber) {
        const structs = this.structures
        const aoe = Config.UNITS.bomber.aoeRadius
        proj.onHit = () => {
          target.takeDamage(unit.damage)
          for (const s of structs) {
            if (!s.isDead) {
              const sdx = s.worldX - target.worldX
              const sdy = s.worldY - target.worldY
              if (Math.sqrt(sdx * sdx + sdy * sdy) < aoe) s.takeDamage(unit.damage * 0.5)
            }
          }
          unit.kill()
        }
      } else {
        proj.onHit = () => target.takeDamage(unit.damage)
      }
      this.projectiles.push(proj)
      return
    }

    // No structure in range — move toward power core
    const tx = this.core.mesh.position.x
    const ty = this.core.mesh.position.y
    const dx = tx - unit.worldX
    const dy = ty - unit.worldY
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist <= Config.POWER_CORE.RADIUS + 20) {
      const unitX = unit.worldX
      const unitY = unit.worldY + 20
      const proj = new Projectile(
        this.scene, unitX, unitY, null, tx, ty,
        unit.damage, unit.isBomber, unit.isBomber ? Config.UNITS.bomber.aoeRadius : 0, 0x00ccff
      )
      const coreRef = this.core
      if (unit.isBomber) {
        const structs = this.structures
        const aoe = Config.UNITS.bomber.aoeRadius
        proj.onHit = () => {
          coreRef.takeDamage(unit.damage)
          for (const s of structs) {
            if (!s.isDead) {
              const sdx = s.worldX - unitX
              const sdy = s.worldY - unitY
              if (Math.sqrt(sdx * sdx + sdy * sdy) < aoe) s.takeDamage(unit.damage * 0.4)
            }
          }
          unit.kill()
        }
      } else {
        proj.onHit = () => coreRef.takeDamage(unit.damage)
      }
      this.projectiles.push(proj)
    } else {
      const nx = unit.worldX + (dx / dist) * unit.speed
      const ny = unit.worldY + (dy / dist) * unit.speed
      unit.moveTo(nx, ny)
      this.checkMines(unit)
    }
  }

  private checkMines(unit: Unit) {
    for (const s of this.structures) {
      if (s.type !== 'mine' || s.isDead) continue
      const dx = s.worldX - unit.worldX
      const dy = s.worldY - unit.worldY
      if (Math.sqrt(dx * dx + dy * dy) < MINE_DETECT_RADIUS) {
        // Detonate — damage all units in AoE
        const radius = Config.STRUCTURES.mine.range + 10
        this.explosions.push(new Explosion(this.scene, s.worldX, s.worldY, radius, 0.7))
        for (const u of this.units) {
          if (!u.isDead) {
            const udx = u.worldX - s.worldX
            const udy = u.worldY - s.worldY
            if (Math.sqrt(udx * udx + udy * udy) < radius) u.takeDamage(Config.STRUCTURES.mine.damage)
          }
        }
        s.takeDamage(9999)  // self-destruct
      }
    }
  }

  private doSphereTurn(aliveUnits: Unit[]) {
    if (!this.sphere || this.sphere.isDead) return
    let nearest: Unit | null = null
    let nearestDist: number = this.sphere.range
    for (const u of aliveUnits) {
      const dx = u.worldX - this.sphere.worldX
      const dy = u.worldY - this.sphere.worldY
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d <= nearestDist) { nearestDist = d; nearest = u }
    }
    if (!nearest) return
    const target = nearest
    const sphere = this.sphere
    const proj = new Projectile(
      this.scene, this.sphere.worldX, this.sphere.worldY + 12,
      target, target.worldX, target.worldY + 20,
      this.sphere.damage, false, 0, 0xffee00
    )
    proj.onHit = () => target.takeDamage(sphere.damage)
    this.projectiles.push(proj)
  }

  private doStructureTurn(structure: Structure, aliveUnits: Unit[]) {
    if (structure.isDead) return

    let nearest: Unit | null = null
    let nearestDist: number = structure.range

    for (const u of aliveUnits) {
      const dx = u.worldX - structure.worldX
      const dy = u.worldY - structure.worldY
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d <= nearestDist) { nearestDist = d; nearest = u }
    }

    if (!nearest) return

    const isAoe = structure.type === 'cannon'
    const proj = new Projectile(
      this.scene, structure.worldX, structure.worldY + 10,
      nearest, nearest.worldX, nearest.worldY + 20,
      structure.damage, isAoe, isAoe ? 45 : 0
    )
    this.projectiles.push(proj)

    if (isAoe) {
      const dmg = structure.damage
      const allUnits = this.units
      proj.onHit = () => {
        const cx = proj.targetX
        const cy = proj.targetY
        for (const u of allUnits) {
          if (!u.isDead) {
            const dx = u.worldX - cx
            const dy = u.worldY - cy
            if (Math.sqrt(dx * dx + dy * dy) < 45) u.takeDamage(dmg)
          }
        }
      }
    } else {
      const target = nearest
      proj.onHit = () => target.takeDamage(structure.damage)
    }
  }
}
