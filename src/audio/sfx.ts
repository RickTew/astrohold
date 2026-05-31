// Synthesized sound effects via Web Audio. No sample files: every sound is
// generated on the fly from oscillators plus filters so the bundle stays small.
//
// AudioContext is created lazily (browsers block construction until the user
// interacts with the page anyway). Each call spawns a new oscillator chain
// per sound; the chain is short-lived and self-cleans via .stop().
//
// Per-weapon recipes are tuned to make each gun read distinctly. Direct
// gunfire is short and percussive (<150ms); energy weapons (Phaser, Sphere)
// have a swept tone; the Sniper gets a heavy crack with a low decay tail;
// the Doublegun is two quick pops. Throws and melee live in the same module
// so any future SFX work has one place to land.
//
// SFX can be muted globally via the Mini Control Center. Every play* exits
// early if isSfxOn() is false. We still consult the throttler first so the
// mute does not accidentally bypass rate limiting if the toggle flips back on.

import { isSfxOn } from './AudioSettings'
import { preloadPool, playPool, isPoolReady } from './samples'

// ── Suno sample-pack mapping ────────────────────────────────────────────
//
// Each event id resolves to a pool of file paths. preloadAllSampleSets
// (called from Game.init) decodes every file in every pool. When an event
// fires we try the pool first; if the pool is empty (no files, decode
// failed, or load not finished yet) we fall back to the synth recipe so
// the game never goes silent.
//
// Folder name has spaces; we keep the literal path and let the browser
// URL-encode internally. Lives in /public/audio so it's served as static.

const SUNO_DIR = '/audio/Astrohold3 Suno Sounds'

export type SampleEvent =
  // Weapon fire (matches WeaponSfxId one-to-one)
  | 'rifle' | 'phaser' | 'sniper' | 'doublegun' | 'sentry' | 'sphere'
  | 'bomb_throw' | 'melee_hit' | 'heal' | 'weld'
  // Detonations + AoE
  | 'explosion'
  // New combat events
  | 'hulk_slam' | 'stalker_swing' | 'core_zap' | 'signal_attack'
  // Support / pickups
  | 'ammo_pickup' | 'core_recharge' | 'repair_recharged' | 'medic_pad_tick'
  // UI + placement
  | 'button_click' | 'button_toggle' | 'power_up' | 'robot_alert'
  | 'structure_placement' | 'signal_placement' | 'shield_placement'
  | 'refund'
  | 'step'

interface PoolSpec { urls: string[]; volume?: number; throttleMs?: number }

