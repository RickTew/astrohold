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

---

## Session 10 (2026-05-17) — Plan-then-play turn engine, cinematic mode, mobile defender, bomber

Massive session. The chess turn system landed end-to-end (Phases 1-3),
then iterated through balance/visual passes based on live testing, then
added the first mobile defender (Combat Dog) and a long-range AoE
defender (Robot Bomber with spinning grenade-ball projectile).

### Direction decisions (locked this session)
1. **Reveal model:** plan-then-play with **initiative-interleaved reveal**.
   Both sides queue all actions during PLAN; clicking BATTLE animates them
   one piece-action at a time sorted by initiative DESC. Per the user:
   "watching the space battle take place" — cinematic payoff is core.
2. **Continuous battle (session-late pivot):** the first BATTLE click runs
   reveal-after-reveal automatically until win/lose. PLAN is only the
   initial setup turn; subsequent reveals use default actions (cyborgs
   advance toward core / dogs wander / spheres + towers auto-fire). Stops
   if a reveal had zero possible actions so the loop can't spin forever.
3. **Cinematic mode — HP bars hidden globally.** Plan-then-watch means the
   player can't react mid-battle, so HP overlays add clutter. Bars stay
   in code (one-line flip to bring back) but `hpBarGroup.visible = false`
   on every piece. Wall is the exception — the wall body itself shrinks
   from the top down as damage accumulates (structural, not an overlay).
4. **Initiative source:** unit Speed verbatim; stationary defenders
   (spheres + structures) use `STATIONARY_INITIATIVE = 100` so they fire
   BEFORE cyborgs each turn (was 10 = fired last and felt useless).
5. **Invalid-action handling:** strict-skip. If your queued target died
   or your destination cell got taken before your action's tick, the
   piece does nothing — wasted action. Mind-game tension > forgiveness.
6. **Size rule:** small pieces = 1 cell footprint, large pieces = 4 cells
   (2x2). Power Core is the first large piece — centroid sits on a grid
   INTERSECTION, four underlying cells reserved.

### Turn-engine architecture (new files)
- `src/game/TurnTypes.ts` — `QueuedAction` union (move / fire / throw /
  hold), `AP_COST` table, `STATIONARY_INITIATIVE`, `nextActorId()` factory.
- `src/game/PlanningPhase.ts` — owns selection state + queued-action
  overlays (blue move arrows + dot, red fire lines). Click a piece → select
  → click destination cell to queue Move, Shift+click an enemy to queue
  Fire, right-click clears the plan or deselects. Manual planning of both
  sides per user spec ("you plan both sides manually" — no AI plan gen).
- `src/game/RevealPhase.ts` — sequencer. Gathers every queued
  (actor, action) pair plus auto-fire actions for turrets/cannons/bombers,
  sorts by initiative DESC (defender-first tiebreak), steps through at
  ~600ms per action. Each action's validity is re-checked at execution
  time (strict skip). Generalized `defaultMobileUnitAction` works for
  both cyborgs (fallback: march to core) and defender mobile units
  (fallback: wander). Game loops reveals continuously until win/lose.

### State machine (Game.ts)
`'loading' | 'build' | 'planning' | 'reveal' | 'win' | 'lose'`
- BUILD → click READY → PLANNING
- PLANNING → click BATTLE → REVEAL
- REVEAL onComplete → enterRevealPhase() again (clears prior queues so
  defaults take over). Stops when a reveal had 0 steps (stalemate).
- REVEAL onWin/onLose → 'win' / 'lose' phase, message overlay.

### Per-piece data
All combatants now have:
- `id` (stable, prefix `cyborg_`/`robot_`/`sphere_`/`struct_`)
- `apBudget` + `apRemaining` (planning UI deducts; reveal resets)
- `queuedActions: QueuedAction[]`
- `initiative` (= speed for mobile units, `STATIONARY_INITIATIVE` for
  stationary pieces)
- `side: 'attacker' | 'defender'` (configurable on SpriteUnit since
  Combat Dog reuses the same class for defender side)

### Asset additions
- **Robot_Tower** — replaces tower1/tower2 placeholders. 8 rotations +
  4-frame death explosion. Faces east by default. Sprite size 64.
- **Robot_Sphere** — replaces old sphere. 8 rotations + 4-frame death
  explosion that plays before the piece hides.
- **Combat Dog** — first defender-side mobile UNIT. 8 static rotations +
  8-direction walking (4 frames each) + death explosion (south-only
  copied to every direction folder since the burst is omnidirectional).
  Wired as `UnitType: 'dog'`, side='defender', placed in defender zone.
- **Robot_Bomber** — long-range AoE defender structure. 8 rotations +
  4-frame death explosion. Cost 70cr, range 350, damage 35, AoE 65.
- **Space_Grenade** — the bowling-ball projectile sprite used by Bomber.
  Loaded once via `getGrenadeTexture()`; Projectile becomes a
  `THREE.Sprite` with `material.rotation` incrementing each tick so the
  ball spins as it flies (top-down lob simulated via tumble, not Y arc).
- **Preview pieces** (single south.png each): defense (geodesic dome),
  gun (twin-barrel turret), laser (twin-laser), signal (satellite dish).
  Placeable so the user can evaluate which to commission full 8-direction
  renders for.

### Balance pass
- Sphere damage 10 → 25 (was being ignored — first shot killed nothing).
- Tower damage 15 → 25, range 200 → 250.
- Combat Dog gets a gun: range 0 → 150, damage 0 → 15 (sprite has a
  mounted gun; treating it as melee felt wrong).
- Grenadier cost 55 → 50 (round to multiples of 10 per user rule).
- `STATIONARY_INITIATIVE` 10 → 100 so defenders fire FIRST each turn.

### Menu redesign
- Shops split into two top-corner panels (`#top-robot-shop` top-left,
  `#top-cyborg-shop` top-right) so they never crash into each other.
  Previously a single bottom bar would shove Double Gun off-screen,
  making it unclickable.
