# AstroHold — Dev Strategies & Reference Notes

These are evaluated strategies and tool notes collected during development.
Status: HOLD = don't add yet | ACTIVE = in use | FUTURE = add when the need arrives

---

## Asset Loading

### /public folder for static assets (ACTIVE)
Put all `.glb`, `.jpg`, `.mp3` in `/public/`. Load with absolute paths:
```ts
loader.load('/models/cyborg/idle.glb')  // correct
loader.load('../../assets/model.glb')   // never this
```
Benefit: zero-config paths, no broken relative imports as files move.

### vite-plugin-gltf — build-time GLB compression (HOLD → FUTURE)
Installed. Works on *imported* GLBs (not /public URL strings).
Apply Draco + Meshoptimizer compression at build time.
Activate when: we want to optimize for production OR move models to `/src/assets/` imports.
Note: 57MB sphere needs compression before use. Cyborg files ~7MB each are fine for dev.
```ts
// vite.config.ts — when ready
import gltf from 'vite-plugin-gltf'
import { draco } from '@gltf-transform/functions'
plugins: [gltf({ transforms: [draco()] })]
```

---

## Shaders

### vite-plugin-glsl — shader HMR without losing game state (HOLD → FUTURE)
Separate `.vert`/`.frag` files hot-reload without full page refresh.
You keep camera position and game state while tweaking shader code.
Activate when: first custom GLSL shader is written.
```ts
import glsl from 'vite-plugin-glsl'
plugins: [glsl()]
```
Put shader files in `/src/shaders/`. Never inline GLSL strings in `.ts` files.

---

## Vite / HMR

### Avoiding double-init on HMR (ACTIVE)
Vite can re-run `main.ts` without unloading the previous module — two renderers on one canvas.
Fix: `import.meta.hot.dispose()` in `main.ts` + `game.dispose()` stops RAF loop, clears scene.
Already wired. Do not remove.

### Recommended vite.config.ts settings (ACTIVE)
- `target: 'esnext'` — no transpilation needed, Three.js r182+ expects it
- `assetsInlineLimit: 0` — never base64-encode assets (breaks GLB URL loading)
- `manualChunks: { three: ['three'] }` — Three.js (~600KB) cached separately from game code
- `host: true` — reach dev server from phone/tablet on local network

---

## 2026 Tool Landscape (reference)

| Tool | Version | Status | Notes |
|---|---|---|---|
| pnpm | 10.x | ACTIVE | 30% faster than npm, better disk usage |
| Vite | 8.0 | ACTIVE | Rolldown bundler inside, 10-30x faster builds |
| Three.js | r184 | ACTIVE | WebGPU renderer available but we use WebGL 2 |
| TypeScript | 6.0 | ACTIVE | 7.0 (Go rewrite) still beta — stay on 6 for now |
| Biome | 1.x | FUTURE | Replaces ESLint+Prettier, 10-25x faster — add when linting is needed |
| Vitest | 4.x | FUTURE | Add when there's logic worth unit testing |
| vite-plugin-gltf | 4.0 | INSTALLED/INACTIVE | Need to activate for production optimization |
| vite-plugin-glsl | — | FUTURE | Add when writing first GLSL shader |
| theatre.js | — | FUTURE | Cinematic animation sequencing — add if we do cutscenes |
| leva | — | FUTURE | Live parameter tweaking GUI — useful for tuning game constants |

---

## Model Workflow
1. Create model in Meshy → download GLB with animations
2. Unzip to `/_zips/`, extract to `/public/models/<name>/`
3. Use short filenames: `idle.glb`, `running.glb`, `dead.glb`, `hit.glb`
4. Set `MODEL_SCALE` in `Unit.ts` — Meshy models vary wildly in size
5. Playtest → exhaust all fixes/improvements on this model
6. Only then: add next model

---

## Camera Strategies & Troubleshooting

### Camera shake — ortho version (FUTURE / easy add)
3 lines in `Game.ts`, no manager class needed:
```ts
shake(intensity: number) {
  this.camera.position.x += (Math.random() - 0.5) * intensity
  this.camera.position.y += (Math.random() - 0.5) * intensity
}
```
Call `shake(8)` on big explosions, `shake(3)` on regular hits. Reset position toward (0,0,100) with lerp if drift becomes visible.

### Raycaster timing (WATCH IF camera ever moves)
Currently camera is static — order doesn't matter.
If camera lerping/movement is added: raycaster must be set *after* the camera has moved in that frame.
```ts
// Correct order in loop:
camera.position.lerp(target, 0.1)  // move first
raycaster.setFromCamera(mouse, camera)  // then raycast
```
Wrong order = clicks land in the wrong place by one frame.

### Logarithmic depth buffer — Z-fighting nuclear option
If textures start flickering at mixed depth ranges (Z-fighting):
```ts
// In Game.ts renderer setup:
this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true })
```
We currently prevent Z-fighting by assigning explicit Z values (starfield z=-5, grid z=0.3, entities z=0, HP bars z=0.1-0.2). Use the log buffer if manual Z management gets unwieldy.

### Ortho vs perspective in build mode
OrthographicCamera has zero perspective distortion by design — objects don't shrink with distance.
This is a free advantage for our build phase grid placement. No FOV tuning needed.

