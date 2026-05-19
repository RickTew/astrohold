import * as THREE from 'three'
import { Config } from './GameConfig'
import { CellRef, QueuedAction, TargetRef } from './TurnTypes'
import { SpriteUnit } from '../entities/SpriteUnit'
import { SphereDefender } from '../entities/SphereDefender'
import { Structure, getGrenadeTexture } from '../entities/Structure'
import { PixelPowerCore } from '../entities/PixelPowerCore'
import { Projectile } from '../entities/Projectile'
import { Explosion } from '../entities/Explosion'
import { PendingGrenade } from '../entities/PendingGrenade'
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

// Half-angle of a structure's fire arc, in radians. 60° each side = 120°
// total wedge. East-facing defender towers cover everything between NE and
// SE (the cyborg corridor). Future UI lets the player pay credits to add
// extra facings to the structure's fireFacings array.
const FIRE_ARC_HALF_RAD = (60 * Math.PI) / 180

// Max reveals an armed bomb stays on the field before force-detonating. Plus
// the 1-reveal arming delay = ~4 reveals total lifespan. Stops bombs from
// becoming ignored permanent traps when both sides flee them indefinitely.
const ARMED_LIFETIME = 3

// 4 cardinal neighbors (N/S/E/W). All standard units move on this grid —
// no diagonals — making positioning sharper and slower-paced. A future
// special-character unit can opt into 8-direction movement via the
// per-unit allowDiagonalMove flag in Config.
const CARDINAL_STEPS: readonly [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
]
const DIAGONAL_STEPS: readonly [number, number][] = [
  ...CARDINAL_STEPS, [1, 1], [1, -1], [-1, 1], [-1, -1],
]

export class RevealPhase {
  private steps: PlannedStep[]
  private idx = 0
  private stepTime = 0
  private firstTickOfStep = true
  private projectiles: Projectile[] = []
  private explosions: Explosion[] = []
  private done = false
  private over = false   // win or lose triggered — wait for projectiles to settle then complete
  // True if any combat-relevant event happened during this reveal: shots
  // fired, bombs detonated, mines triggered, grenadier diffuse. Game uses
  // this to detect a "no-progress" stalemate when all sides are out of
  // ammo and movement loops indefinitely.
  combatThisReveal = false

  onComplete: (() => void) | null = null
  onWin: (() => void) | null = null
  onLose: (() => void) | null = null

  constructor(
    private scene: THREE.Scene,
    private core: PixelPowerCore,
    private units: SpriteUnit[],
    private structures: Structure[],
    private spheres: SphereDefender[],
    private defenderUnits: SpriteUnit[] = [],
    private pendingGrenades: PendingGrenade[] = [],
  ) {
    this.steps = this.buildSteps()
    // Force-detonate bombs that have outlived their fuse. Done before any
    // step runs so the explosions read as "the bomb you left out finally
    // went off" — happens at the start of the new reveal.
    this.expireOldBombs()
  }

