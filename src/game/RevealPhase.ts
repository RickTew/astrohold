import * as THREE from 'three'
import { Config } from './GameConfig'
import { CellRef, QueuedAction, TargetRef } from './TurnTypes'
import { SpriteUnit } from '../entities/SpriteUnit'
import { SphereDefender } from '../entities/SphereDefender'
import { Structure } from '../entities/Structure'
import { PixelPowerCore } from '../entities/PixelPowerCore'
import { Projectile } from '../entities/Projectile'
import { Explosion } from '../entities/Explosion'
import { playGunshot, playExplosion } from '../audio/sfx'

// Phase 3 reveal engine: consumes the queued plans the player set up during
// Planning, sorts every (actor, action) pair by Initiative descending, and
// animates them one at a time cinematically. Strict-skip on invalid actions
// per the locked design — if your queued target died from an earlier action,
// or your destination cell got taken, the piece does nothing for that step.

type Actor = SpriteUnit | SphereDefender | Structure
type AnyTarget = Actor | PixelPowerCore

interface PlannedStep {
  actor: Actor
  action: QueuedAction
}

// Seconds per action in the reveal. Slow enough that the player can read each
// step ("ok the sphere just fired at the cannon"), fast enough that a full
// turn doesn't drag. Projectile flight may exceed this — projectiles keep
// flying during subsequent steps, which actually reads nicely.
const STEP_DURATION = 0.6

const MINE_DETECT_RADIUS = 65

export class RevealPhase {
  private steps: PlannedStep[]
  private idx = 0
  private stepTime = 0
  private firstTickOfStep = true
  private projectiles: Projectile[] = []
  private explosions: Explosion[] = []
  private done = false
  private over = false   // win or lose triggered — wait for projectiles to settle then complete

  onComplete: (() => void) | null = null
  onWin: (() => void) | null = null
  onLose: (() => void) | null = null

  constructor(
    private scene: THREE.Scene,
    private core: PixelPowerCore,
    private units: SpriteUnit[],
    private structures: Structure[],
    private spheres: SphereDefender[],
  ) {
    this.steps = this.buildSteps()
  }

  // ── Step list ────────────────────────────────────────────────────────────

  private buildSteps(): PlannedStep[] {
    const list: PlannedStep[] = []

    // Cyborgs: use queued actions, OR auto-default to advance/fire if the
    // player didn't queue anything (otherwise BATTLE looks like a no-op).
    for (const u of this.units) {
      if (u.isDead) continue
      if (u.queuedActions.length > 0) {
        for (const a of u.queuedActions) list.push({ actor: u, action: a })
      } else {
        const def = this.defaultCyborgAction(u)
        if (def) list.push({ actor: u, action: def })
      }
    }
    // Spheres: queued shots first, otherwise auto-fire at nearest cyborg.
    for (const s of this.spheres) {
      if (s.isDead) continue
      if (s.queuedActions.length > 0) {
        for (const a of s.queuedActions) list.push({ actor: s, action: a })
      } else {
        const def = this.defaultSphereAction(s)
        if (def) list.push({ actor: s, action: def })
      }
    }
    // Structures auto-fire on their initiative tick. Walls/mines have
    // apBudget 0 → skipped.
    for (const st of this.structures) {
      if (st.isDead || st.apBudget === 0) continue
      const target = this.pickNearestEnemyOf(st)
      if (!target) continue
      list.push({ actor: st, action: { kind: 'fire', target: { kind: 'unit', id: target.id } } })
    }

    // Initiative DESC. Tiebreak: defender first (irrelevant in practice since
    // ties only exist among stationary defenders, but spec-correct), then
    // stable array order.
    list.sort((a, b) => {
      if (b.actor.initiative !== a.actor.initiative) return b.actor.initiative - a.actor.initiative
      const aDef = a.actor.side === 'defender' ? 0 : 1
      const bDef = b.actor.side === 'defender' ? 0 : 1
      return aDef - bDef
    })

    return list
  }

