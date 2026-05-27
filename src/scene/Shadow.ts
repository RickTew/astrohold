import * as THREE from 'three'

// Soft elliptical drop-shadow sprite, shared helper. One per piece.
// Style: see docs/VISUAL_STYLE.md (Vector-Grid Pixel Hybrid). Side-themed
// tints (blue for defender, red for attacker) double as a quick side-
// identity cue. Grounded pieces sit at their visible feet; only the
// floating Sphere gets an offset shadow to read the gap.
//
// Implementation notes:
//   - Texture: single 256x128 canvas with a radial gradient, ellipse-
//     shaped because the canvas itself is 2:1. Cached per-side so all
//     pieces share one GPU texture.
//   - Position offset: every game sprite has its visible content from
//     ~27% to ~74% of its PNG (measured offline with PIL — see
//     `feedback_measure_dont_guess_sprite_offsets`). The visible feet
//     sit at -0.24 * sprite_size below the mesh center. Grounded
//     shadow centers there. Floating shadow sits at -0.45 (well below
//     the visible body, gap visible).
//   - depthTest:false + renderOrder:9 so the shadow draws under the
//     unit sprite (renderOrder:10) without depth conflict.

type ShadowSide = 'defender' | 'attacker'

const TEX_CACHE = new Map<ShadowSide, THREE.Texture>()

function shadowTexture(side: ShadowSide): THREE.Texture {
  const cached = TEX_CACHE.get(side)
  if (cached) return cached

  const W = 256
  const H = 128
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!

  // Strategy-board feel: the shadow reads as the piece's BASE (like a
  // miniature standing on a token). Dark core holds a plateau through
  // mid-radius for a "solid disk" look, then a tinted ring fades to
  // transparent at the rim. The dark core must be darker than the
  // floor to actually darken (blue ring alone on warm dust brightens
  // B/G channels instead of darkening — shadow vanishes).
  const core = side === 'defender' ? '12, 20, 38' : '40, 12, 15'
  const ring = side === 'defender' ? '50, 95, 160' : '160, 55, 65'
  const grad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2)
  grad.addColorStop(0,    `rgba(${core}, 0.92)`)
  grad.addColorStop(0.55, `rgba(${core}, 0.72)`)
  grad.addColorStop(0.80, `rgba(${ring}, 0.38)`)
  grad.addColorStop(0.94, `rgba(${ring}, 0.10)`)
  grad.addColorStop(1,    `rgba(${ring}, 0)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)

  const tex = new THREE.CanvasTexture(c)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  TEX_CACHE.set(side, tex)
  return tex
}

type ShadowOpts = {
  size: number
  side: ShadowSide
  floating?: boolean
}

export function makeShadowSprite({ size, side, floating }: ShadowOpts): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: shadowTexture(side),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    opacity: 0.95,
  })
  const sprite = new THREE.Sprite(mat)
  // Slightly wider + taller than the soft-shadow look so the base disk
  // reads from any zoom level. Still narrower than the cell so adjacent
  // pieces don't have overlapping bases.
  sprite.scale.set(size * 0.62, size * 0.20, 1)
  const yOffset = floating ? -0.45 : -0.24
  sprite.position.set(0, size * yOffset, 4)
  sprite.renderOrder = 9
  return sprite
}