const POOLS: Record<SampleEvent, PoolSpec> = {
  // Weapon fire — pools where the user has multiple options. We send the
  // full list and play random one. Throttle matches the synth recipe so a
  // burst of fire from multiple units doesn't pile sounds on top.
  rifle: {
    urls: [
      `${SUNO_DIR}/Cyborg Cannon, Defender Tower Shot.mp3`,
      `${SUNO_DIR}/Cyborg Cannon, Defender Tower Shot (1).mp3`,
      `${SUNO_DIR}/Cyborg canon shot.mp3`,
      `${SUNO_DIR}/Cyborg shot.mp3`,
    ],
    volume: 0.7, throttleMs: 35,
  },
  phaser: {
    urls: [ `${SUNO_DIR}/Defender Cannon (phaser Beam) Shot (1).mp3` ],
    volume: 0.7, throttleMs: 45,
  },
  sniper: {
    urls: [ `${SUNO_DIR}/Cyborg Sniper Shot (1).mp3` ],
    volume: 0.7, throttleMs: 120,
  },
  doublegun: {
    urls: [ `${SUNO_DIR}/Cyborg Double Shots.mp3` ],
    volume: 0.7, throttleMs: 80,
  },
  sentry: {
    urls: [
      `${SUNO_DIR}/Robot Sentry Shot.mp3`,
      `${SUNO_DIR}/Cyborg Gatling Tower attack.mp3`,
      `${SUNO_DIR}/Space tower gun sound.mp3`,
    ],
    volume: 0.7, throttleMs: 45,
  },
  sphere: {
    urls: [
      `${SUNO_DIR}/Laser Shot.mp3`,
      `${SUNO_DIR}/Bright Sine Sweep Triangle Partial.mp3`,
    ],
    volume: 0.7, throttleMs: 45,
  },
  bomb_throw: {
    urls: [ `${SUNO_DIR}/Space swoosh.mp3` ],
    volume: 0.6, throttleMs: 90,
  },
  melee_hit: {
    urls: [
      `${SUNO_DIR}/Light attack.mp3`,
      `${SUNO_DIR}/Medium attack.mp3`,
      `${SUNO_DIR}/Metal on Metal.mp3`,
    ],
    volume: 0.7, throttleMs: 50,
  },
  heal: {
    urls: [
      `${SUNO_DIR}/Cyborg Healing Kit Activated.mp3`,
      `${SUNO_DIR}/Cyborg Healing Kit Activated (1).mp3`,
      `${SUNO_DIR}/Healing quick mist.mp3`,
    ],
    volume: 0.7, throttleMs: 80,
  },
  weld: {
    urls: [
      `${SUNO_DIR}/Robot Repairing.mp3`,
      `${SUNO_DIR}/Robot Repair 2.mp3`,
      `${SUNO_DIR}/Robot Repair Buzz.mp3`,
      `${SUNO_DIR}/Buzzing Bandpass Square.mp3`,
    ],
    volume: 0.6, throttleMs: 90,
  },
  // Detonations + special attacks
  explosion: {
    urls: [
      `${SUNO_DIR}/Cyborge Grenade Explosion big.mp3`,
      `${SUNO_DIR}/Cyborge Grenade Explosion small.mp3`,
      `${SUNO_DIR}/Distant explosion.mp3`,
    ],
    volume: 0.7, throttleMs: 60,
  },
  hulk_slam: {
    urls: [ `${SUNO_DIR}/Cyborg Hulk Power Ground Slam Attack (1).mp3` ],
    volume: 0.8, throttleMs: 200,
  },
  stalker_swing: {
    urls: [ `${SUNO_DIR}/Cyborg Stalker Swing Attack.mp3` ],
    volume: 0.7, throttleMs: 60,
  },
  core_zap: {
    urls: [ `${SUNO_DIR}/Robot Power Core electric fense defense attack.mp3` ],
    volume: 0.7, throttleMs: 80,
  },
  signal_attack: {
    urls: [ `${SUNO_DIR}/Signal Tower attack.mp3` ],
    volume: 0.7, throttleMs: 200,
  },
  // Pickups + support
  ammo_pickup: {
    urls: [
      `${SUNO_DIR}/Cyborg Medic pack collect from drop.mp3`,
      `${SUNO_DIR}/Robot recharging.mp3`,
    ],
    volume: 0.7, throttleMs: 100,
  },
  core_recharge: {
    urls: [ `${SUNO_DIR}/Robot Power Core unit recharge.mp3` ],
    volume: 0.7, throttleMs: 100,
  },
  repair_recharged: {
    urls: [ `${SUNO_DIR}/Robot Repair recharged.mp3` ],
    volume: 0.7, throttleMs: 200,
  },
  medic_pad_tick: {
    urls: [ `${SUNO_DIR}/Healing quick mist.mp3` ],
    volume: 0.5, throttleMs: 100,
  },
  // UI + placement
  button_click: {
    urls: [ `${SUNO_DIR}/Click sound.mp3` ],
    volume: 0.5, throttleMs: 60,
  },
  button_toggle: {
    urls: [ `${SUNO_DIR}/Clicking on off sound.mp3` ],
    volume: 0.5, throttleMs: 60,
  },
  power_up: {
    urls: [ `${SUNO_DIR}/Robot power up.mp3` ],
    volume: 0.7, throttleMs: 300,
  },
  robot_alert: {
    urls: [ `${SUNO_DIR}/Robot Alert.mp3` ],
    volume: 0.5, throttleMs: 300,
  },
  structure_placement: {
    urls: [ `${SUNO_DIR}/Robot placement.mp3` ],
    volume: 0.6, throttleMs: 80,
  },
  refund: {
    // Space placement sound feels like a piece being lifted off the
    // grid — used when the player clicks a placed piece to get its
    // credits back. Distinct from the placement-on sounds above.
    urls: [ `${SUNO_DIR}/Space placement sound.mp3` ],
    volume: 0.6, throttleMs: 80,
  },
  signal_placement: {
    urls: [
      `${SUNO_DIR}/Signal tower placement.mp3`,
      `${SUNO_DIR}/Robot Signal Placement2.mp3`,
    ],
    volume: 0.6, throttleMs: 80,
  },
  shield_placement: {
    urls: [ `${SUNO_DIR}/Robot shield unit placement.mp3` ],
    volume: 0.6, throttleMs: 80,
  },
  step: {
    urls: [ `${SUNO_DIR}/Stepping Crunch.mp3` ],
    volume: 0.25, throttleMs: 60,
  },
  // hulk_callout removed from the preload set: 'Cyborg HULK attack
  // call out.mp3' is a vocal Suno render that macOS Live Caption was
  // transcribing as 'Wow, wow.' The file stays on disk for possible
  // future use; once we re-enable voice we can add the pool back.
}

