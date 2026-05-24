# AstroHold — Project Rules for Claude

## Status: Single-player D&D-style strategy LIVE (session 16)
Turn-based grid strategy. **BUILD → REVEAL** is the live flow (PLAN code
exists but is skipped — see Phase flow). After the first BATTLE click,
reveals **auto-chain** until win / lose. **NO stalemate rule** — the
game is die-or-survive (`feedback_die_or_survive`). Two terminal states
only: `core.isDead` (defender loses) or all-cyborgs-dead (defender wins).
Cyborgs who run out of ammo + can't damage the core trigger an attrition
win for defender via `cyborgsCanAttack()` in onComplete.

Mechanics tuned for D&D-style strategy:
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
  charge/turn, pins both endpoints, +20 HP/turn). Fragile (HP 50). See
  `MedicPad.ts`, `Tether.ts`, and `RevealPhase.medicDefaultAction()`.
- **Robot Repair** — defender-side support unit, **two modes only**:
  repair-pad (2 charges, +15/tick to adjacent defender pieces) and
  weld-tether (1 charge/turn, +20/turn, pins both endpoints). No throw —
  the PixelLab export ships a Repair animation but no throw clip, so we
  dropped that mode rather than render a static frame for it. Both actions
  trigger the welding pose (`playRepairAnim()`, a new `repair` AnimState).
  Repair targets anything defender-side with HP: structures, defender
  mobile units (dog), sphere, Power Core. AI tether priority: Power Core
  > Cannon ≈ Bomber ≈ Gunwall > Sphere > Tower > Laser > Gun > Wall > Mine
  (see `structureRepairPriority` in RevealPhase). Diagonal movement
  allowed. HP 60, cost 70. See `RepairPad.ts`, `RepairTether.ts`,
  `RevealPhase.repairDefaultAction()`. **HUD note:** REPAIR replaced the
  SIGNAL preview tile in the robot grid (bottom-right of the 4×2 layout).
- **Sentry (Robot_Wall art)** — defender structure. Tracked-vehicle turret
  with gun arms — reads as a heavy tower, NOT a wall (renamed from gunwall
  for clarity). **HP 150** (nerfed from 200 — repair-bot healing made it
  effectively unkillable), damage 25, range 200 (vs tower 250), cost 60,
  ammo 5. Sprite size 84 (matches Hulk). **Omni-fire** — sprite auto-rotates
  to face current target via `setSingleFacing` on each shot
  (`STRUCTURE_OMNI_FIRE` table in RevealPhase). The compass-rose UI for
  sentry is single-direction-picker (initial facing only); during combat
  it tracks targets freely.
- **Wall** — defender structure (procedural laser-wall, no sprite). Two
  metallic emitter plates at top + bottom of the cell with a pulsing cyan
  energy beam between them. The original brown-box wall visual was replaced
  in session 16; mechanics unchanged (HP 300, 0 damage, blocks one cell).
  Beam dims + thins with damage; sockets pulse out of phase with the beam
  via `Structure.update()` running every frame regardless of dying state.
  HUD icon is a CSS-gradient mini-version of the in-game visual (no SVG,
  no PNG). Wall is now buyable via the robot HUD (replaced DEFENSE preview).
  Auto-orients horizontal/vertical based on neighbors at placement time
  (right-click toggles individual).