- Bottom bar now just hosts the READY/BATTLE button.
- HUD `setCredits` / `setAttCredits` toggle a `.insufficient` class on
  any shop button whose cost exceeds current credits (greyed out,
  not-allowed cursor). No more silent placement failures.

### Power Core
- Now a 2x2 footprint (size rule) at sprite size `GRID_CELL * 3` (= 150)
  so it visually dominates as the objective. `cellCenters()` returns
  the 4 cells it occupies; all three placement systems (Game placement,
  BuildPhase, BattlePhase / RevealPhase movement) respect them.
- HP bar hidden like everything else; death animation + AoE blast +
  game-over message communicate destruction.

### Visual / UX fixes
- Cross-system placement (sphere ↔ structure) — both systems now share
  an injected occupancy callback so a sphere can't be placed under a
  tower (or vice versa).
- Mid-move occupancy — `prevWorldX/Y` tracked while walking; both source
  and destination cells block other units so two pieces never visually
  share a tile during transit.
- Dead bodies auto-hide ~2s after the die animation finishes.
- Core-blast explosion keeps fading after game-over (was freezing because
  RevealPhase was waiting on projectiles but ignoring explosions — same
  bug had to be fixed twice as the engine evolved).
- Ground texture re-tuned: tighter palette + higher noise frequency +
  smaller specks so it reads as gritty dirt instead of wet mud.
- Grid lines `0x666666 @ 0.32` → `0xaabbcc @ 0.55` for legibility.

### Grenadier west idle workaround
Disk west idle PNGs hash-match the source zip byte-for-byte, but the
exported west file content visually faces east (source-tool export bug).
Workaround: drop 'west' from grenadier idle `presentDirs` so SpriteUnit's
existing MIRROR fallback uses east frames + sets `sprite.scale.x = -1`.
Targeted to idle only — other states might need the same trick.

### Repo state at session end
- Branch `main` at `2e84b35`, pushed to GitHub, deployed to production.
- Build clean (`pnpm build`). Bundle: ~60 KB index + 526 KB Three.js.
- Live: https://astrohold3.vercel.app
- Old `BattlePhase.ts` and `AIPlayer.ts` remain on disk but are no longer
  imported by Game.ts — reference only for the retired tick loop.

### Suggested next-session opening moves
1. **Cinematic grenade arc** — top-down Y-axis arc is hard to convey;
   try scale-up-then-shrink mid-flight so the grenade appears to lift.
   Combine with the existing spin for a believable lob.
2. **Delayed grenade-fuse mechanic** — Bomber/Grenadier throws this turn,
   grenade lands as a "pending" sprite on the target cell, explodes
   next turn. Needs a new pending-entity system between reveals.
3. **Directional firing arc upgrade** — Tower currently auto-fires
   omni-directional. The spec is: each Tower spawns facing east; player
   pays per additional fire-direction. Needs build-phase upgrade UI +
   arc filter on auto-fire target selection.
4. **Game restart** — after win/lose the message hangs forever. Add a
   "Play Again" button that resets state and returns to BUILD.
5. **Asset commissions** — pick winners from preview pieces (user liked
   Gun + Defense dome) and request full 8-direction renders so they can
   become real shop items.
6. **Grenadier west walking + throw** — if those states also show
   east-facing content, apply the same mirror workaround.
7. **More cyborg / robot variety** — Sniper, Assassin, Berserker from the
   STATS.md "Proposed future pieces" list. Each needs sprites + a
   behavior tag (Sniper / Sneaky / Suicide rush).
8. **Stalemate handling** — currently a reveal with 0 actions just halts
   the loop silently. Could show a "no one can act" toast or auto-restart.

---

## Session 11 (2026-05-18) — Strategy-not-RTS rework, bomb economy, Hulk

The whole list from session 10's "next-session opening moves" landed,
plus a major design pivot triggered by playtest feedback: pieces have
**limited per-game ammo**, **reactive AI flees armed bombs**, **bombs
have a 1-turn arming delay + 3-turn lifespan**, **all movement is
cardinal-only**. New unit: **Cyborg Hulk** (melee bruiser).

### Direction decisions (locked this session)
1. **D&D-style strategy, NOT RTS.** Pinned in
   [feedback_strategy_not_rts](memory). Every offensive piece has an
   `ammo` budget for the WHOLE game (not per turn). Once a tower is
   out, it's inert. Once a bomber has thrown 3 bombs, it's spent.
   Forces strategic shot allocation — the player can't spam.
2. **Bomb economy** went through 3 iterations in one session:
   - v1: simple AoE on impact (felt instant + RTS-y)
   - v2: 1-turn-fuse "delayed detonation" (still kind of RTS — bomb is
     a guaranteed hit on whoever stood on the cell)
   - v3 (locked): **proximity trap with arming delay + lifetime**. Lobs
     onto an empty cell, lands UNARMED (dim grey, dim opacity), arms
     at end-of-turn (hot red, fast pulse), proximity-triggers if any
     enemy enters AoE, auto-detonates after 3 armed reveals as failsafe.
     One bomb per thrower at a time.
3. **Reactive AI** for moving units. `pickStepTowardPoint` scores each
   candidate cell by `distance + 2 × armedBombDamageInCell` so units
   sidestep primed bombs rather than walking in. Direct-fire pieces
   prefer shooting armed enemy bombs from outside the AoE
   (`nearestSafeArmedBomb`). Grenadier-specific: diffuses an adjacent
   armed enemy bomb (1 AP, no damage, bomb vanishes) — thematic
   counter to enemy traps.
4. **Cardinal-only movement (N/S/E/W).** Diagonals removed for all
   standard pieces. Future special characters opt into 8-dir movement
   via `Config.UNITS[type].allowDiagonalMove = true`. Pinned in
   [feedback_movement_rules](memory).
5. **Tower fire arcs** — structures fire in a 120° wedge (±60°). Each
   structure has a `fireFacings: number[]` array; defenders default
   facing east toward the cyborg corridor. Pay-per-extra-facing UI
   deferred.
6. **Initiative model retained.** Higher initiative acts first; stationary
   defenders = 100, mobile units use their `speed` stat. User confirmed
   this beats simple side-alternation for strategic depth.