/** Kick off decoding for every Suno sample. Safe to call once at boot.
 *  Returns a promise that resolves when all decodes settle (success or
 *  failure). Individual file failures are non-fatal. */
export async function preloadAllSamples(): Promise<void> {
  await Promise.all(Object.entries(POOLS).map(([name, spec]) =>
    preloadPool(name, spec.urls, { volume: spec.volume, throttleMs: spec.throttleMs }),
  ))
}

/** Try to play a sample pool. Returns true on success, false if pool is
 *  empty / not loaded / throttled. Callers use the boolean to decide
 *  whether to fall back to a synth recipe. */
function trySample(event: SampleEvent): boolean {
  if (!isPoolReady(event)) return false
  return playPool(event)
}

let ctx: AudioContext | null = null
function getCtx(): AudioContext | null {
  if (ctx) return ctx
  try {
    const C: typeof AudioContext | undefined =
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .AudioContext
        ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext
    if (!C) return null
    ctx = new C()
  } catch {
    return null
  }
  return ctx
}

// Cheap rate-limiter: prevents a single tick (which can spawn 10+ projectiles
// at once) from stacking dozens of identical sounds and overdriving output.
const lastFiredAt = new Map<string, number>()
function shouldThrottle(key: string, minSpacingMs: number): boolean {
  const now = performance.now()
  const last = lastFiredAt.get(key) ?? 0
  if (now - last < minSpacingMs) return true
  lastFiredAt.set(key, now)
  return false
}

// ── Per-weapon recipes ──────────────────────────────────────────────────
//
// Convention: each recipe returns void, gates on isSfxOn + a per-recipe
// throttle key, then builds + starts its oscillator chain. Keep the
// dispatcher (playWeaponSfx) thin so adding new weapons is one new case.

export type WeaponSfxId =
  | 'rifle'         // generic cyborg cannon, defender tower (cardinal-lane pop)
  | 'phaser'        // defender cannon -> piercing beam
  | 'sniper'        // cyborg sniper (heavy slow crack)
  | 'doublegun'     // cyborg doublegun (two quick pops)
  | 'sentry'        // defender sentry (heavier auto-cannon burst)
  | 'sphere'        // defender sphere (bright energy zap)
  | 'bomb_throw'    // grenadier + bomber lobbed launch (no detonation, that is playExplosion)
  | 'melee_hit'     // dog bite, hulk fist (generic body impact)
  | 'stalker_swing' // cyborg stalker (sweep + connect; falls back to melee_hit)
  | 'heal'          // medic heal chime
  | 'weld'          // robot repair zap

