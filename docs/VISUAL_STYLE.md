# Visual Style Guide

## The Style: Vector-Grid Pixel Hybrid (a.k.a. High-Definition Retro)

A modern, tactical digital board game with classic-fantasy pixel-art miniatures placed on top. Pixel sprites carry the soul. Everything else (floors, walls, HUD, dashboards, text, speech bubbles, menus) is rendered with crisp procedural geometry and modern web typography.

We are NOT trying to fake a Super Nintendo era look. We are leaning into the contrast: pixel art for the pieces, vector precision for the table they sit on.

Reference touchstones: XCOM tactical UI, classic fantasy sprite charm, modern web app polish.

## Framework-neutral

This style applies across the studio's games regardless of engine. Most projects ship in Phaser; AstroHold is the Three.js experiment to see whether a sprite-first Three.js pipeline holds 60+ FPS for this kind of tactical game. The visual rules (split-brain, procedural floors, modern typography, crisp UI) are identical either way. The implementation notes below call out engine-specific patterns where they matter (e.g. drop shadow as a `THREE.Sprite` in AstroHold vs. Phaser's built-in shadow / blend options elsewhere).

## Why this style works

1. Legibility. True retro pixel text is unreadable on a stats-heavy card or dashboard. High-resolution vector-crisp fonts feel premium, scan instantly, and survive 1366x768 laptop screens.
2. Performance. Procedural shapes (flat fills, gradients, vector strokes) render instantly and hold 60+ FPS without texture sheets. The engine draws math, not bitmaps.
3. Layer depth. A smooth modern floor lets pixel sprites pop off the screen. They read as distinct, stylized pieces on a tactical board, not blurred into the environment.

## The Split-Brain Rule

The single most important rule. Every visual element falls into exactly one bucket.

### Pixel Art (fixed-resolution sprites)
- Characters, units, structures
- Monsters, enemies
- Pickups: chests, ammo crates, objects
- World objects with personality: house, door, etc.

These provide flavor, identity, and the fantasy-game feel.

### Procedural Canvas (vector-clean geometry)
- Floor grid tiles
- Walls (already done: procedural laser-wall in S16)
- Speech bubbles
- Menus, dashboards, modals
- HUD panels, action buttons, status text
- All typography
- VFX overlays (heal glow, shield aura, electric zone, death explosion ring)

These provide clarity, speed, and modern precision.

If you're about to add a new visual, ask which bucket it belongs in BEFORE choosing the implementation. Almost no element should mix the two within itself.

## The Floating Board Aesthetic

Treat the procedural map as a high-tech digital gaming table. Treat the pixel-art sprites as miniatures placed on top of it. Do not blend the styles with cross-texture shaders or pixelated overlays on procedural elements.

To ground the sprites:
- Cast a subtle, slightly transparent drop shadow under each pixel sprite onto the floor tile.
- Shadow is procedural (a soft elliptical alpha-blended quad), NOT a baked sprite. It tracks the unit and scales with movement / death.
- Keep shadows soft and low-contrast. They should read as grounding, not as a graphical effect.

Implementation notes by engine:
- AstroHold (Three.js): a separate `THREE.Sprite` or flat `THREE.Mesh` at the same `x,y` with `renderOrder` below the unit but above the floor. Soft elliptical alpha texture, no real-time light casting.
- Phaser projects: a separate `Sprite` or `Graphics` ellipse drawn under the unit at a lower depth, alpha-blended. Phaser also has built-in `setPipeline('Light2D')` if you want shadows that react to in-scene lights.

Either way, keep the shadow procedural and tunable from one place. Do not bake shadows into the sprite art.

## Typography Rules

- NEVER use pixelated fonts anywhere in the UI. No exceptions.
- All numbers, card text, status text, combat log, and labels use modern crisp web fonts.
- Headlines / phase titles: Orbitron (already in use).
- Body / numeric / log text: a modern sans-serif (system default or Inter). Keep weight and tracking consistent across panels.
- Cost chips, HP readouts, ammo counters: tabular figures so columns of numbers align.
- Size with `clamp()`, never fixed px, so the HUD survives every laptop viewport.

## Menus and Dashboards

- Round corners (subtle, not chunky).
- Subtle gradients, not flat fills, for panel backgrounds (already done on the MCC dial and side-picker cards).
- Crisp 1px borders with vector-effect non-scaling-stroke when using SVG (already the pattern for the three HUD panels).
- Color theming follows role: defender = blue, attacker = red. Never tint pixel sprites to convey side; position and the procedural UI carry that information.

## Color and Light