### New / changed files
- `src/entities/PendingGrenade.ts` — proximity bomb entity with `armed`
  flag, `turnsArmed` counter, owner ID, side-aware target check. Lives
  on Game so it survives RevealPhase instances.
- `src/game/TurnTypes.ts` — `QueuedActionKind` adds `'diffuse'`,
  `TargetKind` adds `'bomb'`. `AP_COST.diffuse = 1`.
- `src/entities/Projectile.ts` — `silentLanding` flag suppresses
  on-landing explosion VFX (used by lobbed grenades that spawn pending
  entities instead). Sprite-projectile arc: scale-up-then-shrink mid
  flight, factor 0.35 (was 0.7 — bomb was ballooning past its cell).
- `src/game/RevealPhase.ts` — major rework. New helpers:
  `lobbedThrowerAction`, `pickBombThrowCell`, `isCellEmptyForBomb`,
  `nearestSafeArmedBomb`, `nearestArmedEnemyBombInRange`,
  `targetInFireArc`, `cellBombDanger`, `applyAoeForSide`,
  `detonatePendingGrenade`, `expireOldBombs`, `executeDiffuse`.
  `executeAttack` consumes ammo via `decrementActorAmmo`.
  `tickPendingGrenades` proximity-trigger on every frame.
- `src/game/Game.ts` — owns `pendingGrenades: PendingGrenade[]`,
  passes by reference into every new RevealPhase. Tracks
  `noProgressReveals` — surfaces stalemate after 5 reveals with no
  combat. Tryrefund now also handles structures (was missing).
- `src/game/BuildPhase.ts` — **refactored**: removed the side
  `occupied` Set that was going stale on refund. Occupancy is now
  derived live from `coreCells` (frozen) + `structures` (live) +
  `externalOccupied` callback. Single source of truth.
- `src/ui/HUD.ts` — Play Again button on win/lose/stalemate overlays
  (uses `window.location.reload()` — simplest reliable reset). New
  `showStalemate()`. Hulk shop button.
- `src/entities/SpriteUnit.ts` — `SPRITE_TINT` table tints grenadier
  (light green) and doublegun (warm orange) via SpriteMaterial.color.
  Hulk manifest entry (sparse coverage: walking 4 cardinal, shoot 2
  E/W, throw 4 cardinal — slam-attack-in-front is bundled but unused).
- `src/entities/Structure.ts` — `fireFacings: number[]` and
  `ammoRemaining: number`.
- `src/entities/SphereDefender.ts` — `ammoRemaining: number`.
- `src/game/GameConfig.ts` — `ammo` added to every UNITS / STRUCTURES
  / SPHERE entry. Bomber nerfed (range 350→200, damage 35→20,
  AoE 65→50). Hulk added (cost 100, hp 280, dmg 55, range 70 melee,
  ammo 5).
- `public/sprites/hulk/` — full asset bundle (rotations + 4 anims).

### Ammo budgets (locked)
| Piece | Ammo |
|---|---|
| Sphere | 8 |
| Turret | 6 |
| Cannon (legacy) | 4 |
| Bomber | 3 |
| Mine | 1 |
| Gun / Laser preview | 5 |
| Dog | 5 |
| Scout | 6 |
| Tank | 5 |
| Cyborg Bomber | 3 |
| Drone | 8 |
| Cannon | 4 |
| Grenadier | 3 |
| Double Gun | 5 |
| **Hulk** | **5** |
| Wall / Defense / Signal | 0 (don't shoot) |

### Bug fixes
- **Refund leaves cell locked** — BuildPhase had its own `occupied`
  Set that wasn't synced when Game.tryRefund spliced structures out.
  Now derived live; no sync to break.
- **Infinite dog wander loop** — when everyone was out of ammo, the
  dog kept wandering and `totalSteps > 0` kept the auto-loop alive
  forever. Now `RevealPhase.combatThisReveal` tracks shots/throws/
  diffuses/mines; Game halts the loop with stalemate after 5
  consecutive no-combat reveals.
- **Bombs sitting forever as ignored traps** — added `turnsArmed`
  counter on PendingGrenade. Game ticks at end-of-reveal, RevealPhase
  force-detonates at `turnsArmed >= 3` at start of next reveal.
- **Bomb visual was too subtle** — yellow→white wasn't readable.
  Unarmed is now dim grey at 55% opacity, armed is hot red at 100%.
- **Grenadier idle east-facing bug** — both 'east' and 'west' idle
  presentDirs dropped. Falls back to the correctly-oriented static
  rotation PNGs.
- **Bomber placement rejection** — same root cause as the refund
  occupied-set bug. Fixed by the BuildPhase refactor.

### Visual / UX polish
- Unified placement ghost — every placement (sphere / dog / cyborg /
  structure) now uses the same 48×48 green square. No more mix of
  circle rings + green squares.
- Grenadier sprite gets a green wash so it doesn't blur with Cannon.
- Doublegun gets a warm orange wash.
- In-flight grenade smaller (base 22→16) + lower arc (0.7→0.35).
- Play Again button on win / lose / stalemate overlay.

### Cyborg Hulk
First melee bruiser. Stats: cost 100, HP 280, damage 55, range 70
(melee), speed 35 (slowest), ammo 5, AP 2. Has 4 anims (walking_slow,
attacks_with_powerful_punch, slam_attack_in_front, exosuit_falls_apart).
Slam animation is in the bundle but the **slam-attack mechanic isn't
wired yet** — task #21 (needs a new QueuedActionKind 'slam' that hits
a 1-cell-forward 3-wide wedge).

### Repo state at session end
- Branch `main` at `6ee5070`, pushed to GitHub, deployed to prod.
- Build clean (`pnpm build`). Bundle: ~70 KB index + 526 KB Three.js.
- Live: https://astrohold3.vercel.app
- Pending tasks for the next session:
  - #5 Asset commissions (Gun + Defense dome — user picks winners)
  - #7 More cyborg / robot variety (Sniper / Assassin / Berserker — user)
  - #21 Cyborg Hulk slam-attack special action
  - #22 Combat history / event log UI (D&D-style turn log)

