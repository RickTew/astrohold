// Mini Control Center. Floating bottom-right widget that consolidates
// reveal pacing, audio toggles, speech-bubble visibility, combat-log
// visibility, and the BATTLE / PAUSE primary action into one beveled-
// ring dial.
//
// Design source: public/build-test.html sandbox Variant C (inner ring
// of 4 toggles at 12 / 3 / 6 / 9 around a speed dial, with a BATTLE
// pill at the bottom). All visuals are procedural CSS plus inline SVG.
// No external assets.
//
// Wiring:
//   Speed dial   -> RevealSpeed.setRevealSpeed
//   BATTLE pill  -> onBattle callback (Game wires this to the current
//                   phase's primary action: start reveal during BUILD,
//                   nothing during reveal since the auto-chain handles
//                   it, page reload during win/lose)
//   PAUSE state  -> onPauseChange callback (Game forwards to the
//                   active RevealPhase.paused flag)
//   Music        -> AudioSettings.setMusicOn (flag only; no music
//                   source consults it yet)
//   SFX          -> AudioSettings.setSfxOn (gates playGunshot/Explosion)
//   Speech       -> SpeechBubble.setSpeechBubblesOn (gates spawn)
//   Combat log   -> toggles `.hidden` on `.center-log` DOM elements

import { getRevealSpeed, setRevealSpeed, RevealSpeed } from '../game/RevealSpeed'
import { isSfxOn, setSfxOn, isMusicOn, setMusicOn } from '../audio/AudioSettings'
import { isSpeechBubblesOn, setSpeechBubblesOn } from '../entities/SpeechBubble'
import { playEventSfx } from '../audio/sfx'

// Phase awareness so the BATTLE pill shows the right label.
export type McPhase = 'build' | 'planning' | 'reveal' | 'win' | 'lose' | 'pick-side' | 'loading'

const COMBAT_LOG_KEY = 'astrohold:combat-log-on:v1'
function isCombatLogOn(): boolean {
  try {
    const raw = localStorage.getItem(COMBAT_LOG_KEY)
    return raw === null ? true : (raw === '1' || raw === 'true')
  } catch { return true }
}
function setCombatLogPersisted(value: boolean) {
  try { localStorage.setItem(COMBAT_LOG_KEY, value ? '1' : '0') } catch { /* non-fatal */ }
}

const ICON_SVGS: Record<string, string> = {
  music:  `<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="7" cy="18" r="2" class="mc-fill"/><circle cx="18" cy="16" r="2" class="mc-fill"/></svg>`,
  sfx:    `<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z" class="mc-fill"/><path d="M16 8c1.5 1.5 1.5 6.5 0 8"/><path d="M19 5c3 3 3 11 0 14"/></svg>`,
  speech: `<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4V5z"/><circle cx="9" cy="10.5" r="1" class="mc-fill"/><circle cx="13" cy="10.5" r="1" class="mc-fill"/><circle cx="17" cy="10.5" r="1" class="mc-fill"/></svg>`,
  log:    `<svg viewBox="0 0 24 24"><line x1="5" y1="7" x2="19" y2="7"/><line x1="5" y1="12" x2="19" y2="12"/><line x1="5" y1="17" x2="14" y2="17"/></svg>`,
}

interface SpeedSpec { id: RevealSpeed; angle: number; arcPct: number; tickClass: string }
const SPEEDS: SpeedSpec[] = [
  { id: 'slow',   angle: -55, arcPct: 0.18, tickClass: 'slow'   },
  { id: 'normal', angle:   0, arcPct: 0.55, tickClass: 'normal' },
  { id: 'fast',   angle:  55, arcPct: 0.92, tickClass: 'fast'   },
]

function tickPos(angleDeg: number, radius: number) {
  const rad = (angleDeg - 90) * Math.PI / 180
  return { x: 190 + radius * Math.cos(rad), y: 190 + radius * Math.sin(rad) }
}

export interface MiniControlCenterCallbacks {
  /** Fired when the BATTLE pill is clicked (and the engine is not paused
   *  in reveal). Game decides what BATTLE means based on current phase. */
  onBattle?: () => void
  /** Fired when the PAUSE toggle changes during reveal. Game forwards
   *  to RevealPhase.paused. true = pause, false = resume. */
  onPauseChange?: (paused: boolean) => void
}

