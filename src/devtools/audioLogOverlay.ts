// On-screen audio log overlay (dev tool). Shows the exact file every sound
// plays, newest at top, so a stray-vocal sample can be caught by name the
// instant macOS Live Caption shows the word. Gated by ?audiolog in main.ts.
//
// Reads the live feed from audioDebug.onAudioPlayed. Music rows are tinted so
// the faction track stands out from SFX. Each row carries a battle-clock-style
// timestamp to correlate with the caption (which lags the audio slightly).

import { onAudioPlayed, type AudioLogEntry } from '../audio/audioDebug'

const MAX_ROWS = 18

function fmtTime(ms: number): string {
  const s = ms / 1000
  return s.toFixed(2).padStart(7, ' ')
}

export function mountAudioLogOverlay(): void {
  const box = document.createElement('div')
  box.id = 'audio-log-overlay'
  Object.assign(box.style, {
    position: 'fixed',
    top: '8px',
    left: '8px',
    zIndex: '99999',
    maxWidth: '46vw',
    maxHeight: '60vh',
    overflow: 'hidden',
    padding: '8px 10px',
    background: 'rgba(8,10,14,0.82)',
    border: '1px solid #2a4a66',
    borderRadius: '8px',
    font: '12px/1.45 ui-monospace, Menlo, monospace',
    color: '#bfe3ff',
    pointerEvents: 'none',
    whiteSpace: 'pre',
  } as CSSStyleDeclaration)

  const title = document.createElement('div')
  title.textContent = 'AUDIO LOG  (?audiolog)  — file played per sound'
  Object.assign(title.style, { color: '#7fd0ff', marginBottom: '4px', fontWeight: '700' } as CSSStyleDeclaration)
  box.appendChild(title)

  const list = document.createElement('div')
  box.appendChild(list)
  document.body.appendChild(box)

  onAudioPlayed((e: AudioLogEntry) => {
    const row = document.createElement('div')
    const tag = e.kind === 'music' ? '♪' : '▸'
    row.textContent = `${fmtTime(e.t)}  ${tag} ${e.label.padEnd(16, ' ')} ${e.file}`
    row.style.color = e.kind === 'music' ? '#ffcf6b' : '#bfe3ff'
    // Newest on top; brief highlight so the just-fired line is obvious.
    row.style.background = 'rgba(90,200,255,0.18)'
    list.prepend(row)
    setTimeout(() => { row.style.background = 'transparent' }, 450)
    while (list.childElementCount > MAX_ROWS) list.lastElementChild?.remove()
  })
}