export function playWeaponSfx(id: WeaponSfxId) {
  // Sample pool first; synth fallback if pool unloaded or empty. Both
  // paths gate on isSfxOn internally so the MCC mute kills both layers.
  if (trySample(id)) return
  switch (id) {
    case 'rifle':      return playRifle()
    case 'phaser':     return playPhaser()
    case 'sniper':     return playSniper()
    case 'doublegun':  return playDoubleGun()
    case 'sentry':     return playSentry()
    case 'sphere':     return playSphere()
    case 'bomb_throw':    return playBombThrow()
    case 'melee_hit':     return playMeleeHit()
    case 'stalker_swing': return playMeleeHit()   // synth fallback shares the melee body-impact recipe
    case 'heal':          return playHeal()
    case 'weld':          return playWeld()
  }
}

/** Play an event that has no synth equivalent. Returns true if a
 *  sample was triggered; callers can use the boolean to drive their
 *  own fallback (e.g. hulk_slam falls back to playExplosion if the
 *  dedicated sample is missing). Used for UI, pickups, and special-
 *  action sounds added in S19. */
export function playEventSfx(id: Exclude<SampleEvent, WeaponSfxId | 'explosion'>): boolean {
  return trySample(id)
}

function playRifle() {
  if (shouldThrottle('rifle', 35)) return
  if (!isSfxOn()) return
  const c = getCtx(); if (!c) return
  const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(880, t)
  osc.frequency.exponentialRampToValueAtTime(140, t + 0.06)
  gain.gain.setValueAtTime(0.18, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09)
  osc.connect(gain).connect(c.destination)
  osc.start(t)
  osc.stop(t + 0.1)
}

function playPhaser() {
  // Ascending energy beam: bright square swept upward + a short shimmer
  // sine an octave higher. Distinct from rifle: rises in pitch instead of
  // dropping, longer (~180ms), with a high partial layered on.
  if (shouldThrottle('phaser', 45)) return
  if (!isSfxOn()) return
  const c = getCtx(); if (!c) return
  const t = c.currentTime
  const lp = c.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(3500, t)
  lp.frequency.exponentialRampToValueAtTime(8000, t + 0.18)
  const mainGain = c.createGain()
  mainGain.gain.setValueAtTime(0.22, t)
  mainGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2)

  const main = c.createOscillator()
  main.type = 'square'
  main.frequency.setValueAtTime(420, t)
  main.frequency.exponentialRampToValueAtTime(1300, t + 0.16)

  const shimmer = c.createOscillator()
  const shimGain = c.createGain()
  shimmer.type = 'sine'
  shimmer.frequency.setValueAtTime(1600, t)
  shimmer.frequency.exponentialRampToValueAtTime(2800, t + 0.18)
  shimGain.gain.setValueAtTime(0.08, t)
  shimGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2)

  main.connect(lp).connect(mainGain).connect(c.destination)
  shimmer.connect(shimGain).connect(c.destination)
  main.start(t);    main.stop(t + 0.22)
  shimmer.start(t); shimmer.stop(t + 0.22)
}

function playSniper() {
  // Heavy crack + low decay tail. Two layered oscillators: a fast bright
  // transient on top and a slower deep boom underneath. Long throttle so
  // consecutive sniper shots feel weighty, not buzzy.
  if (shouldThrottle('sniper', 120)) return
  if (!isSfxOn()) return
  const c = getCtx(); if (!c) return
  const t = c.currentTime
  // Bright crack.
  const crack = c.createOscillator()
  const crackGain = c.createGain()
  crack.type = 'sawtooth'
  crack.frequency.setValueAtTime(1400, t)
  crack.frequency.exponentialRampToValueAtTime(220, t + 0.07)
  crackGain.gain.setValueAtTime(0.28, t)
  crackGain.gain.exponentialRampToValueAtTime(0.001, t + 0.1)
  crack.connect(crackGain).connect(c.destination)
  crack.start(t); crack.stop(t + 0.12)
  // Low tail.
  const tail = c.createOscillator()
  const tailGain = c.createGain()
  const tailLp = c.createBiquadFilter()
  tail.type = 'sawtooth'
  tail.frequency.setValueAtTime(180, t + 0.02)
  tail.frequency.exponentialRampToValueAtTime(55, t + 0.4)
  tailLp.type = 'lowpass'
  tailLp.frequency.value = 600
  tailGain.gain.setValueAtTime(0.16, t + 0.02)
  tailGain.gain.exponentialRampToValueAtTime(0.001, t + 0.42)
  tail.connect(tailLp).connect(tailGain).connect(c.destination)
  tail.start(t + 0.02); tail.stop(t + 0.45)
}