export class MiniControlCenter {
  private host: HTMLDivElement
  private speed: RevealSpeed = getRevealSpeed()
  private paused = false
  // Default to 'loading' so the widget starts HIDDEN. Game.init creates
  // the MCC before the side picker resolves; without this default the
  // dial would flash onto the pick-side screen for a frame.
  private phase: McPhase = 'loading'

  /** Toggle states. Read on construction from localStorage so a player's
   *  choice survives Play Again. */
  private state = {
    music:  isMusicOn(),
    sfx:    isSfxOn(),
    speech: isSpeechBubblesOn(),
    log:    isCombatLogOn(),
  }

  constructor(private cb: MiniControlCenterCallbacks = {}) {
    this.host = document.createElement('div')
    this.host.id = 'mini-control-center'
    this.host.className = 'mcc-cluster mcc-style-c'
    // Start hidden. Default phase is 'loading' so the dial does not
    // flash onto the side-picker screen between construction and the
    // first phase transition.
    this.host.style.display = 'none'
    document.body.appendChild(this.host)
    injectStyles()
    // Apply the persisted combat-log toggle before the first paint so
    // the panel state matches the dial state from the moment the page
    // loads (avoids a flash of "log visible then suddenly hidden").
    this.applyCombatLogVisibility()
    this.paint()
  }

  /** Called by Game on phase transitions so the BATTLE pill label and
   *  enabled state can update (BATTLE during BUILD, BATTLE inert
   *  during reveal since auto-chain drives it, PLAY AGAIN after end).
   *  The widget hides itself entirely during pre-game (loading and
   *  pick-side) so the side picker stays uncluttered. */
  setPhase(phase: McPhase) {
    this.phase = phase
    // Leaving reveal clears any pause state so it does not carry into
    // the next match's reveal (would block the auto-chain).
    if (phase !== 'reveal') this.paused = false
    const hidden = phase === 'loading' || phase === 'pick-side'
    this.host.style.display = hidden ? 'none' : ''
    this.paint()
  }

  /** Game calls this when the engine pauses or resumes for reasons
   *  other than the pill (currently none, but the hook exists). */
  setPaused(paused: boolean) {
    this.paused = paused
    this.paint()
  }

  /** Tear down. Called from Game.dispose when HMR rebuilds. */
  dispose() {
    this.host.remove()
  }

  // ── DOM construction ──────────────────────────────────────────────

