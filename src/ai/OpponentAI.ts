import { Config, StructureType, UnitType } from '../game/GameConfig'

export type OpponentSide = 'defender' | 'attacker'

// API the AI uses to spend the opposing team's resources. Game implements
// these methods directly so the AI doesn't have to know about scene graphs
// or BuildPhase internals — it just spends credits and asks for spawns.
export interface OpponentAIApi {
  /** Credits available to this side right now. */
  getCredits(): number
  /** Subtract N credits. Returns false if insufficient. */
  spendCredits(amount: number): boolean
  /** Spawn a sphere at world (x, y). Returns true on success. */
  spawnSphere(x: number, y: number): boolean
  /** Spawn a defender mobile unit (dog) at world (x, y). */
  spawnDefenderUnit(type: UnitType, x: number, y: number): boolean
  /** Spawn an attacker mobile unit (cyborg) at world (x, y). */
  spawnAttackerUnit(type: UnitType, x: number, y: number): boolean
  /** Place a structure at grid cell (col, row) within the defender zone (col 0..7). */
  spawnStructure(type: StructureType, col: number, row: number): boolean
  /** Cross-system occupancy check at world coords (matches Game.isCellOccupied). */
  isCellOccupied(x: number, y: number): boolean
}

type Cell = { col: number; row: number; x: number; y: number }

const ZONE_COLS = 8     // each side's playable column count
const TOTAL_ROWS = 8

// Per-turn budget cap so the AI doesn't blow its entire bank on turn 1.
// Leaves credits in reserve for reinforcement waves in later BUILD phases.
const PER_TURN_BUDGET_FRAC = 0.55

/**
 * Lightweight opponent that handles the AI side's BUILD phase. PLAN-phase
 * behaviour falls through to RevealPhase's defaultMobileUnitAction logic
 * (move toward enemy, fire when in range, throw bombs, etc) so we don't
 * need to queue actions here.
 */
export class OpponentAI {
  constructor(private side: OpponentSide, private api: OpponentAIApi) {}

  /** Called once at the start of every BUILD phase by Game. */
  runBuildTurn() {
    const budget = Math.floor(this.api.getCredits() * PER_TURN_BUDGET_FRAC)
    const startCredits = this.api.getCredits()
    const stopAt = startCredits - budget    // halt purchases once we've burned this turn's allotment

    if (this.side === 'defender') this.buildDefender(stopAt)
    else                          this.buildAttacker(stopAt)
  }

  // ── Defender (Robots) build strategy ───────────────────────────────────
  // Priority order (each gated on credits):
  //   1. One sphere on the back columns (high impact, 100cr)
  //   2. Two towers on the front columns (covers approach)
  //   3. Two walls on the mid columns (blockers)
  //   4. One bomber in the mid lane (area control)
  //   5. One dog on the front line (harasser)
  //
  // Sphere placement bias toward the rows above and below the core (rows
  // 2-5) so it can cover the most cyborg approaches.
  private buildDefender(stopAt: number) {
    // SPHERES — back columns 1-2 (cols 0/1 are behind the core), middle rows.
    {
      const slots = this.cellsInZoneSorted({
        zoneXMin: Config.WORLD.LEFT,
        colMin: 2, colMax: 4,
        rowPreference: 'center',
      })
      if (this.api.getCredits() > stopAt && this.api.getCredits() >= Config.SPHERE.cost && slots.length > 0) {
        const slot = slots.shift()!
        this.api.spawnSphere(slot.x, slot.y)
      }
    }

    // TOWERS — front columns 5-7 (closest to the battlefield). Up to two.
    {
      const cost = Config.STRUCTURES.turret.cost
      const slots = this.cellsInZoneSorted({
        zoneXMin: Config.WORLD.LEFT,
        colMin: 5, colMax: 7,
        rowPreference: 'edges',   // pick top/bottom rows first so they cover flanks
      })
      let placed = 0
      while (placed < 2 && this.api.getCredits() > stopAt && this.api.getCredits() >= cost && slots.length > 0) {
        const slot = slots.shift()!
        if (this.api.spawnStructure('turret', slot.col, slot.row)) placed++
      }
    }

    // WALLS — mid columns 4-5. Just one per turn; walls compound across turns.
    {
      const cost = Config.STRUCTURES.wall.cost
      const slots = this.cellsInZoneSorted({
        zoneXMin: Config.WORLD.LEFT,
        colMin: 4, colMax: 5,
        rowPreference: 'center',
      })
      if (this.api.getCredits() > stopAt && this.api.getCredits() >= cost && slots.length > 0) {
        const slot = slots.shift()!
        this.api.spawnStructure('wall', slot.col, slot.row)
      }
    }

    // BOMBER — area-control trap. One per turn at most.
    {
      const cost = Config.STRUCTURES.bomber.cost
      const slots = this.cellsInZoneSorted({
        zoneXMin: Config.WORLD.LEFT,
        colMin: 4, colMax: 6,
        rowPreference: 'edges',
      })
      if (this.api.getCredits() > stopAt && this.api.getCredits() >= cost && slots.length > 0) {
        const slot = slots.shift()!
        this.api.spawnStructure('bomber', slot.col, slot.row)
      }
    }

    // DOG — single harasser, front edge.
    {
      const cost = Config.UNITS.dog.cost
      const slots = this.cellsInZoneSorted({
        zoneXMin: Config.WORLD.LEFT,
        colMin: 6, colMax: 7,
        rowPreference: 'random',
      })
      if (this.api.getCredits() > stopAt && this.api.getCredits() >= cost && slots.length > 0) {
        const slot = slots.shift()!
        this.api.spawnDefenderUnit('dog', slot.x, slot.y)
      }
    }
  }