function playDoubleGun() {
  // Two quick rifle-ish pops, 60ms apart. Same recipe as rifle but slightly
  // tighter envelope so the pair reads as a controlled burst.
  if (shouldThrottle('doublegun', 80)) return
  if (!isSfxOn()) return
  const c = getCtx(); if (!c) return
  const t = c.currentTime
  for (let i = 0; i < 2; i++) {
    const t0 = t + i * 0.06
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(960, t0)
    osc.frequency.exponentialRampToValueAtTime(220, t0 + 0.05)
    gain.gain.setValueAtTime(0.16, t0)
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07)
    osc.connect(gain).connect(c.destination)
    osc.start(t0); osc.stop(t0 + 0.09)
  }
}

function playSentry() {
  // Heavier auto-cannon thump. Slightly longer than rifle, with a square
  // sub adding weight underneath the saw transient.
  if (shouldThrottle('sentry', 45)) return
  if (!isSfxOn()) return
  const c = getCtx(); if (!c) return
  const t = c.currentTime
  // Saw transient.
  const transient = c.createOscillator()
  const tGain = c.createGain()
  transient.type = 'sawtooth'
  transient.frequency.setValueAtTime(620, t)
  transient.frequency.exponentialRampToValueAtTime(110, t + 0.09)
  tGain.gain.setValueAtTime(0.22, t)
  tGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
  transient.connect(tGain).connect(c.destination)
  transient.start(t); transient.stop(t + 0.13)
  // Square sub.
  const sub = c.createOscillator()
  const subGain = c.createGain()
  sub.type = 'square'
  sub.frequency.setValueAtTime(110, t)
  sub.frequency.exponentialRampToValueAtTime(60, t + 0.12)
  subGain.gain.setValueAtTime(0.18, t)
  subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.14)
  sub.connect(subGain).connect(c.destination)
  sub.start(t); sub.stop(t + 0.16)
}

function playSphere() {
  // Bright sine sweep with a high partial. Reads as energy, not ballistic.
  if (shouldThrottle('sphere', 45)) return
  if (!isSfxOn()) return
  const c = getCtx(); if (!c) return
  const t = c.currentTime
  const main = c.createOscillator()
  const mGain = c.createGain()
  main.type = 'sine'
  main.frequency.setValueAtTime(720, t)
  main.frequency.exponentialRampToValueAtTime(220, t + 0.12)
  mGain.gain.setValueAtTime(0.22, t)
  mGain.gain.exponentialRampToValueAtTime(0.001, t + 0.14)
  main.connect(mGain).connect(c.destination)
  main.start(t); main.stop(t + 0.16)
  const high = c.createOscillator()
  const hGain = c.createGain()
  high.type = 'triangle'
  high.frequency.setValueAtTime(1800, t)
  high.frequency.exponentialRampToValueAtTime(900, t + 0.1)
  hGain.gain.setValueAtTime(0.1, t)
  hGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
  high.connect(hGain).connect(c.destination)
  high.start(t); high.stop(t + 0.14)
}

function playBombThrow() {
  // Soft launch thunk. Dull low triangle with a quick decay, no high end.
  // Sits below the music and never feels percussive enough to confuse with
  // a rifle shot. Detonation later is playExplosion.
  if (shouldThrottle('throw', 90)) return
  if (!isSfxOn()) return
  const c = getCtx(); if (!c) return
  const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  const lp = c.createBiquadFilter()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(220, t)
  osc.frequency.exponentialRampToValueAtTime(80, t + 0.18)
  lp.type = 'lowpass'
  lp.frequency.value = 500
  gain.gain.setValueAtTime(0.18, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22)
  osc.connect(lp).connect(gain).connect(c.destination)
  osc.start(t); osc.stop(t + 0.24)
}