  private paint() {
    this.host.className = `mcc-cluster mcc-style-c is-${this.speed}`
    this.host.innerHTML = `
      ${this.dialSvg()}
      <button class="mcc-toggle pos-12 ${this.state.music  ? 'on' : 'off'}" data-toggle="music"  title="Music">${ICON_SVGS.music}</button>
      <button class="mcc-toggle pos-3  ${this.state.sfx    ? 'on' : 'off'}" data-toggle="sfx"    title="Sound effects">${ICON_SVGS.sfx}</button>
      <button class="mcc-toggle pos-6  ${this.state.speech ? 'on' : 'off'}" data-toggle="speech" title="Speech bubbles">${ICON_SVGS.speech}</button>
      <button class="mcc-toggle pos-9  ${this.state.log    ? 'on' : 'off'}" data-toggle="log"    title="Combat log">${ICON_SVGS.log}</button>
      <button class="mcc-action ${this.paused ? 'paused' : ''}" data-role="action">${this.actionLabel()}</button>
      <div class="mcc-action-diamond"></div>
    `
    // Wire interactive parts.
    this.host.querySelectorAll<HTMLElement>('.mcc-tick').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id as RevealSpeed | undefined
        if (!id) return
        this.speed = id
        setRevealSpeed(id)
        playEventSfx('button_click')
        this.paint()
      })
    })
    this.host.querySelectorAll<HTMLElement>('.mcc-toggle').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.toggle as keyof typeof this.state | undefined
        if (!id) return
        this.state[id] = !this.state[id]
        this.persistToggle(id)
        if (id === 'log') this.applyCombatLogVisibility()
        // Single click sound. The 'button_toggle' sample we tried first
        // contained an on-then-off pair which read as a double-click on
        // a single press; this matches the phaser-flavored HUD click.
        playEventSfx('button_click')
        this.paint()
      })
    })
    this.host.querySelector<HTMLElement>('.mcc-action')?.addEventListener('click', () => {
      playEventSfx('button_click')
      this.handleAction()
    })
  }

  private persistToggle(id: keyof typeof this.state) {
    const v = this.state[id]
    switch (id) {
      case 'music':  setMusicOn(v); break
      case 'sfx':    setSfxOn(v); break
      case 'speech': setSpeechBubblesOn(v); break
      case 'log':    setCombatLogPersisted(v); break
    }
  }

  private applyCombatLogVisibility() {
    // Hides or shows the in-HUD combat-history panel. The hide is non-
    // destructive: log entries still get appended to the DOM, just kept
    // off-screen via display:none on the container.
    const v = this.state.log
    document.querySelectorAll<HTMLElement>('.center-log').forEach(el => {
      el.style.display = v ? '' : 'none'
    })
  }

  private actionLabel(): string {
    if (this.phase === 'reveal') return this.paused ? 'RESUME' : 'PAUSE'
    if (this.phase === 'win' || this.phase === 'lose') return 'PLAY AGAIN'
    return 'BATTLE'
  }

  private handleAction() {
    if (this.phase === 'reveal') {
      this.paused = !this.paused
      this.cb.onPauseChange?.(this.paused)
      this.paint()
      return
    }
    if (this.phase === 'win' || this.phase === 'lose') {
      // Full reload. Matches the existing Play Again behaviour
      // elsewhere in the HUD.
      window.location.reload()
      return
    }
    // BUILD or PLANNING: hand off to the game's primary action.
    this.cb.onBattle?.()
  }

  // ── Dial SVG ──────────────────────────────────────────────────────

  private dialSvg(): string {
    const speed = SPEEDS.find(s => s.id === this.speed) ?? SPEEDS[1]
    const arcR = 142
    const arcStart = tickPos(-100, arcR)
    const arcEnd   = tickPos( 100, arcR)
    const arcCircum = 2 * Math.PI * arcR * (200 / 360)
    const liveLen = arcCircum * speed.arcPct
    const arcD = `M ${arcStart.x.toFixed(1)} ${arcStart.y.toFixed(1)} A ${arcR} ${arcR} 0 1 1 ${arcEnd.x.toFixed(1)} ${arcEnd.y.toFixed(1)}`
    const ticks = SPEEDS.map(s => {
      const p = tickPos(s.angle, arcR)
      const active = s.id === this.speed
      return `<circle class="mcc-tick ${s.tickClass}${active ? ' active' : ''}"
                      data-id="${s.id}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${active ? 7 : 6}" />`
    }).join('')
    const sideNotch = (cx: number, cy: number, w: number, h: number) =>
      `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="1.5"
             fill="rgba(8,18,32,0.9)" stroke="rgba(120,200,230,0.45)" stroke-width="1" />`
    return `
      <svg class="mcc-dial" viewBox="0 0 380 380">
        <defs>
          <radialGradient id="mcc-outer" cx="50%" cy="40%" r="60%">
            <stop offset="0%"   stop-color="#0c1e34"/>
            <stop offset="85%"  stop-color="#08152a"/>
            <stop offset="100%" stop-color="#152a45"/>
          </radialGradient>
          <radialGradient id="mcc-mid" cx="50%" cy="40%" r="50%">
            <stop offset="0%"   stop-color="#0a1828"/>
            <stop offset="100%" stop-color="#04101e"/>
          </radialGradient>
          <radialGradient id="mcc-inner-face" cx="50%" cy="38%" r="60%">
            <stop offset="0%"   stop-color="#0d2238"/>
            <stop offset="100%" stop-color="#04101e"/>
          </radialGradient>
          <radialGradient id="mcc-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stop-color="rgba(107,217,255,0.18)"/>
            <stop offset="70%"  stop-color="rgba(107,217,255,0.03)"/>
            <stop offset="100%" stop-color="rgba(107,217,255,0)"/>
          </radialGradient>
        </defs>

        <circle cx="190" cy="190" r="188" fill="url(#mcc-glow)"/>

        <circle cx="190" cy="190" r="180" fill="url(#mcc-outer)"
                stroke="rgba(107,217,255,0.85)" stroke-width="1.5"/>
        <circle cx="190" cy="190" r="176" fill="none"
                stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
        <circle cx="190" cy="190" r="160" fill="url(#mcc-mid)"
                stroke="rgba(107,217,255,0.45)" stroke-width="1"/>
        <circle cx="190" cy="190" r="138" fill="url(#mcc-inner-face)"
                stroke="rgba(107,217,255,0.55)" stroke-width="1"/>

        ${sideNotch(190, 358, 20, 9)}
        ${sideNotch( 14, 190,  9, 26)}
        ${sideNotch(366, 190,  9, 26)}

        <path class="mcc-arc-bg"   d="${arcD}"/>
        <path class="mcc-arc-fill" d="${arcD}"
              stroke-dasharray="${liveLen} ${arcCircum * 2}" />

        ${ticks}

        <line class="mcc-pointer" x1="190" y1="190" x2="190" y2="78"
              style="transform: rotate(${speed.angle}deg)"/>
        <circle class="mcc-hub" cx="190" cy="190" r="7"/>
      </svg>`
  }
}

