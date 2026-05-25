// Difficulty setting. Drives the AI-side credit multiplier during
// BUILD so the player can tune match length / challenge from the
// side-picker screen.
//
//   easy   -25% AI credits (smaller AI army)
//   normal +0%  same as player
//   hard   +25% larger AI army
//
// Player-side credits are unaffected. Persisted in localStorage so the
// choice survives Play Again (which is a full reload).

export type Difficulty = 'easy' | 'normal' | 'hard'

const KEY = 'astrohold:difficulty:v1'
const VALID: Difficulty[] = ['easy', 'normal', 'hard']
const DEFAULT: Difficulty = 'normal'

const MULTIPLIER: Record<Difficulty, number> = {
  easy:   0.75,
  normal: 1.00,
  hard:   1.25,
}

let cached: Difficulty | null = null

export function getDifficulty(): Difficulty {
  if (cached) return cached
  try {
    const raw = localStorage.getItem(KEY)
    if (raw && (VALID as string[]).includes(raw)) {
      cached = raw as Difficulty
      return cached
    }
  } catch { /* storage disabled */ }
  cached = DEFAULT
  return cached
}

export function setDifficulty(d: Difficulty) {
  cached = d
  try { localStorage.setItem(KEY, d) } catch { /* non-fatal */ }
}

/** AI-side credit multiplier. Player credits never use this. */
export function aiCreditMultiplier(): number {
  return MULTIPLIER[getDifficulty()]
}