- Floor / ground: flat subtle color gradient per cell, NOT a tile texture. The gradient shifts based on light sources (torch indoors, ambient outdoors). See Test Lab below.
- Grid lines: 1px razor-sharp vector border, dim by default, bright cyan when hovered or selected for player-controlled actions.
- VFX color discipline:
  - Defender / friendly: cyan, white, soft blue.
  - Attacker / hostile: red, peach, warm orange.
  - Neutral / world: amber for crates, magenta for electric zones.
- Additive-blend VFX: pick blue-leaning bases (0x33aaff) over white-leaning (0x88ffff). Green and blue channels saturate fast on dark backgrounds and white-leaning bases wash out. See `feedback_additive_blend_color_choice` memory.

## Current State Check (AstroHold)

What already follows the style:
- Pixel-art combatants on a Three.js sprite-only render path.
- HUD uses three SVG-silhouetted panels with Orbitron titles and vector-clean borders.
- Procedural laser-wall (S16) replaced the pixel-art wall.
- Shield aura, electric core zone, heal VFX, death explosion, and the Mini Control Center are all procedural.
- Side-picker modal is procedural with crisp role-themed cards.
- Speech bubbles use canvas-drawn modern type (cyan mono robots, peach italic cyborgs).
- **Floor is Dusty Planet** (S20). Three layered procedural gradients (vertical fade plus two soft warm pools) replace the old Perlin dust texture. Pure vector-clean per the style guide; no noise, no specks. See `src/scene/Background.ts`. Source-of-truth color stops live in the FLOOR COLOR LAB variant 2 of `/build-test.html`.

What still needs to move toward the style:
- No drop shadows under pixel sprites yet. Add a procedural soft-ellipse shadow per unit (grounded pieces sit at feet, only Sphere floats with offset shadow).
- Grid lines do not react to hover during BUILD or player actions. Add cyan hover-glow on the cell under the placement ghost.
- Combat log row styling is functional but could pick up the same gradient + border treatment as the panels.

## Test Lab Ideas (for `/build-test.html` and future test pages)

The build-test sandbox is the right surface for any of these. Stage in the AFTER row, get sign-off, then port to production.

1. Gradient floor. Each grid cell gets a flat subtle color gradient (NOT a tile texture). Indoors: gradients shift based on torch / light-source position. Outdoors: a global lighting direction. Implementation: a single fullscreen vector overlay with per-cell radial gradients, or a fragment-shader plane.
2. Hover-glow grid borders. 1px vector grid lines stay dim by default. The cell under the cursor (during BUILD placement, or player action in future modes) gets a 1px yellow / cyan border glow. Selected paths could trace a brighter color along the route.
3. Drop shadows. Soft elliptical alpha shadow per pixel sprite. Tunable: shadow scale, opacity, blur. Try a single-light setup first (top-down soft, slightly offset south) before per-light shadow casting.
4. Floor light pools. Place a procedural radial gradient pool under torch / structure light sources. Pieces inside the pool read brighter against the dim baseline.
5. Card / dashboard panel polish. Round-corner cards with subtle vertical gradient and crisp 1px border. Test the look against the existing HUD panel silhouettes so they share a visual family.

Each experiment should ship as its own row in the sandbox with a BEFORE / AFTER comparison, same pattern we use for HUD changes.

### Test-lab assets rule

Every test-lab mockup must include real game assets on top of (or in place of) any placeholder shapes. Pull from `/public/sprites/` and use `image-rendering: pixelated` so the source pixel art stays crisp. At minimum show a defender piece and a cyborg piece per stage so both color sides are represented. Placeholder colored boxes alone are not enough to evaluate a visual direction.

## Hard Rules (carry over from CLAUDE.md and memory)

- No em dashes anywhere. Use periods, commas, hyphens, or reword. See `feedback_no_em_dashes_ever`.
- Mouse-only UI. No keyboard commands. See `feedback_no_keyboard_commands`.
- HUD is locked. Visual edits to the HUD must go through the build-test sandbox first. See the HUD HARD LOCK section in CLAUDE.md.
- Player vs AI team tinting is OFF for sprites. Position and procedural UI carry side identity, not sprite color. See the Color conventions section in CLAUDE.md.

## When to update this doc

- New procedural visual lands: add it to "What already follows the style".
- New pixel-art unit lands: it does NOT need a mention here unless the integration introduced a new shadow / grounding pattern.
- New test-lab experiment runs: add the result to "Test Lab Ideas" or graduate it to "What already follows the style".
- Hard rule changes: update the rules section AND the related memory file.
