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

/**
 * Lightweight opponent that handles the AI side's BUILD phase. PLAN-phase
 * behaviour falls through to RevealPhase's defaultMobileUnitAction logic
 * (move toward enemy, fire when in range, throw bombs, etc) so we don't
 * need to queue actions here.
 *
 * S17 build rule: guarantee one of each type first, then spend every
 * remaining credit on random picks. There is no PLAN phase + no later
 * BUILD phase in the current flow, so reserving credits made no sense —
 * the old 55% per-turn cap is removed.
 */
export class OpponentAI {
  constructor(private side: OpponentSide, private api: OpponentAIApi) {}

  /** Called once at the start of every BUILD phase by Game. */
  runBuildTurn() {
    // S17: spend everything. stopAt = 0 means "loop until broke".
    const stopAt = 0
    if (this.side === 'defender') this.buildDefender(stopAt)
    else                          this.buildAttacker(stopAt)
  }

  // ── Defender (Robots) build strategy ───────────────────────────────────
  // S17 rule: guaranteed 1 of each type first (sphere, turret, bomber,
  // sentry, wall, dog, repair — laser is a preview piece without real
  // mechanics, excluded), then random spending until broke or no slots.
  // Initial picks keep their strategic placement bias (sphere back, towers
  // front, etc.); phase 2 fills the remaining grid with random affordable
  // pieces.
  private buildDefender(stopAt: number) {
    // ── PHASE 1 — guaranteed 1 of each type ────────────────────────────
    // SPHERE — back-side cols 2-4, center rows, high-impact anchor.
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

    // TURRET (TOWER) — front cols 5-7, flank-edge rows.
    {
      const cost = Config.STRUCTURES.turret.cost
      const slots = this.cellsInZoneSorted({
        zoneXMin: Config.WORLD.LEFT,
        colMin: 5, colMax: 7,
        rowPreference: 'edges',
      })
      if (this.api.getCredits() > stopAt && this.api.getCredits() >= cost && slots.length > 0) {
        const slot = slots.shift()!
        this.api.spawnStructure('turret', slot.col, slot.row)
      }
    }

    // CANNON — AoE turret, mid-front. Defender answer to clustered cyborgs.
    {
      const cost = Config.STRUCTURES.cannon.cost
      const slots = this.cellsInZoneSorted({
        zoneXMin: Config.WORLD.LEFT,
        colMin: 5, colMax: 7,
        rowPreference: 'center',
      })
      if (this.api.getCredits() > stopAt && this.api.getCredits() >= cost && slots.length > 0) {
        const slot = slots.shift()!
        this.api.spawnStructure('cannon', slot.col, slot.row)
      }
    }

    // BOMBER — area-control trap, mid lane.
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

    // LASER — long-range direct fire, back cols (range 300 reaches the
    // middle map from anywhere in defender zone).
    {
      const cost = Config.STRUCTURES.laser.cost
      const slots = this.cellsInZoneSorted({
        zoneXMin: Config.WORLD.LEFT,
        colMin: 3, colMax: 5,
        rowPreference: 'edges',
      })
      if (this.api.getCredits() > stopAt && this.api.getCredits() >= cost && slots.length > 0) {
        const slot = slots.shift()!
        this.api.spawnStructure('laser', slot.col, slot.row)
      }
    }

    // MINE — passive trap. Front-edge cells where cyborgs walk through.
    {
      const cost = Config.STRUCTURES.mine.cost
      const slots = this.cellsInZoneSorted({
        zoneXMin: Config.WORLD.LEFT,
        colMin: 7, colMax: 7,
        rowPreference: 'shuffle',
      })
      if (this.api.getCredits() > stopAt && this.api.getCredits() >= cost && slots.length > 0) {
        const slot = slots.shift()!
        this.api.spawnStructure('mine', slot.col, slot.row)
      }
    }

    // SIGNAL — EMP emitter, deep back so it stays alive long enough to
    // fire its 2 charges. Range 500 reaches the entire middle map.
    {
      const cost = Config.STRUCTURES.signal.cost
      const slots = this.cellsInZoneSorted({
        zoneXMin: Config.WORLD.LEFT,
        colMin: 2, colMax: 3,
        rowPreference: 'center',
      })
      if (this.api.getCredits() > stopAt && this.api.getCredits() >= cost && slots.length > 0) {
        const slot = slots.shift()!
        this.api.spawnStructure('signal', slot.col, slot.row)
      }
    }

    // SENTRY — heavy-armor turret on tracks, front cols.
    {
      const cost = Config.STRUCTURES.sentry.cost
      const slots = this.cellsInZoneSorted({
        zoneXMin: Config.WORLD.LEFT,
        colMin: 5, colMax: 7,
        rowPreference: 'center',
      })
      if (this.api.getCredits() > stopAt && this.api.getCredits() >= cost && slots.length > 0) {
        const slot = slots.shift()!
        this.api.spawnStructure('sentry', slot.col, slot.row)
      }
    }

    // WALL — mid cols, blocker.
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

    // DOG — harasser, front edge.
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

    // REPAIR — support unit, mid-back cols.
    {
      const cost = Config.UNITS.repair.cost
      const slots = this.cellsInZoneSorted({
        zoneXMin: Config.WORLD.LEFT,
        colMin: 3, colMax: 5,
        rowPreference: 'center',
      })
      if (this.api.getCredits() > stopAt && this.api.getCredits() >= cost && slots.length > 0) {
        const slot = slots.shift()!
        this.api.spawnDefenderUnit('repair', slot.x, slot.y)
      }
    }

    // ── PHASE 2 — random fill, spend everything ────────────────────────
    // Pool excludes laser (preview piece, no real mechanic). Each random
    // pick searches its preferred placement zone; if the zone is full it
    // tries the broader defender zone before giving up on that type.
    type Pick = { kind: 'structure' | 'sphere' | 'defender'; type?: StructureType | UnitType; cost: number }
    const pool: Pick[] = [
      { kind: 'sphere',    cost: Config.SPHERE.cost },
      { kind: 'structure', type: 'turret', cost: Config.STRUCTURES.turret.cost },
      { kind: 'structure', type: 'cannon', cost: Config.STRUCTURES.cannon.cost },
      { kind: 'structure', type: 'bomber', cost: Config.STRUCTURES.bomber.cost },
      { kind: 'structure', type: 'sentry', cost: Config.STRUCTURES.sentry.cost },
      { kind: 'structure', type: 'laser',  cost: Config.STRUCTURES.laser.cost },
      { kind: 'structure', type: 'mine',   cost: Config.STRUCTURES.mine.cost },
      { kind: 'structure', type: 'signal', cost: Config.STRUCTURES.signal.cost },
      { kind: 'structure', type: 'wall',   cost: Config.STRUCTURES.wall.cost },
      { kind: 'defender',  type: 'dog',    cost: Config.UNITS.dog.cost },
      { kind: 'defender',  type: 'repair', cost: Config.UNITS.repair.cost },
    ]
    let safety = 256
    while (safety-- > 0 && this.api.getCredits() > stopAt) {
      const affordable = pool.filter(p => p.cost <= this.api.getCredits())
      if (affordable.length === 0) break
      const pick = affordable[Math.floor(Math.random() * affordable.length)]
      if (!this.placeDefenderPiece(pick)) {
        // No slot for this type — drop it from the pool for the rest of this
        // build so we don't spin forever on a saturated piece.
        const idx = pool.indexOf(pick)
        if (idx >= 0) pool.splice(idx, 1)
        if (pool.length === 0) break
      }
    }
  }