function playMeleeHit() {
  // Short dull thud. Body-impact feel: low triangle + a touch of noise via
  // a sawtooth at the same frequency for grit. Quick decay, no tail.
  if (shouldThrottle('melee', 50)) return
  if (!isSfxOn()) return
  const c = getCtx(); if (!c) return
  const t = c.currentTime
  const body = c.createOscillator()
  const bGain = c.createGain()
  const lp = c.createBiquadFilter()
  body.type = 'triangle'
  body.frequency.setValueAtTime(180, t)
  body.frequency.exponentialRampToValueAtTime(60, t + 0.08)
  lp.type = 'lowpass'
  lp.frequency.value = 800
  bGain.gain.setValueAtTime(0.22, t)
  bGain.gain.exponentialRampToValueAtTime(0.001, t + 0.1)
  body.connect(lp).connect(bGain).connect(c.destination)
  body.start(t); body.stop(t + 0.12)
  const grit = c.createOscillator()
  const gGain = c.createGain()
  grit.type = 'sawtooth'
  grit.frequency.setValueAtTime(160, t)
  grit.frequency.exponentialRampToValueAtTime(70, t + 0.05)
  gGain.gain.setValueAtTime(0.08, t)
  gGain.gain.exponentialRampToValueAtTime(0.001, t + 0.06)
  grit.connect(gGain).connect(c.destination)
  grit.start(t); grit.stop(t + 0.08)
}

function playHeal() {
  // Soft chime. Two sine tones a fifth apart, short attack, gentle decay.
  if (shouldThrottle('heal', 80)) return
  if (!isSfxOn()) return
  const c = getCtx(); if (!c) return
  const t = c.currentTime
  const freqs = [880, 1320]
  for (const f of freqs) {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(f, t)
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.12, t + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
    osc.connect(gain).connect(c.destination)
    osc.start(t); osc.stop(t + 0.42)
  }
}

function playWeld() {
  // Buzzing zap. Square wave with a fast amplitude flutter, narrow band.
  if (shouldThrottle('weld', 90)) return
  if (!isSfxOn()) return
  const c = getCtx(); if (!c) return
  const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  const bp = c.createBiquadFilter()
  osc.type = 'square'
  osc.frequency.setValueAtTime(540, t)
  bp.type = 'bandpass'
  bp.frequency.value = 1500
  bp.Q.value = 4
  // Amplitude flutter for the buzz: ramp + dip + ramp + final fall.
  gain.gain.setValueAtTime(0, t)
  gain.gain.linearRampToValueAtTime(0.16, t + 0.02)
  gain.gain.linearRampToValueAtTime(0.04, t + 0.08)
  gain.gain.linearRampToValueAtTime(0.16, t + 0.14)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
  osc.connect(bp).connect(gain).connect(c.destination)
  osc.start(t); osc.stop(t + 0.32)
}

// ── Back-compat aliases ─────────────────────────────────────────────────
// Existing call sites use playGunshot/playExplosion. Keep them working so
// nothing breaks while RevealPhase migrates to playWeaponSfx.

export function playGunshot() {
  playRifle()
}

export function playExplosion() {
  if (trySample('explosion')) return
  if (shouldThrottle('boom', 60)) return
  if (!isSfxOn()) return
  const c = getCtx(); if (!c) return
  const t = c.currentTime
  const osc = c.createOscillator()
  const noiseFilter = c.createBiquadFilter()
  const gain = c.createGain()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(160, t)
  osc.frequency.exponentialRampToValueAtTime(38, t + 0.4)
  noiseFilter.type = 'lowpass'
  noiseFilter.frequency.value = 700
  gain.gain.setValueAtTime(0.42, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45)
  osc.connect(noiseFilter).connect(gain).connect(c.destination)
  osc.start(t)
  osc.stop(t + 0.5)
}
