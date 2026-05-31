// AudioBuffer-based sample player. Used for the Suno-generated SFX in
// /public/audio/Astrohold3 Suno Sounds/. Buffer playback is zero-latency
// and overlap-safe: every play() creates a new AudioBufferSourceNode, so
// rapid retriggers (e.g. five cyborgs firing on the same reveal) layer
// cleanly instead of cancelling each other like HTMLAudioElement does.
//
// Design:
//   • One shared AudioContext (lazy, cached). Same ctx as sfx.ts would
//     prefer, but we keep this module standalone so it can be dropped
//     into other surfaces (test page) without dragging the synth code.
//   • preloadPool(name, urls): fetch + decodeAudioData for each url and
//     stash the resulting AudioBuffer in a Map. Missing files / decode
//     failures are swallowed (game keeps running) and the pool ends up
//     with fewer buffers than urls, which is fine.
//   • playPool(name, opts): pick one of the buffers (random + last-not-
//     repeated when pool size >= 2), throttle, play. Returns true on
//     successful trigger, false if nothing was queued (throttled OR
//     pool empty / not yet loaded) so callers can fall back to synth.
//
// Volume note: Suno samples vary wildly in loudness. We expose per-pool
// volume so any track that arrives hot can be tamed without re-rendering
// the file.

import { isSfxOn } from './AudioSettings'
import { logAudioPlay, audioFileName } from './audioDebug'

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
  } catch { return null }
  return ctx
}

interface Pool {
  buffers: AudioBuffer[]
  names: string[]        // file name per buffer, same index — for the audio debug overlay
  lastIndex: number
  volume: number
  throttleMs: number
}

const pools = new Map<string, Pool>()
const lastFiredAt = new Map<string, number>()

function shouldThrottle(key: string, minMs: number): boolean {
  const now = performance.now()
  const last = lastFiredAt.get(key) ?? 0
  if (now - last < minMs) return true
  lastFiredAt.set(key, now)
  return false
}

export interface PreloadOptions {
  /** Multiplier applied to each playback (0..1). Tames hot Suno samples. */
  volume?: number
  /** Minimum spacing between successive plays from this pool, in ms. */
  throttleMs?: number
}

/** Resolve a list of URLs into a pool of decoded buffers. Safe to call
 *  multiple times: re-decoding the same urls produces equivalent buffers
 *  but we short-circuit if the pool name is already populated.
 *
 *  Always succeeds (resolves) even if individual fetches fail; failed
 *  decodes are silently dropped from the pool. If every fetch fails the
 *  pool ends up empty and playPool returns false, letting the caller fall
 *  back to a synth recipe. */
export async function preloadPool(name: string, urls: string[], opts: PreloadOptions = {}): Promise<void> {
  const c = getCtx(); if (!c) return
  const existing = pools.get(name)
  if (existing && existing.buffers.length > 0) {
    // Update options without re-fetching.
    if (opts.volume !== undefined) existing.volume = opts.volume
    if (opts.throttleMs !== undefined) existing.throttleMs = opts.throttleMs
    return
  }
  const pool: Pool = {
    buffers: [],
    names: [],
    lastIndex: -1,
    volume: opts.volume ?? 1,
    throttleMs: opts.throttleMs ?? 30,
  }
  pools.set(name, pool)
  // Decode in parallel. Each result keeps its url so a successful buffer and
  // its file name stay aligned by index (the audio debug overlay reports the
  // name). Failures resolve to a null buffer and are dropped from both arrays.
  const decoded = await Promise.all(urls.map(url =>
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer() })
      .then(ab => c.decodeAudioData(ab))
      .then(buf => ({ url, buf }))
      .catch(() => ({ url, buf: null as AudioBuffer | null })),
  ))
  for (const { url, buf } of decoded) {
    if (!buf) continue
    pool.buffers.push(buf)
    pool.names.push(audioFileName(url))
  }
}

/** Returns true if the pool has at least one decoded buffer. Useful for
 *  the sample-first/synth-fallback pattern in sfx.ts. */
export function isPoolReady(name: string): boolean {
  const p = pools.get(name)
  return !!p && p.buffers.length > 0
}

/** Play a random buffer from the pool. Returns true if a sound actually
 *  started (passed throttle + buffer available). */
export function playPool(name: string): boolean {
  const p = pools.get(name)
  if (!p || p.buffers.length === 0) return false
  if (!isSfxOn()) return false
  if (shouldThrottle(`pool:${name}`, p.throttleMs)) return false
  const c = getCtx(); if (!c) return false

  // Pick an index that isn't the same as the last one, when the pool has
  // 2+ buffers. Keeps consecutive triggers from sounding repetitive.
  let idx: number
  if (p.buffers.length === 1) {
    idx = 0
  } else {
    do { idx = Math.floor(Math.random() * p.buffers.length) }
    while (idx === p.lastIndex)
  }
  p.lastIndex = idx

  const src = c.createBufferSource()
  src.buffer = p.buffers[idx]
  const gain = c.createGain()
  gain.gain.value = p.volume
  src.connect(gain).connect(c.destination)
  src.start(0)
  // Dev overlay: report the exact file that just played (no-op unless ?audiolog).
  logAudioPlay({ t: performance.now(), kind: 'sample', label: name, file: p.names[idx] ?? '?' })
  return true
}
