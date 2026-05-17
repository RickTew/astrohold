// Plan-then-play turn-system types. Filled out in phase 1 (data model).
// Consumers (Planning UI in phase 2, Reveal engine in phase 3) come later.

export type CellRef = { col: number; row: number }

export type TargetKind = 'unit' | 'sphere' | 'structure' | 'core'
export type TargetRef = { kind: TargetKind; id: string }

export type QueuedActionKind = 'move' | 'fire' | 'throw' | 'hold'

export type QueuedAction =
  | { kind: 'move';  cell: CellRef }
  | { kind: 'fire';  target: TargetRef }
  | { kind: 'throw'; cell: CellRef }
  | { kind: 'hold' }

export const AP_COST: Record<QueuedActionKind, number> = {
  move: 1,
  fire: 1,
  throw: 2,
  hold: 0,
}

// Stationary pieces (Sphere, structures, core) use this fallback. Set HIGHER
// than any cyborg's speed (max 75 for Grenadier, 90 for the Dog) so defender
// structures fire BEFORE the attacker waves close in each turn. Previously
// 10 meant they fired last, after every cyborg had already moved/fired,
// which made defenders feel useless.
export const STATIONARY_INITIATIVE = 100

let nextId = 1
export function nextActorId(prefix: string): string {
  return `${prefix}_${nextId++}`
}