### Lerp smoothing for camera transitions
If adding camera pan/zoom:
```ts
// Smooth any value toward target
current = THREE.MathUtils.lerp(current, target, lerpFactor * delta * 60)
```
`lerpFactor` 0.05–0.15 = smooth, 0.3+ = snappy.

### HMR + singleton cameras — known trap
Static singleton cameras (`static instance`) survive Vite HMR and cause stale camera state.
Our pattern: `Game` instance is created fresh in `main.ts`, old one disposed via `import.meta.hot.dispose()`. No singleton needed.

---

## Current Build State (2026-05-06)
- Deployed at https://astrohold3.vercel.app
- World: ±600 x ±200, three ~400×400 zones
- Testing phase: both shops visible, attacker units spawn on button click
- Sphere.glb = power core (local only; SphereGeometry fallback on Vercel)
- Cyborg = attacker (running + dead animations, hit flash)
- Tuning knobs: `SPHERE_SCALE` in PowerCore.ts, `MODEL_SCALE` + `MODEL_TILT_X` in Unit.ts

---

## Common Errors & Fixes

### Resize distorts game — camera frustum not updated (WATCH)
The renderer size updates on resize but the OrthographicCamera frustum does NOT auto-update.
If window is resized, the scene will squish/stretch.
Fix — add to `onResize` in `Game.ts`:
```ts
private onResize = () => {
  this.renderer.setSize(window.innerWidth, window.innerHeight)
  // Ortho camera needs frustum refresh too:
  const aspect = window.innerWidth / window.innerHeight
  this.camera.left   = -600 * aspect
  this.camera.right  =  600 * aspect
  this.camera.updateProjectionMatrix()
}
```
Or lock to a fixed canvas size and don't handle resize at all — simpler for dev.

### Resize event guard — defensive check (ACTIVE pattern)
Before updating camera aspect or renderer size, guard against zero dimensions (can happen during HMR or rapid resizes):
```ts
const { innerWidth: w, innerHeight: h } = window
if (w === 0 || h === 0) return
```

### Grid snapping: Math.floor vs Math.round
`Math.floor` = origin-based snap (top-left of cell). This is what BuildPhase uses — correct for grid placement.
`Math.round` = center-based snap. Use this only if you want the cursor to snap to the nearest center rather than the cell the cursor is in.
Never mix them — one places structures half a cell off.

### HMR duplicate event listeners
All `window.addEventListener` calls must be cleaned up in `cleanup()` / `dispose()`.
Our pattern: BuildPhase registers `mousemove` + `click` in constructor, removes both in `cleanup()`. If cleanup is skipped (crash/HMR), listeners stack up and you get double-fire on every event.
Symptom: clicking places two structures, or ghost appears when no type is selected.

### Projectile fires but target is already dead
Design decision: damage is applied immediately when the structure fires (in `doStructureTurn`), not when the projectile lands. The flying projectile is visual only.
If a unit dies and vanishes before the projectile animation completes, that's correct behavior. Do not move damage to projectile `update()` — it will cause double-damage.

### Turn loop: all alive units act each tick (no index drift)
`executeTurn` filters `units.filter(u => !u.isDead)` and loops everyone in one go (no `unitIdx`). A unit that dies mid-loop won't be revisited this tick, won't be skipped next tick. Earlier sessions documented "unit-skip drift" — that bug is gone; the design is simpler now.

### Mines don't fire if unit spawns inside mine radius
`checkMines` is called before the unit moves on its first turn. If units spawn close to a mine (spawnX 420+, mines max at ~-200), this is not an issue. But if map changes and spawn zone moves, test mine trigger on first turn.

---

## Decisions Made & Why
- **No React / R3F** — vanilla Three.js keeps the build lean; R3F ecosystem is strong but adds React overhead for a non-UI-heavy game
- **Geometric placeholders** — structures use Three.js primitives so gameplay works before art is final
- **Sphere GLB on Vercel** — 57MB file IS tracked in git and deployed; SphereGeometry fallback only if file fails to load
- **Turn-based not real-time** — easier to balance and debug; speed controlled by `TURN_INTERVAL` in `BattlePhase.ts`
- **DOM overlay for HUD** — HTML/CSS is faster to iterate than Three.js UI; `pointer-events: none` on container with `auto` on children
- **Bottom bar flex layout** — single `#bottom-bar` div holds both shops + battle button; prevents any overlap at any window size

---

## Current Build State (2026-05-06, session 2)
- Deployed at https://astrohold3.vercel.app / GitHub: RickTew/AstroHold3
- World: ±600 x ±200, three ~400×400 zones, rocky planet terrain (canvas texture)

### Key tuning knobs (check these first after any crash)
- `MODEL_SCALE = 25` in `Unit.ts` — cyborg 1.65 units → ~41 world units tall
- `MODEL_TILT_X = 0` in `Unit.ts` — faces camera; if model appears face-down, try `Math.PI / 2`
- Sphere auto-scales in `PowerCore.ts` from bounding box; stored as `glbBaseScale` for pulse

### Animation gotcha — T-pose during build phase (FIXED)
`testUnits` are visible during the build phase but `battlePhase` is null, so `update()` was never called.
Fix: `this.testUnits.forEach(u => u.update(delta))` in Game.ts loop.
Symptom if this regresses: model appears frozen in T-pose (arms spread, no motion).

