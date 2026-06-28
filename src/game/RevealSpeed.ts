// Battle pacing setting. Multiplies RevealPhase step durations so the
// player can pick how fast the auto-chain plays back. Persisted in
// localStorage so the choice survives Play Again (which is a full reload).
//
// Multipliers are calibrated against the FAST baseline
// (STEP_DURATION = 0.6s, hold = 0.08s):
//   slow   5.0x = 3.00s / 0.40s per step  (relaxed cinematic watch)
//   normal 2.5x = 1.50s / 0.20s per step  (default-feeling balanced)
//   fast   1.0x = 0.60s / 0.08s per step  (current baseline for tester / stats farming)
//
// S17.8: slow was 2.4x and felt indistinguishable from fast in playtest.
// Bumped to 5.0x so the difference is unmistakable. If even 5.0x still
// reads as fast, the next lever is the base STEP_DURATION itself.

export type RevealSpeed = 'slow' | 'normal' | 'fast'

const KEY = 'astrohold:reveal-speed:v1'
const VALID: RevealSpeed[] = ['slow', 'normal', 'fast']

// Default is SLOW so a brand-new player (no stored preference) watches
// the auto-chained reveals at a relaxed, readable pace instead of being
// overwhelmed by the fast baseline. Returning players keep whatever they
// last picked (persisted in localStorage), so this only changes the
// first-run experience.
const DEFAULT: RevealSpeed = 'slow'

const MULTIPLIER: Record<RevealSpeed, number> = {
  slow: 5.0,
  normal: 2.5,
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
  // Diagnostic. Open devtools to verify a tick-dot click is actually
  // propagating into the engine. Removed once players report the
  // slowdown is unambiguous in playtest.
  // eslint-disable-next-line no-console
  console.info('[astrohold] reveal speed set to', speed, 'multiplier', MULTIPLIER[speed])
}

/** Multiplier applied to a base step duration. 1.0 = current pace. */
export function revealSpeedMultiplier(): number {
  return MULTIPLIER[getRevealSpeed()]
}
