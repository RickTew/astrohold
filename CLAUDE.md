# AstroHold — Project Rules for Claude

Single-player D&D-style turn-based grid strategy on Vite + Three.js.
Live flow: **BUILD -> REVEAL** (PLAN is preserved but currently skipped).
After the first BATTLE click, reveals auto-chain until win/lose.
Two terminal states: core dies (defender loses) or all cyborgs dead /
unable to attack (defender wins). No stalemate rule
(`feedback_die_or_survive`).

**S27 state (latest, 2026-07-07): AstroCraft mini-RTS shipped + Mini games
menu.** One-mission mini-Starcraft ("First Claim") in
`src/astrocraft/AstroCraft.ts`, self-contained 2D canvas, gated by
`?astrocraft` in `main.ts` (main game + frozen HUD untouched). Buildings =
existing structure sprites on procedural vector foundation pads (zero new
art; pads clear when construction finishes). Mouse-only + mouse-wheel zoom;
music/sfx reuse `/audio` with an ON/LOW/OFF dial bottom-right; Cyborg base
mines its own shard patch (cosmetic income, scripted waves). Home screen has
a Rick-approved "Mini games" collapsed section below "How to play" (reuses
sp-howto classes verbatim): Main game / AstroCraft PLAY link / **Campaign =
coming-soon stub, not built**. Scripted-playtest handle `window.astrocraft`
(use `ff(seconds)`; Chrome throttles occluded windows). Win + lose paths
verified live. Log: DEVNOTES Session 27 + `project_astrocraft_minigame`.

**S26 state (2026-06-28).** Live-playtest fixes + faction-rosters
groundwork. (1) New games default to the **slow** reveal speed for first-run
players (`RevealSpeed` DEFAULT; saved prefs win). (2) Phaser beam visual now
exits the barrel bore, not the muzzle glint. (3) **Cyborg Sniper** shoot-and-
move now SIDESTEPS at ~80% range instead of stepping toward the target (was
creeping inside its own range). (4) The in-game **How to play** was rewritten
(honest "SIDES and FACTIONS" copy) and now opens with an **"Updates and
fixes"** changelog; a HARD RULE + `feedback_keep_howtoplay_synced` memory
require updating How to play on every game change. (5) Faction "I picked X but
got Robots" is BY DESIGN (faction = skin over role-bound stats; defender uses
shared structures). The real **faction rosters** build is scoped
(`docs/FACTION_ROSTERS.md`): decision = "decoupled but shared DEFENSE" (towers
shared; faction art on the mobile UNITS - attacker units + Sphere/Dog/Repair).
**Phase 1 code seam shipped** (empty override maps, no art, no visual change):
`FACTION_STRUCTURE_ART` scaffold in `Structure.ts`, `FACTION_ART` how-to guide
in `SpriteUnit.ts`, `factionAttackerGrids` map in `HUD.ts`. Art commission
prompts: `docs/FACTION_ART_PROMPTS.md`. Remaining work is pure art + data
drop-ins. Full log: `project_session_26_wrap` + `project_faction_rosters_build`
memories and `docs/DEVNOTES.md` Session 26. (The 2026-06-27 mobile +
pre-launch-gate work lives in `project_mobile_support` / `project_prelaunch_gate`.)

**S23 state.** Three factions now exist: Robots, Cyborgs, and
the new **Humans** (`Faction = 'robot' | 'cyborg' | 'human'`), decoupled
from role via the picker's "Change factions" cycler. Unit ART is now
faction-aware (`FACTION_ART` in `SpriteUnit.ts`, art resolved by
`artKey`) while gameplay TYPE/stats are unchanged - so faction is a pure
skin over role-bound stat blocks. Human roster reuses attacker stats:
WARRIOR=`cannon`, MARINE=`doublegun`, MEDIC=`medic`. New cyborg unit
**HACKER** (Cyborg Nerd) turns robots into 3-turn traitors (new combat
mechanic; `hackedTurnsRemaining`/`isHacked` on SpriteUnit + Structure).
Full S23 log: `project_human_faction_planned` + `project_hacker_unit`
memories and `docs/DEVNOTES.md` Session 23.

