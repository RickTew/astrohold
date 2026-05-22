# AstroHold — Project Rules for Claude

## Status: Single-player D&D-style strategy LIVE (session 14)
Chess-like turn-based grid strategy. **BUILD → REVEAL** is the live flow
(PLAN phase code exists but is currently skipped — see Phase flow section).
After the first BATTLE click, reveals **auto-chain** until win / lose /
stalemate — the player just watches. **NOT an RTS.** Mechanics tuned for
D&D-style strategy:
- **Single-player mode (session 13).** Asset preload → side-picker modal
  (ROBOTS or CYBORGS) → BUILD. The unpicked side runs on autopilot via
  `OpponentAI` (`src/ai/OpponentAI.ts`). AI handles BUILD purchases as a
  one-shot autobuyer; PLAN actions fall through to RevealPhase's
  default-action heuristics. **Fog of war:** AI-side pieces have
  `mesh.visible=false` during BUILD/PLAN; revealed at REVEAL start.
  Opponent credits are never shown.
- **Limited per-game ammo** on every offensive piece. Once spent, it's inert.
- **Cardinal-only movement** (N/S/E/W) by default. Special characters opt in
  to diagonals via `Config.UNITS[type].allowDiagonalMove = true`.
- **Reactive AI** — units flee armed bomb AoEs, prefer shooting bombs from
  outside the radius, grenadiers diffuse adjacent enemy bombs.
- **Bomb counterplay always exists** — flee, shoot, or diffuse.
- **Mouse-only UI — ZERO keyboard commands.** No Shift/Ctrl/Alt
  modifiers, no hotkeys. Every action must be reachable with the
  cursor alone (right-click, double-click, hover, HUD buttons).
- **Combat history log** streams every reveal action to a right-rail
  panel during BATTLE (D&D-style turn log; side-coloured rows).
- **Compass-rose UI** — right-click a placed firing structure during
  BUILD to buy extra fire-arc directions (30cr per added cardinal).
- **Fire-arc preview** appears under the placement ghost so the player
  can see what a tower will and won't cover before committing.
- **Hulk slam special action** (2 AP, 3-cell wedge in facing dir).
- **Cyborg Sniper** — single-shot, 400-range, 150 dmg precision strike.
- **Cyborg Medic** — support unit, three heal modes sharing a 5-charge pool:
  med-pack throw (1 charge, 3-cell range, +30 HP), deployable medic-pad
  (2 charges, +15 HP/tick to adjacent cyborgs for 4 ticks), tether (1
  charge/turn, pins both endpoints, +20 HP/turn). Only mobile unit with
  `allowDiagonalMove: true`. Fragile (HP 50). See `MedicPad.ts`,
  `Tether.ts`, and `RevealPhase.medicDefaultAction()`.

## HUD (session 14)
Floating top strip with three SVG-silhouetted panels — DO NOT reserve
canvas space for it (canvas is full window; HUD floats on top with
`rgba(8,18,32,0.58)` panel fill so the map shows through). To stop the
world top row from rendering BEHIND the HUD, `Game.computeCameraYOffset()`
reads `--hud-top-h` and shifts `camera.position.y` so world top aligns
with HUD bottom. Resize re-applies via the delta to preserve user pan.
- LEFT panel — 4×2 robot tile grid (8 unique pieces): Sphere/Tower/Bomber/Wall
  over Dog/Defense/Laser/Signal. Defense/Laser/Signal are "preview"
  pieces with placeholder behavior (no unique mechanics yet).
- CENTER panel — clean chamfered rectangle SVG with two internal dividers
  splitting it into three console "screens":
  * **Title bar** (`.cc-title`): BUILD PHASE / PLAN PHASE / BATTLE label
    in Orbitron, flanked by corner-bracket glyphs.
  * **Body** (`.cc-body`): CR chip (Orbitron number, green glow), matchup
    line ("ROBOTS VS CYBORGS"), single-line system status from
    `HUD.logSystemMessage`.
  * **Action bar** (`.cc-action`): primary action button (READY/BATTLE).
    Color follows role (.role-defender = blue, .role-attacker = red);
    `:active` translates 2px to feel mechanical.
