# AstroHold — Pixel-Perfect Rendering

S21 foundation contract for crisp pixel art at any window size. The
goal: each artist-drawn texel maps to an integer number of screen
pixels, every frame, regardless of device pixel ratio or browser zoom.

## The contract

- **`Config.PPWU = 2`** — pixels per world unit at base zoom. The
  internal renderer canvas is locked to `WORLD_WIDTH_WU * PPWU = 2400`
  px wide. Height matches the viewport aspect.
- **`renderer.setPixelRatio(1)`** — devicePixelRatio never multiplies
  the texture sample rate. The browser does the final stretch to the
  display via CSS.
- **`renderer({ antialias: false })`** — we want hard pixel edges, not
  shader-AA-smoothed ones.
- **`canvas.style.imageRendering = 'pixelated'`** — browser
  nearest-neighbor upscale from internal canvas to CSS pixels. Without
  this, the final blit on a 4K monitor or zoomed browser would smooth.
- **Render-time position snap** — every frame, before
  `renderer.render`, top-level scene children + the camera have their
  `position.x / .y` rounded to nearest `1 / PPWU` wu (= 0.5 wu at
  PPWU=2). Snaps integer screen pixel; gameplay logic still floats.
- **NearestFilter on pixel-art textures** — sprite, structure, pad,
  ammo box, power core all set `min/magFilter = NearestFilter`.
  Procedural soft VFX (shadows, gradients, glows, speech bubbles)
  stay on `LinearFilter` because their continuous gradients have no
  native pixel grid to preserve.

## Render-time snap (the safety net)

`Game.snapForRender()` runs once per frame between the gameplay update
pass and `renderer.render`. It iterates only `scene.children` (top
level — child sprites/HP bars/shadows ride on their parent's snapped
transform) and quantizes `.position.x / .y` to nearest `1 / PPWU` wu.

Gameplay-truth lives on `entity.worldX` / `entity.worldY` (which return
`logicalX` / `logicalY`, not `mesh.position`). Snapping `mesh.position`
is cosmetic — the next `update()` chase loop reads logicalX and walks
from the snapped position with no accumulating drift.

## HUD icons keep native resolution (S21 session 2.1)

The HUD tiles + side-picker hero images reference `/hud_icons/<folder>.png`,
NOT the gameplay `/sprites/<folder>/south.png`. Reason: HUD tiles display
at a larger size than the gameplay sprite, so upscaling a 60-px gameplay
sprite to fill an 80-200-px HUD tile would produce chunky uneven texels
(non-integer CSS scale with `image-rendering: pixelated`).

The `/hud_icons/` copy is the pre-S2 native-resolution PNG (104-124 px),
which CSS can downscale smoothly. When you add a new HUD-displayed piece,
copy a 100+ px source PNG into `/public/hud_icons/<folder>.png` and
reference it in `HUD.ts`.

## Native PNG sizes match render targets (S21 session 2)

Every sprite folder's PNGs have been nearest-neighbor downsampled to
match the per-type target world-unit size (which is also the on-screen
pixel size at PPWU=2 and zoom 1). Hulk PNG 108 -> 84, Sniper 104 -> 60,
Phaser 120 -> 40, etc. The `SPRITE_SIZE_OVERRIDE` tables in
`SpriteUnit.ts`, `Structure.ts`, and the `SPHERE_SCREEN_SIZE` constant
in `SphereDefender.ts` now match the source PNG dimensions exactly.

Result: 1 source texel = 1 world unit = 2 screen pixels at PPWU=2.
Clean integer upscale at every default-zoom render. No texel data
discarded at runtime.

Re-running `scripts/downsample_sprites.py` is idempotent (the script
skips files already at the target size). Use it when you commission
new sprite art that comes in oversized.

The override tables stay as per-piece visual hierarchy knobs. If a
piece feels too small, bump its override value — the renderer will
NearestFilter upscale the PNG to the larger wu size. That break the
clean 1:1 ratio for that one piece but is visually subtle for ratios
close to 1.

## What S21 did NOT do (future sessions)

- **Zoom-aware PPWU.** Mouse-wheel zoom changes the camera frustum
  continuously, breaking the integer PPWU contract at non-default
  zoom levels. Grid lines shimmer slightly during zoom. Fix: snap
  zoom factor to discrete integer-PPWU steps (1x, 2x, 0.5x).
- **Integer-multiple canvas upscale.** Today the browser stretches
  the 2400-px-wide internal canvas to whatever CSS width the window
  is (e.g. 1920 px = 0.8x). With `imageRendering: pixelated` this is
  nearest-neighbor but non-integer scale produces slightly uneven
  texel sizes. A future pass could letterbox to the nearest integer
  multiple instead.
- **Skipped folders.** `cyborg_gatling`, `cyborg_sentry`,
  `freeze_mine`, `grenade_*`, `powercore` were not downsampled.
  First three are staged but unused. Powercore's native (124) is
  smaller than its target (150), so downsample would do nothing.
  Re-export from PixelLab at the target sizes when these go live.

## What to do when adding new visuals

- **Artist-drawn PNG sprite?** Use `NearestFilter` + `SRGBColorSpace`
  on the texture. Position the sprite in float wu; the render snap
  handles screen-pixel alignment.
- **Procedural gradient / glow / soft VFX?** `LinearFilter` is fine.
  Document the choice in a comment if it's not obvious why nearest
  was skipped (we already do this in Background.ts, Shadow.ts, etc.).
- **Mouse-position handling?** Existing raycaster code uses
  `clientX / clientY` against `window.innerWidth/Height` — that's CSS
  pixels, not internal canvas pixels. The camera frustum lives in wu,
  so the NDC math works regardless. Don't touch this without testing
  placement + zoom + pan together.

## How to verify

After any render-path change:
1. Reload at default zoom — sprites should be razor-sharp.
2. Resize the browser slowly — sprites should snap visibly (1-pixel
   jumps) rather than smear smoothly. Smear = the snap isn't running.
3. Browser-zoom in (Cmd-plus). Each step should be pixelated, not
   anti-aliased.
4. Walking units should not "wobble." Faster movement is more
   forgiving than near-stationary drift — watch the slowest piece
   (Hulk speed 45) for jitter.
