// Background music player. One looped HTMLAudioElement at a time, with a
// short cross-fade when switching tracks. Three logical tracks:
//   'menu'    -> /audio/menu.mp3    (loading + pick-side)
//   'robots'  -> /audio/robots.mp3  (player picked Robot Defender)
//   'cyborgs' -> /audio/cyborgs.mp3 (player picked Cyborg Attacker)
//
// Files are dropped into /public/audio/ at the paths above. The wiring is
// resilient to missing files: if a play() fails (404 / decode error / autoplay
// block), we swallow the error so the rest of the game keeps working. For
// the autoplay-blocked case we retry on the first user gesture, since the
// side picker requires a click and that satisfies the policy.
//
// Mute is reactive: the Mini Control Center music toggle calls
// AudioSettings.setMusicOn, which notifies onMusicChange listeners; the
// live element fades to 0 or back to target volume without reloading.

import { isMusicOn, onMusicChange } from './AudioSettings'

export type MusicTrack = 'menu' | 'robots' | 'cyborgs'

const TRACK_URLS: Record<MusicTrack, string> = {
  menu:    '/audio/menu.mp3',
  robots:  '/audio/robots.mp3',
  cyborgs: '/audio/cyborgs.mp3',
}

const TARGET_VOLUME = 0.45
const FADE_MS = 900

let currentTrack: MusicTrack | null = null
let currentEl: HTMLAudioElement | null = null
let pendingGesture: (() => void) | null = null
let unsubscribeMusicToggle: (() => void) | null = null

function ensureToggleListener() {
  if (unsubscribeMusicToggle) return
  unsubscribeMusicToggle = onMusicChange(on => {
    if (!currentEl) return
    fadeTo(currentEl, on ? TARGET_VOLUME : 0, 250)
  })
}

function fadeTo(el: HTMLAudioElement, target: number, ms: number) {
  // requestAnimationFrame-driven volume ramp. Cheap; runs only while a
  // fade is in flight. No tracking of in-progress fades: a later fadeTo
  // call simply starts a new ramp from the current value, which yields
  // the same destination just with a slightly compressed curve.
  const start = el.volume
  const t0 = performance.now()
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / ms)
    el.volume = start + (target - start) * t
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

function fadeOutAndDispose(el: HTMLAudioElement, ms: number) {
  const start = el.volume
  const t0 = performance.now()
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / ms)
    el.volume = start * (1 - t)
    if (t < 1) requestAnimationFrame(step)
    else {
      el.pause()
      el.src = ''
      el.load()
    }
  }
  requestAnimationFrame(step)
}

function attemptPlay(el: HTMLAudioElement) {
  const p = el.play()
  if (!p || typeof p.then !== 'function') {
    // Older Safari returns undefined from play(); assume success and ramp.
    fadeTo(el, isMusicOn() ? TARGET_VOLUME : 0, FADE_MS)
    return
  }
  p.then(() => {
    fadeTo(el, isMusicOn() ? TARGET_VOLUME : 0, FADE_MS)
  }).catch(() => {
    // Likely autoplay-blocked (browser requires a user gesture first).
    // Side picker's pointerdown will satisfy this. If file is missing
    // the same path runs but the retry will also fail silently.
    if (pendingGesture) return
    pendingGesture = () => {
      pendingGesture = null
      el.play().then(() => fadeTo(el, isMusicOn() ? TARGET_VOLUME : 0, FADE_MS)).catch(() => {})
    }
    const handler = () => {
      window.removeEventListener('pointerdown', handler)
      window.removeEventListener('keydown', handler)
      pendingGesture?.()
    }
    window.addEventListener('pointerdown', handler, { once: true })
    window.addEventListener('keydown', handler, { once: true })
  })
}

/** Switch to the given track with a cross-fade. Calling with the same
 *  track that is already playing is a no-op. */
export function setMusicTrack(track: MusicTrack | null) {
  ensureToggleListener()
  if (track === currentTrack) return
  if (currentEl) fadeOutAndDispose(currentEl, FADE_MS)
  currentEl = null
  currentTrack = track
  if (!track) return
  const el = new Audio(TRACK_URLS[track])
  el.loop = true
  el.preload = 'auto'
  el.volume = 0
  currentEl = el
  attemptPlay(el)
}

/** Stop and discard the current track. Used on dispose / HMR teardown. */
export function stopMusic() {
  if (currentEl) {
    const el = currentEl
    el.pause()
    el.src = ''
    el.load()
  }
  currentEl = null
  currentTrack = null
  unsubscribeMusicToggle?.()
  unsubscribeMusicToggle = null
}

export function getMusicTrack(): MusicTrack | null {
  return currentTrack
}