- RIGHT panel — duplicate of LEFT, both clickable.
- Cyborg variant `#hud-top-att` has 4×2 attacker grid (5 unique
  cyborgs + 3 duplicates until new art exists). `setPlayerSide` toggles
  which strip variant renders; `.ai-side` hides the inactive one.
- Panel silhouettes are inline SVG with `vector-effect="non-scaling-
  stroke"` so chamfered corners stay crisp at any width. CSS clip-path
  was tried and abandoned — produces aliased corners against borders.
- Side-picker modal (`#side-picker`) is its own thing — full-screen
  before BUILD. **2 cards**: DEFENDER (Robots) and ATTACKER (Cyborgs).
  Card color follows ROLE — defender=blue, attacker=red. AI gets the
  opposite role + opposite faction. Layout uses `clamp()` everywhere
  (no fixed px) and the safe-centering pattern (outer `overflow: auto`
  + inner `min-height: 100% + flex center`). "How to play" expander
  below the cards. Phase × Faction expansion (4 cards / same-faction
  matchups) is RETIRED for now; `Faction` and `Role` types still in
  GameConfig in case it comes back. **Do not redesign without
  explicit user direction.**

## Phase flow (session 14)
- `loading → pick-side → build → reveal → win/lose`
- **PLAN phase is currently skipped.** BUILD's READY button calls
  `startBattleFromBuild()` which tears down BuildPhase and jumps
  straight to `enterRevealPhase()`. RevealPhase's default-action
  heuristics (cyborgs march, towers fire, etc.) drive every piece.
- `enterPlanningPhase()` is preserved in `Game.ts` but unreachable
  from BUILD. Re-enable when piece-action queuing becomes useful
  (e.g., Hulk slam targeting that requires user input).

## Color conventions (session 14)
- **Defender = blue, Attacker = red** — applied consistently across
  HUD theming, side picker cards, action button, matchup line.
- **Player vs AI team tinting is OFF.** `TEAM_TINT` in `GameConfig.ts`
  is `{ player: 0xffffff, ai: 0xffffff }` (no-op). Was confusing when
  multiplied with per-type tints. Position (left zone = your side)
  signals ownership. Re-enable for same-faction matchups if those
  return.
- **Per-type sprite tints removed.** `SPRITE_TINT` in `SpriteUnit.ts`
  is `{}`. Pieces render with their natural sprite-art colors. Used
  to wash Grenadier green / Doublegun orange / Sniper olive — removed
  at user request.
