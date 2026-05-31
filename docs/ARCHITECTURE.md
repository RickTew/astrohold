# AstroHold — Architecture Reference

Code map + flow-of-control reference. Per-piece numbers / behaviors live in
`STATS.md`. HUD/UI details live in `HUD.md`. Session-by-session decisions
live in `DEVNOTES.md`.

## Phase flow
- `loading -> pick-side -> build -> reveal -> win/lose`
- **PLAN phase is currently skipped.** BUILD's READY button calls
  `startBattleFromBuild()` which tears down BuildPhase and jumps
  straight to `enterRevealPhase()`. RevealPhase's default-action
  heuristics (cyborgs march, towers fire, etc.) drive every piece.
- `enterPlanningPhase()` is preserved in `Game.ts` but unreachable
  from BUILD. Re-enable when piece-action queuing becomes useful
  (e.g. Hulk slam targeting that requires user input).

## Single-player setup (session 13)
Asset preload -> side-picker modal (ROBOTS or CYBORGS) -> BUILD. The
unpicked side runs on autopilot via `OpponentAI` (`src/ai/OpponentAI.ts`).
AI handles BUILD purchases as a one-shot autobuyer; PLAN actions fall
through to RevealPhase's default-action heuristics.

**Fog of war:** AI-side pieces have `mesh.visible=false` during BUILD/PLAN;
revealed at REVEAL start. Opponent credits are never shown.

**S17 build rule:** AI guarantees 1 of each TYPE first (cyborgs:
cannon, grenadier, doublegun, hulk, sniper, medic; defenders:
sphere, turret, bomber, sentry, wall, dog, repair), then spends
ALL remaining credits on random picks. Previous 55% per-turn cap
is gone since there is no PLAN phase + no second BUILD, so reserving
credits made no sense.

## File-by-file

- `GameConfig.ts` — all constants + per-piece stats. Per-unit fields:
  `cost`, `hp`, `speed`, `damage`, `range`, `sightRange`, `aoeRadius`,
  `apBudget`, `ammo`, `label`, `color`. Structures also have
  `aoeRadius` + `ammo`. Sphere config in `Config.SPHERE` (also has
  `ammo`). Optional `allowDiagonalMove?: boolean` per unit (cast at
  read site since Config is `as const`).
- `Game.ts` — scene, camera, renderer, state machine
  (`'loading' | 'build' | 'planning' | 'reveal' | 'win' | 'lose'`),
  unified `PlacementSession`, grid snap, cross-system `isCellOccupied`
  (covers spheres + cyborgs + dogs + structures + core 2x2 cells),
  defenderUnits + attackerUnits + structures arrays owned here.
  - **Two-canvas render (S22d).** Two stacked canvases share ONE camera:
    `rendererBack`/`sceneBack` (antialiased, devicePixelRatio, NOT
    pixelated) draws the procedural GROUND (floor + zone tints/borders +
    grid) behind a transparent, pixelated `renderer`/`scene` that draws
    sprites + VFX at native 1:1. Thin grid/border lines need smooth
    scaling; pixel sprites need nearest-neighbor — opposite needs, so
    they live on separate canvases. Ground is rendered BEFORE the
    per-frame `snapForRender()` (with the un-snapped camera) so it pans
    smoothly. The back canvas sits at `z-index: -1`; the sprite canvas
    and the floating HUD keep their original stacking. See
    `project_grid_zoom_quality`.
- `TurnTypes.ts` — `QueuedAction` union, `AP_COST` table,
  `STATIONARY_INITIATIVE = 100`, `nextActorId()` factory.
- `PlanningPhase.ts` — selection + queued-action overlays during PLAN.
  Click piece -> select, click cell -> queue Move, Shift+click enemy ->
  queue Fire, right-click -> clear/deselect. Manual planning of both
  sides (no AI plan generator).
- `RevealPhase.ts` — initiative-sorted sequencer. Collects queued
  actions + auto-fire for structures + default fallback actions for
  unplanned mobile units. Steps through at ~600ms per action (80ms
  for `hold` actions) with strict-skip on invalid. Auto-loops via
  `Game.enterRevealPhase` until win/lose (no stalemate, see STATS).
  Auto-loop YIELDS via `setTimeout(0)` between reveals so the browser
  can repaint and the call stack resets. Without this, many reveals
  could chain synchronously in one RAF frame and freeze the tab.
  Streams combat log lines via `onLogEntry` callback so the HUD panel
  updates in step with the visible action. Holds: AmmoBox array,
  medic/repair pads + tethers, pendingGrenades, projectiles, explosions.
  - **Replan at execute time (S17)** — default actions for mobile
    units (`isDefault: true` on PlannedStep) are PLACEHOLDERS pushed
    by `buildSteps()`. `executeStep()` calls
    `defaultMobileUnitAction(actor)` fresh when the unit's turn
    arrives. Critical for slow units (Hulk = lowest initiative):
    without this, their plan was based on the start-of-reveal field
    state where faster cyborgs were still blocking their west cell,
    and they would lock in to N/S sidesteps that were obsolete by
    execute time. Structures keep pre-computed actions since they
    do not move, so plan staleness does not matter.
  - **Per-piece telemetry (S17.4)** — `onPieceEvent` callback fires
    'damage' / 'kill' / 'assist' / 'attack' / 'move' / 'action'
    events. Game accumulates into BattleStats for `/stats.html` analysis.
    `attribute(target, attackerType, side, amount, killed)` helper
    atomically emits damage + kill + assist events using the
    `damageHistory` Map (per-target attacker set).
