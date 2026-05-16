# AstroHold — Project Rules for Claude

## Status: chess-like turn-based grid strategy (session 8-9 pivot)
The game is **NOT an RTS** and **not real-time**. It's a chess-style turn-based
strategy on a visible grid. Defenders (Robots, blue) place pieces in their
zone; attackers (Cyborgs, red) place pieces in theirs; battle alternates sides
turn-by-turn. **One piece per cell, strict.** Long-term plan and current
balance numbers live in `docs/STATS.md` — that's the source of truth for
stats, behaviors, and open design questions. Update STATS.md whenever stats
or behaviors change.

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
- Source PNG zips and other archives go in `/_zips/`.
- GLBs are not used for gameplay; `super.glb`, `textured.glb`, `plain.glb`
  remain under `/public/models/powercore/` only as future repurposable assets
  (textured is earmarked as a defense-tower visual).

## Key constants
- World: x [-600, +600], y [-200, +200] = 1200 × 400 world units
- Grid cell: **50 × 50** world units → 24 cols × 8 rows = **192 cells**
- Defender zone: x < -200 (8 cols) — Robots place here
- Attacker zone: x > 200 (8 cols) — Cyborgs spawn / place here
- Battlefield: middle 8 cols, no placements
- Power Core at (-550, 0). Pixel sprite, 200 world units tall.
- Start credits: 1000 (testing budget; STATS.md lists production target)

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
  In top-down view, the cell center IS the piece's screen position. Old
  feet-anchoring (`y = 0.35 × size`) is wrong for grid placement.
- HP bar group above sprite, billboarded each frame via
  `hpBarGroup.quaternion.copy(camera.quaternion)`.

## Architecture
- `GameConfig.ts` — all constants and per-unit stats. Tweak numbers here
  first; per-unit fields include `cost`, `hp`, `speed`, `damage`, `range`,
  **`sightRange`** (new), `aoeRadius`, `label`, `color`.
- `Game.ts` — scene, camera, renderer, state machine, unified
  `PlacementSession`, grid snap (`snapToGridCell`), one-piece-per-cell
  enforcement (`isCellOccupied`).
- `BuildPhase.ts` — credit ledger; structures placement code (no shop UI yet).
- `BattlePhase.ts` — current real-time-ish combat: units act in a tick,
  defenders react. **Full turn system not yet implemented.** Contains:
  `anyTargetInSight`, `wanderUnit`, `advanceToward`, `isCellOccupiedInBattle`,
  `applyCoreBlast`.
- `PixelPowerCore.ts` — gameplay core. 8 rotation PNGs + 9-frame explosion.
- `SphereDefender.ts` — defender hero. 8 rotation PNGs cycled on a spin
  timer (45 world-units across).
- `SpriteUnit.ts` — every attacker. Per-state per-direction animation frames
  with horizontal-mirror fallback for missing directions; `playAttackAnim()`
  is called from BattlePhase before each projectile spawn.
- `HUD.ts` — DOM overlay only, no Three.js. Exposes onBuySphere /
  onSpawnUnit / onBattle / onSelectStructure callbacks.
- `audio/sfx.ts` — synthesized gunshot + explosion. Lazy AudioContext,
  rate-limited (35ms / 60ms). No sample files.
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

## Battle movement
- One cell per turn for every unit (speed stat ignored for now — AP system
  will tier this).
- `BattlePhase.advanceToward` picks the adjacent cell (of 8) closest to the
  target that's not blocked by `isCellOccupiedInBattle`.
- **CAMP vs ENGAGED:** before moving, `anyTargetInSight(unit)` checks
  distance to spheres / structures / core against
  `Config.UNITS[type].sightRange`. If nothing is in sight, 50% chance to
  call `wanderUnit()` instead of advancing. If anything's in sight, always
  advance every turn.

## Sound
- `playGunshot()` after every non-AoE projectile spawn (cyborg attacks,
  sphere shots, turret shots).
- `playExplosion()` on AoE projectile impacts (grenadier, cannon turret,
  mines), and on Power Core death.
- Both are throttled to avoid stacking dozens per turn.

## Deployment
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