// ── Styles injected once on first construction ──────────────────────
// Keeps the MCC self-contained (no need to edit index.html). All rules
// are scoped to .mcc-cluster so they cannot leak into existing HUD
// styles per the project's HUD lock protocol.

let stylesInjected = false
function injectStyles() {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.id = 'mini-control-center-styles'
  style.textContent = `
    #mini-control-center {
      position: fixed;
      right: 18px;
      bottom: 18px;
      width: 240px;
      height: 240px;
      z-index: 50;
      font-family: 'Orbitron', monospace;
      user-select: none;
      pointer-events: auto;
      filter: drop-shadow(0 0 18px rgba(107, 217, 255, 0.22));
    }
    .mcc-cluster {
      --sv-c: #6bd9ff; --sv-c-rgb: 107, 217, 255;
    }
    .mcc-cluster.is-slow   { --sv-c: #ffb96b; --sv-c-rgb: 255, 185, 107; }
    .mcc-cluster.is-normal { --sv-c: #6bd9ff; --sv-c-rgb: 107, 217, 255; }
    .mcc-cluster.is-fast   { --sv-c: #ff6b7a; --sv-c-rgb: 255, 107, 122; }

    /* The SVG fills the floating widget. Scales with the .mcc-cluster
       container size, NOT the dial viewBox (380 internal coords). */
    #mini-control-center > svg.mcc-dial {
      position: absolute; inset: 0; width: 100%; height: 100%;
    }

    #mini-control-center .mcc-arc-bg   { fill: none; stroke: rgba(120, 200, 230, 0.16); stroke-width: 9; }
    #mini-control-center .mcc-arc-fill {
      fill: none;
      stroke: var(--sv-c);
      stroke-width: 9;
      stroke-linecap: round;
      filter: drop-shadow(0 0 7px rgba(var(--sv-c-rgb), 0.85));
      transition: stroke 220ms ease, stroke-dasharray 280ms cubic-bezier(0.4, 0, 0.2, 1);
    }
    #mini-control-center .mcc-pointer {
      stroke: var(--sv-c);
      stroke-width: 3;
      stroke-linecap: round;
      filter: drop-shadow(0 0 5px rgba(var(--sv-c-rgb), 0.9));
      transition: transform 240ms cubic-bezier(0.4, 0, 0.2, 1), stroke 220ms ease;
      transform-origin: 190px 190px;
    }
    #mini-control-center .mcc-hub { fill: #0a1828; stroke: rgba(120, 200, 230, 0.6); stroke-width: 1; }

    #mini-control-center .mcc-tick {
      cursor: pointer;
      stroke-width: 1.5;
      transition: fill 160ms ease, stroke 160ms ease, filter 160ms ease, r 160ms ease;
    }
    #mini-control-center .mcc-tick.slow   { --tk: #ffb96b; }
    #mini-control-center .mcc-tick.normal { --tk: #6bd9ff; }
    #mini-control-center .mcc-tick.fast   { --tk: #ff6b7a; }
    #mini-control-center .mcc-tick:not(.active) {
      fill: rgba(120, 200, 230, 0.25);
      stroke: rgba(120, 200, 230, 0.55);
    }
    #mini-control-center .mcc-tick:hover { fill: rgba(216, 238, 249, 0.6); stroke: #d8eef9; }
    #mini-control-center .mcc-tick.active {
      fill: var(--tk);
      stroke: var(--tk);
      filter: drop-shadow(0 0 7px var(--tk));
    }

    #mini-control-center .mcc-toggle {
      position: absolute;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: radial-gradient(circle at 30% 30%, rgba(30, 50, 72, 0.95), rgba(8, 18, 32, 0.95));
      border: 1px solid rgba(120, 200, 230, 0.4);
      color: #6f8ea2;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 140ms ease;
      z-index: 2;
    }
    #mini-control-center .mcc-toggle:hover { color: #d8eef9; border-color: rgba(216, 238, 249, 0.85); }
    #mini-control-center .mcc-toggle svg { width: 18px; height: 18px; display: block; }
    #mini-control-center .mcc-toggle svg path,
    #mini-control-center .mcc-toggle svg circle,
    #mini-control-center .mcc-toggle svg rect,
    #mini-control-center .mcc-toggle svg line {
      stroke: currentColor; fill: none;
      stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
    }
    #mini-control-center .mcc-toggle svg .mc-fill { fill: currentColor; stroke: none; }
    #mini-control-center .mcc-toggle.on {
      color: #84e3a2;
      border-color: #84e3a2;
      background: radial-gradient(circle at 30% 30%, rgba(132, 227, 162, 0.25), rgba(8, 18, 32, 0.85));
      box-shadow: 0 0 11px rgba(132, 227, 162, 0.55), inset 0 0 9px rgba(132, 227, 162, 0.22);
    }
    #mini-control-center .mcc-toggle.off::before {
      content: '';
      position: absolute;
      top: 50%; left: 18%;
      width: 64%; height: 1.4px;
      background: currentColor;
      transform: rotate(-30deg);
      transform-origin: center;
      opacity: 0.7;
      pointer-events: none;
    }

    /* Inner-ring positions. Coords are pixel offsets inside the 240px
       widget, scaled by ~0.63 from the 380px sandbox prototype. */
    #mini-control-center .mcc-toggle.pos-12 { top:  56px; left: 50%;  transform: translateX(-50%); }
    #mini-control-center .mcc-toggle.pos-3  { right: 56px; top:  50%; transform: translateY(-50%); }
    #mini-control-center .mcc-toggle.pos-6  { bottom: 76px; left: 50%; transform: translateX(-50%); }
    #mini-control-center .mcc-toggle.pos-9  { left:  56px; top: 50%;  transform: translateY(-50%); }

    /* Bottom action pill */
    #mini-control-center .mcc-action {
      position: absolute;
      left: 50%;
      bottom: 32px;
      transform: translateX(-50%);
      padding: 6px 22px;
      font-family: 'Orbitron', monospace;
      font-size: 11px;
      letter-spacing: 4px;
      font-weight: 700;
      color: #d8eef9;
      background: linear-gradient(180deg, rgba(20, 36, 56, 0.95), rgba(8, 18, 32, 0.95));
      border: 1px solid rgba(120, 200, 230, 0.55);
      cursor: pointer;
      transition: all 130ms ease;
      z-index: 2;
      clip-path: polygon(
        8px 0, calc(100% - 8px) 0, 100% 50%,
        calc(100% - 8px) 100%, 8px 100%, 0 50%
      );
      box-shadow: 0 0 10px rgba(120, 200, 230, 0.3), inset 0 0 8px rgba(120, 200, 230, 0.18);
    }
    #mini-control-center .mcc-action:hover {
      color: #ffffff;
      border-color: #6bd9ff;
      box-shadow: 0 0 16px rgba(107, 217, 255, 0.7), inset 0 0 10px rgba(107, 217, 255, 0.3);
    }
    #mini-control-center .mcc-action:active { transform: translateX(-50%) translateY(1px); }
    #mini-control-center .mcc-action.paused {
      color: #ffb96b;
      border-color: #ffb96b;
      background: linear-gradient(180deg, rgba(255, 185, 107, 0.15), rgba(8, 18, 32, 0.95));
      box-shadow: 0 0 14px rgba(255, 185, 107, 0.55), inset 0 0 10px rgba(255, 185, 107, 0.22);
    }
    #mini-control-center .mcc-action-diamond {
      position: absolute;
      left: 50%;
      bottom: 20px;
      transform: translateX(-50%) rotate(45deg);
      width: 8px;
      height: 8px;
      background: rgba(107, 217, 255, 0.55);
      box-shadow: 0 0 6px rgba(107, 217, 255, 0.7);
      pointer-events: none;
    }
  `
  document.head.appendChild(style)
}