- **Bombs vs Grenades** (`project_grenadier_vs_bomber` memory). Two
  pieces, two mechanics on the same `PendingGrenade` class via the
  `triggerMode` field:
  - **Bomber** (cyborg unit AND defender structure) → `'proximity'`
    mines, 3-reveal safety fuse. Bomber-side targeting STRICT: zero
    allies in AoE + bomber must be outside its own bomb's blast.
  - **Grenadier** (cyborg) → `'timed'` cooked grenades, detonate at
    exactly 1 armed reveal after landing. Friendly-fire OK on
    grenadier throws per user; targeting requires net positive
    (enemies > allies).
  Detonation: **enemy-only trigger** (allies walking past idle bombs
  don't set them off), but the AoE on detonation hits **everyone** in
  radius regardless of side.
- **Hulk core-march.** Single decision tree: slam wedge (if 2+ enemies
  cluster) → punch (melee 70 range, **unlimited fists** — no ammo cost)
  → otherwise march straight at the Power Core. Doesn't get distracted
  by sighted enemies; the core is the only goal.
- **Sniper crouch-and-anchor.** Walk into range → spend one turn
  CROUCHING (no fire; `aim` AnimState shows `crouches_and_prepares`
  final frame for E/W) → fire on the next turn. **Rule (session 17):
  can NOT crouch and shoot the same turn — must spend a turn settling
  in first.** Stays crouched after firing so consecutive shots from
  the same spot don't re-pay the settle cost; movement breaks the
  crouch (`SpriteUnit.moveTo` clears the flag). On ammo=0: detour to
  compatible ammo crate if sighted, else retreat east;
  `standUpFromAim()` swaps to upright static rotation at the retreat
  edge ("rifle empty"). AI build enforces 3-cell sniper spacing.
- **Universal melee fallback.** When a SpriteUnit hits `ammoRemaining=0`
  AND an enemy is within ~1.4 cells, swings for `MELEE_FALLBACK_DAMAGE`
  (10) at no ammo cost. Excludes hulk (already unlimited at 55), sniper
  (retreats), medic + repair (retreat). Keeps combat moving when both
  sides are dry.
- **Ammo crates.** Resupply boxes drop in the middle no-build zone every
  5 reveals (cap 4). Four kit types gated by unit family:
  ammo / grenade / medkit / repair_kit. AI: every out-of-ammo unit prefers
  detouring to a compatible crate over retreat/wander. Crates are
  destructible (1 HP) — grenades destroy them, defender structures with
  no cyborg target fire on crates to deny enemy reloads. See `AmmoBox.ts`.

## HUD (session 15)
Floating top strip with three SVG-silhouetted panels — DO NOT reserve
canvas space for it (canvas is full window; HUD floats on top with
`rgba(8,18,32,0.58)` panel fill so the map shows through). To stop the
world top row from rendering BEHIND the HUD, `Game.computeCameraYOffset()`
reads `--hud-top-h` and shifts `camera.position.y` so world top aligns
with HUD bottom. Resize re-applies via the delta to preserve user pan.

Tile grid sizing (session 15): `.tile-grid` uses
`grid-template-columns/-rows: repeat(N, auto)` + `justify-content: center`
+ `align-content: center` so each `.hud-tile` is content-sized (icon +
label + cost) and the cluster sits centered with breathing room on all
four sides of the cyan panel border. Unit icons remain at
`clamp(46px, 7vh, 64px)`. Don't go back to `1fr` — it stretched tiles
into the panel border and left empty space under the cost text.

Six effects shipped in session 15 from the `/build-test.html` sandbox:
tile hover-pop (snappy scale + glow), CR bloom pulse (50% intensity),
letter-by-letter phase title reveal (`HUD.setPhase` wraps chars in
`.boot-char` spans inside `.phase-chars`), additive-blend selection
pulse ring (on `.hud-tile.selected`), edge-trace orbit (SVG
`<animateMotion>` dot on center panel — auto-hidden during REVEAL
via `.phase-reveal` class), unit icon glow. All theme-matched
(cyan defender / pink attacker).

- LEFT panel — 4×2 robot tile grid (8 pieces): Sphere/Tower/Bomber/Sentry
  over Dog/Wall/Laser/Repair. Laser is the lone "preview" piece left;
  Sphere, Tower, Bomber, Sentry, Dog, Wall, Repair all have real mechanics.
  See the Robot Repair + Sentry + Wall sections above.
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
- Cyborg variant `#hud-top-att` has 4×2 attacker grid (6 unique
  cyborgs + 2 duplicates after S15 added Medic to the roster).
  `setPlayerSide` toggles which strip variant renders; `.ai-side`
  hides the inactive one.
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
- Start credits: 1000 (testing budget). **AI side gets +50%** via
  `Config.AI_CREDIT_BONUS = 0.5` (= 1500cr) to compensate for the lack
  of human positional judgement — applied per-side in `enterBuildPhase`
  based on which side the player picked. Tune knob for balance.
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
  win/lose (no stalemate — see Status). Streams combat log lines via
  `onLogEntry` callback so the HUD panel updates in step with the
  visible action. Holds: AmmoBox array, medic/repair pads + tethers,
  pendingGrenades, projectiles, explosions.
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
  repair_kit`) gated by unit family via `kitForUnit()`. 1 HP — any
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
  (low_hp ≤25% / low_ammo count templates / out_of_ammo) + sniper_shot
  + medic_low_packs. Lines use `{n}` (count) and `{s}/{S}` (auto-
  pluralizer — empty when n==1). One bubble per (trigger, count) key
  per entity via `spokenSet`. Canvas 320×80 to fit longer monospace
  robot lines.
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
