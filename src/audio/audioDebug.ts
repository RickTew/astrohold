// Audio debug bus. A dev-only hook that reports the EXACT file every time a
// sound actually plays, so a contaminated sample (e.g. a stray Suno vocal that
// macOS Live Caption transcribes) can be caught by name instead of guessed at.
//
// Off by default. main.ts flips it on when the URL carries ?audiolog and mounts
// the on-screen overlay (src/devtools/audioLogOverlay.ts). When disabled the
// log call is a single boolean check, so it's free to leave the hooks in place.
//
// Coverage: every sample file funnels through playPool (samples.ts), and music
// through setMusicTrack (music.ts) — both call logAudioPlay, so the overlay
// sees 100% of audio files the game plays. Synth fallbacks make no file and
// thus can't carry a vocal, so they're intentionally not logged.

export interface AudioLogEntry {
  t: number               // performance.now() at play time
  kind: 'sample' | 'music'
  label: string           // event / pool name (e.g. 'heal', 'rifle') or 'music:cyborgs'
  file: string            // the file that actually played, e.g. 'Cyborg Double Shots.mp3'
}

type Listener = (e: AudioLogEntry) => void

let enabled = false
const listeners = new Set<Listener>()

export function enableAudioDebug(): void { enabled = true }
export function audioDebugEnabled(): boolean { return enabled }

export function onAudioPlayed(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function logAudioPlay(e: AudioLogEntry): void {
  if (!enabled) return
  for (const l of listeners) l(e)
}

/** Strip a public path down to just the file name for display. */
export function audioFileName(url: string): string {
  return url.split('/').pop() ?? url
}