### Lessons / patterns to remember
- **`as const` on Config blocks ergonomic optional fields.** When I
  added per-unit `allowDiagonalMove`, every UNITS entry needed it OR a
  cast at read-time. Cast was cleaner: `(Config.UNITS[t] as
  { allowDiagonalMove?: boolean }).allowDiagonalMove === true`.
- **Side state-sets break when external code mutates the underlying
  array.** BuildPhase's `occupied` Set was the second time this
  pattern bit. Lesson: derive live from authoritative arrays instead
  of caching parallel state. Same lesson Spheres learned in session 9.
- **Visual subtlety is the enemy of readable game state.** Yellow vs
  white was indistinguishable in playtest. Dim grey @ low opacity vs
  hot red @ full opacity reads instantly. Pick the bigger contrast.
- **3 iterations on the bomb in one session is the correct loop.**
  Each playtest exposed an implicit assumption (RTS-y instant blast →
  delayed-fuse for planning → proximity trap with lifetime). Don't
  ship the first version of a mechanic and walk away.

### Suggested next-session opening moves
1. **Slam-attack special action (#21)** — Hulk has the animation in
   bundle. Add `QueuedActionKind 'slam'` targeting a CellRef in the
   direction of the unit's facing. AP cost 2. Hits all enemies in the
   3-cell-wide wedge 1 cell forward. AI prefers slam over punch when
   2+ enemies cluster in front.
2. **Combat history log (#22)** — right-side panel showing event
   stream per reveal: "Sphere fires at Grenadier (8 dmg) / Grenadier
   throws bomb at (12,4) / Bomber bomb detonates, kills Cannon".
   Helps user debug AI behavior + reads like a D&D combat log.
3. **Tower extra facings UI** — player pays credits during BUILD to add
   a second/third facing to a tower. Hover the tower → click a compass
   rose to add a wedge. Needs Structure mutator + cost balance.
4. **Asset commissions (#5)** — user to pick winners from the preview
   pieces (Gun / Defense dome / Laser / Signal) and order 8-direction
   renders.
5. **More cyborg / robot variety (#7)** — Sniper (long-range one-shot,
   1 ammo), Assassin (move 2 cells, sneaky), Berserker (frenzy mode
   when below 30% HP). Each needs sprites + a behavior tag.
6. **Sphere placement-ghost shows fire-arc preview** during BUILD —
   show the 120° wedge before the player commits, so they understand
   that an east-facing tower won't protect the north flank.
7. **Bomb spawn cell affordance** — currently bombs target empty cells
   the AI picks. Player has no visibility into where bombs will land.
   Add a faint "planned throw cell" indicator during PLAN phase for
   queued throws.
8. **Hulk balance pass** after playtest** — if 280 HP + 55 dmg melee
   is too strong, drop HP first; if too weak, give him diagonal
   movement (he's the special-character carve-out from the
   no-diagonals rule).

---

## Session 12 (2026-05-19) — Slam, log, fire arcs, sniper, polish

Big session. Six of session 11's eight "next-session opening moves"
shipped, plus a new cyborg type (Sniper) added from a fresh PixelLab
asset drop. Also pinned two durable feedback rules: **mouse-only UI
(no keyboard commands)** and **finish tasks end-to-end** (don't keep
asking the user to confirm direction mid-build).

### Features shipped (commits in order)
1. **Hulk slam-attack special** (`67c0d6d`) — `QueuedActionKind 'slam'`
   with AP cost 2, separate `slamAmmo: 3` counter, 3-cell-wide wedge
   one tile forward of facing. AI scores all four cardinal wedges
   and slams the cluster with 2+ enemies (ties broken by total HP);
   re-uses Hulk's PixelLab `throw` clip as the slam animation.
2. **Combat history log** (`99df790`) — right-rail D&D-style turn
   log. `RevealPhase.combatLog: CombatLogEntry[]` accumulates entries
   per reveal; Game forwards them to a new `#combat-log` HUD panel.
   Side-coloured rows (defender blue / attacker red / neutral gold);
   "── Turn N ──" headers; trimmed to last ~220 lines; auto-scrolls.
   Visible during BATTLE and persists through win/lose/stalemate.
3. **Fire-arc preview during BUILD** (`57d3677`) — new
   `FireArcPreview` overlay class. Wedge under directional structure
   ghosts (turret/bomber/etc), full 360° circle under the sphere
   ghost. Outline + filled disc, faint blue, low opacity.
4. **Tower extra-facings UI** (`b0e2fac` → `1f0f290` → `059a914`
   → `6432272` — iteratively fixed): compass-rose popup, paid extra
   `Bash(Config.EXTRA_FACING_COST = 30cr)` per cardinal direction.
   Right-click a placed firing structure to open; click outside
   (anywhere) to close; explicit ✕ button + Refund button; right-
   clicking the SAME structure toggles closed. The rose hides the
   active placement + clears the shop selection so it's a focused
   edit mode.
5. **Cyborg Sniper** (`55bae70`) — new attacker type. 90cr / 80 HP /
   speed 50 / damage 150 / range 400 (longest in game) / **ammo 1**
   (single shot per game). One-shots every defender structure (max
   HP 120 cannon turret). Asset coverage: 8 static rotations, 4
   cardinal walking, 7-direction shoot composed from 3 Meshy clips
   (E/W = crouches-with-rifle, N/NE/NW = back-aim, SE/SW = holding
   rifle), 8-direction die. No idle (initially used the
   `standing_still` clip — turned out to be a kneel-with-rifle pose
   that read as "still aiming"; dropped and let static rotations
   serve as the rest pose).
6. **Sniper + Hulk size & rest tweaks** (`4268927`): Hulk sprite
   bumped 60→84 via new `SPRITE_SIZE_OVERRIDE` table; per-type
   override lets future bruisers opt in. Sniper idle dropped (see
   above). Plus the bug fixes below.

### Bug fixes (session-12 playtest)
- **Compass-rose buy buttons closed without buying** (`4268927`). Root
  cause: `Game.openCompassRose` set `editingStructure = s` BEFORE
  calling `hud.showCompassRose`. Show's first line is an internal
  `hideCompassRose()` cleanup which fires `onRoseClose`, which Game
  wires to clear `editingStructure = null`. `tryBuyFacing` then saw
  null and closed. Fix: gate `onRoseClose` to only fire when there
  was actually an open rose (skips the no-op internal cleanup), and
  set `editingStructure` AFTER `showCompassRose`.
- **Rose got stuck open / outside-click didn't close** (`059a914`).
  Cause: the previous close logic gated on `closest('#hud')`, so
  clicks landing on other HUD elements (combat log, shop, credits)
  never reached the close branch. Replaced with a document-level
  mousedown listener installed at rose-open time; it closes the rose
  on any click outside the rose's own DOM, regardless of where the
  click lands. Doesn't consume the click — refund/place still runs
  in the same gesture.
- **"Refund tower" not surfaced** (`059a914`) — added Refund row in
  the rose footer. Refunds the base cost; extra-facing spend is sunk
  by design (a known compromise documented in STATS.md).
- **Click-to-refund tower silently re-placed** (`6432272`). With a
  structure type selected in the shop, clicking an existing structure
  splices it on mousedown (Game.tryRefund) but then BuildPhase's own
  click handler fires on the same gesture, sees the cell as empty,
  and immediately places a replacement. To the player, the piece
  "didn't remove". Fix: tryRefund clears the shop selection when it
  removes a structure, so the trailing click event is a no-op.
  Sphere/dog refund unaffected — they use a separate placement path.
- **Right-click ghost lingered after opening rose** (`6432272`) —
  `openCompassRose` now also `endPlacement()` + `selectStructure(null)`
  + `clearStructureSelection()`. Rose is a focused edit mode.
- **Cyborg gridlock stalemate** (`4268927`). When a cyborg had a
  sighted enemy that was unreachable (walls in the way), the previous
  default action returned null — every cyborg jammed → totalSteps 0
  → stalemate even with units alive and ammo remaining. Fix: when
  pickStepTowardPoint returns null for a sighted enemy, fall through
  to the core-advance fallback (different target, may have a free
  direction); if that's also blocked, wander-step. Formation can
  unstick over multiple turns.
- **Stalemate banner was too vague** (`4268927`). Now distinguishes
  "No piece could move or fire" vs "No combat for 5 consecutive
  turns" so the player knows whether it's ammo exhaustion or genuine
  gridlock.

### Design rules pinned this session
- **Mouse-only UI — ZERO keyboard commands.** No Shift / Ctrl / Alt
  modifiers, no hotkeys. Memory: [[feedback-no-keyboard-commands]].
  Pinned into the top of `CLAUDE.md`. First triggered the compass-
  rose rebind from shift+click → right-click (commit `1f0f290`).
- **Finish tasks end-to-end.** Don't keep checking in mid-build for
  trivial forks. Memory: [[feedback-finish-tasks-dont-stop]]. Reserve
  AskUserQuestion for genuine forks (e.g. the no-keyboard rebind was
  the right ask; "which carryover next?" was not). Default to picking
  the recommended option and shipping.

### New / changed files
- `src/entities/FireArcPreview.ts` — new utility class. Wedge or
  circle range overlay, faint blue, depth-test disabled so it
  always shows. Used by BuildPhase (placement) + Game (sphere
  placement + tower-edit preview).
- `src/game/TurnTypes.ts` — `QueuedActionKind` adds `'slam'`,
  `AP_COST.slam = 2`. New `slam` action carries a `cell: CellRef`
  (the centre of the wedge, one cardinal step forward of the Hulk).
- `src/entities/Structure.ts` — `addFacing(angle: number): boolean`
  mutator. Normalizes to [0, 2π) and rejects duplicates. Caller is
  responsible for charging credits.
- `src/entities/SpriteUnit.ts` — `SPRITE_SIZE_OVERRIDE` table
  (hulk → 84). `slamAmmoRemaining` field on every SpriteUnit
  (sniper-style: Config-driven, 0 for non-Hulks). New `playSlamAnim()`
  routes to the `throw` clip for Hulk.
- `src/entities/PixelPowerCore.ts` / `SphereDefender.ts` — unchanged.
- `src/game/Game.ts` — owns `editingStructure: Structure | null`,
  `placementArcPreview: FireArcPreview`, `revealTurn: number` (for
  the combat-log header). `tryBuyFacing`, `openCompassRose`,
  `closeCompassRose`, `refundEditingStructure`, `findStructureNear`,
  `worldToScreen` (inverse of screenToWorld). Right-click in BUILD
  toggles the rose. tryRefund clears shop selection.
- `src/game/BuildPhase.ts` — `firePreview: FireArcPreview` shown
  alongside the structure cell ghost.
- `src/game/RevealPhase.ts` — `combatLog: CombatLogEntry[]` +
  `actorLabel` / `targetLabel` helpers. New `executeSlam` (wedge
  geometry + side-aware hit). `applyAoeForSide` returns
  `{ hits, damageDealt, kills }` so log entries can format the
  summary. Diffuse / detonate / mine all emit log lines.
- `src/game/GameConfig.ts` — `EXTRA_FACING_COST: 30`. Hulk gets
  `slamDamage: 40, slamAmmo: 3`. Sniper added (cost 90, hp 80,
  speed 50, dmg 150, range 400, ammo 1).
- `src/ui/HUD.ts` — `#combat-log` panel (DOM); `#compass-rose` popup
  (DOM, projected screen coords). New callbacks: `onAddFacing`,
  `onRefundStructure`, `onRoseClose`. `appendCombatLog(turn, entries)`,
  `showCompassRose(...)`, `refreshCompassRose(...)`, `hideCompassRose()`.
  `showStalemate(reason?)` accepts an explanation.
- `index.html` — CSS for `#combat-log` + `#compass-rose` + close /
  refund buttons.
- `public/sprites/sniper/` — full asset bundle.
- `_zips/Cyborg_Sniper.zip` — source.

### Repo state at session end
- Branch `main` at `4268927`, pushed to GitHub, deployed to prod.
- Build clean (`pnpm build`). Bundle: ~85 KB index + 526 KB Three.js.
- Live: https://astrohold3.vercel.app
- Project settings: created `.claude/settings.json` with 6 read-only
  patterns (awk, shasum, Vercel MCP reads) — most permissions live
  in the pre-existing `.claude/settings.local.json` (125 entries).
- Pending tasks for the next session:
  - **#5** Asset commissions (Gun + Defense dome — user picks winners)
  - **#7** More cyborg / robot variety — Sniper landed; Assassin
    (2-cell move, sneaky) + Berserker (frenzy <30% HP) still open
  - **Hulk balance pass** — now possible after playtest with slam +
    combat log live
  - **Bomb planned-cell affordance** during PLAN (show where AI
    queued throws land — small UX win)
  - **Tower fire-arc UI: rotation** — currently arcs only ADD east
    is locked as the base facing. Letting the player rotate the
    initial facing would be the natural next pass.

### Lessons / patterns to remember
- **Callbacks fired during internal cleanup will clobber state set
  just before.** The `openCompassRose` ordering bug was a textbook
  example: setting state, then calling a method whose internal
  cleanup runs the same callback that resets that state. Gate
  cleanup-only paths so callbacks fire only on user-initiated
  closes. Or set state AFTER calling the method.
- **DOM-level outside-click listeners > delegated event gating.**
  `closest('#hud')` to detect "click outside" silently broke when
  the rose's outside happened to be ANOTHER HUD element. A
  capture-phase document listener that checks `compassRoseEl.contains(target)`
  is robust against any DOM layout.
- **`mousedown` + `click` are two separate gestures.** If you fix
  refund on `mousedown` but `click` still hits another handler,
  your fix appears to do nothing. Track which event each handler
  binds to, especially across files (Game uses mousedown,
  BuildPhase uses click — they fire on the same gesture).
- **Asset clips can lie about what they are.** The Meshy
  `standing_still` clip was actually a kneel-with-rifle scoping
  pose, not a relaxed idle. Always look at the rendered frames
  before mapping an Meshy export to an `AnimState`; the clip name
  is a hint, not a contract.
- **Per-game ammo + cardinal-only + structure walls can deadlock.**
  When everyone's spent and cyborgs are wall-blocked, default
  actions must fall through to SOMETHING (core-advance, wander)
  or the game ends in a confusing stalemate. Stalemate is fine —
  silent stalemate isn't.

### Suggested next-session opening moves
1. **Bomb planned-cell indicator (PLAN phase)** — small affordance,
   high information value. Hover-show / persistent marker for the
   cell the AI will throw a bomb into when default actions run.
2. **Tower rotation in compass rose** — currently the first facing
   is hardcoded east. Add a "rotate base facing" gesture (e.g. the
   center "X/4" tile becomes clickable and cycles N→E→S→W). Then
   the rose is a complete tower-customization tool.
3. **Hulk balance pass** — combat log now shows slam damage; pick
   a target round, watch Hulk hit rate, tune damage 40→? or HP
   280→? based on observed dominance.
4. **More cyborg variety** — Assassin (cost 60, hp 60, speed 110,
   2-cell move per turn — diagonal-capable special) + Berserker
   (cost 80, hp 200, dmg 25 normal / dmg 50 + speed 120 when HP
   under 30% — frenzy state). Need new PixelLab asset zips.
5. **Sniper visual followup** — if static rotations also feel too
   aggressive after playtest, re-render with a "rifle slung over
   shoulder" pose for the rest stance, OR add a 1-frame `idle`
   that sources from walking[0] (the standing-step frame which is
   more neutral than the current rotations).
6. **Combat log filtering / persistence options** — pin recent
   kills to top, or add a "show only N turns" toggle for long
   matches.


## Session 13 (2026-05-20) — Single-player + HUD redesign attempts

### What landed
- **Single-player mode.** Asset preload → side-picker modal (ROBOTS or
  CYBORGS) → BUILD. The chosen side runs through the normal HUD; the
  other is handled by a new `OpponentAI` (`src/ai/OpponentAI.ts`) that
  spends the AI's budget on a sensible opening force at BUILD start and
  then lets RevealPhase's existing default-action heuristics drive
  everything in PLAN + REVEAL.
- **Fog of war.** `Game.setAiPiecesVisible(false)` flips `mesh.visible`
  to false on every AI-side `SpriteUnit` / `SphereDefender` /
  `Structure` after the AI's BUILD turn. Re-enabled at the top of
  `enterRevealPhase`. Opponent credits + opposing shop panel are
  hidden in HUD (`.ai-side` class). Player sees an empty enemy zone
  during BUILD/PLAN; the fog drops when BATTLE starts.
- **Side-picker UI.** Full-screen modal with two team cards — hero
  sprite (sphere / hulk), role tagline, roster description, CTA
  button. Survived multiple HUD rewrites unchanged.
- **In-game HUD (current state).** Top strip with three floating
  panels:
    - LEFT — 5×2 robot tile grid (Sphere/Tower/Bomber/Wall/Dog
      over Defense/Gun/Gun/Laser/Signal — Gun duplicated because we
      only have 9 pieces and the reference shows 10)
    - CENTER — raised-banner panel with BUILD PHASE title (cyan glow
      + flanking corner-bracket glyphs) + CR chip + VS · CYBORGS · AI
      chip
    - RIGHT — duplicate of LEFT, both clickable (same data-action /
      data-type handlers)
  Panels are SVG-silhouetted octagons (8px chamfers all corners), no
  background fill on the wrapper — they float on top of the canvas
  with `rgba(8,18,32,0.85)` fill so the map shows through faintly.
  Cyborg variant (`#hud-top-att`) is pre-built with red palette + the
  cyborg roster duplicated to fill 10 slots.

### Hard-won lessons (also saved as memory feedback)
- **Don't redesign the HUD without an explicit reference from the
  user.** I shipped maybe 6–8 different HUD variants this session
  (corner panels → wide top bar → angled wings → bottom strip with
  SVG silhouette → centered single panel → three-section panel with
  log → reverted → final three-panel command deck). Most rounds were
  ME interpreting vague feedback and shipping something further from
  what the user wanted. The session became productive only AFTER the
  user pinned a literal reference image and I committed to building
  THAT, with the visual mechanics they pointed at (chamfered corners,
  duplicated panels, decorative title framing).
- **Treat reserved-band canvas + floating-HUD as opposite design
  axes.** I reserved 210px at the top of the canvas for the HUD;
  when the HUD hid during REVEAL, the band stayed black and looked
  like browser chrome. The fix was making the canvas full-window and
  the HUD floating with transparent gaps between panels. "Part of the
  game, not part of the window" was the user's exact wording —
  reserved canvas bands fail that test.
- **clip-path on borders silently aliases corners.** The first
  panel-frame attempts used CSS `clip-path` polygons; corners came
  out jagged because the browser doesn't anti-alias clip-paths to
  the same precision as `border-radius`. Replaced with inline SVG
  + `stroke-width` + `vector-effect="non-scaling-stroke"` for crisp
  angled edges at any panel width.
- **SVG path geometry has to leave room for tile content.** Tiles
  in the 5×2 grid overflowed the panel outline when the SVG had
  aggressive inward steps at the bottom corners. Switching to
  simple octagonal silhouettes (no inward stepping) + adjusting
  `panel-content` insets to match the chamfer kept tiles safely
  inside.
- **Save feedback memory the moment you receive it; otherwise you
  forget it three messages later.** When the user said "ROBOTS do
  not see CYBORG data until BATTLE," I should have saved that
  immediately. I noted it in conversation, then forgot it on the
  next iteration when I added an opponent credits readout. Wrote
  `feedback_opponent_data_hidden.md` after the second correction.
- **Mouse NDC must use canvas dimensions, not window.** When the
  canvas is offset/shrunk inside the window, `clientY /
  window.innerHeight` gives wrong NDC and cells under the cursor
  get mis-targeted. Fix: subtract any canvas top offset and divide
  by canvas height. Reverted out of the codebase at session end
  (canvas is full-window again) but the rule stands for future
  reservations.

### Memory entries added this session
- `feedback_ui_is_critical` — the HUD is the most-seen surface;
  treat it holistically; no single-axis tweaks for visual polish.
- `feedback_opponent_data_hidden` — no opponent credits / units
  shown during BUILD/PLAN; `mesh.visible=false` on AI pieces until
  REVEAL.
- `feedback_hud_centered_top` — single-player HUD should be
  centered horizontally; preview-piece sprites need scale ≈ 1.0
  because their PNGs already fill edge-to-edge.
- `feedback_three_section_panel` — reference images are literal
  layout specs, not style references; the reference showed three
  sections (units · log · specials) which the user wanted
  reflected in the build.

### Suggested next-session opening moves
1. **Strip down HUD if anything feels too busy.** The three-panel
   layout is intentionally symmetric (duplicate side panels) until
   we have more pieces to fill them differently. When the cyborg
   roster grows, split the duplicate side into Units / Upgrades.
2. **Wire the system log back in.** The center panel had an event
   log that the user removed because the black box was ugly. The
   log itself is valuable — find a way to surface system messages
   (build phase start, AI deployment complete, plan instructions)
   that doesn't break the panel silhouette. Maybe a slim ticker
   above or below the panels.
3. **Tile click feedback during PLAN.** Tiles still respond to
   clicks but lead nowhere (the shop is disabled during PLAN).
   Either visually grey them out or hide the tile grid during PLAN
   and reuse the center panel for queued-action display.
4. **Move forward with carry-overs from session 12.**
   Bomb planned-cell indicator, tower rotation, Hulk balance,
   more cyborg variety (Assassin / Berserker) — listed in the
   session 12 close-out and still relevant.


## Session 14 (2026-05-21) — Faction × role, HUD redesign, recurring UI failures

### What landed
- **Cleanup pass.** Deleted 91 MB of unused GLBs (`public/models/powercore/`),
  removed dead `PowerCore.ts` / `BattlePhase.ts` / `AIPlayer.ts` (~680 lines),
  removed the dead Three.js lighting rig from `Game.ts`. Parallelized
  `preloadSpriteUnit` animation-frame loads (was serial inside each unit).
- **Faction × role pivot, then walk-back.** First built a 4-card side
  picker (Robot Defender / Robot Attacker / Cyborg Defender / Cyborg Attacker)
  with team tinting (player blue, AI red) for same-faction matchups.
  After multiple UX issues the user pulled it back to **2 cards**
  (DEFENDER Robots / ATTACKER Cyborgs) coupled to fixed factions. AI
  always gets the opposite role + opposite faction. `Faction` and `Role`
  types in `GameConfig.ts` remain in case same-faction returns.
- **Team tint disabled.** `TEAM_TINT.player` and `TEAM_TINT.ai` are both
  `0xffffff` (identity) since same-faction matchups aren't a thing right
  now. Per-type tints (Grenadier green / Doublegun orange / Sniper olive)
  also removed at user request — `SPRITE_TINT` is now `{}`. Pieces render
  with their natural sprite-art colors.
- **HUD center panel rebuild.** READY (BUILD) and BATTLE (PLAN) buttons
  moved from `#bottom-bar` / `#plan-bar` into the center HUD panel as
  `.center-action-btn`. **Planning phase skipped from BUILD.** New
  `startBattleFromBuild` tears down BuildPhase and calls `enterRevealPhase`
  directly — one click instead of READY → BATTLE. `enterPlanningPhase`
  kept in source but unreachable from BUILD; available to re-enable later.
- **Center panel SVG redesigned.** Dropped the protruding banner-notch
  shape (was 30% wide, title needed 60%+ — text overflowed). New panel
  is a clean chamfered rectangle with two internal divider lines that
  split it into three "console sections": title bar (y=4..58), content
  (y=58..158), action bar (y=158..206). HTML structure mirrors with
  `.cc-title` / `.cc-body` / `.cc-action` grid rows.
- **Center content reflow.** Credits chip centered on its own line.
  New `.center-matchup` line shows "ROBOTS VS CYBORGS" (or
  "CYBORGS VS ROBOTS" for attacker), faction names colored by role
  (defender blue, attacker red). Static `.center-message` replaced with
  `.center-events` — single-line in-place status replacement (was a
  scroll feed that clipped at the panel's tight height).
- **Camera Y offset.** With the canvas full-window and the HUD floating
  on top, the world's top edge was rendering behind the HUD tiles.
  Added `computeCameraYOffset(halfH)` in `Game.ts` that reads the CSS
  `--hud-top-h` variable and shifts the camera Y so world top aligns
  with HUD bottom. Pan still works relative to this new center
  (delta-applied on resize so user pan offsets don't reset).
- **Wheel-event scroll fix.** `onWheel` in `Game.ts` called
  `e.preventDefault()` for camera zoom on `window`. That fired even
  when the cursor was over HUD overlays, blocking native scroll inside
  the side picker. Added `if ((e.target as HTMLElement).closest('#hud'))
  return` guard so HUD overlays scroll naturally.
- **HUD shop trim.** 5×2 grid (10 tiles per side, padded with duplicates)
  → 4×2 grid (8 per side). Defender now has 8 unique pieces (dropped
  duplicate GUN + single GUN). Cyborg has 5 unique + 3 duplicates until
  new art is generated.
- **Typography.** Loaded Orbitron from Google Fonts (500/700/900). Used
  for BUILD PHASE title, matchup line, credits chip, READY/BATTLE button.
  Bigger sizes throughout per user feedback ("you default TINY").
- **Memory pivot.** Strengthened `feedback_ui_viewport_checklist` with
  hard rules: clamp() everything, no media-query cliffs, no em dashes in
  user-visible text, test 1366×768 + 1024×768 + 768×1024 + 600×800
  before commit, regression-audit ALL gameplay screens after HUD changes.

### Hard-won lessons (also saved as memory feedback)
- **The user tests on real viewports. Always.** This session shipped
  ~four versions of the side picker that overflowed common laptop
  viewports because I'd designed in a wide reference and not mentally
  walked through narrow ones. Eventually fixed by switching every size
  to `clamp()` and using the safe-centering pattern
  (`overflow: auto` outer + `min-height: 100%` flex inner).
- **HUD changes ripple into the gameplay canvas.** Transparency on
  panels exposed the fact that the world's top row was always rendering
  behind the HUD. Fix was a camera Y offset, not a transparency revert.
  Lesson: when touching the HUD, test the BUILD/PLAN/REVEAL gameplay
  screens too, not just the HUD itself.
- **One global wheel-preventDefault breaks every scrollable overlay.**
  The side-picker scroll bug had nothing to do with the picker — it
  was the camera-zoom wheel handler eating the events. Guard
  `preventDefault` to non-HUD targets.
- **READY → BATTLE was redundant.** Two confirmation buttons for the
  same intent ("start the fight") felt clunky. Skipping PLAN entirely
  for now is fine; RevealPhase's default-action heuristics handle every
  piece without queued moves. PLAN comes back as an opt-in feature
  when there's a real reason to plan (e.g., Hulk slam targeting).
- **Em dashes are a hard NO** in user-visible text. The user called this
  out and I kept slipping em dashes into status messages. Now in memory.
- **"You default TINY."** When in doubt, bigger fonts. Especially for
  the side picker explainer, status messages, and tile labels.
- **Color conventions in this project:** ROLE colors are settled —
  defender=blue, attacker=red. Player vs AI tinting is OFF (was confusing
  layered on top of role colors and per-type tints). Side picker cards
  are colored by ROLE (DEFENDER card blue, ATTACKER card red), not faction.

### Memory entries added/updated this session
- `feedback_ui_viewport_checklist` — STRENGTHENED. clamp() rules,
  4 named viewports to test, safe-centering pattern, regression audit
  checklist for HUD changes, recurring failure log.
- `feedback_always_deploy_after_fix` — STRENGTHENED to explicitly ban
  the words "local", "localhost", "dev server", and "preview" in
  verification step language (was being violated repeatedly).

### Suggested next-session opening moves
1. **Cyborg art expansion.** The cyborg side has 3 duplicates in the
   shop because we only have 5 distinct cyborg pieces. Generate
   PixelLab art for Assassin (60cr, fast, diagonal-capable) and
   Berserker (80cr, frenzy when low HP) per the carry-over from S12.
   That brings cyborgs to 7 unique + 1 dupe, much closer to symmetric.
2. **Define the 3 "preview" defender pieces.** DEFENSE, LASER, SIGNAL
   exist as shop tiles but their unique mechanics aren't implemented.
   Pick distinct behaviors: e.g., DEFENSE = stationary shield that
   absorbs N hits, LASER = pierce-through-line damage, SIGNAL = passive
   buff to adjacent towers.
3. **HUD polish carry-overs.** Tile-click feedback during PLAN
   (greyed-out shop or hidden), in-game stat indicators when hovering
   a piece on the board, win/lose overlay redesign in the new console
   aesthetic.
4. **Carry-overs from S12/S13** still relevant: bomb planned-cell
   indicator, tower rotation, Hulk balance pass.

### Open friction points
- The cyborg-side shop has visible duplicates (CANNON / GRENADIER /
  HULK each appear twice). Functionally fine — same pieces, same costs
  — but visually obvious. Either generate new art or hide the duplicates
  (would leave 3 empty grid slots).
- "Preview" defender pieces (DEFENSE / LASER / SIGNAL) only have
  generic Structure behavior in the code; no unique mechanics yet.
- Center panel still feels improvable per user ("one day we will get
  this to look nice ;)" was the polite signal). Areas for future
  polish: typography on body text, divider line treatment, the corner
  rivet decoration, microinteractions on credit/phase changes.