**S24 (2026-06-11): S23 VALIDATED live via scripted Playwright playtest**
(4 full battles on the production URL; harness recipe in
`project_playwright_playtest_harness`). Humans render + fire, Hacker
hacks/turncoats/EMP-counterplay all work, lone-hacker edge case did not
hang. Found + FIXED a real bug: RevealPhase ran its start-of-reveal ticks
in the constructor before Game bound the callbacks, silently dropping
tick-time log lines ("reboots" never showed), whole turn headers, and
tick damage telemetry. Ticks now live in `RevealPhase.start()`, called
after wiring. Also shipped same session (all verified live): human units
log as Warrior/Marine/Medic, em-dash sweep in combat-log strings,
no-target Phaser line silenced, and same-type shop-tile re-click is a
no-op instead of silently cancelling placement (board click-to-place /
click-to-remove unchanged). Flags awaiting decisions in
`docs/DEVNOTES.md` Session 24 (reconciliation attribution, 16:9
bottom-rows cutoff, MCC overlap, endgame punch grind).

**S22d state.** The battle map is STAGE-driven (see "Key constants"
below + `project_lobby_configurable_stage` memory): the whole board
derives from one `STAGE` object, placement is rule-driven via
`canPlace`, the floor is flat themed color, zones have blue/red tints,
and the grid spans the full map. Map #1 is 20x12 @ cell 75. Sphere +
robot_mine render at 1x (the only crisp step below 2x).

S22d shipped a batch of fixes (full log: `project_session_23_wrap`):
- **Grid zoom quality FIXED.** The procedural ground (floor + zone
  tints/borders + grid) now renders on a SEPARATE smooth-scaled canvas
  (`sceneBack` / `rendererBack`) BEHIND the pixelated sprite canvas, at
  true device resolution with antialiasing. Even cells at any zoom;
  native 1:1 sprite sizing untouched. The old uneven/shimmer was the
  pixelated sprite canvas nearest-neighbor squashing thin lines.
  `project_grid_zoom_quality` (resolved).
- **Melee combat:** reach is now cell-relative (`MELEE_REACH = cell*1.3`
  = cardinal-adjacent ONLY, no diagonal); melee units (Hulk/Stalker) and
  out-of-ammo punches hit INSTANTLY (no projectile); core aim resolves to
  the nearest core CELL so melee actually connects with the 2x2 core.
- **Stalker** cloaks the instant it leaves its red zone (was a 2s timer
  that let it get shot). Defender targeting (sentry walk, bomber aim) now
  skips cloaked units.
- **Side picker:** "Swap factions" pill decouples faction from role
  (either faction can defend or attack). Faction is still cosmetic
  (music + label) - rosters are role-bound; faction-specific rosters
  would be a separate build.

**OPEN - start here next session:**
- **Online 2-player (S25) - read `docs/ONLINE_PVP.md` to resume.** Backend
  (shared "TewBit Games" Supabase hub, `astro_hold` schema, RLS, join_match
  RPC) and the LOBBY are DONE and proven live in a browser
  (`astro-hold.vercel.app/?online`): create -> share code -> realtime
  connects both players. All 3 prereqs done (exposed schema, anon sign-in,
  Vercel env). Client: `src/net/{supabaseClient,onlineMatch,lobbyUI}.ts`,
  gated by `?online` (normal game untouched, HUD never touched).
  **NEXT:** (1) **entry screen + login (guest-first)** - the free/public
  game needs an entry + OPTIONAL account; guest play must ALWAYS work, never
  a login wall (keeps it free/public + playtest unblocked); (2) in-game
  BUILD+REVEAL sync (host records the RevealPhase `PieceEvent` stream ->
  `rounds.replay_events` -> guest plays back; seam = `lobbyUI` onReady +
  `Game.onSidePicked` at Game.ts:386); (3) "Play Online" button into
  `#side-picker` (HUD.ts) LAST. Full detail + gotchas: `docs/ONLINE_PVP.md`,
  `project_supabase_hub_backend` + `project_login_entry_planned` memories.
  Live game now on `www.astrohold.com` (custom domain); bare `astrohold.com`
  apex still on a Squarespace placeholder pending a Vercel DNS tweak.
