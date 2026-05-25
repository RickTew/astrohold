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
  | 'crate_spotted' | 'rearmed'
  | 'no_repairs_needed'
  // ── S17.6 additions — not yet wired in RevealPhase ──
  // These triggers are documented in the line table and can be fired
  // from RevealPhase once we decide the timing/rate-limit story. Until
  // then the lines exist for design review on /build-test.html only.
  | 'on_kill' | 'on_death' | 'core_hit'

// Lines may include {n} (count) and {s} (auto-pluralizer: '' if n==1
// else 's') so "{n} shot{s} left!" renders "1 shot left!" / "3 shots left!"
// without per-count duplicates. Robot voice uses {S} for capital 's'.
//
// ⚠ KEEP IN SYNC: public/build-test.html has a CALLOUT MATRIX section that
// mirrors this table for design review. Update both when adding/changing
// lines so the sandbox reflects production.
//
// ── Weapon vocabulary policy (S17.7) ──────────────────────────────────
//   Robots  — synthetic, energy weapons ONLY. Vocabulary: charge, cell,
//             battery, pulse, beam, recharge, capacitor. NO "rounds",
//             NO "magazine", NO "reload" (those are kinetic concepts).
//   Cyborgs — augmented humans, MIX of kinetic and energy. Most lines
//             stay kinetic (shot, clip, pistol) since the cyborg art
//             carries gunpowder weapons, but a few energy-flavored
//             variants give the mix flavor.
//   Humans  — (future faction, not in game yet) kinetic ONLY.
// When adding new lines, keep robot voice strictly energy-flavored.
export const SPEECH_LINES: Record<SpeechVoice, Record<SpeechTrigger, string[]>> = {
  cyborg: {
    low_hp: [
      "MEDIC!!",
      "Where's the medic?",
      "I'm hit — cover me!",
      "Need a patch!",
      "Bleeding out!",
      "Still alive… barely.",
      "I'm melting!",
      "Patch me up!",
      "Rebooting brain…",
      "That hurt!",
    ],
    low_ammo: [
      "{n} shot{s} left!",
      "Down to {n}!",
      "Almost dry!",
      "Last few rounds!",
      "Charge low!",
    ],
    out_of_ammo: [
      "I'm out!",
      "Down to fists!",
      "Need ammo, now!",
      "Pistol's dry!",
      "Need juice!",
      "Cell's tapped!",
    ],
    sniper_shot: [
      "One shot, one kill.",
      "Target down.",
      "Headshot.",
      "Eagle eye.",
      "Take the shot!",
    ],
    medic_low_packs: [
      "{n} pack{s} left!",
      "Running low on supplies!",
      "Down to {n} kit{s}!",
      "Save the rest!",
    ],
    crate_spotted: [
      "Crate spotted!",
      "Resupply incoming!",
      "Ammo drop — on me!",
      "Mine!!",
    ],
    rearmed: [
      "Reloaded!",
      "Locked and loaded!",
      "Fresh clip!",
      "Back in the fight!",
      "Going in!",
      "Recharged!",
    ],
    no_repairs_needed: [],  // cyborg-side has no repair role
    on_kill: [
      "Who's next?",
      "Got one!",
      "Take that!",
      "Down!",
    ],
    on_death: [
      "They're cheating!",
      "I hate Mondays.",
      "Aaargh!",
      "Tell my mom…",
    ],
    core_hit: [
      "Core's ours!",
      "Crack that thing!",
      "Almost there!",
    ],
  },
  robot: {
    low_hp: [
      "SYSTEMS CRITICAL",
      "INTEGRITY: LOW",
      "DAMAGE: SEVERE",
      "ARMOR FAILING",
      "SYSTEM BREACH",
      "OVERHEAT",
      "ERROR DETECTED",
      "REBOOTING",
    ],
    low_ammo: [
      "{n} CHARGE{S} LEFT",
      "POWER CELLS: {n}",
      "RESERVES LOW",
      "BATTERY DEPLETING",
      "RECALIBRATING",
    ],
    out_of_ammo: [
      "POWER CELL DEPLETED",
      "WEAPON OFFLINE",
      "RECHARGE REQUIRED",
      "CAPACITOR EMPTY",
      "ENERGY EXHAUSTED",
    ],
    sniper_shot: [
      "TARGET ELIMINATED",
      "PRECISION SHOT CONFIRMED",
      "MARK STRUCK",
      "SINGLE-PULSE KILL",
      "TARGET LOCKED",
      "EXECUTING STRIKE",
    ],
    medic_low_packs: [
      "REPAIR CHARGES: {n}",
      "{n} CHARGE{S} LEFT",
      "WELD MATERIAL LOW",
      "SUPPLIES DEPLETING",
    ],
    crate_spotted: [
      "RESUPPLY DETECTED",
      "CRATE ON MAP",
      "TARGETING SUPPLY",
      "CACHE LOCKED",
      "DATA CONFIRMED",
    ],
    rearmed: [
      "POWER RESTORED",
      "RECHARGE COMPLETE",
      "ENERGY REPLENISHED",
      "CELL CYCLED",
      "POWER SURGE",
    ],
    no_repairs_needed: [
      "ALL SYSTEMS NOMINAL",
      "NO REPAIRS REQUIRED",
      "STANDING BY",
      "AWAITING DAMAGE REPORT",
    ],
    on_kill: [
      "TARGET NEUTRALIZED",
      "KILL CONFIRMED",
      "MARK DOWN",
      "ENEMY TERMINATED",
    ],
    on_death: [
      "UNIT OFFLINE",
      "SIGNAL LOST",
      "TERMINATING",
      "FATAL ERROR",
    ],
    core_hit: [
      "CORE HIT",
      "CORE BREACH",
      "CRITICAL TARGET STRUCK",
    ],
  },
}
// Back-compat alias — internal callers use the local name; SPEECH_LINES is
// the exported one so external tooling (test page generator etc.) can read it.
const LINES = SPEECH_LINES

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
  // Some voices don't have lines for a given trigger (e.g. cyborg has no
  // 'no_repairs_needed' lines — it's a repair-bot-only callout). Skip
  // gracefully instead of crashing on an undefined random pick.
  if (!lines || lines.length === 0) return
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
