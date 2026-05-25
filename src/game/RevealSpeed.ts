// Battle pacing setting. Multiplies RevealPhase step durations so the
// player can pick how fast the auto-chain plays back. Persisted in
// localStorage so the choice survives Play Again (which is a full reload).
//
// Multipliers are calibrated against the current FAST baseline
// (STEP_DURATION = 0.6s, hold = 0.08s):
//   slow   → 2.4× ≈ 1.44s / 0.19s per step  (relaxed watch)
//   normal → 1.5× ≈ 0.90s / 0.12s per step  (default-feeling)
//   fast   → 1.0× ≈ 0.60s / 0.08s per step  (current — tester / stats farming)

export type RevealSpeed = 'slow' | 'normal' | 'fast'

const KEY = 'astrohold:reveal-speed:v1'
const VALID: RevealSpeed[] = ['slow', 'normal', 'fast']

// Default is FAST — current build speed; matches what S17 stats were
// gathered under so existing records remain comparable until users opt
// into a slower setting.
const DEFAULT: RevealSpeed = 'fast'

const MULTIPLIER: Record<RevealSpeed, number> = {
  slow: 2.4,
  normal: 1.5,
  fast: 1.0,
}

let cached: RevealSpeed | null = null

export function getRevealSpeed(): RevealSpeed {
  if (cached) return cached
  try {
    const raw = localStorage.getItem(KEY)
    if (raw && (VALID as string[]).includes(raw)) {
      cached = raw as RevealSpeed
      return cached
    }
  } catch { /* localStorage disabled / SSR — fall through */ }
  cached = DEFAULT
  return cached
}

export function setRevealSpeed(speed: RevealSpeed) {
  cached = speed
  try { localStorage.setItem(KEY, speed) } catch { /* non-fatal */ }
}

/** Multiplier applied to a base step duration. 1.0 = current pace. */
export function revealSpeedMultiplier(): number {
  return MULTIPLIER[getRevealSpeed()]
}