- **Hacker balance** (80cr / 60hp / 2 hacks / 3-turn / range 200 are
  first guesses) + the wider **balance retune** for the bigger board
  (`feedback_data_driven_balance`). S24 note: a "3-turn" hack yields
  about 2 acting turns (timer decrements at reveal start).
- **S24 playtest flags needing decisions** (`docs/DEVNOTES.md` S24):
  damage-reconciliation attribution (core blast + turncoat damage),
  bottom 4 rows hidden at 16:9 default zoom, MCC overlapping attacker
  cells, 40-turn endgame punch grind vs structures.
- **Human faction polish (optional):** bespoke voice (`SpeechBubble.ts`),
  a `humans.mp3` track, human defensive structures, and a side-aware
  `firePhaserBeam` so the Phaser becomes hackable.
- **Audio vocal hunt (`project_audio_vocal_hunt`).** Some cyborg sound
  triggers macOS Live Caption (an "Oh" / "wow wow") - intermittent,
  unconfirmed which file. Use the `?audiolog` overlay (visit `/?audiolog`)
  which names the exact file every sound plays. Catch the line when the
  caption fires, then pull that URL from its pool.

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
  the recent-session summary. Current is `project_session_27_wrap`
  (2026-07-07). Older balance context lives in `project_session_20_wrap`
  (S20 balance pass is unvalidated; retest before more balance work).

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

### Keep "How to play" in sync with the game
Whenever we change, add, or adjust a game mechanic, piece, stat, or
behavior, update the in-game **How to play** panel in the SAME change so
it never drifts from the live build. The panel lives in the `.sp-howto`
`<details>` inside `#side-picker` in `src/ui/HUD.ts` (editing its prose is
content, not a HUD-style change, so it is allowed under the HUD hard lock
as long as you only touch text in the existing `<h4>`/`<p>` pattern).
The panel opens with an **"Updates and fixes"** changelog section (newest
first) - add a dated one-line entry there for every player-facing change
(e.g. the Sniper standoff fix) so the player can follow along. Also keep
the relevant body section (basics, combat rules, side specials, win
conditions, factions) accurate for the same change.

### Deployment ritual is `git push`, full stop
The Vercel project has Git integration enabled. Every push to `main`
auto-deploys to production. **Do NOT also run `vercel --prod`** —
that fires a second build of the same code and burns paid Vercel
build minutes. Only run a CLI deploy when the user explicitly asks.

We do NOT use the local dev server. The user tests on the live URL
(https://astro-hold.vercel.app). Never run `pnpm dev` / `vite` as
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

## Module map (src/, by capability)
Quick orientation for agents; the file-by-file detail still lives in
`docs/ARCHITECTURE.md`. Tagged by what each module DOES, not by piece name.
- `game/` — turn/phase engine + tuning: BuildPhase, PlanningPhase,
  RevealPhase, RevealSpeed, Difficulty, BattleStats, TurnTypes, and the
  GameConfig/Game core (the STAGE seam).
- `entities/` — combat actors + VFX: SpriteUnit, Structure, SphereDefender,
  Projectile, Explosion, AmmoBox, MedicPad/RepairPad/RepairTether/Tether,
  HealVfx, PendingGrenade, FireArcPreview, PixelPowerCore, SpeechBubble.
- `scene/` — Three.js environment: Background (procedural ground/grid) + Shadow.
- `ui/` — HUD + MiniControlCenter (FROZEN per the HUD hard-lock above).
- `audio/` — music, sfx, samples, AudioSettings, audioDebug.
- `ai/` — OpponentAI (the attacker brain).
- `devtools/` — audioLogOverlay (`/?audiolog`) + buildTest sandbox.
- root `main.ts` — entry/bootstrap.

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