- `PendingGrenade.ts` — lobbed AoE bomb with two `triggerMode` flavors:
  - `'proximity'` (Bomber): waits for enemies, 3-reveal safety fuse.
  - `'timed'` (Grenadier): cooked grenade, detonates at 1 armed reveal.
  Common: `armed` (true at end-of-throw-reveal), `turnsArmed`,
  `timerTurns` (3 vs 1), `ownerId` (one-per-thrower gate), `side`.
  Detonation AoE is **friendly-fire** (everyone in radius); the
  trigger for proximity is **enemy-only**. Visual: dim grey unarmed,
  hot red armed.
- `AmmoBox.ts` — resupply crate. Spawns every 5 reveals in the middle
  no-build zone. Four kit types (`ammo / grenade / medkit /
  repair_kit`) gated by unit family via `kitForUnit()`. 1 HP, any
  hit destroys. Picked up when a SpriteUnit's logical position lands
  on the cell (refills `ammoRemaining += 2` capped at Config max).
- `HealVfx.ts` — three variants of floating heal feedback:
  - `'number'` (throws): floating +N text.
  - `'plus'` (tethers): sparkle stamps.
  - `'bubble'` (pads): orb swarm with additive blending.
  Optional `scale` parameter for big targets (Power Core uses 1.8).
  Cell-glow square spawns underneath every heal so "the cell is being
  healed" reads even on huge pieces. RAF-driven self-disposal.
- `SpeechBubble.ts` — status callouts above units / structures. Two
  voices (cyborg italic peach / robot mono cyan), three triggers
  (low_hp <=25% / low_ammo count templates / out_of_ammo) + sniper_shot
  + medic_low_packs. Lines use `{n}` (count) and `{s}/{S}` (auto
  pluralizer, empty when n==1). One bubble per (trigger, count) key
  per entity via `spokenSet`. Canvas 320x80 to fit longer monospace
  robot lines. All callouts capped at 20 chars per line (S20).
- `BattleStats.ts` — per-game metrics persisted to localStorage.
  Records outcome / endType / playerSide / turns / alive counts /
  damage dealt / kills / coreHpEnd. Console API installed at boot:
  `astrohold.statsSummary() / dumpStats() / statsJSON() / clearStats()`.
  Capped at 50 records (oldest pruned).
- `BuildPhase.ts` — credit ledger + structure placement. Takes a
  cross-system occupancy callback from Game so structures respect
  spheres / cyborgs / dogs / core cells. Occupancy is derived LIVE
  from `coreCells` (frozen 2x2 core footprint) + `structures` (the
  live array) + `externalOccupied` callback. **Do NOT add a parallel
  occupied Set.** The old one went stale on refund and locked cells
  forever; live derivation has no sync to break.
- `PixelPowerCore.ts` — gameplay core. 2x2 footprint via
  `cellCenters()`. 8 rotation PNGs + 9-frame death explosion.
- `SphereDefender.ts` — defender hero. 8 rotation PNGs + 4-frame death
  explosion. Mobile in S18 (speed 110).
- `SpriteUnit.ts` — every mobile unit (cyborgs + Combat Dog + Hulk +
  Sentry walking frames). Configurable `side` param
  ('attacker' | 'defender'). Per-state per-direction animation frames
  with horizontal-mirror fallback. `playAttackAnim()` triggers
  shoot/throw state before projectile spawn. `SPRITE_TINT` table
  is `{}` today (per-type tints removed at user request).
- `Structure.ts` — tower / bomber / wall / mine / cannon / sentry /
  preview pieces. Pixel sprite layout with per-type folder, size,
  default direction, and explosion. `getGrenadeTexture()` exposes
  the shared Space_Grenade sprite for the Bomber's projectile. Has
  `fireFacings: number[]` (math-angle array; default `[0]` = east);
  RevealPhase only auto-fires at targets within the per-facing
  cardinal-lane gate.
