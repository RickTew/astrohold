// Per-battle metrics tracker. The game writes a snapshot to localStorage
// every time a match ends; the user can then paste the JSON dump to me
// (or any analyst) to spot balance issues across many games.
//
// Storage layout: a single localStorage key holds a JSON array of
// BattleRecord objects. Each game appends one record. The array is
// capped at MAX_RECORDS so it doesn't grow unbounded.
//
// Console API (attached to window.astrohold for easy access):
//   astrohold.dumpStats()    — pretty-print all records to the console
//   astrohold.statsJSON()    — return the records as a JSON string for copy
//   astrohold.statsSummary() — aggregate stats across all records
//   astrohold.clearStats()   — wipe the records

export interface BattleRecord {
  /** ISO timestamp when the battle ended. */
  endedAt: string
  /** Outcome from the PLAYER's POV. */
  outcome: 'win' | 'lose'
  /** HOW the battle ended (informational — useful for "attrition rate"
   *  analysis even when outcome is the same as 'cyborgs_eliminated'). */
  endType: 'core_destroyed' | 'cyborgs_eliminated' | 'attrition'
  /** Side the player picked. */
  playerSide: 'defender' | 'attacker'
  /** Number of reveal turns that elapsed. */
  turns: number
  /** Pieces alive at game end, by side. */
  alive: { attacker: number; defender: number }
  /** Total damage dealt per side (parsed from combat-log entries). */
  damageDealt: { attacker: number; defender: number }
  /** Kills caused per side (parsed from "killed" markers in log). */
  kills: { attacker: number; defender: number }
  /** Power core HP at end (0 if destroyed). */
  coreHpEnd: number
  coreMaxHp: number
}

const KEY = 'astrohold:battle-stats:v1'
const MAX_RECORDS = 50

function loadAll(): BattleRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as BattleRecord[]
  } catch {
    return []
  }
}

function saveAll(records: BattleRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(records))
  } catch {
    // localStorage quota / disabled — non-fatal
  }
}

export function recordBattle(record: BattleRecord) {
  const all = loadAll()
  all.push(record)
  while (all.length > MAX_RECORDS) all.shift()
  saveAll(all)
}

// Install the console-accessible helpers on window. main.ts calls this
// at boot so the user can grab stats from the dev console at any time.
export function installBattleStatsConsoleApi() {
  const api = {
    dumpStats() {
      const all = loadAll()
      // Sort newest first for readability
      // eslint-disable-next-line no-console
      console.table(all.map(r => ({
        when: r.endedAt.slice(11, 19),
        outcome: r.outcome,
        side: r.playerSide,
        turns: r.turns,
        att_alive: r.alive.attacker,
        def_alive: r.alive.defender,
        att_dmg: r.damageDealt.attacker,
        def_dmg: r.damageDealt.defender,
        coreHp: `${r.coreHpEnd}/${r.coreMaxHp}`,
      })))
      return all
    },
    statsJSON(): string {
      return JSON.stringify(loadAll(), null, 2)
    },
    statsSummary() {
      const all = loadAll()
      if (all.length === 0) {
        return { games: 0, message: 'No battles recorded yet — play some games first.' }
      }
      const total = all.length
      const wins = all.filter(r => r.outcome === 'win').length
      const losses = all.filter(r => r.outcome === 'lose').length
      const byEnd = {
        core_destroyed:   all.filter(r => r.endType === 'core_destroyed').length,
        cyborgs_eliminated: all.filter(r => r.endType === 'cyborgs_eliminated').length,
        attrition:        all.filter(r => r.endType === 'attrition').length,
      }
      const avgTurns = all.reduce((s, r) => s + r.turns, 0) / total
      const avgAttDmg = all.reduce((s, r) => s + r.damageDealt.attacker, 0) / total
      const avgDefDmg = all.reduce((s, r) => s + r.damageDealt.defender, 0) / total
      const defenderWinRate = all.filter(r => r.endType !== 'core_destroyed').length / total
      return {
        games: total,
        outcomes: { wins, losses },
        endTypes: byEnd,
        defenderWinRate: defenderWinRate.toFixed(2),
        avgTurns: avgTurns.toFixed(1),
        avgDamageAttacker: avgAttDmg.toFixed(0),
        avgDamageDefender: avgDefDmg.toFixed(0),
      }
    },
    clearStats() {
      saveAll([])
      return 'Cleared.'
    },
  }
  // Attach without overwriting any existing astrohold namespace
  ;(window as unknown as { astrohold: typeof api }).astrohold = api
  // eslint-disable-next-line no-console
  console.info(
    '[astrohold] battle-stats console API ready — try `astrohold.statsSummary()` after a few games'
  )
}