  private expireOldBombs() {
    for (const g of [...this.pendingGrenades]) {
      if (g.armed && g.turnsArmed >= ARMED_LIFETIME) {
        this.detonatePendingGrenade(g)
      }
    }
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
        const def = this.defaultMobileUnitAction(u)
        if (def) list.push({ actor: u, action: def })
      }
    }
    // Defender mobile units (combat dogs): same default-action logic but
    // hunting cyborgs rather than defender pieces.
    for (const u of this.defenderUnits) {
      if (u.isDead) continue
      if (u.queuedActions.length > 0) {
        for (const a of u.queuedActions) list.push({ actor: u, action: a })
      } else {
        const def = this.defaultMobileUnitAction(u)
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
    // apBudget 0 → skipped. Pieces out of ammo (ammoRemaining 0) are inert
    // — they sit there and take damage without firing back. The defender
    // Bomber is special — it throws a proximity bomb at an empty cell, not
    // direct-fire at a unit, and only if it doesn't already have a bomb
    // on the field.
    for (const st of this.structures) {
      if (st.isDead || st.apBudget === 0) continue
      if (st.ammoRemaining <= 0) continue
      if (st.type === 'bomber') {
        // One bomb per defender Bomber at a time — skip if their previous
        // bomb is still armed on the field.
        if (this.hasActiveBomb(st.id)) continue
        const cell = this.pickBombThrowCell(st)
        if (cell) list.push({ actor: st, action: { kind: 'throw', cell } })
        continue
      }
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

  // Default action for any mobile unit (attacker cyborg OR defender dog).
  // If an enemy is in attack range, fire at the nearest one. Otherwise step
  // one cell toward the nearest enemy in sight. If nothing's in sight,
  // cyborgs still advance toward the core (their objective) and defender
  // mobile units (dogs) wander to a random adjacent cell.
  private defaultMobileUnitAction(unit: SpriteUnit): QueuedAction | null {
    // Hulk-specific: if 2+ enemies cluster in any cardinal slam wedge AND
    // we have slam ammo, slam them. Lower per-target damage than punch but
    // hits up to 3 at once — a real "save it for the cluster" decision.
    if (unit.type === 'hulk' && unit.slamAmmoRemaining > 0) {
      const slam = this.pickSlamWedge(unit)
      if (slam) return { kind: 'slam', cell: slam }
    }
    // Grenadier-specific: if an armed enemy bomb is adjacent (within 1.5
    // cells), prefer DIFFUSING it over anything else. Costs 1 AP, no
    // damage, bomb vanishes — strictly better than walking into the blast.
    if (unit.type === 'grenadier') {
      const adj = this.nearestArmedEnemyBombInRange(unit, Config.GRID_CELL * 1.5)
      if (adj) return { kind: 'diffuse', target: { kind: 'bomb', id: adj.id } }
    }
    // Lobbed AoE units (Bomber / Grenadier) throw proximity bombs onto empty
    // cells, one bomb per thrower at a time. Special-cased here because the
    // standard fire-at-nearest-enemy flow doesn't apply to area traps.
    // Ammo-gated: out-of-ammo throwers skip the throw branch and fall through
    // to move/advance like inert units.
    if (this.isLobbedThrower(unit) && unit.ammoRemaining > 0) {
      const lobbed = this.lobbedThrowerAction(unit)
      if (lobbed) return lobbed
      // Fall through to move / advance if no throw is available right now.
    }
    const range: number = Config.UNITS[unit.type].range
    if (range > 0 && !this.isLobbedThrower(unit) && unit.ammoRemaining > 0) {
      // Bomb counterplay: if there's an armed enemy bomb in range AND we're
      // safely outside its AoE, shoot it instead of an enemy unit. Detonates
      // the bomb harmlessly (from our perspective) — clears the field.
      const bombShot = this.nearestSafeArmedBomb(unit, range)
      if (bombShot) {
        return { kind: 'fire', target: { kind: 'bomb', id: bombShot.id } }
      }
      const fireTarget = this.nearestEnemy(unit, range)
      if (fireTarget) {
        return { kind: 'fire', target: { kind: fireTarget.kind, id: fireTarget.id } }
      }
    }
    const sight: number = Config.UNITS[unit.type].sightRange ?? range
    const moveTarget = this.nearestEnemy(unit, sight)
    if (moveTarget) {
      const cell = this.pickStepTowardPoint(unit, moveTarget.x, moveTarget.y)
      if (cell) return { kind: 'move', cell }
    }
    // Nothing in sight. Fallback behaviour by side.
    if (unit.side === 'attacker' && !this.core.isDead) {
      // Cyborgs always grind toward the core.
      const cc = this.core.cellCenters()[0]
      const cell = this.pickStepTowardPoint(unit, cc.x, cc.y)
      if (cell) return { kind: 'move', cell }
    }
    if (unit.side === 'defender') {
      // Robots wander when no enemy in sight (per user spec).
      const cell = this.pickWanderStep(unit)
      if (cell) return { kind: 'move', cell }
    }
    return null
  }

  // Pick the cardinal slam direction whose 3-cell wedge contains the most
  // enemies. Returns the wedge-center cell (one step forward of `unit`) iff
  // that wedge contains at least 2 enemies — anything less and the AI
  // prefers conserving slam ammo for a real cluster. Ties broken by which
  // wedge has higher TOTAL HP to chew through (kills aren't guaranteed at
  // 40 dmg vs typical 80–300 HP, so concentration matters).
  private pickSlamWedge(unit: SpriteUnit): CellRef | null {
    const cs = Config.GRID_CELL
    const col = Math.floor((unit.worldX - Config.WORLD.LEFT) / cs)
    const row = Math.floor((unit.worldY - Config.WORLD.BOTTOM) / cs)
    let best: { cell: CellRef; count: number; hp: number } | null = null
    for (const [dc, dr] of CARDINAL_STEPS) {
      const targetCol = col + dc
      const targetRow = row + dr
      const perpCol = dr === 0 ? 0 : 1
      const perpRow = dr === 0 ? 1 : 0
      let count = 0
      let hp = 0
      for (let k = -1; k <= 1; k++) {
        const wcol = targetCol + perpCol * k
        const wrow = targetRow + perpRow * k
        const wx = Config.WORLD.LEFT + wcol * cs + cs / 2
        const wy = Config.WORLD.BOTTOM + wrow * cs + cs / 2
        if (wx < Config.WORLD.LEFT || wx > Config.WORLD.RIGHT) continue
        if (wy < Config.WORLD.BOTTOM || wy > Config.WORLD.TOP) continue
        const hit = this.firstEnemyAt(unit, wx, wy)
        if (hit) { count++; hp += hit.hp }
      }
      if (count >= 2 && (!best || count > best.count || (count === best.count && hp > best.hp))) {
        best = { cell: { col: targetCol, row: targetRow }, count, hp }
      }
    }
    return best ? best.cell : null
  }

  // Returns the first live enemy of `unit` whose cell center sits on (x, y),
  // or null. Used by the Hulk slam scorer.
  private firstEnemyAt(unit: SpriteUnit, x: number, y: number): { hp: number } | null {
    const E = 1
    if (unit.side === 'attacker') {
      for (const s of this.spheres) {
        if (!s.isDead && Math.abs(s.worldX - x) < E && Math.abs(s.worldY - y) < E) return { hp: s.hp }
      }
      for (const st of this.structures) {
        if (!st.isDead && Math.abs(st.worldX - x) < E && Math.abs(st.worldY - y) < E) return { hp: st.hp }
      }
      for (const du of this.defenderUnits) {
        if (!du.isDead && Math.abs(du.worldX - x) < E && Math.abs(du.worldY - y) < E) return { hp: du.hp }
      }
      if (!this.core.isDead) {
        for (const cc of this.core.cellCenters()) {
          if (Math.abs(cc.x - x) < E && Math.abs(cc.y - y) < E) return { hp: this.core.hp }
        }
      }
    } else {
      for (const u of this.units) {
        if (!u.isDead && Math.abs(u.worldX - x) < E && Math.abs(u.worldY - y) < E) return { hp: u.hp }
      }
    }
    return null
  }

  private pickWanderStep(unit: SpriteUnit): CellRef | null {
    const cs = Config.GRID_CELL
    const options: CellRef[] = []
    for (const [dx, dy] of CARDINAL_STEPS) {
      const x = unit.worldX + dx * cs
      const y = unit.worldY + dy * cs
      if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) continue
      if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) continue
      if (this.isCellOccupiedAtBattle(x, y, unit)) continue
      const col = Math.floor((x - Config.WORLD.LEFT) / cs)
      const row = Math.floor((y - Config.WORLD.BOTTOM) / cs)
      options.push({ col, row })
    }
    if (options.length === 0) return null
    return options[Math.floor(Math.random() * options.length)]
  }

  // Total planned steps — Game uses this after onComplete to detect a
  // zero-action reveal (no pieces capable of acting) so the continuous-battle
  // loop doesn't spin forever.
  get totalSteps(): number { return this.steps.length }

  // Returns the closest LIVE enemy entity within `maxDist` of unit. Enemy side
  // is inferred from the unit's own side (attacker → defender, defender → attacker).
  private nearestEnemy(
    unit: SpriteUnit,
    maxDist: number,
  ): { id: string; kind: 'sphere' | 'structure' | 'core' | 'unit'; x: number; y: number; d: number } | null {
    let bestId: string | null = null
    let bestKind: 'sphere' | 'structure' | 'core' | 'unit' = 'unit'
    let bestX = 0, bestY = 0
    let bestDist = maxDist
    const consider = (id: string, kind: typeof bestKind, x: number, y: number) => {
      const d = Math.hypot(x - unit.worldX, y - unit.worldY)
      if (d <= bestDist) { bestId = id; bestKind = kind; bestX = x; bestY = y; bestDist = d }
    }
    if (unit.side === 'attacker') {
      for (const s of this.spheres)        if (!s.isDead) consider(s.id, 'sphere',    s.worldX, s.worldY)
      for (const s of this.structures)     if (!s.isDead) consider(s.id, 'structure', s.worldX, s.worldY)
      for (const d of this.defenderUnits)  if (!d.isDead) consider(d.id, 'unit',      d.worldX, d.worldY)
      if (!this.core.isDead) {
        for (const cc of this.core.cellCenters()) consider('core', 'core', cc.x, cc.y)
      }
    } else {
      for (const u of this.units) if (!u.isDead) consider(u.id, 'unit', u.worldX, u.worldY)
    }
    return bestId === null ? null : { id: bestId, kind: bestKind, x: bestX, y: bestY, d: bestDist }
  }

  // Step one cell toward (tx, ty) — picks the adjacent cell that reduces
  // distance the most and isn't occupied AND isn't sitting inside an armed
  // enemy bomb's AoE. Returns null if no valid step. Reactive-AI flee:
  // candidates are scored by (distance to target) + (danger from armed
  // enemy bombs covering this cell). Bomb damage dominates pure distance
  // so a unit will sidestep instead of walking through a primed AoE — but
  // if every legal step is dangerous, it still picks the least-bad one.
  //
  // Cardinal-only by default — units pick from N/S/E/W neighbors. Future
  // diagonal-capable units (e.g., Hulk) gate on Config.UNITS[type]
  // .allowDiagonalMove and unlock the 8-cell search.
  private pickStepTowardPoint(unit: SpriteUnit, tx: number, ty: number): CellRef | null {
    const cs = Config.GRID_CELL
    const curDist = Math.hypot(tx - unit.worldX, ty - unit.worldY)
    type Cand = { col: number; row: number; x: number; y: number; d: number; danger: number }
    const candidates: Cand[] = []
    const allowDiagonal = (Config.UNITS[unit.type] as { allowDiagonalMove?: boolean }).allowDiagonalMove === true
    const steps = allowDiagonal ? DIAGONAL_STEPS : CARDINAL_STEPS
    for (const [dx, dy] of steps) {
      const x = unit.worldX + dx * cs
      const y = unit.worldY + dy * cs
      if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) continue
      if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) continue
      const col = Math.floor((x - Config.WORLD.LEFT) / cs)
      const row = Math.floor((y - Config.WORLD.BOTTOM) / cs)
      const d = Math.hypot(tx - x, ty - y)
      if (d >= curDist) continue   // must reduce distance
      if (this.isCellOccupiedAtBattle(x, y, unit)) continue
      candidates.push({ col, row, x, y, d, danger: this.cellBombDanger(x, y, unit.side) })
    }
    if (candidates.length === 0) return null
    // Score = distance + (danger weight). Weight tuned so any non-zero
    // bomb damage outranks ~2 cell-lengths of distance — a unit will gladly
    // sidestep one tile to dodge a primed grenade.
    candidates.sort((a, b) => (a.d + a.danger * 2) - (b.d + b.danger * 2))
    const c = candidates[0]
    return { col: c.col, row: c.row }
  }

  // How much armed enemy-bomb damage would a unit on `side` standing at
  // (x, y) absorb if every armed bomb in range went off right now. Used by
  // pickStepTowardPoint to flee primed AoE. Only ARMED bombs count —
  // freshly-thrown unarmed grenades don't yet pose a threat.
  private cellBombDanger(x: number, y: number, side: 'attacker' | 'defender'): number {
    let total = 0
    for (const g of this.pendingGrenades) {
      if (!g.armed) continue
      if (g.side === side) continue   // own side's bombs don't trigger on us
      if (Math.hypot(g.worldX - x, g.worldY - y) <= g.aoeRadius) total += g.damage
    }
    return total
  }

  // Default sphere action: fire at nearest cyborg in range. Skipped if the
  // sphere has burned through its ammo budget.
  private defaultSphereAction(sphere: SphereDefender): QueuedAction | null {
    if (sphere.ammoRemaining <= 0) return null
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

  // ── Lobbed-thrower (Bomber / Grenadier) helpers ────────────────────────

  private isLobbedThrower(actor: Actor): boolean {
    return (actor instanceof Structure && actor.type === 'bomber')
      || (actor instanceof SpriteUnit && (actor.type === 'bomber' || actor.type === 'grenadier'))
  }

  private hasActiveBomb(ownerId: string): boolean {
    return this.pendingGrenades.some(g => g.ownerId === ownerId)
  }

  // Auto-action for cyborg Bomber / Grenadier. If their bomb is still on the
  // field, they hold (or shuffle closer to an enemy). Otherwise they pick the
  // best empty cell within throw range and lob.
  private lobbedThrowerAction(unit: SpriteUnit): QueuedAction | null {
    if (this.hasActiveBomb(unit.id)) return null   // caller continues to move/advance fallback
    const cell = this.pickBombThrowCell(unit)
    if (cell) return { kind: 'throw', cell }
    return null
  }

  // Pick the empty cell within thrower's range that's closest to the nearest
  // enemy. Returns null if no enemy in throw + a-bit range, or no empty cell
  // qualifies. Works for both SpriteUnit (cyborg) and Structure (defender
  // bomber).
  private pickBombThrowCell(actor: Actor): CellRef | null {
    const range = this.actorRange(actor)
    const ax = this.actorX(actor)
    const ay = this.actorY(actor)
    const enemy = this.nearestEnemyXY(actor, range + Config.GRID_CELL * 2)
    if (!enemy) return null

    const cs = Config.GRID_CELL
    const ecol = Math.floor((enemy.x - Config.WORLD.LEFT) / cs)
    const erow = Math.floor((enemy.y - Config.WORLD.BOTTOM) / cs)

    let best: { col: number; row: number; score: number } | null = null
    const SEARCH = 3
    for (let dc = -SEARCH; dc <= SEARCH; dc++) {
      for (let dr = -SEARCH; dr <= SEARCH; dr++) {
        const col = ecol + dc
        const row = erow + dr
        const x = Config.WORLD.LEFT + col * cs + cs / 2
        const y = Config.WORLD.BOTTOM + row * cs + cs / 2
        if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) continue
        if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) continue
        if (Math.hypot(x - ax, y - ay) > range) continue
        // Structures only throw within their fire arc — same constraint as
        // direct-fire targeting. Mobile throwers (cyborg Bomber / Grenadier)
        // can lob in any direction since they pivot to face their throw.
        if (actor instanceof Structure && !this.targetInFireArc(actor, x - ax, y - ay)) continue
        if (!this.isCellEmptyForBomb(x, y)) continue
        const de = Math.hypot(x - enemy.x, y - enemy.y)
        if (!best || de < best.score) best = { col, row, score: de }
      }
    }
    return best ? { col: best.col, row: best.row } : null
  }

  // Closest armed enemy bomb within `maxDist` of the unit — used by Grenadier
  // diffuse targeting. Returns the bomb regardless of AoE (diffuse is a melee
  // safe-remove, the grenadier doesn't care about the radius).
  private nearestArmedEnemyBombInRange(unit: SpriteUnit, maxDist: number): PendingGrenade | null {
    let best: PendingGrenade | null = null
    let bestD = maxDist
    for (const g of this.pendingGrenades) {
      if (!g.armed) continue
      if (g.side === unit.side) continue
      const d = Math.hypot(g.worldX - unit.worldX, g.worldY - unit.worldY)
      if (d < bestD) { best = g; bestD = d }
    }
    return best
  }

  // Find the closest armed enemy bomb that's far enough that we're outside
  // its AoE — shooting it would detonate it harmlessly. Returns null if no
  // bomb is in range or every in-range bomb would catch us in its blast.
  private nearestSafeArmedBomb(unit: SpriteUnit, attackRange: number): PendingGrenade | null {
    let best: PendingGrenade | null = null
    let bestD = attackRange
    for (const g of this.pendingGrenades) {
      if (!g.armed) continue
      if (g.side === unit.side) continue       // not enemy
      const d = Math.hypot(g.worldX - unit.worldX, g.worldY - unit.worldY)
      if (d > attackRange) continue
      if (d <= g.aoeRadius + 8) continue       // too close — we'd eat the blast
      if (d < bestD) { best = g; bestD = d }
    }
    return best
  }

  // Side-aware enemy position lookup (no ID needed — we just need a point).
  private nearestEnemyXY(actor: Actor, maxDist: number): { x: number; y: number } | null {
    let best: { x: number; y: number; d: number } | null = null
    const consider = (x: number, y: number) => {
      const d = Math.hypot(x - this.actorX(actor), y - this.actorY(actor))
      if (d <= maxDist && (!best || d < best.d)) best = { x, y, d }
    }
    if (actor.side === 'attacker') {
      for (const s of this.spheres)        if (!s.isDead) consider(s.worldX, s.worldY)
      for (const s of this.structures)     if (!s.isDead) consider(s.worldX, s.worldY)
      for (const d of this.defenderUnits)  if (!d.isDead) consider(d.worldX, d.worldY)
      if (!this.core.isDead) {
        for (const cc of this.core.cellCenters()) consider(cc.x, cc.y)
      }
    } else {
      for (const u of this.units) if (!u.isDead) consider(u.worldX, u.worldY)
    }
    return best
  }

  // A cell is bomb-eligible if no piece sits on it (units, structures,
  // spheres, core sub-cells) AND no existing pending grenade is already
  // there. Walls/mines count as occupants — bombs go on truly open ground.
  private isCellEmptyForBomb(x: number, y: number): boolean {
    const E = 1
    const occupied = (px: number, py: number) =>
      Math.abs(px - x) < E && Math.abs(py - y) < E
    for (const u of this.units)        if (!u.isDead && occupied(u.worldX, u.worldY)) return false
    for (const u of this.defenderUnits) if (!u.isDead && occupied(u.worldX, u.worldY)) return false
    for (const s of this.spheres)       if (!s.isDead && occupied(s.worldX, s.worldY)) return false
    for (const s of this.structures)    if (!s.isDead && occupied(s.worldX, s.worldY)) return false
    for (const cc of this.core.cellCenters()) if (occupied(cc.x, cc.y)) return false
    for (const g of this.pendingGrenades) if (occupied(g.worldX, g.worldY)) return false
    return true
  }

  private pickNearestEnemyOf(struct: Structure): SpriteUnit | null {
    let nearest: SpriteUnit | null = null
    let nearestDist: number = struct.range
    for (const u of this.units) {
      if (u.isDead) continue
      const dx = u.worldX - struct.worldX
      const dy = u.worldY - struct.worldY
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > nearestDist) continue
      if (!this.targetInFireArc(struct, dx, dy)) continue
      nearestDist = d; nearest = u
    }
    return nearest
  }

  // True if (dx, dy) points within any of `struct.fireFacings` ± half-arc.
  // Used for direct-fire structures AND bomb-throw cell picking — both are
  // constrained to the structure's facing wedge(s).
  private targetInFireArc(struct: Structure, dx: number, dy: number): boolean {
    if (dx === 0 && dy === 0) return true
    const angle = Math.atan2(dy, dx)
    for (const facing of struct.fireFacings) {
      let delta = angle - facing
      // Normalize to [-π, π].
      while (delta > Math.PI)  delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2
      if (Math.abs(delta) <= FIRE_ARC_HALF_RAD) return true
    }
    return false
  }

  // ── Main tick ────────────────────────────────────────────────────────────

  update(delta: number) {
    // Always tick visuals (projectiles, explosions, unit anims) — they keep
    // running between steps and after the engine ends.
    this.tickProjectiles(delta)
    this.tickExplosions(delta)
    this.tickPendingGrenades(delta)
    for (const u of this.units) u.update(delta)

    if (this.done) return

    if (this.over) {
      // Game ended (win/lose) — wait for visuals to settle, then close.
      if (this.projectiles.length === 0 && this.explosions.length === 0) {
        this.done = true
      }
      return
    }

    // All planned actions consumed — wait for in-flight projectiles AND
    // explosions to finish, then signal completion. (Previously only waited
    // on projectiles, so a Grenadier AoE explosion that was still expanding
    // got orphaned in the scene with nothing to tick it.)
    if (this.idx >= this.steps.length) {
      if (this.projectiles.length === 0 && this.explosions.length === 0) {
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
      // Silent landing = lobbed grenade has arrived but won't blow until next
      // turn. No explosion VFX, no boom sound — onHit spawned the pending
      // grenade sprite that now sits on the cell.
      if (!proj.silentLanding) {
        this.explosions.push(new Explosion(
          this.scene, proj.targetX, proj.targetY,
          proj.isAoe ? proj.aoeRadius : 20, 0.4,
        ))
        if (proj.isAoe) playExplosion()
      }
      this.projectiles.splice(i, 1)
    }
  }

  private tickExplosions(delta: number) {
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      this.explosions[i].update(delta)
      if (this.explosions[i].isDone) this.explosions.splice(i, 1)
    }
  }

  // Proximity-fuse bombs: any enemy entering the aoeRadius detonates the
  // bomb immediately. Side-aware — defender bombs only trigger on cyborgs,
  // attacker bombs trigger on robots/dogs/core.
  private tickPendingGrenades(delta: number) {
    for (let i = this.pendingGrenades.length - 1; i >= 0; i--) {
      const g = this.pendingGrenades[i]
      g.update(delta)
      if (this.over) continue
      // Unarmed bombs ignore proximity — they're in the 1-turn fuse window
      // that gives enemies a chance to plan around them.
      if (!g.armed) continue
      if (this.shouldDetonateGrenade(g)) {
        this.detonatePendingGrenade(g)
      }
    }
  }

  // Apply a pending grenade's blast (explosion VFX + side-aware AoE + sound)
  // and remove it from the field. Shared by proximity trigger + shoot-the-bomb.
  private detonatePendingGrenade(g: PendingGrenade) {
    this.explosions.push(new Explosion(this.scene, g.worldX, g.worldY, g.aoeRadius, 0.5))
    this.applyAoeForSide(g.worldX, g.worldY, g.aoeRadius, g.damage, g.side)
    playExplosion()
    g.dispose()
    const idx = this.pendingGrenades.indexOf(g)
    if (idx >= 0) this.pendingGrenades.splice(idx, 1)
    this.combatThisReveal = true
  }

  private shouldDetonateGrenade(g: PendingGrenade): boolean {
    const r = g.aoeRadius
    if (g.side === 'defender') {
      for (const u of this.units) {
        if (u.isDead) continue
        if (Math.hypot(u.worldX - g.worldX, u.worldY - g.worldY) <= r) return true
      }
      return false
    }
    // Attacker bomb — trigger on any defender piece in range.
    for (const s of this.spheres)        if (!s.isDead && Math.hypot(s.worldX - g.worldX, s.worldY - g.worldY) <= r) return true
    for (const s of this.structures)     if (!s.isDead && Math.hypot(s.worldX - g.worldX, s.worldY - g.worldY) <= r) return true
    for (const d of this.defenderUnits)  if (!d.isDead && Math.hypot(d.worldX - g.worldX, d.worldY - g.worldY) <= r) return true
    if (!this.core.isDead) {
      for (const cc of this.core.cellCenters()) {
        if (Math.hypot(cc.x - g.worldX, cc.y - g.worldY) <= r) return true
      }
    }
    return false
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
      return
    }

    if (action.kind === 'diffuse') {
      this.executeDiffuse(actor, action.target)
      return
    }

    if (action.kind === 'slam') {
      this.executeSlam(actor, action.cell)
    }
  }

  // Hulk-only wedge attack. `cell` is the center of the wedge — one cardinal
  // step from the Hulk's current cell. The wedge is 3 cells wide perpendicular
  // to that direction; every enemy occupying any of the 3 cells takes the
  // slam's damage. Hits zero targets is still a legal action — the Hulk slams
  // the ground, ammo is spent.
  private executeSlam(actor: Actor, cell: CellRef) {
    if (!(actor instanceof SpriteUnit)) return
    if (actor.type !== 'hulk') return
    if (actor.slamAmmoRemaining <= 0) return

    const cs = Config.GRID_CELL
    const hulkCol = Math.floor((actor.worldX - Config.WORLD.LEFT) / cs)
    const hulkRow = Math.floor((actor.worldY - Config.WORLD.BOTTOM) / cs)
    const dirCol = cell.col - hulkCol
    const dirRow = cell.row - hulkRow
    // Must be a cardinal neighbor — guard against stale plans where the Hulk
    // moved before the slam tick. Diagonal or non-adjacent targets are a
    // strict skip per the planning model.
    const isCardinal = (Math.abs(dirCol) + Math.abs(dirRow)) === 1
    if (!isCardinal) return

    // Wedge perpendicular to the slam direction. East slam → wedge runs N/S,
    // covering rows -1/0/+1 of the target col.
    const perpCol = dirRow === 0 ? 0 : 1
    const perpRow = dirRow === 0 ? 1 : 0
    const wedgeCells: { x: number; y: number }[] = []
    for (let k = -1; k <= 1; k++) {
      const col = cell.col + perpCol * k
      const row = cell.row + perpRow * k
      const x = Config.WORLD.LEFT + col * cs + cs / 2
      const y = Config.WORLD.BOTTOM + row * cs + cs / 2
      if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) continue
      if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) continue
      wedgeCells.push({ x, y })
    }

    actor.faceTarget(cell.col * cs + Config.WORLD.LEFT + cs / 2,
                     cell.row * cs + Config.WORLD.BOTTOM + cs / 2)
    actor.playSlamAnim()
    actor.slamAmmoRemaining = Math.max(0, actor.slamAmmoRemaining - 1)
    this.combatThisReveal = true

    // Visual punch — a small impact burst on each wedge cell. Tied to the
    // slam animation cadence so the boom lands as the Hulk's fist connects.
    const damage = (Config.UNITS.hulk as { slamDamage: number }).slamDamage
    const E = 1
    for (const wc of wedgeCells) {
      this.explosions.push(new Explosion(this.scene, wc.x, wc.y, 22, 0.35))
      // Hit any enemy whose cell-centre overlaps this wedge cell.
      if (actor.side === 'attacker') {
        for (const s of this.spheres) {
          if (s.isDead) continue
          if (Math.abs(s.worldX - wc.x) < E && Math.abs(s.worldY - wc.y) < E) s.takeDamage(damage)
        }
        for (const st of this.structures) {
          if (st.isDead) continue
          if (Math.abs(st.worldX - wc.x) < E && Math.abs(st.worldY - wc.y) < E) st.takeDamage(damage)
        }
        for (const du of this.defenderUnits) {
          if (du.isDead) continue
          if (Math.abs(du.worldX - wc.x) < E && Math.abs(du.worldY - wc.y) < E) du.takeDamage(damage)
        }
        if (!this.core.isDead) {
          for (const cc of this.core.cellCenters()) {
            if (Math.abs(cc.x - wc.x) < E && Math.abs(cc.y - wc.y) < E) {
              this.core.takeDamage(damage)
              break
            }
          }
        }
      } else {
        for (const u of this.units) {
          if (u.isDead) continue
          if (Math.abs(u.worldX - wc.x) < E && Math.abs(u.worldY - wc.y) < E) u.takeDamage(damage)
        }
      }
    }
    playExplosion()
  }

  // Grenadier safe-remove of an armed enemy bomb. The bomb just vanishes —
  // no damage, no explosion VFX, small white blip where it sat. Strict-skip
  // if the bomb already detonated, the grenadier is no longer adjacent, or
  // somehow non-grenadier code routed through here.
  private executeDiffuse(actor: Actor, ref: TargetRef) {
    if (!(actor instanceof SpriteUnit) || actor.type !== 'grenadier') return
    if (ref.kind !== 'bomb') return
    const bomb = this.pendingGrenades.find(g => g.id === ref.id)
    if (!bomb || !bomb.armed) return
    if (bomb.side === actor.side) return       // own side — refuse to "diffuse" friendly
    const d = Math.hypot(bomb.worldX - actor.worldX, bomb.worldY - actor.worldY)
    if (d > Config.GRID_CELL * 1.6) return     // too far now
    // Quick non-explosive "puff" so the player sees the diffuse happen.
    this.explosions.push(new Explosion(this.scene, bomb.worldX, bomb.worldY, 14, 0.25))
    bomb.dispose()
    const idx = this.pendingGrenades.indexOf(bomb)
    if (idx >= 0) this.pendingGrenades.splice(idx, 1)
    actor.faceTarget(bomb.worldX, bomb.worldY)
    this.combatThisReveal = true
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
    // Out of ammo — strict skip. Catches both planned actions and the
    // default-AI path that may have slipped through.
    if (this.actorAmmo(actor) <= 0) return

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

    // The shot is going to fire — burn one round of ammo + mark combat.
    this.decrementActorAmmo(actor)
    this.combatThisReveal = true

    // Cyborg attack animation; spheres/structures don't have shoot anims yet.
    if (actor instanceof SpriteUnit) {
      actor.faceTarget(aim.x, aim.y)
      actor.playAttackAnim()
    }

    const isAoe = action.kind === 'throw'
      || (actor instanceof SpriteUnit && Config.UNITS[actor.type].aoeRadius > 0)
      || (actor instanceof Structure && (Config.STRUCTURES[actor.type].aoeRadius ?? 0) > 0)
    const aoeRadius = !isAoe ? 0
      : actor instanceof SpriteUnit ? Config.UNITS[actor.type].aoeRadius
      : actor instanceof Structure  ? (Config.STRUCTURES[actor.type].aoeRadius ?? 0)
      : 0

    const muzzle = this.actorMuzzle(actor, aim.x, aim.y)
    const damage = this.actorDamage(actor)
    const color = actor.side === 'defender' ? 0xffee00 : 0xff3333
    // Lobbed AoE = Bomber (defender structure) + Bomber/Grenadier (cyborg
    // units). These throw a grenade with a 1-turn fuse: projectile lands as
    // a PendingGrenade sprite, detonates at the start of the next reveal.
    // Direct-fire AoE (e.g. cannon turret) keeps the original instant-blast
    // behaviour.
    const isLobbed = (actor instanceof Structure && actor.type === 'bomber')
      || (actor instanceof SpriteUnit && (actor.type === 'bomber' || actor.type === 'grenadier'))
    const spriteTex = isLobbed ? getGrenadeTexture() : null

    const proj = new Projectile(
      this.scene, muzzle.x, muzzle.y, null, aim.x, aim.y,
      damage, isAoe, aoeRadius, color, spriteTex,
    )

    if (action.kind === 'fire' && !isAoe) {
      const ref = (action as { target: TargetRef }).target
      if (ref.kind === 'bomb') {
        // Shoot-the-bomb counterplay — the projectile is a hit-marker, the
        // bomb supplies its own damage/AoE/side on detonation. Removes the
        // pending grenade from the field cleanly.
        const bomb = this.pendingGrenades.find(g => g.id === ref.id)
        if (bomb && bomb.armed) {
          proj.onHit = () => this.detonatePendingGrenade(bomb)
        }
      } else {
        // Direct fire — resolve target entity NOW (at fire time) and damage on
        // hit. If the target died before the projectile lands, no damage.
        const targetEntity = this.resolveTargetEntity(ref)
        if (targetEntity) {
          proj.onHit = () => { if (!targetEntity.isDead) targetEntity.takeDamage(damage) }
        }
      }
    } else if (isLobbed) {
      // Proximity bomb — grenade lands silently, sits on the target cell as
      // a pulsing trap, and detonates when any enemy steps into its aoe
      // radius (see tickPendingGrenades). One bomb per thrower at a time —
      // the lobbed-thrower auto-action enforces that gate.
      proj.silentLanding = true
      const side = actor.side
      const ownerId = actor.id
      proj.onHit = () => {
        this.pendingGrenades.push(new PendingGrenade(
          this.scene, aim.x, aim.y, damage, aoeRadius, side, ownerId,
        ))
      }
    } else {
      // Direct-fire AoE — splash everything in range of the impact point
      // immediately. Defender AoE hits cyborgs only; attacker AoE hits
      // defender pieces + dogs + core.
      proj.onHit = () => this.applyAoe(aim.x, aim.y, aoeRadius, damage, actor)
    }

    this.projectiles.push(proj)
    if (!isAoe) playGunshot()
  }

  private applyAoe(cx: number, cy: number, radius: number, damage: number, source: Actor) {
    this.applyAoeForSide(cx, cy, radius, damage, source.side)
  }

  private applyAoeForSide(cx: number, cy: number, radius: number, damage: number, side: 'attacker' | 'defender') {
    // Defender AoE hits cyborgs only. Attacker AoE hits defender pieces +
    // defender mobile units + the core.
    if (side === 'defender') {
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
      for (const u of this.defenderUnits) {
        if (u.isDead) continue
        if (this.inRadius(u.worldX, u.worldY, cx, cy, radius)) u.takeDamage(damage)
      }
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
      this.combatThisReveal = true
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
    const all: Actor[] = [...this.units, ...this.defenderUnits, ...this.spheres, ...this.structures]
    const hit = all.find(p => p.id === ref.id)
    return hit && !hit.isDead ? hit : null
  }

  private resolveTargetXY(ref: TargetRef): { x: number; y: number } | null {
    if (ref.kind === 'core') {
      if (this.core.isDead) return null
      return { x: this.core.mesh.position.x, y: this.core.mesh.position.y }
    }
    if (ref.kind === 'bomb') {
      const b = this.pendingGrenades.find(g => g.id === ref.id)
      return b && b.armed ? { x: b.worldX, y: b.worldY } : null
    }
    const all: Actor[] = [...this.units, ...this.defenderUnits, ...this.spheres, ...this.structures]
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
    for (const u of this.defenderUnits) {
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

  private actorAmmo(actor: Actor): number {
    if (actor instanceof SpriteUnit)     return actor.ammoRemaining
    if (actor instanceof SphereDefender) return actor.ammoRemaining
    return actor.ammoRemaining
  }

  private decrementActorAmmo(actor: Actor) {
    if (actor instanceof SpriteUnit)     { actor.ammoRemaining = Math.max(0, actor.ammoRemaining - 1); return }
    if (actor instanceof SphereDefender) { actor.ammoRemaining = Math.max(0, actor.ammoRemaining - 1); return }
    actor.ammoRemaining = Math.max(0, actor.ammoRemaining - 1)
  }

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
    for (const u of this.defenderUnits) u.faceCamera(camera)
    for (const s of this.spheres) if (!s.isDead) s.faceCamera(camera)
    for (const s of this.structures) if (!s.isDead) s.faceCamera(camera)
  }
}
