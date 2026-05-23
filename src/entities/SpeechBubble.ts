import * as THREE from 'three'

// Status callouts that pop above units / structures when they hit a
// significant threshold (low HP, low ammo, out of ammo). Self-managed:
// each bubble adds itself to the scene, runs its own RAF animation,
// disposes its material on completion. Texture is cached by (voice, text).
//
// Two voices keep the personality consistent:
//   'cyborg' — casual lines with italics, used by attacker units
//   'robot'  — mechanical ALL-CAPS, used by defender units + structures

export type SpeechVoice = 'cyborg' | 'robot'
export type SpeechTrigger =
  | 'low_hp' | 'low_ammo' | 'out_of_ammo'
  | 'sniper_shot' | 'medic_low_packs'

// Lines may include {n} (count) and {s} (auto-pluralizer: '' if n==1
// else 's') so "{n} shot{s} left!" renders "1 shot left!" / "3 shots left!"
// without per-count duplicates. Robot voice uses {S} for capital 's'.
const LINES: Record<SpeechVoice, Record<SpeechTrigger, string[]>> = {
  cyborg: {
    low_hp:           ["MEDIC!!", "Where's the medic?", "Aaargh!", "I'm hit!", "Need a patch!", "Bleeding out!"],
    low_ammo:         ["{n} shot{s} left!", "Down to {n}!", "Last few rounds!", "Almost out!"],
    out_of_ammo:      ["I'm out!", "Down to fists!", "Need ammo!", "Pistol's dry!"],
    sniper_shot:      ["Lining one up... shot.", "Target acquired... gone.", "One shot, one kill.", "Eagle eye."],
    medic_low_packs:  ["{n} pack{s} left!", "Running low on supplies!", "Down to {n} kit{s}!"],
  },
  robot: {
    low_hp:           ["SYSTEMS CRITICAL", "INTEGRITY: LOW", "DAMAGE: SEVERE", "ARMOR FAILING"],
    low_ammo:         ["{n} ROUND{S} LEFT", "AMMUNITION: {n}", "RESERVES LOW"],
    out_of_ammo:      ["AMMUNITION DEPLETED", "WEAPON OFFLINE", "RELOAD UNAVAILABLE"],
    sniper_shot:      ["TARGET ELIMINATED", "MARK STRUCK", "ONE SHOT CONFIRMED"],
    medic_low_packs:  ["REPAIR CHARGES: {n}", "{n} CHARGE{S} LEFT", "SUPPLIES DEPLETING"],
  },
}

export interface SpeechContext {
  /** Substituted into {n} in the line template. Undefined → no substitution. */
  n?: number
}

// One canvas texture per unique (voice, text). Repeat lines on later
// units reuse the texture instead of re-rendering the canvas.
const textureCache = new Map<string, THREE.Texture>()