  // ── Attacker (Cyborgs) build strategy ──────────────────────────────────
  // Buy a mixed squad weighted toward bread-and-butter units. Skip premium
  // picks (Sniper, Hulk) early so credits last for ongoing pressure.
  private buildAttacker(stopAt: number) {
    type Pick = { t: UnitType; weight: number }
    const pool: Pick[] = [
      { t: 'cannon',    weight: 3 },
      { t: 'grenadier', weight: 3 },
      { t: 'doublegun', weight: 2 },
      { t: 'hulk',      weight: 1 },
      { t: 'sniper',    weight: 1 },
      // Medic — support unit, weight 1 so AI buys ~1 per squad when it fits.
      { t: 'medic',     weight: 1 },
    ]

    // Spawn from the back columns (closest to the cyborg edge of the field).
    // Cyborgs march west toward the core, so back-row spawns get the most
    // turns of action before they reach the front.
    const baseSlots = this.cellsInZoneSorted({
      zoneXMin: Config.ATTACKER_MIN_X,
      colMin: 0, colMax: 3,
      rowPreference: 'shuffle',
    })

    let safety = 32   // hard cap on AI loop iterations
    while (safety-- > 0 && this.api.getCredits() > stopAt && baseSlots.length > 0 && pool.length > 0) {
      const type = this.weightedPick(pool)
      const cost = Config.UNITS[type].cost
      if (this.api.getCredits() < cost) {
        // Too expensive — drop this type from the pool and retry with what's left.
        const idx = pool.findIndex(p => p.t === type)
        if (idx >= 0) pool.splice(idx, 1)
        continue
      }
      const slot = baseSlots.shift()!
      this.api.spawnAttackerUnit(type, slot.x, slot.y)
    }
  }

  // ── Cell helpers ───────────────────────────────────────────────────────

  // Find empty cells inside the named column range, ordered by row preference.
  // `colMin/colMax` are ZONE-LOCAL (0..7) and converted to world coords using
  // `zoneXMin` as the zone's left edge.
  private cellsInZoneSorted(opts: {
    zoneXMin: number
    colMin: number
    colMax: number
    rowPreference: 'center' | 'edges' | 'shuffle' | 'random'
  }): Cell[] {
    const cells: Cell[] = []
    const cell = Config.GRID_CELL
    for (let col = opts.colMin; col <= opts.colMax; col++) {
      for (let row = 0; row < TOTAL_ROWS; row++) {
        const x = opts.zoneXMin + col * cell + cell / 2
        const y = Config.WORLD.BOTTOM + row * cell + cell / 2
        if (this.api.isCellOccupied(x, y)) continue
        cells.push({ col, row, x, y })
      }
    }

    if (opts.rowPreference === 'center') {
      // Rows closest to the vertical midpoint (rows 3/4) first.
      const mid = (TOTAL_ROWS - 1) / 2
      cells.sort((a, b) => Math.abs(a.row - mid) - Math.abs(b.row - mid))
    } else if (opts.rowPreference === 'edges') {
      // Top and bottom rows first — covers flanks.
      const mid = (TOTAL_ROWS - 1) / 2
      cells.sort((a, b) => Math.abs(b.row - mid) - Math.abs(a.row - mid))
    } else {
      // shuffle / random — Fisher-Yates so successive games don't look identical.
      for (let i = cells.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[cells[i], cells[j]] = [cells[j], cells[i]]
      }
    }

    // Defender's zone exposes ZONE columns 0..7 but Structure constructor
    // takes GLOBAL col indices. zoneXMin = WORLD.LEFT means local==global;
    // any other zoneXMin (e.g. attacker zone) would need offsetting — but
    // we don't place structures for the attacker side, only mobile units
    // (which use world coords directly), so no adjustment needed.
    return cells
  }

  private weightedPick<T extends { t: UnitType; weight: number }>(items: T[]): UnitType {
    const total = items.reduce((s, x) => s + x.weight, 0)
    let r = Math.random() * total
    for (const x of items) {
      r -= x.weight
      if (r <= 0) return x.t
    }
    return items[0].t
  }
}