### What's working now
- Cyborg: idle.glb default, running.glb + dead.glb preloaded, hit flash
- Power Core: sphere.glb on Vercel, auto-scales, pulses using stored base scale
- Bottom bar: flex — defender left, battle center, attacker right — never overlaps
- Credits: defender top-left (blue), attacker top-right (red), both deduct on spend

### What to test / next up
1. Confirm idle animation plays (not T-pose)
2. Spawn attacker units, watch credits deduct
3. Place structures, hit BATTLE — check running/dead animations
4. Confirm sphere.glb loads and pulses (may take a moment — 57MB)

---

## Session 3 (2026-05-12) — Sphere placement bug + canonical placement flow

### Bug fixed: ghost shown but `sphereSelecting` stuck false
`onBuySphere` was setting `this.sphereSelecting = true` *before* calling `this.createSphereGhost()`. But `createSphereGhost` calls `this.clearSphereGhost()` defensively to wipe any stale mesh — and `clearSphereGhost` ALSO sets `sphereSelecting = false`. Net: the ghost appeared on screen, but the flag was already back to false, so every canvas click silently failed the `sphereSelecting && buildPhase` gate.

**Fix:** swap the order in `onBuySphere` — call `createSphereGhost()` first, then set `sphereSelecting = true`. Order matters because the helper resets the flag.

**Diagnosis tool:** an on-screen debug overlay (top-center) that prints mousedown state was added temporarily — it surfaced the impossible-looking `ssel=N, ghost.v=Y` combination immediately. Pattern worth reusing: when a placement / state-flag bug is invisible to inspection, route state into the HUD via `setDebug(msg)` and screenshot it. Removed after the fix.

### Pattern: helper-resets-state class of bug
Any "clear/reset" helper that also resets a coordination flag will silently undo flag changes made by its callers if called from within a `create` helper. **Watch for this any time a `createX` calls `clearX` internally** — `attGhost` happens to dodge this by not calling `clearAttPlacement` from `createAttGhost` (it only removes the mesh).

### Canonical placement flow (now in CLAUDE.md)
Cyborg and sphere now share the same 3-step pattern. The ghost mesh is the source of truth for placement position — never re-raycast at click time. See CLAUDE.md "Canonical placement flow" section.

### Visual upgrade
Defender zone gets a bright cyan tint (`0x00ddff @ 0.32` opacity) over (-600..-200, -200..200) when sphere selection mode is active — was previously invisible, so users couldn't tell where to click.

---

## Session 4 (2026-05-12) — Code cleanup + visual polish

### Unified placement state (one source of truth)
Previously: sphere had `sphereSelecting` + `sphereGhostMesh` + `spherePlaced` + `sphereZoneMesh`; cyborg had `selectedAttUnitType` + `attGhostMesh` + `attPendingCost`. Three different state machines for the same idea — pick a thing, hover ghost, click to place.

Now: a single `placement: PlacementSession | null` in `Game.ts`. Each session owns its own ghost mesh, optional zone tint, zone bounds, and an `onPlace(x, y) => boolean` callback (return `true` to end the session, e.g. one-shot sphere; `false` to stay in placement, e.g. multi-place cyborg). Starting a new session implicitly cancels the old one.

Killed: the "must call createSphereGhost before setting flag" gotcha — that whole class of bug becomes structurally impossible since helpers no longer mutate shared flags.

### Billboard HP bars
All HP bars (Unit, SphereDefender, PowerCore, Structure) are now wrapped in a `hpBarGroup` whose quaternion is copied from the camera each frame. Previously they used a fixed `rotation.x = -π/4` tilt that worked only at the default camera angle and broke under pan/zoom. Each entity exposes `faceCamera(camera)`; Game's render loop calls them after `update()`.

### Structure placement offset bug (FIXED)
`Structure.worldY` was hardcoded to `-350 + row * 50 + 25` even though `Config.WORLD.BOTTOM = -200`. Result: structures rendered 125 units south of where the user clicked. Replaced with `Config.WORLD.BOTTOM + row * GRID_CELL + GRID_CELL/2` (and same Config-derived form for `worldX`). Always derive grid coords from `Config.WORLD` — never re-magic-number the bounds.

### Permanent zone tints (symmetric)
Both sides now have a subtle permanent tint during build phase — defender cyan (`0x00ddff @ 0.07`), attacker red (`0xff4488 @ 0.07`). Placement adds a brighter tint *on top* of the permanent one. No more "where can I click?" confusion before pressing a Buy button.

### Sphere fallback: BasicMaterial + rings
Per CLAUDE.md, swapped fallback `MeshStandardMaterial` → `MeshBasicMaterial` so the placeholder doesn't render as a washed-out gray sphere under our scene lighting. Added two thin equatorial rings so the placeholder reads as "spherical object with structure" rather than "untextured ball." Only visible until `sphere.glb` (57MB) finishes downloading.