function makeTexture(text: string, voice: SpeechVoice): THREE.Texture {
  const key = `${voice}:${text}`
  const cached = textureCache.get(key)
  if (cached) return cached

  // Canvas was 256 wide — too tight for 22px Courier monospace robot
  // lines like "AMMUNITION DEPLETED". Bumped to 320 so both voices can
  // render at the same point size without clipping.
  const W = 320
  const H = 80
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const ctx = c.getContext('2d')!

  // Voice-specific palette. Cyborgs: warm dark red bubble with peach
  // text + italic sans serif (organic, panicked). Robots: cold dark
  // blue bubble with light-blue text + bold monospace (computerized).
  const bgFill = voice === 'cyborg' ? 'rgba(45, 18, 22, 0.94)' : 'rgba(14, 28, 44, 0.94)'
  const bgStroke = voice === 'cyborg' ? '#dd8888' : '#88c8ff'
  const textColor = voice === 'cyborg' ? '#ffe0d0' : '#d8f0ff'
  // Both voices use the same size (22px) — robot was 18px and unreadable
  // alongside the cyborg lines. Monospace at 22 just barely fits the
  // widest robot lines ("AMMUNITION DEPLETED") in the 256-wide canvas.
  const font = voice === 'cyborg'
    ? 'italic 700 22px "Helvetica Neue", sans-serif'
    : '700 22px "Courier New", monospace'

  // Rounded-rect speech bubble with a downward tail centered on the body.
  const r = 10
  const padL = 8, padR = 8, padT = 4, tailH = 12
  const bodyTop = padT
  const bodyBottom = H - tailH - 4
  ctx.beginPath()
  ctx.moveTo(padL + r, bodyTop)
  ctx.lineTo(W - padR - r, bodyTop)
  ctx.arcTo(W - padR, bodyTop, W - padR, bodyTop + r, r)
  ctx.lineTo(W - padR, bodyBottom - r)
  ctx.arcTo(W - padR, bodyBottom, W - padR - r, bodyBottom, r)
  // Tail: right side of opening → tail tip → left side of opening
  ctx.lineTo(W / 2 + 10, bodyBottom)
  ctx.lineTo(W / 2, bodyBottom + tailH)
  ctx.lineTo(W / 2 - 10, bodyBottom)
  ctx.lineTo(padL + r, bodyBottom)
  ctx.arcTo(padL, bodyBottom, padL, bodyBottom - r, r)
  ctx.lineTo(padL, bodyTop + r)
  ctx.arcTo(padL, bodyTop, padL + r, bodyTop, r)
  ctx.closePath()
  ctx.fillStyle = bgFill
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = bgStroke
  ctx.stroke()

  // Text — centered in the body region (above the tail).
  ctx.font = font
  ctx.fillStyle = textColor
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, W / 2, (bodyTop + bodyBottom) / 2)

  const tex = new THREE.CanvasTexture(c)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.colorSpace = THREE.SRGBColorSpace
  textureCache.set(key, tex)
  return tex
}

// Drop a speech bubble at (x, y) — bubble's TAIL TIP anchors at that
// position, so callers pass the speaker's head position. Picks a random
// line from the voice/trigger table. Self-disposes after ~1.8 seconds.
export function spawnSpeechBubble(
  scene: THREE.Scene,
  x: number, y: number,
  voice: SpeechVoice,
  trigger: SpeechTrigger,
  context: SpeechContext = {},
) {
  const lines = LINES[voice][trigger]
  const raw = lines[Math.floor(Math.random() * lines.length)]
  // Substitute {n} (count) and {s}/{S} (auto-pluralizer — empty when
  // n==1, else 's'/'S'). Lines without {n} pass through unchanged.
  let text = raw
  if (context.n !== undefined) {
    const s = context.n === 1 ? '' : 's'
    text = text.replace(/\{n\}/g, String(context.n))
               .replace(/\{s\}/g, s)
               .replace(/\{S\}/g, s.toUpperCase())
  }
  const tex = makeTexture(text, voice)
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true,
    depthTest: false, depthWrite: false,
  })
  const sprite = new THREE.Sprite(mat)
  // Bubble world size. Canvas is 320×80 (4:1); render at 140 wide so
  // text reads at roughly the same in-world height as before the canvas
  // was widened.
  const BUBBLE_W = 140
  const BUBBLE_H = (H_TO_W * BUBBLE_W)
  sprite.scale.set(BUBBLE_W, BUBBLE_H, 1)
  // Tail tip is at the bottom-center of the sprite. Position the sprite
  // so the tail tip is ~30 units above the speaker.
  const tailTipOffset = 30
  sprite.position.set(x, y + tailTipOffset + BUBBLE_H / 2, 7)
  sprite.renderOrder = 25
  scene.add(sprite)

  const startY = sprite.position.y
  const start = performance.now()
  const DUR = 1.8

  const tick = () => {
    const elapsed = (performance.now() - start) / 1000
    if (elapsed >= DUR) {
      sprite.removeFromParent()
      mat.dispose()
      // Texture stays in the cache for reuse — don't dispose.
      return
    }
    // Slight upward drift over lifetime so the bubble doesn't feel pinned.
    sprite.position.y = startY + 6 * (elapsed / DUR)
    // Fade in (0.15s) → hold → fade out (0.4s).
    let alpha = 1
    if (elapsed < 0.15) alpha = elapsed / 0.15
    else if (elapsed > DUR - 0.4) alpha = Math.max(0, (DUR - elapsed) / 0.4)
    mat.opacity = alpha
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

const H_TO_W = 80 / 320
