# AstroHold — Native 1:1 Pixel Art

The contract: **the artist's source PNG IS the on-screen sprite.** No
runtime scaling, no per-piece size tables, no downsampling. The PNG's
native pixel width is the sprite's world-unit size. The browser scales
the whole canvas at once via `image-rendering: pixelated`. This is the
"native 1:1 asset deployment" approach: small files, fast loads,
razor-sharp pixels.

## The contract

- **`Config.PPWU = 2`.** Internal canvas is locked to
  `WORLD_WIDTH_WU * PPWU = 2400` px wide; height matches viewport
  aspect. Each world unit = 2 internal pixels.
- **`renderer.setPixelRatio(1)`** + **`antialias: false`.** No
  devicePixelRatio multiplier on the texture sample rate. No
  shader-AA softening sprite edges.
- **`canvas.style.imageRendering = 'pixelated'`.** Browser
  nearest-neighbor scales the internal canvas to the actual window
  dimensions. Sprites stay crisp at any window size.
- **Sprite render-wu = source PNG pixel size.** Read from
  `texture.image.width` at preload, cached per piece type. A 108-px
  Hulk PNG renders at 108 wu = 216 screen pixels = clean 2x integer
  upscale (one source texel = a 2x2 screen pixel block). No per-piece
  scale knob.
- **Render-time position snap.** `Game.snapForRender()` quantizes top
  level scene children + camera to nearest `1 / PPWU` wu (= 0.5 wu)
  each frame. Snaps integer screen pixel; gameplay logic still floats.
- **NearestFilter on pixel-art textures.** Sprites, structures, pads,
  mines, ammo boxes, power core. Procedural soft VFX (Background
  Dusty Planet floor, shadows, glows, speech bubbles) intentionally
  stay LinearFilter — they're continuous gradients with no native
  pixel grid to preserve.

## Why no SPRITE_SIZE_OVERRIDE table

Earlier sessions had per-type scale tables (Hulk 84, Stalker 76,
Sniper 60, etc.) that multiplied texture rendering at runtime. That
is the anti-pattern the guide warns against:

> Instead of stretching the Paladin's file, the cleaner modern method
> is to keep the Paladin's file at 1:1, center him inside the larger
> structural tile container, and leave the extra pixels around him as
> empty space.

The tables are now gone. Visual hierarchy (Hulk bigger than a regular
cyborg) comes from the artist drawing Hulk on a 108-px canvas while
sniper is on a 104-px canvas. **The artist's chosen resolution per
piece IS the visual hierarchy.** Want a bigger Hulk? Commission a
larger PNG. Don't scale the existing one.

## Sprite overflows its cell — and that's fine

The grid cell is 50 wu (logical footprint: collision, occupancy,
placement). Most sprites are 104-124 px native, so they overflow
their cell visually by ~2x. That's intentional. The cell is what the
piece OCCUPIES; the sprite is what the piece LOOKS LIKE. They don't
have to match.

When two pieces stand on adjacent cells, their sprites overlap a bit.
Read order keeps the further-back piece behind the closer one
(top-down ordering by world Y).

## When you add a new piece

1. Commission the PNG at the visual size you want it to read on the
   field. Don't pick "what fits in a cell" — pick what looks right
   relative to the existing roster.
2. Drop it in `/public/sprites/<folder>/<dir>.png`.
3. Add the type to the appropriate preload (SpriteUnit / Structure /
   SphereDefender). `NATIVE_SIZE` populates automatically from the
   loaded texture's `.image.width`.
4. No size constants to update. No HUD icon copy. The HUD references
   the same `/sprites/<folder>/south.png` and the browser CSS-scales
   it down with `image-rendering: pixelated`.

## Render-time snap (the safety net)

`Game.snapForRender()` runs once per frame between the gameplay
update pass and `renderer.render`. It iterates `scene.children` (top
level only — children/shadows/HP bars ride on their parent) and
quantizes `.position.x / .y` to nearest `1 / PPWU` wu. Camera too.

Gameplay-truth lives on `entity.worldX` / `entity.worldY` (return
`logicalX` / `logicalY`, not `mesh.position`). Snapping `mesh.position`
is cosmetic — the next update() walks from the snapped position with
no accumulating drift.

## What S21 did NOT do

- **Zoom-aware PPWU.** Mouse-wheel zoom changes the camera frustum
  continuously, breaking the integer PPWU contract at non-default
  zoom levels. The grid lines shimmer slightly during zoom. Fix:
  snap zoom factor to discrete integer-PPWU steps (1x, 2x, 0.5x).
- **Integer-multiple canvas upscale.** The browser stretches the
  2400-px-wide internal canvas to whatever CSS width the window is
  (e.g. 1920 = 0.8x). With `imageRendering: pixelated` this is
  nearest-neighbor but non-integer scale produces slightly uneven
  texel sizes. A future pass could letterbox to the nearest integer
  multiple instead.

## How to verify

After any render-path change:
1. Reload at default zoom — sprites should be razor-sharp.
2. Cmd-plus browser zoom — every step should be pixelated, not
   anti-aliased.
3. Resize the browser slowly — sprites should snap visibly (1-pixel
   jumps) rather than smear.
4. Walking units shouldn't "wobble." The slowest piece (Hulk speed
   45) is the most forgiving test for jitter.
