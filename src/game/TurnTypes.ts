// Plan-then-play turn-system types. Filled out in phase 1 (data model).
// Consumers (Planning UI in phase 2, Reveal engine in phase 3) come later.

export type CellRef = { col: number; row: number }

export type TargetKind = 'unit' | 'sphere' | 'structure' | 'core' | 'bomb'
export type TargetRef = { kind: TargetKind; id: string }

export type QueuedActionKind =
  | 'move' | 'fire' | 'throw' | 'diffuse' | 'slam' | 'hold'
  // Medic actions. heal-throw lobs a med-pack at an ally (1 charge);
  // heal-pad deploys a structure that ticks heals to adjacent cyborgs
  // (2 charges to drop); heal-tether locks the medic + target together,
  // healing each turn (1 charge per turn while tethered).
  | 'heal-throw' | 'heal-pad' | 'heal-tether'

export type QueuedAction =
  | { kind: 'move';    cell: CellRef }
  | { kind: 'fire';    target: TargetRef }
  | { kind: 'throw';   cell: CellRef }
  | { kind: 'diffuse'; target: TargetRef }   // Grenadier safe-removes an armed enemy bomb
  // Cyborg Hulk special. `cell` is the center of the wedge — one cardinal
  // step forward of the Hulk. The wedge is 3 cells wide perpendicular to
  // that direction, so a Hulk at (5,3) slamming east targets cell (6,3)
  // and damages (6,2), (6,3), (6,4).
  | { kind: 'slam';    cell: CellRef }
  | { kind: 'hold' }
  // Cyborg Medic. heal-throw targets a damaged ally by ref; heal-pad drops
  // a healing station on the specified cell; heal-tether starts a sustained
  // bond with the target ally (per-turn heal + ammo decrement until the
  // medic runs out of charges, the target hits full HP, or one dies).
  | { kind: 'heal-throw';  target: TargetRef }
  | { kind: 'heal-pad';    cell: CellRef }
  | { kind: 'heal-tether'; target: TargetRef }

export const AP_COST: Record<QueuedActionKind, number> = {
  move: 1,
  fire: 1,
  throw: 2,
  diffuse: 1,
  slam: 2,
  hold: 0,
  'heal-throw': 1,
  'heal-pad': 2,
  'heal-tether': 1,
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
