# AstroHold — Project Rules for Claude

## Status: cinematic plan-then-play turn engine LIVE (session 10)
Chess-like turn-based grid strategy. The full **plan-then-play** turn engine
shipped this session — both sides queue all actions during a Planning phase,
clicking BATTLE animates them one piece-action at a time sorted by Initiative
(descending). After the first BATTLE click, reveals **auto-chain** until
win/lose — the player just watches. "We are now watching the space battle take
place" is the locked model.

**One piece per cell, strict.** Large pieces (Power Core today) use a 2x2
footprint per the size rule. Long-term plan and current balance numbers live
in `docs/STATS.md` — source of truth for stats, behaviors, and open design
questions. Update STATS.md whenever stats or behaviors change.

## Stack
- Package manager: pnpm
- Bundler: Vite 8 (Rolldown inside)
- Renderer: Three.js r184 (sprite-first now — no GLBs loaded for gameplay)
- Language: TypeScript 6 (strict)
- Linting: Biome (when added)

Framework decision (session 9): stay on Vite + Three.js. Phaser 4 was
evaluated and rejected — Three.js renders sprites perfectly well; migration
cost was unwarranted.

## File conventions
- Static assets in `/public/`. Loaded via absolute paths.
- Pixel sprite layout:
  `/public/sprites/<entity>/<dir>.png` (8 directional static rotations)
  `/public/sprites/<entity>/<state>/<dir>/frame_NNN.png` (animation frames)
  `/public/sprites/<entity>/explosion/frame_NNN.png` (flat death sequence
  — Structure loader expects this layout, no direction subfolders)
- Source PNG zips go in `/_zips/`.
- Projectile-style single sprites (e.g. `grenade.png`) live at
  `/public/sprites/<name>.png` and are loaded once into a shared cache.
- GLBs are not loaded at runtime. The old `super.glb` etc. were removed
  this session.

## Key constants
- World: x [-600, +600], y [-200, +200] = 1200 × 400 world units
- Grid cell: **50 × 50** world units → 24 cols × 8 rows = **192 cells**
- Defender zone: x < -200 (8 cols) — Robots place here
- Attacker zone: x > 200 (8 cols) — Cyborgs spawn / place here
- Battlefield: middle 8 cols, no placements
- Power Core at (-550, 0) — **2x2 footprint** (size rule), sprite size
  `GRID_CELL * 3` = 150 world units. Centroid sits on a grid intersection,
  4 underlying cells reserved.
- Start credits: 1000 (testing budget)
- **All piece costs in multiples of 10** so leftover credits remain
  spendable by the cheapest piece (Wall 20cr / Grenadier 50cr).
- `STATIONARY_INITIATIVE = 100` (from `TurnTypes.ts`). Defender structures
  fire BEFORE any cyborg each turn.

## Camera
- **Top-down** orthographic at (0, 0, 500) looking at origin. Grid cells
  project as true on-screen squares.
- Earlier 45° tilt was retired in session 9 — it foreshortened Y and made
  cells render as wide rectangles. Top-down also avoids 3D self-occlusion
  problems for any Meshy export (the spike-occlusion bug that motivated the
  retire-the-GLB-core decision).

## Visual stack — pixel sprites only (combatants)
Every combatant is a `THREE.Sprite` billboard. Sprites face the camera
identically at any angle, so the camera change in session 9 didn't require
asset changes. Required `SpriteMaterial` flags:
- `transparent: true`
- `depthTest: false` — billboards share one depth per quad, so depth-test
  failures cull all four corners at once. With `false` they never get
  occluded by the ground / fence / other sprites.
- `depthWrite: false` — and don't poison the buffer for later draws.
- `alphaTest: 0.1` — clean pixel-art edges.
- `renderOrder: 10` — sequence after ground / grid / fence.

### Direction picker bug to remember
`SpriteUnit.updateDirectionSprite()` uses
`((facingAngle / (π/4)) + 16) % 8`. The `+ 16` must be an **integer multiple
of 8** for the modulo to preserve bucket values. A previous `+ TAU * 8`
(= 16π ≈ 50.27) silently rotated every direction (west → south). See
session 8 in DEVNOTES.

### Sprite anchoring (top-down)
- `sprite.position.set(0, 0, 5)` — centered on the piece's `mesh.position`.
  In top-down view, the cell center IS the piece's screen position.
