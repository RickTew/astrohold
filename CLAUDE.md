# AstroHold — Project Rules for Claude

Single-player D&D-style turn-based grid strategy on Vite + Three.js.
Live flow: **BUILD -> REVEAL** (PLAN is preserved but currently skipped).
After the first BATTLE click, reveals auto-chain until win/lose.
Two terminal states: core dies (defender loses) or all cyborgs dead /
unable to attack (defender wins). No stalemate rule
(`feedback_die_or_survive`).

**S22c state.** The battle map is now STAGE-driven (see "Key constants"
below + `project_lobby_configurable_stage` memory): the whole board
derives from one `STAGE` object, placement is rule-driven via
`canPlace`, the floor is flat themed color, zones have blue/red tints,
and the grid spans the full map. Map #1 is 20x12 @ cell 75. Sphere +
robot_mine render at 1x (the only crisp step below 2x). Full session
summary: `project_session_22_wrap` memory.

**OPEN - start here next session:** the grid shows uneven cells /
shimmer at fractional zoom. The current live grid (world-space lines)
is visible but has this issue; a baked texture and an fwidth grid
SHADER were both tried and pulled (shader is the right path but
rendered invisible, commit 28f65ca). Full trail + next steps:
`project_grid_zoom_quality` memory. Also pending: balance retune for
the bigger board (piece stats untouched on purpose).

## Where to find what
The detail lives in topical docs, not here. Read the relevant file when
you touch that area:

- **`docs/STATS.md`** — per-piece numbers + per-piece behaviors
  (Sniper crouch, Hulk core-march, Stalker cloak, Sentry walking,
  Shield aura, Repair refill, Phaser beam, ammo crates, etc.).
  Source of truth for stats. Update with Config when tuning.
- **`docs/ARCHITECTURE.md`** — phase flow, file-by-file code map,
  placement flow, battle movement, ammo + counterplay, RevealPhase
  internals.
- **`docs/HUD.md`** — top-strip panels, tile-grid sizing, Mini Control
  Center, side-picker modal, build-test sandbox, color conventions.
- **`docs/VISUAL_STYLE.md`** — Vector-Grid Pixel Hybrid spec (procedural
  vector geometry for environment, pixel sprites for characters, side
  tinted drop shadows).
- **`docs/PIXEL_PERFECT.md`** — S21 pixel-perfect render contract: PPWU,
  internal canvas sizing, render-time position snap, NearestFilter audit.
  Read before touching the camera / renderer / sprite size constants.
- **`docs/DEVNOTES.md`** — session-by-session decisions, gotchas, bugs.
- **Session wrap memories** — `project_session_NN_wrap` in memory has
  the recent-session summary. Check current `project_session_20_wrap`
  before doing balance work (S20 balance pass is unvalidated and
  retest is the first task next session).

If a per-piece rule, balance number, or piece behavior is not in this
file, it lives in `STATS.md`. Don't duplicate.

## HARD RULES — apply every session

### No em dashes (`—`) ANYWHERE
Applies to ALL writing: UI text, source code comments, JSDoc, commit
messages, PR descriptions, documentation, chat replies. No carve-outs.
Use regular hyphens (`-`), periods, commas, or reword. Em dashes are a
tell of AI-generated writing; the user has flagged this multiple times.

### Mouse-only UI — ZERO keyboard commands
No Shift/Ctrl/Alt modifiers, no hotkeys. Every action must be reachable
with the cursor alone (right-click, double-click, hover, HUD buttons).

### Deployment ritual is `git push`, full stop
The Vercel project has Git integration enabled. Every push to `main`
auto-deploys to production. **Do NOT also run `vercel --prod`** —
that fires a second build of the same code and burns paid Vercel
build minutes. Only run a CLI deploy when the user explicitly asks.