- **NO em dashes (`—`) in user-visible text.** Use regular dashes,
  periods, or rewording. Internal docs/comments fine.

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
  `apBudget`, `ammo`, `label`, `color`. Structures also have
  `aoeRadius` + `ammo`. Sphere config in `Config.SPHERE` (also has
  `ammo`). Optional `allowDiagonalMove?: boolean` per unit (cast at
  read site since Config is `as const`).
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
  win/lose/stalemate. Exposes `totalSteps` (for zero-action stalemate)
  and `combatThisReveal` (for "no combat for N turns" stalemate — Game
  halts after 5 no-combat reveals so the dog can't wander forever).
- `PendingGrenade.ts` — proximity-trap bomb. Lobbed AoE units (Bomber,
  Grenadier) spawn one when their thrown projectile lands. Has
  `armed` (false on land, true at end-of-reveal — gives opponents
  a planning turn), `turnsArmed` (auto-detonate at 3 to stop ignored
  traps), `ownerId` (one-per-thrower gate), `side` (proximity check
  only triggers on enemies). Visual: dim grey @ 55% opacity when
  unarmed, hot red @ 100% when armed.
- `BuildPhase.ts` — credit ledger + structure placement. Takes a
  cross-system occupancy callback from Game so structures respect
  spheres / cyborgs / dogs / core cells. Occupancy is derived LIVE
  from `coreCells` (frozen 2x2 core footprint) + `structures` (the
  live array) + `externalOccupied` callback. **Do NOT add a parallel
  occupied Set** — the old one went stale on refund and locked cells
  forever; live derivation has no sync to break.
- `PixelPowerCore.ts` — gameplay core. 2x2 footprint via
  `cellCenters()`. 8 rotation PNGs + 9-frame death explosion.
- `SphereDefender.ts` — defender hero. 8 rotation PNGs + 4-frame death
  explosion. Stationary.
- `SpriteUnit.ts` — every mobile unit (cyborgs + Combat Dog + Hulk).
  Configurable `side` param ('attacker' | 'defender'). Per-state
  per-direction animation frames with horizontal-mirror fallback.
  `playAttackAnim()` triggers shoot/throw state before projectile spawn.
  `SPRITE_TINT` table colours specific cyborg types (Grenadier green,
  Doublegun warm orange) so roles read at a glance.
- `Structure.ts` — tower / bomber / wall / mine / cannon / preview
  pieces. Pixel sprite layout with per-type folder, size, default
  direction, and explosion. `getGrenadeTexture()` exposes the shared
  Space_Grenade sprite for the Bomber's projectile. Has
  `fireFacings: number[]` (math-angle array; default `[0]` = east);
  RevealPhase only auto-fires at targets within ±60° of any facing.
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
- **Cardinal-only by default** (N/S/E/W). A unit with
  `Config.UNITS[type].allowDiagonalMove = true` opts into 8 directions
  — reserved for special characters (e.g. Hulk in a future pass).
- `RevealPhase.pickStepTowardPoint` picks the adjacent cell that
  reduces distance to the target AND has the lowest combined danger
  score: `distance + 2 × armedEnemyBombDamageInCell`. Units sidestep
  primed bomb AoE rather than walking in.
- **Default action when no queued plan** (`defaultMobileUnitAction`):
  - Grenadier: if armed enemy bomb within 1.5 cells → DIFFUSE it
    (1 AP, bomb vanishes with a puff, no damage).
  - Lobbed thrower (Bomber/Grenadier): throw a proximity bomb at the
    best empty cell near the nearest enemy (one bomb per thrower on
    the field at a time; ammo-gated).
  - Direct-fire piece with armed enemy bomb in range AND outside its
    AoE: SHOOT the bomb (detonates harmlessly to us).
  - Else fire at nearest enemy in attack range (ammo-gated).
  - Else move toward nearest enemy in sight.
  - **Fallback** if nothing's in sight: cyborgs march toward the core
    anyway; defender mobile units (dogs) wander to a random adjacent cell.
- `isCellOccupiedAtBattle` checks BOTH current and `prevWorldX/Y` cells
  for any walking unit so two pieces never visually share a tile during
  transit.

## Ammo + counterplay (D&D-style strategy)
- Every offensive piece has an `ammo` budget in Config — total shots /
  throws for the entire game (NOT per turn). Once 0, the piece is
  inert (still alive, still blocks cells, just can't attack). Forces
  shot-allocation decisions. See STATS.md for current numbers.
- `RevealPhase.decrementActorAmmo` runs after every fired/thrown
  action. `actor.ammoRemaining` lives on SpriteUnit / SphereDefender /
  Structure.
- Bombs are proximity traps with a 1-turn arming delay and a 3-turn
  armed-lifetime failsafe (see PendingGrenade.ts). Counterplay:
  - **Flee:** pickStepTowardPoint penalizes armed-bomb cells.
  - **Shoot:** direct-fire pieces detonate bombs from outside their AoE.
  - **Diffuse:** Grenadier-only safe-remove at melee range.
- `TargetRef.kind = 'bomb'` lets the targeting system reference a
  PendingGrenade by its id.

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