- **HP bars are hidden globally** (`hpBarGroup.visible = false` set in each
  piece's constructor). The bar meshes still exist + `takeDamage` still
  updates them, so re-enabling for a future tactical-pause mode is a
  one-line flip per class.
- Wall is the lone exception: no HP bar, the wall body itself shrinks
  from the top as it takes damage (structural feedback, not an overlay).

### Default facing
- Cyborgs (attacker) spawn facing **west** (toward the core).
- Defender mobile units (Combat Dog) spawn facing **east** (toward
  incoming cyborgs).
- Structure default facing comes from `STRUCTURE_DEFAULT_DIR` in
  `Structure.ts` — Tower + Bomber use `east.png` (planned mechanic: pay
  per added direction). Preview pieces stay south since they only have
  a single south.png.

## Architecture
- `GameConfig.ts` — all constants + per-piece stats. Per-unit fields:
  `cost`, `hp`, `speed`, `damage`, `range`, `sightRange`, `aoeRadius`,
  `apBudget`, `label`, `color`. Structures also have `aoeRadius`.
  Sphere config in `Config.SPHERE`.
- `Game.ts` — scene, camera, renderer, state machine
  (`'loading' | 'build' | 'planning' | 'reveal' | 'win' | 'lose'`),
  unified `PlacementSession`, grid snap, cross-system `isCellOccupied`
  (covers spheres + cyborgs + dogs + structures + core 2x2 cells),
  defenderUnits + attackerUnits + structures arrays owned here.
- `TurnTypes.ts` — `QueuedAction` union, `AP_COST` table,
  `STATIONARY_INITIATIVE = 100`, `nextActorId()` factory.
- `PlanningPhase.ts` — selection + queued-action overlays during PLAN.
  Click piece → select, click cell → queue Move, Shift+click enemy →
  queue Fire, right-click → clear/deselect. Manual planning of both
  sides (no AI plan generator).
- `RevealPhase.ts` — initiative-sorted sequencer. Collects queued
  actions + auto-fire for structures + default fallback actions for
  unplanned mobile units. Steps through at ~600ms per action with
  strict-skip on invalid. Auto-loops via `Game.enterRevealPhase` until
  win/lose (or stalemate). Exposes `totalSteps` so Game can detect
  zero-action reveals and halt the loop.
- `BuildPhase.ts` — credit ledger + structure placement. Takes a
  cross-system occupancy callback from Game so structures respect
  spheres / cyborgs / dogs / core cells.
- `PixelPowerCore.ts` — gameplay core. 2x2 footprint via
  `cellCenters()`. 8 rotation PNGs + 9-frame death explosion.
- `SphereDefender.ts` — defender hero. 8 rotation PNGs + 4-frame death
  explosion. Stationary.
- `SpriteUnit.ts` — every mobile unit (cyborgs + Combat Dog).
  Configurable `side` param ('attacker' | 'defender'). Per-state
  per-direction animation frames with horizontal-mirror fallback.
  `playAttackAnim()` triggers shoot/throw state before projectile spawn.
- `Structure.ts` — tower / bomber / wall / mine / cannon / preview
  pieces. Pixel sprite layout with per-type folder, size, default
  direction, and explosion. `getGrenadeTexture()` exposes the shared
  Space_Grenade sprite for the Bomber's projectile.
- `Projectile.ts` — sphere mesh by default, optional `spriteTexture`
  parameter turns it into a spinning `THREE.Sprite` (Bomber's grenade).
- `HUD.ts` — DOM overlay. Shops split into `#top-robot-shop` (top-left)
  and `#top-cyborg-shop` (top-right) so they never collide. Bottom bar
  hosts just the READY/BATTLE button. `setCredits`/`setAttCredits`
  toggle a `.insufficient` class on unaffordable buttons (greyed out +
  not-allowed cursor).
- `audio/sfx.ts` — synthesized gunshot + explosion. Lazy AudioContext,
  rate-limited (35ms / 60ms). No sample files.
- `BattlePhase.ts` + `AIPlayer.ts` — **retired** this session. Files
  remain on disk for reference but aren't imported. RevealPhase replaced
  the tick loop.
- HMR dispose is wired in `main.ts` + `Game.ts` — do not remove it.

## Placement flow (grid)
Single source of truth: `Game.placement` (PlacementSession). The ghost ring
is the position authority — never re-raycast at click time.
1. **HUD button → start session.** `startSpherePlacement` or
   `startCyborgPlacement` call `endPlacement()` first (so the prior ghost
   ring is destroyed), then create a new ghost mesh and set
   `this.placement`.
2. **`onMouseMove` → snap.** `snapToGridCell(cursor.x, cursor.y, zoneXMin,
   zoneXMax)` returns the cell center + a `valid` flag. Ghost jumps to that
   cell center; hidden if outside the zone.
3. **`onMouseDown` → place.** Reads `placement.ghost.position`, runs
   `placement.onPlace(x, y)`. The callback checks `isCellOccupied(x, y)`
   and returns false to reject (one piece per cell).

## Battle movement (RevealPhase)
- One cell per turn (Move action = 1 AP).
- `RevealPhase.pickStepTowardPoint` picks the adjacent cell (of 8)
  closest to the target that's not blocked by `isCellOccupiedAtBattle`
  AND reduces distance to the target.
- **Default action when no queued plan** (`defaultMobileUnitAction`):
  - Fire if any enemy in attack range (range > 0).
  - Else move toward nearest enemy in sight.
  - **Fallback** if nothing's in sight: cyborgs march toward the core
    anyway; defender mobile units (dogs) wander to a random adjacent cell
    (per user spec — "robots wander when no target").
- `isCellOccupiedAtBattle` checks BOTH current and `prevWorldX/Y` cells
  for any walking unit so two pieces never visually share a tile during
  transit.

## Sound
- `playGunshot()` after every non-AoE projectile spawn (cyborg attacks,
  sphere shots, turret shots).
- `playExplosion()` on AoE projectile impacts (grenadier, cannon turret,
  mines), and on Power Core death.
- Both are throttled to avoid stacking dozens per turn.

## Deployment
- **We do NOT use the local dev server.** The user tests on the live
  Vercel URL. Never run `pnpm dev` / `vite` as a verification step.
- After any code change: commit → `git push origin main` → `vercel --prod`.
- Always deploy with `vercel --prod` — `vercel` alone creates a preview URL
  the user never sees.
- Production URL: https://astrohold3.vercel.app

## Rules
- Don't hardcode rules or patterns that don't match the actual build —
  verify before committing.
- Prefer pragmatic / working over theoretically correct.
- Numbers (stats / behaviors / costs) live in `Config` and `docs/STATS.md`.
  Update both together when tuning.
- No test files yet — add Vitest only when there's logic worth testing.
- `vite-plugin-gltf` installed but inactive (no GLBs are loaded at runtime).