- `Projectile.ts` — sphere mesh by default, optional `spriteTexture`
  parameter turns it into a spinning `THREE.Sprite` (Bomber's grenade).
- `HUD.ts` — DOM overlay. Shops split into `#top-robot-shop` (top-left)
  and `#top-cyborg-shop` (top-right). Bottom bar hosts just the
  READY/BATTLE button. `setCredits`/`setAttCredits` toggle a
  `.insufficient` class on unaffordable buttons (greyed out +
  not-allowed cursor). See `HUD.md` for the panel composition rules.
- `MiniControlCenter.ts` — floating bottom-right speed/toggle dial.
  See `HUD.md`.
- `audio/sfx.ts` + audio pools — full sample-based audio (S19) with
  synth fallback. Lazy AudioContext, rate-limited. See
  `project_audio_architecture` memory.
- `BattlePhase.ts` + `AIPlayer.ts` — **retired.** Files remain on disk
  for reference but are not imported. RevealPhase replaced the tick loop.
- HMR dispose is wired in `main.ts` + `Game.ts`. Do not remove it.

## Placement flow (grid)
Single source of truth: `Game.placement` (PlacementSession). The ghost
ring is the position authority. Never re-raycast at click time.
1. **HUD button -> start session.** `startSpherePlacement` or
   `startCyborgPlacement` call `endPlacement()` first (so the prior
   ghost ring is destroyed), then create a new ghost mesh and set
   `this.placement`.
2. **`onMouseMove` -> snap.** `snapToGridCell(cursor.x, cursor.y,
   zoneXMin, zoneXMax)` returns the cell center + a `valid` flag.
   Ghost jumps to that cell center; hidden if outside the zone.
3. **`onMouseDown` -> place.** Reads `placement.ghost.position`, runs
   `placement.onPlace(x, y)`. The callback checks `isCellOccupied(x, y)`
   and returns false to reject (one piece per cell).

## Battle movement (RevealPhase)
- One cell per turn (Move action = 1 AP).
- **Cardinal-only by default** (N/S/E/W). A unit with
  `Config.UNITS[type].allowDiagonalMove = true` opts into 8 directions
  (reserved for special characters).
- `RevealPhase.pickStepTowardPoint` picks the adjacent cell that
  reduces distance to the target AND has the lowest combined danger
  score: `distance + 2 * armedEnemyBombDamageInCell`. Units sidestep
  primed bomb AoE rather than walking in. Defender mobile units add
  a 40-point detour penalty per adjacent live defender when outside
  base (S20 anti-cluster rule).
- **Default action when no queued plan** (`defaultMobileUnitAction`):
  - Grenadier: if armed enemy bomb within 1.5 cells -> DIFFUSE it
    (1 AP, bomb vanishes with a puff, no damage).
  - Lobbed thrower (Bomber/Grenadier): throw a proximity bomb at the
    best empty cell near the nearest enemy (one bomb per thrower on
    the field at a time; ammo-gated).
  - Direct-fire piece with armed enemy bomb in range AND outside its
    AoE: SHOOT the bomb (detonates harmlessly to us).
  - Else fire at nearest enemy in attack range (ammo-gated).
  - Else move toward nearest enemy in sight.
  - **Fallback** if nothing's in sight: cyborgs march toward the core
    anyway; defender mobile units (dogs) wander to a random adjacent
    cell.
- `isCellOccupiedAtBattle` checks BOTH current and `prevWorldX/Y`
  cells for any walking unit so two pieces never visually share a
  tile during transit.

## Ammo + counterplay
- Every offensive piece has an `ammo` budget in Config (total
  shots/throws for the entire game, NOT per turn). Once 0, the piece
  is inert (still alive, still blocks cells, just cannot attack).
  See `STATS.md` for current numbers per piece.
- `RevealPhase.decrementActorAmmo` runs after every fired/thrown
  action. `actor.ammoRemaining` lives on SpriteUnit / SphereDefender /
  Structure.
- Bombs are proximity traps with a 1-turn arming delay and a 3-turn
  armed-lifetime failsafe (see `PendingGrenade.ts`). Counterplay:
  - **Flee:** pickStepTowardPoint penalizes armed-bomb cells.
  - **Shoot:** direct-fire pieces detonate bombs from outside their AoE.
  - **Diffuse:** Grenadier-only safe-remove at melee range.
- `TargetRef.kind = 'bomb'` lets the targeting system reference a
  PendingGrenade by its id.
- **Universal melee fallback.** When a SpriteUnit hits
  `ammoRemaining=0` AND an enemy is within ~1.4 cells, swings for
  `MELEE_FALLBACK_DAMAGE` (10) at no ammo cost. Excludes hulk
  (already unlimited), sniper (retreats), medic + repair (retreat).
- **Ammo crates (cyborgs only).** Resupply boxes drop in the middle
  no-build zone every 5 reveals (cap 4). Robots restore via the
  Power Core dock instead. See `AmmoBox.ts`.