  // Default action when a cyborg has no queued plan. If an enemy is in attack
  // range, fire at the nearest one. Otherwise step one cell toward the core.
  private defaultCyborgAction(unit: SpriteUnit): QueuedAction | null {
    const range: number = Config.UNITS[unit.type].range
    let bestId: string | null = null
    let bestKind: 'sphere' | 'structure' | 'core' = 'sphere'
    let bestDist: number = range
    const consider = (id: string, kind: 'sphere' | 'structure' | 'core', x: number, y: number) => {
      const d = Math.hypot(x - unit.worldX, y - unit.worldY)
      if (d <= bestDist) { bestId = id; bestKind = kind; bestDist = d }
    }
    for (const s of this.spheres)    if (!s.isDead) consider(s.id, 'sphere',    s.worldX, s.worldY)
    for (const s of this.structures) if (!s.isDead) consider(s.id, 'structure', s.worldX, s.worldY)
    if (!this.core.isDead) {
      // Use closest of the 4 core cells.
      for (const cc of this.core.cellCenters()) {
        consider('core', 'core', cc.x, cc.y)
      }
    }
    if (bestId !== null) {
      return { kind: 'fire', target: { kind: bestKind, id: bestId } }
    }

    // Nothing in range — advance one cell toward the core.
    const cell = this.pickStepTowardCore(unit)
    return cell ? { kind: 'move', cell } : null
  }

