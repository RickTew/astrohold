import * as THREE from 'three'

// Soft elliptical drop-shadow sprite, shared helper. One per piece.
// Strategy-game miniature-base feel: light, single sprite, single
// cached texture per side. See docs/VISUAL_STYLE.md.
//
// Implementation:
//   - Texture: SQUARE canvas (256x256) so the radial gradient
//     reaches alpha 0 at every edge. A 2:1 canvas clipped the top
//     and bottom of the gradient at ~0.5 alpha, giving a flat-topped
//     and flat-bottomed ellipse in-game.
//   - Side-themed: dark core (does the actual darkening) + lighter
//     ring (carries blue/red side identity). On the warm Dusty
//     Planet floor a blue-tinted gradient alone would brighten the
//     B/G channels instead of darkening — the core fixes that.
//   - Foot offset: position is computed from a `footFraction` arg
//     (the % of PNG height where the sprite's visible bottom sits).
//     Standard game sprites are 0.74; laser/gun/signal extend much
//     lower (0.91 / 0.97 / 0.98). Without this, shadows on those
//     pieces hide behind the opaque sprite body and read as missing.
//   - depthTest:false + renderOrder:9 so the shadow draws below the
//     unit sprite (renderOrder:10) without depth conflict.

type ShadowSide = 'defender' | 'attacker'

const TEX_CACHE = new Map<ShadowSide, THREE.Texture>()

function shadowTexture(side: ShadowSide): THREE.Texture {
  const cached = TEX_CACHE.get(side)
  if (cached) return cached

  const SQ = 256
  const c = document.createElement('canvas')
  c.width = SQ
  c.height = SQ
  const ctx = c.getContext('2d')!

  const core = side === 'defender' ? '12, 20, 38' : '40, 12, 15'
  const ring = side === 'defender' ? '50, 95, 160' : '160, 55, 65'
  const grad = ctx.createRadialGradient(SQ / 2, SQ / 2, 0, SQ / 2, SQ / 2, SQ / 2)
  grad.addColorStop(0,    `rgba(${core}, 0.78)`)
  grad.addColorStop(0.50, `rgba(${core}, 0.50)`)
  grad.addColorStop(0.78, `rgba(${ring}, 0.22)`)
  grad.addColorStop(1,    `rgba(${ring}, 0)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, SQ, SQ)

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
  // Visible-bottom of the PNG as a fraction of PNG height. Defaults
  // to 0.74 which matches the bulk of the game roster. Override per
  // piece for sprites with feet extending farther down: laser ~0.91,
  // gun ~0.97, signal ~0.98.
  footFraction?: number
}

export function makeShadowSprite({
  size,
  side,
  floating = false,
  footFraction = 0.74,
}: ShadowOpts): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: shadowTexture(side),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    opacity: 0.88,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(size * 0.55, size * 0.13, 1)
  // Grounded: shadow center 2% past the visible feet (small halo
  // extends past the feet). Floating: 16% past feet for the float gap.
  const groundedY = (0.5 - footFraction - 0.02) * size
  const floatingY = (0.5 - footFraction - 0.16) * size
  sprite.position.set(0, floating ? floatingY : groundedY, 4)
  sprite.renderOrder = 9
  return sprite
}