### Dead code removed
- `attPendingCost` — declared and read in `clearAttPlacement` but never assigned anywhere → useless "refund" code path
- `testUnits` → renamed to `attackerUnits` (they're real attacker units, not test fixtures)
- Removed `markSpherePurchased` is still called (single-shot sphere) but flag-spaghetti gates are gone

---

## Session 5 (2026-05-12) — Multi-sphere refactor BROKE sphere visuals; LIVE SITE IS BROKEN

### TL;DR for the next session
- **Live site (https://astrohold3.vercel.app) is currently broken.** Placed spheres render as oblate / squashed ellipsoids instead of round.
- Most likely cause: `loadSphereTemplate()` in `Game.ts` stores `gltf.scene` as a template, and `SphereDefender` constructor does `modelTemplate.clone(true)` per placement. Meshy GLB exports often contain `SkinnedMesh` + `Skeleton` metadata even when the rig add-on wasn't purchased. `Object3D.clone(true)` does NOT correctly clone skinned meshes — the clones share the original skeleton's bind matrices and render with broken transforms.
- The cyborg code already uses `SkeletonUtils.clone` (imported from `three/examples/jsm/utils/SkeletonUtils.js`) for exactly this reason.
- Most likely fix: replace `modelTemplate.clone(true)` in `SphereDefender.ts:21` with `SkeletonUtils.clone(modelTemplate)`. One-line change. **NOT VERIFIED.**
- Alternative: `git revert b5aef86 1ec6443` to roll back to last-known-good state (single-sphere singleton, GLB rendered correctly).

### What was attempted this session
1. **Unified placement state** (commit `1ec6443`) — replaced sphere/cyborg flag soup with a single `PlacementSession` in Game.ts. This part is independently fine and shouldn't be reverted just to fix the sphere visual.
2. **Billboard HP bars** — every entity (Unit, SphereDefender, PowerCore, Structure) gained a `faceCamera(camera)` method that copies the camera quaternion onto a `hpBarGroup`. Replaces fixed `rotation.x = -π/4` tilt.
3. **Structure offset fix** — `Structure.worldY` was hardcoded to `-350 + ...` instead of `Config.WORLD.BOTTOM + ...`; now uses Config. Independently a real bug fix.
4. **Permanent zone tints** — both sides get a subtle always-on tint during build phase.
5. **Multi-sphere refactor** (commit `b5aef86`) — Sphere is no longer a singleton. Game stores `sphereTemplate: THREE.Object3D` (loaded once, awaited) + `spheres: SphereDefender[]`. SphereDefender clones the template per instance. Sphere button stays enabled until credits run out.
6. **Awaited GLB load** — `init()` now waits for `sphere.glb` to fully load before showing the game, so the cyan fallback never appears during normal load.

### My mistakes this session (for honesty, so the next session reads from a clean slate)
- **Claimed PowerCore had no HP bar.** It did — I missed it on first read. Caught by re-reading the file before coding.
- **Listed structure verification steps in the verify-after-deploy list when there's no structure UI in HUD.** The Structure code path exists in `BuildPhase.ts` and `Structure.ts` but there are no shop buttons for turret/wall/cannon/mine yet. User correctly called this out.
- **Confidently asserted the sphere GLB is intrinsically oblate, without inspecting the asset.** User showed the Meshy preview of the GLB — it's a perfect round sphere. The warping is from my clone code, not the asset. This was the worst of the session and the reason the user lost trust. Memory written: see `feedback_dont_blame_asset.md`.
- **Pattern: I made multiple confident wrong claims in a row.** Each correction eroded trust further. The lesson is not "be less confident" — it's "verify before asserting, and after the first wrong claim in a session the bar for the next assertion should go up, not just hedge it." Memory written: see `feedback_dont_claim_works.md`.

### Repo state at session end
- Working tree clean
- Branch `main` is at `b5aef86` (multi-sphere refactor), pushed to GitHub
- Production deploy is on `b5aef86` — broken sphere visuals
- Pre-broken last-good commit: `f27a2a6` (or any commit before `1ec6443`)
- Files most relevant to the sphere-clone bug: `src/entities/SphereDefender.ts:21`, `src/game/Game.ts` `loadSphereTemplate`

### Suggested next-session opening moves
1. Decide direction: revert (`git revert b5aef86 1ec6443`) vs forward-fix (`SkeletonUtils.clone`)
2. If forward-fix: change `SphereDefender.ts:21` from `this.inner.add(modelTemplate.clone(true))` to use `SkeletonUtils.clone`, redeploy, playtest
3. If still warped after fix: inspect the GLB itself in a Three.js editor or `npx @gltf-transform/cli inspect public/models/sphere.glb` to see if there's non-uniform scale baked into nested children

---

## Session 6 (2026-05-15) — Sphere → pixel sprite; UX polish; remove cyan tints

### Major direction change: sphere is now a PIXEL SPRITE, not a 3D GLB
- 8 directional PNGs in `/public/sprites/sphere/` (~3 KB each, ~24 KB total) replace the 60 MB sphere.glb. ~3000× smaller payload, instant placement.
- `SphereDefender` uses `THREE.Sprite` with `NearestFilter` for crisp pixel scaling. `update(delta)` cycles through the 8 directions on a 0.4 s timer → ~3.2 s full spin.
- All GLB sphere infrastructure (loadSphereTemplate, makeSphereModel, sphereGlbBuffer, sphereScale, GLTFLoader import) gone from Game.ts.
- **Render flags that matter for sprite-on-3D-scene:**
  - `depthTest: false` so the sprite is never occluded by ground/fence depth. The billboard quad shares a single camera-space depth for all four corners, so depth failure was all-or-nothing (caused the entire sphere top to vanish when placed near the fence).
  - `depthWrite: false` so the sprite doesn't poison the buffer for later draws.
  - `alphaTest: 0.1` to discard fully transparent pixels for clean pixel-art edges.
  - `renderOrder: 10` so it sequences after ground/fence in transparent sort.

### Removed cyan/red zone tints → thin fence borders
- The semi-transparent tint planes were washing out sprite colors and creating "phantom edges" where they ended. Replaced with `makeZoneBorder()` LineSegments rectangle at z=0.4.
- Placement-time bright tint also dropped; the ghost ring at cursor is enough feedback.

### Cyborg model now Iron Arm Sentinel + merged animations format
- `/public/models/cyborg/character.glb` (mesh + skeleton) and `/public/models/cyborg/animations.glb` (13 clips, single file): Idle, Running, Walking, Dead, Hit_Reaction_1, Female_Crouch_Pick_Gun_Point_Forward, Rifle_Aim_Turn_Right, Run_and_Shoot, Forward_Roll_and_Fire, Gun_Hold_Left_Turn, Crouch_Pull_and_Throw, Crouch_Walk_with_Torch, Spartan_Kick.
- `Unit.preload()` now loads BOTH from `animations.glb` (using its `gltf.scene` as the character template too — separate character.glb had a different bind pose that caused Idle and Crouch_Pick_Gun to render distorted).
- Track filter strips `*.scale` (we set MODEL_SCALE) AND `Hips.position` (no root motion drift in test mode).
- **Known issue:** Meshy labeled the clips wrong inside the GLB — "Walking" plays the death animation, "Dead" plays hit reaction, etc. The DATA is correct; the NAMES are mislabeled by Meshy export. Either re-export with corrected labels, or add a name-remap table in Unit.ts. See `feedback_small_feedback_small_change.md` for related guidance.
- Test mode added: each cyborg drop cycles through ALL_ANIM_CLIPS via `getAllAnimClips()` (returns clip objects, not strings — bulletproof). Canvas-textured label above each cyborg shows the clip name being played.

### Camera/world simplifications
- Camera back to (0, 300, 300), 45° tilt — the known-good angle. Earlier in the session I tried straight top-down and a tilt-with-model-rotation; both were wrong. Reverted with memory `feedback_small_feedback_small_change.md`.
- Removed both grids (Game.ts ground grid + BuildPhase placement grid). The placement ghost ring is enough cell indicator. COLS/ROWS constants kept in BuildPhase for placement bounds checking only.

### Cyborg combat improvements
- `Unit.facingY` field persists across animation swaps so faceTarget rotations stick (swapAnim was resetting rotation.y to -π/2 every idle↔running, wiping faceTarget).
- `Unit.faceTarget(x, y)` called before each Projectile spawn in BattlePhase (sphere, structure, core engagements). Units visibly rotate to face their target.
- `Unit.getMuzzlePoint()` returns a point 22u in front of the unit. Projectiles spawn from there instead of (worldX, worldY + 20) → shots leave from the front, not the belly.
- Unit projectile color 0x00ccff → 0xff3333 (red). Sphere/structure/core projectiles keep their colors so you can tell who's shooting.

### Range balance
- Sphere range 200 → 300. Outranges scout (280), tank (200), bomber (160). Only drone (350, designed sniper) still outranges.

### UI polish
- HP bar bg 0x222222 → 0xcc2222 (red) on Unit, SphereDefender, PowerCore — damaged HP reads as red lost / green remaining.
- PowerCore rewritten as a chunky box + antenna spike + emissive edge wire (was octahedron+rings — looked too much like a sphere).
- PowerCore antenna repositioned to +Y world (was at +Z which projects DOWN on screen at our 45° tilt — looked upside down).
- `START_CREDITS` 200 → 1000 for testing. Tune down for production.
- Click on a placed sphere or cyborg during build phase → refund + remove. `tryRefund(x, y)` checks both arrays before falling through to placement logic. `BuildPhase.addCredits()` added for sphere refund path.
- Per-entity placement clamp: PlacementSession now carries marginTop/marginBottom. Sphere = 50/50 (sprite is symmetric ~90 tall). Cyborg = 45/20 (head extends ~40 above feet).

### Required model orientation (added to CLAUDE.md)
- New humanoid models need body axis +Y, front face +Z, origin at feet (standard Meshy/glTF). Documented in CLAUDE.md "Required model orientation" section.

### Repo state at session end
- Working tree clean, branch `main` at `d7ddcb7` (depth-test fix), production deployed.
- All recent commits on main, pushed to GitHub.
- Live: https://astrohold3.vercel.app

### Suggested next-session opening moves
1. **Sphere HP bar position.** Bar is at local (0, 55, 0), which after 45° camera projection puts it noticeably high *above* the sphere body, sometimes outside the fence when sphere is placed near the top. Either:
   - Lower the offset (e.g., local 35) so it sits closer to the sphere top
   - Or render HP bars at fixed screen distance using camera-space offset instead of world-space
2. **Cyborg animation naming.** Either re-export from Meshy with corrected labels, OR add a remap table in Unit.ts (`MESHY_NAME → ACTUAL_CONTENT_NAME`). Need user input to identify each clip's actual content visually.
3. **Wire `shoot` / `grenade` animation states.** Once names are correct, hook firing → "Female_Crouch_Pick_Gun_Point_Forward" or "Rifle_Aim_Turn_Right"; bomber → "Crouch_Pull_and_Throw". Brief play during projectile spawn.
4. **Consider pixel-sprite-ifying the cyborg** if the user wants to commit to the pixel-art aesthetic. PixelLab can render the cyborg at 8 directions per anim state, similar to the sphere. Would eliminate the Meshy labeling mess entirely.

---

## Session 7 (2026-05-16) — Sprite cyborgs + sphere HP-bar fix; Meshy retired for characters

### Direction confirmed: NO MORE MESHY for characters
User decision this session: stop using Meshy for any humanoid/character work. Pixel sprites from PixelLab are the way forward for combatants. Cyborg animation naming (DEVNOTES session 6 leftover #2/#3) is now moot — those threads are closed.
- Meshy is still the right tool for **inanimate objects** (Power Core next).
- The existing 3D scout cyborg stays for now (still uses `/public/models/cyborg/animations.glb`), but new attacker types are sprite-only and the scout is a candidate for replacement when convenient.

### Two new sprite attackers wired up
- **Cannon** — 70cr, 180 HP, speed 55, dmg 35, range 240, no AoE. Heavy hand-cannon direct-fire infantry. Color `0xffaa55`.
- **Grenadier** — 55cr, 110 HP, speed 75, dmg 28, range 220, aoeRadius 65. Throws grenades with splash damage but **not kamikaze** (lives through the throw). Color `0x88dd44`.
- Assets: 8 directional PNGs each at `/public/sprites/cannon/` and `/public/sprites/grenadier/` (~16 KB per unit). Source zips: `~/Downloads/astrohold3/Cyborg_Canon_Hand.zip` + `Cyborg_Grenadier.zip` (also include per-state per-direction animation frames we did not extract).
- HUD: two new buttons in the attacker shop panel.

### New entity class: SpriteUnit (`/src/entities/SpriteUnit.ts`)
Pixel-sprite cousin of Unit. Public shape matches Unit exactly (`worldX/Y`, `range`, `damage`, `isBomber`, `faceTarget`, `getMuzzlePoint`, `moveTo`, `takeDamage`, `kill`, `update`, `faceCamera`) so `BattlePhase` consumes them through a shared `Attacker = Unit | SpriteUnit` union with zero behavioral special-cases.
- `preloadSpriteUnit(type, folder)` loads the 8 PNGs into a module-level texture cache; called once per type from `Game.init()`.
- Direction picker: stores `facingAngle` (math angle in world XY) and remaps to one of 8 sprite names by `Math.round((angle / (π/4) + 8N) % 8)`. Buckets are π/4 wide centered on each direction.
- `getMuzzlePoint()` projects 26 world units forward along facingAngle so projectiles leave from the weapon hand area, not the chest.
- Render flags mirror SphereDefender (`depthTest: false`, `depthWrite: false`, `alphaTest: 0.1`, `renderOrder: 10`) — same fence-clipping reason.
- `SPRITE_SIZE = 60`, sprite anchored low (`position.y = SPRITE_SIZE * 0.35`) so feet sit near `mesh.position.y`.

### Game.makeAttacker(type, x, y) dispatch
Cannon/grenadier → `new SpriteUnit(...)`. Anything else → `new Unit(...)`. Used both by placement (`startCyborgPlacement.onPlace`) and the AI fallback path in `enterBattlePhase`. The unused 3D `animTestIndex` + `getAllAnimClips` import were removed.

### BattlePhase generalized: aoeRadius drives AoE, isBomber drives kamikaze
Old code hard-coded `unit.isBomber` for both AoE projectile + self-kill. Refactored to:
- `const aoe = Config.UNITS[unit.type].aoeRadius; const isAoe = aoe > 0` for the projectile flag and splash radius
- `if (unit.isBomber) unit.kill()` is now the **only** bomber-specific branch (kamikaze)
- Grenadier therefore gets AoE projectiles and structure splash on hit, but survives every throw

### Projectile target structurally typed
Old `targetUnit: Unit | null` was changed to a structural `Trackable = { worldX, worldY, isDead }`. Decouples Projectile from the body classes and lets a homing projectile track a SpriteUnit too.

### SphereDefender HP bar lowered
- Local y went 55 → 30. Comment in source explains the body fills ~52/108 of the sprite (~22 world-unit half-height); 30 sits just above the body with a small gap and keeps the bar inside the +Y fence when sphere is placed at the edge of the defender zone (marginTop 50 → max sphere y = 150 → bar world y = 180 < fence top 200).

### Power Core: Meshy prompt requested (not yet ordered)
User plans to commission the Power Core in Meshy. Delivered the prompt as chat text — captured in the project memory `project_powercore_meshy_prompt` for re-use.

### Repo state at session end
- Branch `main` at `3c2e1d9`, pushed to GitHub, production deployed to https://astrohold3.vercel.app via `vercel --prod`.
- Pre-session commit: `448330c` (CLAUDE.md hybrid-direction codification).
- Build is clean (`pnpm build` succeeds, no TypeScript errors).

### Suggested next-session opening moves
1. **Verify Cannon + Grenadier visually in browser** — placement, walking direction → sprite, muzzle origin, AoE splash on grenadier throws, no kamikaze death. Tune sprite scale (`SPRITE_SIZE = 60`) if pixel art reads too large or small at fixed camera.
2. **Power Core replacement** — once Meshy returns the GLB, drop it under `/public/models/powercore/`, swap PowerCore.ts's geometric placeholder for a GLB load (mirror the way Unit loaded the cyborg GLB; PowerCore is static so no animation mixer needed).
3. **Retire the 3D scout?** — if the pixel aesthetic feels right with cannon + grenadier on screen, port scout to SpriteUnit and delete the heavy `/public/models/cyborg/*.glb` files + animation infrastructure in Unit.ts. Optional, not urgent.
4. **Animation frames in the new zips** — both zips include per-state per-direction animation frame PNGs (`stop_dies_and_drops_dead`, `Medium_Throw`, `Points_canon_arm_forward`, etc.). Not wired up; available if we want firing/death state cycles instead of static rotation poses.

---

## Session 8-9 (2026-05-16 → 2026-05-17) — Chess pivot: top-down grid, pixel power core, sphere multi-shot

This session is a hard pivot toward grid-based chess-like strategy. Power Core
becomes a pixel sprite, camera goes top-down, every entity snaps to a grid
cell, and an AI behavior framework (CAMP/ENGAGED + sight ranges) is wired in.

### Direction decisions (locked)
1. **Game type:** chess-like turn-based grid strategy. Not RTS, not real-time.
2. **Framework:** stay on Vite + Three.js. Phaser migration evaluated and
   rejected — Three.js renders 2D sprites fine, migration would be 6-10 hours
   for no concrete win.
3. **Assets:** sprite-only for combatants. Meshy retired for characters
   (session 7 confirmed); now also retired for the Power Core after the GLB
   super core had unavoidable back-spike occlusion under any tilted camera.
   See `[[project_chess_design_pivot]]` and `[[meshy-retired-for-characters]]`.

### Power Core — pixel sprite locked
- Tried three Meshy variants side-by-side (plain / textured / super). Super
  was the best but its dome geometry occluded back-half spikes under any tilt.
- Switched to `PixelPowerCore` — 124×124 PNG with 8 rotation directions and a
  9-frame explosion animation. Sprite-based, never self-occludes.
- Death sequence: HP=0 → 9-frame explosion plays once → sprite hides. Blast
  damages all attackers within 180-unit radius (BattlePhase.applyCoreBlast).
- `super.glb` / `textured.glb` / `plain.glb` remain on disk; `preloadPowerCore`
  is no longer called. Three.js bundle dropped 70KB (GLTFLoader gone).
- `textured.glb` is **earmarked as a future defense-tower asset** — drop it in
  if we add a turret structure that needs a hero visual.

### New attacker — Double Gun
- 90cr, 160 HP, speed 65, dmg 45, range 230, no AoE. Costliest cyborg, highest
  direct-fire damage.
- Cleanest sprite extraction yet: every state has all 8 directions, no mirror
  fallback needed. 256 PNGs.
- Cannon zip was also re-extracted this session (user fixed west walking via
  a separate `walking_WEST_...` clip; merged into the main walking folder).
- Grenadier NE↔NW sprites swapped per user (Meshy had them flipped).

### Cyborg animation system — fully wired
Per-state per-direction frame sequences for every cyborg type. Folder layout:
`/public/sprites/<unit>/<state>/<direction>/frame_NNN.png`.
- States: `idle` (loop), `walking` (loop), `shoot`/`throw` (one-shot, returns
  to idle/walking on completion), `die` (one-shot, clamps on last frame).
- BattlePhase calls `unit.playAttackAnim()` right before every projectile
  spawn so cyborgs visibly shoot/throw instead of emitting silently.
- Missing-direction fallback: `MIRROR` map flips `sprite.scale.x` to render
  the partner clip. Cannon idle/shoot missing dirs handled this way.
- Grenadier `throw` is two Meshy clips fused — lean_back covers E/NE/NW/W,
  Medium_Throw covers N/S/SE/SW.

### Sound effects
- New `src/audio/sfx.ts` — synthesized via Web Audio, no sample files (zero
  bundle cost). Lazy AudioContext.
- `playGunshot()` (35ms throttle) — every non-AoE projectile spawn.
- `playExplosion()` (60ms throttle) — AoE projectile impacts, mine detonations,
  Power Core death.

### Camera: 45° tilt → TOP-DOWN
- `camera.position` (0, 300, 300) → (0, 0, 500). lookAt origin unchanged.
- Grid cells now project as true squares instead of foreshortened rectangles.
- Sprite anchoring recentered: SpriteUnit + PixelPowerCore both moved from
  feet-anchor (`position.y = 0.35×size`) to true center (`position.y = 0`).
  HP bar offsets pulled in accordingly (SpriteUnit 35→22, PixelPowerCore
  0.78×→0.55×size).
- SphereDefender sprite shrunk 50% (90 → 45 world units) per user request.

### Grid + placement
- Map-wide grid: 50×50 cells, 24 cols × 8 rows = 192 cells. Drawn as subtle
  gray line segments at z=0.3 (under fence borders).
- `Game.snapToGridCell(x, y, zoneXMin, zoneXMax)` snaps cursor to cell center,
  restricted to active placement zone. Ghost ring jumps cell-to-cell.
- `Game.isCellOccupied(x, y)` blocks placement if a piece already sits there.
- `BattlePhase.isCellOccupiedInBattle(x, y, exclude)` does the same during
  movement, also covering spheres, structures, and the core's cell.
- Margin-clamping code (`marginTop` / `marginBottom`) removed — grid bounds
  supersede it.
- Bug fix: switching attacker types previously left an orphan ghost ring in
  the scene. Added `endPlacement()` to start of both placement helpers.

### Movement: grid-stepped, one cell per turn (all units)
- Speed stat is currently unused for movement — every unit moves at most one
  cell per turn. Returns to AP-tiered when the full turn system lands.
- Movement picks the adjacent cell closest to the core; rejects any cell
  that's already occupied OR doesn't reduce distance to the core.

### Range-based engagement
- Old code engaged the core only when `dist <= POWER_CORE.RADIUS + 20`
  (38 units — basically melee). Now: any unit fires at the core from
  `dist <= unit.range`. Cannons / Grenadiers / DoubleGuns engage from across
  the battlefield.
- Core death triggers a 180-unit AoE blast that kills nearby attackers.

### Sphere multi-shot
- `doSphereTurn` fires up to 3 shots/turn at the 3 nearest distinct enemies
  inside `sphere.range`. Fewer shots if fewer enemies in range.

### AI behavior framework — CAMP / ENGAGED
- New `Config.UNITS[type].sightRange` per cyborg (320 / 280 / 300).
- `BattlePhase.anyTargetInSight(unit)` checks distance to sphere /
  structure / core against sightRange.
- In `doUnitTurn`: if no fire opportunity AND nothing in sight (CAMP), 50%
  chance to call `wanderUnit()` (random unoccupied adjacent cell) and 50%
  chance to still advance. ENGAGED (target in sight) always advances.

### docs/STATS.md — created and maintained
Single source of truth for balance. Captures:
- Every current piece's stats (sphere, structures, cyborgs, core)
- Proposed AP / behavior per piece
- AI behavior state machine (CAMP/ENGAGED, behavior list:
  Aggressive / Standoff / Defensive / Sneaky / Sniper / Suicide rush)
- Sight ranges, line-of-sight rules (proposed)
- Build-phase economy expansion (ammo, health, shields, AP boost)
- Proposed future pieces: Heavy Laser Turret, Sniper Spire, Shield Generator,
  Recon Drone, Sapper, Sniper Cyborg, Assassin, Berserker
- Open design questions (plan-then-play vs one-action-at-a-time, diagonal
  movement, ammo finite/unlimited, wander frequency, sight blocking,
  flanking pathfinding)

### Bugs identified that turned out to be misdiagnoses (worth recording)
- "HP bar occluding model spikes" — wasn't the bar; was geometric depth
  occlusion of the back-half spikes by the model's own dome under the 45°
  camera. The eventual fix was top-down camera + pixel core.
- "Lighting issue making model invisible" — wasn't lighting; same geometric
  occlusion. The lighting rig (hemisphere + back-fill) added during that
  diagnosis is still in place and is fine for any future PBR meshes (defense
  tower etc.), just wasn't the right tool for that problem.

### Repo state at session end
- Branch `main` at `d0ac6a8`, pushed to GitHub, deployed to production.
- Build clean (`pnpm build`). Bundle: 38 KB index + 527 KB Three.js (down
  70 KB from session 7 — GLTFLoader removed).
- Live: https://astrohold3.vercel.app

### Suggested next-session opening moves
1. **Full turn system** — alternating Robots → Cyborgs → Robots turns. Each
   piece has Action Points it spends on moves/shots (see STATS.md "Movement
   / Action Points" table). Currently turns alternate between "all units act"
   and "all defenders act" simultaneously — the chess pivot needs proper
   per-piece sequential turns.
2. **Plan-then-play vs one-action-at-a-time** — pick one before building the
   turn system. STATS.md has the tradeoff captured.
3. **Build-phase shop expansion** — buyable upgrades (ammo / health / shield /
   AP boost) per piece. STATS.md has costs scoped.
4. **Structures HUD** — turret / cannon / wall / mine code paths all exist
   in BuildPhase.ts + Structure.ts but no shop buttons. Hooking them up is
   the cheapest way to add tactical variety on the defender side.
5. **First future archetype** — Sniper Cyborg or Assassin from the proposed
   list. Both need new behavior code + a PixelLab asset commission.
6. **Tuning pass** — wander frequency (50% may be too high), Sphere 3-shot
   strength (may be too strong against single targets), sight range numbers.
7. **textured.glb defense tower** — earmarked asset on disk, ready to wire up
   as a fancy turret variant once the structure shop is in.
