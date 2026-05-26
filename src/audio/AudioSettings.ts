// Global audio mute flags driven by the Mini Control Center toggles.
// Persisted in localStorage so a player's choice survives Play Again
// (which is a full reload). Defaults: both ON, since first-time players
// expect the game to play sounds.
//
// SFX flag gates the synthesized gunshot + explosion in sfx.ts.
// Music flag is reserved for the future backing-track system. The
// MCC toggle persists the flag so the choice is already in place when
// music is added; no audio source consults it yet.

const KEY_SFX   = 'astrohold:audio:sfx-on:v1'
const KEY_MUSIC = 'astrohold:audio:music-on:v1'

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === '1' || raw === 'true')  return true
    if (raw === '0' || raw === 'false') return false
  } catch { /* storage disabled */ }
  return fallback
}

function writeBool(key: string, value: boolean) {
  try { localStorage.setItem(key, value ? '1' : '0') } catch { /* non-fatal */ }
}

let sfxOn:   boolean | null = null
let musicOn: boolean | null = null

export function isSfxOn(): boolean {
  if (sfxOn === null) sfxOn = readBool(KEY_SFX, true)
  return sfxOn
}
export function setSfxOn(value: boolean) {
  sfxOn = value
  writeBool(KEY_SFX, value)
}

export function isMusicOn(): boolean {
  if (musicOn === null) musicOn = readBool(KEY_MUSIC, true)
  return musicOn
}
export function setMusicOn(value: boolean) {
  musicOn = value
  writeBool(KEY_MUSIC, value)
  for (const cb of musicListeners) cb(value)
}

type MusicListener = (on: boolean) => void
const musicListeners: MusicListener[] = []
export function onMusicChange(cb: MusicListener): () => void {
  musicListeners.push(cb)
  return () => {
    const i = musicListeners.indexOf(cb)
    if (i >= 0) musicListeners.splice(i, 1)
  }
}