  // Phase-2 random placement helper. Returns true if a piece was actually
  // placed, false if no slot accepts it (caller drops the type from the pool).
  private placeDefenderPiece(pick: { kind: 'structure' | 'sphere' | 'defender'; type?: StructureType | UnitType }): boolean {
    // Broad search across the whole defender zone; phase 2 doesn't care
    // about strategic placement, just filling open cells.
    const slots = this.cellsInZoneSorted({
      zoneXMin: Config.WORLD.LEFT,
      colMin: 0, colMax: 7,
      rowPreference: 'shuffle',
    })
    while (slots.length > 0) {
      const slot = slots.shift()!
      let ok = false
      if (pick.kind === 'sphere') {
        ok = this.api.spawnSphere(slot.x, slot.y)
      } else if (pick.kind === 'structure') {
        ok = this.api.spawnStructure(pick.type as StructureType, slot.col, slot.row)
      } else {
        ok = this.api.spawnDefenderUnit(pick.type as UnitType, slot.x, slot.y)
      }
      if (ok) return true
    }
    return false
  }

  // ── Attacker (Cyborgs) build strategy ──────────────────────────────────
  // S17 rule: guaranteed 1 of each cyborg type first, then random spending
  // until broke or no slots. ATTACKER roster (per HUD): cannon, grenadier,
  // doublegun, hulk, sniper, medic. Bomber/scout/tank/drone exist in Config
  // but are NOT in the buyable cyborg shop, so they're excluded here too.
  private buildAttacker(stopAt: number) {
    const allTypes: UnitType[] = ['cannon', 'grenadier', 'doublegun', 'hulk', 'sniper', 'medic', 'stalker']

    // Spawn from the back columns (closest to the cyborg edge of the field).
    // Cyborgs march west toward the core, so back-row spawns get the most
    // turns of action before they reach the front.
    const baseSlots = this.cellsInZoneSorted({
      zoneXMin: Config.ATTACKER_MIN_X,
      colMin: 0, colMax: 3,
      rowPreference: 'shuffle',
    })

    // Track placed sniper positions so we can enforce a min-spacing rule
    // (snipers should cover different angles, not stack). Distance is in
    // world units; 3 cells = 150.
    const placedSnipers: { x: number; y: number }[] = []
    const SNIPER_MIN_SPACING = Config.GRID_CELL * 3

    const tryPlace = (type: UnitType): boolean => {
      const cost = Config.UNITS[type].cost
      if (this.api.getCredits() < cost) return false
      if (baseSlots.length === 0) return false
      let slot: Cell | undefined
      if (type === 'sniper') {
        for (let i = 0; i < baseSlots.length; i++) {
          const c = baseSlots[i]
          const tooClose = placedSnipers.some(p =>
            Math.hypot(p.x - c.x, p.y - c.y) < SNIPER_MIN_SPACING)
          if (!tooClose) {
            slot = baseSlots.splice(i, 1)[0]
            break
          }
        }
        if (!slot) return false
        placedSnipers.push({ x: slot.x, y: slot.y })
      } else {
        slot = baseSlots.shift()!
      }
      this.api.spawnAttackerUnit(type, slot.x, slot.y)
      return true
    }

    // PHASE 1 — 1 of each type. Skip types that are unbuyable right now.
    for (const t of allTypes) {
      if (this.api.getCredits() <= stopAt) break
      tryPlace(t)
    }

    // PHASE 2 — random fills until OOC or OOS. Each iteration picks a random
    // affordable type; safety cap protects against pathological loops.
    let safety = 128
    while (safety-- > 0 && this.api.getCredits() > stopAt && baseSlots.length > 0) {
      const affordable = allTypes.filter(t => Config.UNITS[t].cost <= this.api.getCredits())
      if (affordable.length === 0) break
      const type = affordable[Math.floor(Math.random() * affordable.length)]
      if (!tryPlace(type)) {
        // sniper spacing failure — drop sniper from this round's candidates
        // by trying again with sniper temporarily excluded if it was the pick.
        if (type === 'sniper') {
          // Temporarily skip sniper if no spaced slot exists; loop continues.
          const others = affordable.filter(t => t !== 'sniper')
          if (others.length === 0) break
          const fallback = others[Math.floor(Math.random() * others.length)]
          if (!tryPlace(fallback)) break
        } else {
          break
        }
      }
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

}
