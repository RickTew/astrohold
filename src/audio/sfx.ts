// Synthesized sound effects via Web Audio. No sample files: every sound is
// generated on the fly from oscillators plus filters so the bundle stays small.
//
// AudioContext is created lazily (browsers block construction until the user
// interacts with the page anyway). Each call spawns a new oscillator chain
// per sound; the chain is short-lived and self-cleans via .stop().
//
// SFX can be muted globally via the Mini Control Center. Both play* exits
// early if isSfxOn() is false. We still consult the throttler first so the
// mute does not accidentally bypass rate limiting if the toggle flips back on.

import { isSfxOn } from './AudioSettings'

let ctx: AudioContext | null = null
function getCtx(): AudioContext | null {
  if (ctx) return ctx
  try {
    // Some browsers wrap this in webkitAudioContext.
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

export function playGunshot() {
  if (shouldThrottle('gun', 35)) return
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

export function playExplosion() {
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