  private pickStepTowardCore(unit: SpriteUnit): CellRef | null {
    const cs = Config.GRID_CELL
    const tx = this.core.mesh.position.x
    const ty = this.core.mesh.position.y
    const curDist = Math.hypot(tx - unit.worldX, ty - unit.worldY)
    type Cand = { col: number; row: number; x: number; y: number; d: number }
    const candidates: Cand[] = []
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue
        const x = unit.worldX + dx * cs
        const y = unit.worldY + dy * cs
        const col = Math.floor((x - Config.WORLD.LEFT) / cs)
        const row = Math.floor((y - Config.WORLD.BOTTOM) / cs)
        candidates.push({ col, row, x, y, d: Math.hypot(tx - x, ty - y) })
      }
    }
    candidates.sort((a, b) => a.d - b.d)
    for (const c of candidates) {
      if (c.d >= curDist) continue
      if (c.x < Config.WORLD.LEFT || c.x > Config.WORLD.RIGHT) continue
      if (c.y < Config.WORLD.BOTTOM || c.y > Config.WORLD.TOP) continue
      if (this.isCellOccupiedAtBattle(c.x, c.y, unit)) continue
      return { col: c.col, row: c.row }
    }
    return null
  }

  // Default sphere action: fire at nearest cyborg in range.
  private defaultSphereAction(sphere: SphereDefender): QueuedAction | null {
    let nearest: SpriteUnit | null = null
    let nearestDist: number = sphere.range
    for (const u of this.units) {
      if (u.isDead) continue
      const d = Math.hypot(u.worldX - sphere.worldX, u.worldY - sphere.worldY)
      if (d <= nearestDist) { nearestDist = d; nearest = u }
    }
    if (!nearest) return null
    return { kind: 'fire', target: { kind: 'unit', id: nearest.id } }
  }

  private pickNearestEnemyOf(struct: Structure): SpriteUnit | null {
    let nearest: SpriteUnit | null = null
    let nearestDist: number = struct.range
    for (const u of this.units) {
      if (u.isDead) continue
      const dx = u.worldX - struct.worldX
      const dy = u.worldY - struct.worldY
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d <= nearestDist) { nearestDist = d; nearest = u }
    }
    return nearest
  }

  // ── Main tick ────────────────────────────────────────────────────────────

  update(delta: number) {
    // Always tick visuals (projectiles, explosions, unit anims) — they keep
    // running between steps and after the engine ends.
    this.tickProjectiles(delta)
    this.tickExplosions(delta)
    for (const u of this.units) u.update(delta)

    if (this.done) return

    if (this.over) {
      // Game ended (win/lose) — wait for visuals to settle, then close.
      if (this.projectiles.length === 0 && this.explosions.length === 0) {
        this.done = true
      }
      return
    }

    // All planned actions consumed — wait for in-flight projectiles to land,
    // then signal completion so Game can open a fresh Planning phase.
    if (this.idx >= this.steps.length) {
      if (this.projectiles.length === 0) {
        this.done = true
        this.onComplete?.()
      }
      return
    }

    if (this.firstTickOfStep) {
      this.executeStep(this.steps[this.idx])
      this.firstTickOfStep = false
    }

    this.stepTime += delta
    if (this.stepTime >= STEP_DURATION) {
      this.stepTime = 0
      this.firstTickOfStep = true
      this.idx++
      this.checkWinLose()
    }
  }

  private tickProjectiles(delta: number) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const hit = this.projectiles[i].update(delta)
      if (!hit) continue
      const proj = this.projectiles[i]
      // Skip onHit (damage application) after game over so corpses don't
      // get re-damaged and trigger weird state.
      if (!this.over) proj.onHit?.()
      this.explosions.push(new Explosion(
        this.scene, proj.targetX, proj.targetY,
        proj.isAoe ? proj.aoeRadius : 20, 0.4,
      ))
      if (proj.isAoe) playExplosion()
      this.projectiles.splice(i, 1)
    }
  }

  private tickExplosions(delta: number) {
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      this.explosions[i].update(delta)
      if (this.explosions[i].isDone) this.explosions.splice(i, 1)
    }
  }

  // ── Per-action execution ─────────────────────────────────────────────────

  private executeStep(step: PlannedStep) {
    const { actor, action } = step
    if (actor.isDead) return   // strict skip — actor died earlier in the reveal

    if (action.kind === 'hold') return

    if (action.kind === 'move') {
      this.executeMove(actor, action.cell)
      return
    }

    if (action.kind === 'fire' || action.kind === 'throw') {
      this.executeAttack(actor, action)
    }
  }

  private executeMove(actor: Actor, cell: CellRef) {
    // Only mobile units (cyborgs) can move; structures/spheres ignore move
    // even if the planning UI accidentally queued one.
    if (!(actor instanceof SpriteUnit)) return
    const dest = this.cellCenter(cell)
    if (this.isCellOccupiedAtBattle(dest.x, dest.y, actor)) return   // strict skip
    actor.moveTo(dest.x, dest.y)
    // Mine trigger: if this move lands the unit on/near a live mine, detonate.
    this.checkMineTriggers(actor, dest.x, dest.y)
  }

  private executeAttack(actor: Actor, action: QueuedAction) {
    // Resolve target XY (specific entity for 'fire', cell center for 'throw').
    const aim = action.kind === 'fire'
      ? this.resolveTargetXY((action as { target: TargetRef }).target)
      : this.cellCenter((action as { cell: CellRef }).cell)
    if (!aim) return   // strict skip — target gone, cell invalid

    // Range check against the actor's attack range.
    const ax = this.actorX(actor)
    const ay = this.actorY(actor)
    const dx = aim.x - ax
    const dy = aim.y - ay
    const dist = Math.sqrt(dx * dx + dy * dy)
    const range = this.actorRange(actor)
    if (dist > range) return   // strict skip — out of range now

    // Cyborg attack animation; spheres/structures don't have shoot anims yet.
    if (actor instanceof SpriteUnit) {
      actor.faceTarget(aim.x, aim.y)
      actor.playAttackAnim()
    }

    const isAoe = action.kind === 'throw'
      || (actor instanceof SpriteUnit && Config.UNITS[actor.type].aoeRadius > 0)
    const aoeRadius = isAoe
      ? (actor instanceof SpriteUnit ? Config.UNITS[actor.type].aoeRadius : 0)
      : 0

    const muzzle = this.actorMuzzle(actor, aim.x, aim.y)
    const damage = this.actorDamage(actor)
    const color = actor.side === 'defender' ? 0xffee00 : 0xff3333

    const proj = new Projectile(
      this.scene, muzzle.x, muzzle.y, null, aim.x, aim.y,
      damage, isAoe, aoeRadius, color,
    )

    if (action.kind === 'fire' && !isAoe) {
      // Direct fire — resolve target entity NOW (at fire time) and damage on
      // hit. If the target died before the projectile lands, no damage.
      const ref = (action as { target: TargetRef }).target
      const targetEntity = this.resolveTargetEntity(ref)
      if (targetEntity) {
        proj.onHit = () => { if (!targetEntity.isDead) targetEntity.takeDamage(damage) }
      }
    } else {
      // AoE — splash everything in range of the impact point.
      proj.onHit = () => this.applyAoe(aim.x, aim.y, aoeRadius, damage, actor)
    }

    this.projectiles.push(proj)
    if (!isAoe) playGunshot()
  }

  private applyAoe(cx: number, cy: number, radius: number, damage: number, source: Actor) {
    // Defender AoE (cannon structure / sphere with AoE) hits cyborgs. Attacker
    // AoE (grenadier) hits defender pieces + the core.
    if (source.side === 'defender') {
      for (const u of this.units) {
        if (u.isDead) continue
        if (this.inRadius(u.worldX, u.worldY, cx, cy, radius)) u.takeDamage(damage)
      }
    } else {
      for (const s of this.spheres) {
        if (s.isDead) continue
        if (this.inRadius(s.worldX, s.worldY, cx, cy, radius)) s.takeDamage(damage)
      }
      for (const s of this.structures) {
        if (s.isDead) continue
        if (this.inRadius(s.worldX, s.worldY, cx, cy, radius)) s.takeDamage(damage)
      }
      // Core takes a hit if any of its 4 cells is inside the splash.
      if (!this.core.isDead) {
        const cc = this.core.cellCenters()
        const hit = cc.some(p => this.inRadius(p.x, p.y, cx, cy, radius))
        if (hit) this.core.takeDamage(damage)
      }
    }
  }

  private checkMineTriggers(unit: SpriteUnit, x: number, y: number) {
    for (const s of this.structures) {
      if (s.type !== 'mine' || s.isDead) continue
      const dx = s.worldX - x
      const dy = s.worldY - y
      if (Math.sqrt(dx * dx + dy * dy) >= MINE_DETECT_RADIUS) continue
      const radius = Config.STRUCTURES.mine.range + 10
      this.explosions.push(new Explosion(this.scene, s.worldX, s.worldY, radius, 0.7))
      playExplosion()
      const dmg = Config.STRUCTURES.mine.damage
      for (const u of this.units) {
        if (u.isDead) continue
        if (this.inRadius(u.worldX, u.worldY, s.worldX, s.worldY, radius)) u.takeDamage(dmg)
      }
      s.takeDamage(9999)   // mine self-destructs on trigger
    }
  }

  // ── Win/lose ─────────────────────────────────────────────────────────────

  private checkWinLose() {
    if (this.over) return
    if (this.core.isDead) {
      this.over = true
      this.applyCoreBlast()
      this.onLose?.()
      return
    }
    if (this.units.every(u => u.isDead)) {
      this.over = true
      this.onWin?.()
    }
  }

  private applyCoreBlast() {
    const cx = this.core.mesh.position.x
    const cy = this.core.mesh.position.y
    const BLAST_RADIUS = 180
    for (const u of this.units) {
      if (u.isDead) continue
      if (this.inRadius(u.worldX, u.worldY, cx, cy, BLAST_RADIUS)) u.takeDamage(99999)
    }
    this.explosions.push(new Explosion(this.scene, cx, cy, BLAST_RADIUS, 1.2))
    playExplosion()
  }

  // ── Resolvers ────────────────────────────────────────────────────────────

  private resolveTargetEntity(ref: TargetRef): { takeDamage(n: number): void; isDead: boolean } | null {
    if (ref.kind === 'core') return this.core.isDead ? null : this.core
    const all: Actor[] = [...this.units, ...this.spheres, ...this.structures]
    const hit = all.find(p => p.id === ref.id)
    return hit && !hit.isDead ? hit : null
  }

  private resolveTargetXY(ref: TargetRef): { x: number; y: number } | null {
    if (ref.kind === 'core') {
      if (this.core.isDead) return null
      return { x: this.core.mesh.position.x, y: this.core.mesh.position.y }
    }
    const all: Actor[] = [...this.units, ...this.spheres, ...this.structures]
    const hit = all.find(p => p.id === ref.id)
    return hit && !hit.isDead ? { x: hit.worldX, y: hit.worldY } : null
  }

  // ── Geometry helpers ─────────────────────────────────────────────────────

  private cellCenter(cell: CellRef): { x: number; y: number } {
    const c = Config.GRID_CELL
    return {
      x: Config.WORLD.LEFT   + cell.col * c + c / 2,
      y: Config.WORLD.BOTTOM + cell.row * c + c / 2,
    }
  }

  private isCellOccupiedAtBattle(x: number, y: number, exclude: Actor): boolean {
    const E = 1
    for (const u of this.units) {
      if (u === exclude || u.isDead) continue
      if (Math.abs(u.worldX - x) < E && Math.abs(u.worldY - y) < E) return true
      if (u.isWalking && Math.abs(u.prevWorldX - x) < E && Math.abs(u.prevWorldY - y) < E) return true
    }
    for (const s of this.spheres) {
      if (s.isDead) continue
      if (Math.abs(s.worldX - x) < E && Math.abs(s.worldY - y) < E) return true
    }
    for (const s of this.structures) {
      if (s.isDead) continue
      if (Math.abs(s.worldX - x) < E && Math.abs(s.worldY - y) < E) return true
    }
    for (const cc of this.core.cellCenters()) {
      if (Math.abs(cc.x - x) < E && Math.abs(cc.y - y) < E) return true
    }
    return false
  }

  private inRadius(x: number, y: number, cx: number, cy: number, r: number): boolean {
    const dx = x - cx, dy = y - cy
    return Math.sqrt(dx * dx + dy * dy) < r
  }

  private actorX(a: AnyTarget): number { return a instanceof PixelPowerCore ? a.mesh.position.x : a.worldX }
  private actorY(a: AnyTarget): number { return a instanceof PixelPowerCore ? a.mesh.position.y : a.worldY }

  private actorRange(actor: Actor): number {
    if (actor instanceof SpriteUnit)     return Config.UNITS[actor.type].range
    if (actor instanceof SphereDefender) return Config.SPHERE.range
    return Config.STRUCTURES[actor.type].range
  }
  private actorDamage(actor: Actor): number {
    if (actor instanceof SpriteUnit)     return Config.UNITS[actor.type].damage
    if (actor instanceof SphereDefender) return Config.SPHERE.damage
    return Config.STRUCTURES[actor.type].damage
  }
  private actorMuzzle(actor: Actor, aimX: number, aimY: number): { x: number; y: number } {
    if (actor instanceof SpriteUnit) return actor.getMuzzlePoint()
    // Spheres and structures don't have a directional muzzle — fire from a
    // small forward offset toward the target so the projectile doesn't start
    // inside the piece.
    const dx = aimX - actor.worldX
    const dy = aimY - actor.worldY
    const d = Math.sqrt(dx * dx + dy * dy) || 1
    const FORWARD = 14
    return {
      x: actor.worldX + (dx / d) * FORWARD,
      y: actor.worldY + (dy / d) * FORWARD,
    }
  }

  faceCamera(camera: THREE.Camera) {
    for (const u of this.units) u.faceCamera(camera)
    for (const s of this.spheres) if (!s.isDead) s.faceCamera(camera)
    for (const s of this.structures) if (!s.isDead) s.faceCamera(camera)
  }
}