We do NOT use the local dev server. The user tests on the live URL
(https://astrohold3.vercel.app). Never run `pnpm dev` / `vite` as
a verification step.

### HUD HARD LOCK protocol (S17.3)
The HUD has cost three+ broken pushes. The user has said: **"only
change the UNITS, do not touch the HUD style."** Treat the HUD's CSS,
panel SVG silhouettes, tile padding, tile-icon sizes, grid gap, font
clamps, hover/selected/preview classes, icon halos, and every other
visual property as FROZEN.

**What you CAN change without sandbox or approval:**
- Contents of `robotLeftTiles` / `robotRightTiles` / `cyborgTiles`
  arrays in `src/ui/HUD.ts` — the `label`, `cost`, `icon`, `dataType`,
  `action`, and `preview` fields of existing `Tile` objects.

**What requires explicit user approval EACH TIME:**
- Adding a new `Tile` shape property (`iconScale`, `empty`, `spacer`,
  `iconClass`, etc.).
- Modifying the `tileHtml` function's rendered structure.
- Any change inside `<style>` blocks of `index.html`.
- Any addition or change to CSS rules that apply to `.hud-*` selectors.
- Splitting / merging tile arrays (LEFT/RIGHT split, etc.).
- Changing how empty/upgrade slots render. They must look IDENTICAL to
  a filled tile's box, not collapse, not render dashed.

**Sandbox-first protocol.** `build-test.html` is the HUD A/B surface.
1. Propose in the AFTER row of the sandbox FIRST. Push + deploy.
2. The sandbox MUST copy production CSS verbatim. If the BEFORE row
   looks different from production, FIX THE SANDBOX first (re-sync
   CSS) before anything else.
3. ONLY port to `src/ui/HUD.ts` after the user says "go" or equivalent.
4. After porting, update the sandbox BEFORE row to match new production.

**When in doubt: ask, don't iterate.** Don't ship "a small fix" in the
HUD without explicit user direction. The pattern that keeps burning the
user is small fix -> unexpected side effect -> another small fix ->
drift. Stop the chain by asking what the exact desired outcome is, then
make exactly that change, then stop.

### One piece per cell, strict
Large pieces (Power Core today) use a 2x2 footprint per the size rule.

### All piece costs in multiples of 10
So leftover credits remain spendable by the cheapest piece.

## Stack
- Package manager: pnpm
- Bundler: Vite 8 (Rolldown inside)
- Renderer: Three.js r184 (sprite-first; no GLBs loaded for gameplay)
- Language: TypeScript 6 (strict)
- Linting: Biome (when added)

Framework decision (session 9): stay on Vite + Three.js. Phaser 4 was
evaluated and rejected.

## File conventions
- Static assets in `/public/`. Loaded via absolute paths.
- Pixel sprite layout:
  - `/public/sprites/<entity>/<dir>.png` (8 directional static rotations)
  - `/public/sprites/<entity>/<state>/<dir>/frame_NNN.png` (animation frames)
  - `/public/sprites/<entity>/explosion/frame_NNN.png` (flat death
    sequence; Structure loader expects this layout, no direction
    subfolders)
- Source PNG zips go in `/_zips/`.
- Projectile-style single sprites live at `/public/sprites/<name>.png`
  and are loaded once into a shared cache.
- GLBs are not loaded at runtime.

## Key constants
**S22c: the board is DERIVED from `STAGE` (a `StageDef` in `GameConfig.ts`),
the "set the stage" seam. Change the board by editing `STAGE`, not the
derived `Config.WORLD` / zone / `WORLD_WIDTH_WU` / `POWER_CORE` fields.
Placement territory is rule-driven via `canPlace(side, col, row)` (modes:
`zones` default / `coreRadius` / `half` / `free`), NOT hardcoded x-bounds.
See `project_lobby_configurable_stage` memory.**

Map #1 ("Proving Ground"):
- World: x [-750, +750], y [-450, +450] = 1500 x 900 world units
  (= STAGE.cols*cell x STAGE.rows*cell). `WORLD_WIDTH_WU` = 1500, so the
  camera frames more world = reads zoomed out vs the old 1200.
- Grid cell: **75 x 75** -> **20 cols x 12 rows = 240 cells**
- Defender zone: x < -300 (6 cols, `STAGE.defenderCols`)
- Attacker zone: x > 300 (6 cols, `STAGE.attackerCols`)
- Battlefield: middle 8 cols, no placements
- Power Core at (-675, 0) (= WORLD.LEFT + cell, derived), **2x2 footprint**
  (cells (0,5)(1,5)(0,6)(1,6), the two center rows). Sprite renders at
  native PNG width x `POWER_CORE.RENDER_SCALE` (= 2), not tied to GRID_CELL.
- Floor is one flat themed color (`STAGE.theme.floor`); zone tint bands +
  dividers are gone. Blue/red base outlines come from `STAGE.theme`.
- Start credits: 1000 (testing). Equal credits both sides;
  `Difficulty.aiCreditMultiplier()` is the only economic knob
  (easy 0.75x, normal 1.0x, hard 1.25x on AI side)
- `STATIONARY_INITIATIVE = 100` (defender structures fire BEFORE any
  cyborg each turn)

## Camera
**Top-down** orthographic at (0, 0, 500) looking at origin. Grid cells
project as true on-screen squares. The 45° tilt from earlier sessions
is gone (foreshortened Y; also avoided 3D self-occlusion issues).

## Sprite gotchas (always relevant)
Every combatant is a `THREE.Sprite` billboard. Required
`SpriteMaterial` flags:
- `transparent: true`
- `depthTest: false` — billboards share one depth per quad, so
  depth-test failures cull all four corners at once. With `false`
  they never get occluded by the ground / fence / other sprites.
- `depthWrite: false` — don't poison the buffer for later draws.
- `alphaTest: 0.1` — clean pixel-art edges.
- `renderOrder: 10` — sequence after ground / grid / fence.

**Direction picker bug to remember.**
`SpriteUnit.updateDirectionSprite()` uses
`((facingAngle / (π/4)) + 16) % 8`. The `+ 16` must be an integer
multiple of 8 for the modulo to preserve bucket values. A previous
`+ TAU * 8` (= 16π ≈ 50.27) silently rotated every direction
(west -> south).

**Sprite anchoring.** `sprite.position.set(0, 0, 5)` centered on the
piece's `mesh.position`. In top-down view, the cell center IS the
piece's screen position. HP bars are hidden globally
(`hpBarGroup.visible = false` per-piece). Wall is the lone exception:
no HP bar, the wall body itself shrinks from the top as it takes damage.

**Default facing.** Cyborgs (attacker) spawn facing west (toward core).
Defender mobile units (Combat Dog) spawn facing east. Structure default
facing comes from `STRUCTURE_DEFAULT_DIR` in `Structure.ts`.

**Measure, don't guess** (`feedback_measure_dont_guess_sprite_offsets`).
When a sprite renders off-center, measure the source PNG bbox before
tweaking. Guessing wastes loops.

**Pixel-perfect render snap (S21).** Every frame, top-level scene
children + the camera have `.position.x / .y` rounded to nearest
`1 / Config.PPWU` wu before render. Gameplay logic uses
`entity.worldX/Y` (logical, not snapped) so collision + targeting
math is unaffected. Don't bypass `Game.snapForRender()`. Don't snap
in entity update loops either; movement interpolation needs float
positions for smooth deltas. See `docs/PIXEL_PERFECT.md`.

## Rules
- Don't hardcode rules or patterns that don't match the actual build.
  Verify before committing.
- Prefer pragmatic / working over theoretically correct.
- Numbers (stats / behaviors / costs) live in `Config` and `docs/STATS.md`.
  Update both together when tuning.
- No test files yet. Add Vitest only when there's logic worth testing.
- `vite-plugin-gltf` installed but inactive.
- Don't change game mechanics without asking
  (`feedback_dont_change_mechanics`). Visual/UX tweaks fine; combat
  rules, trigger modes, piece behaviors require user sign-off first.
