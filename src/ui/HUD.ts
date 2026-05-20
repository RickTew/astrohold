import { Config, StructureType, UnitType } from '../game/GameConfig'
import type { PlanningSelectionInfo } from '../game/PlanningPhase'
import type { CombatLogEntry } from '../game/RevealPhase'

const SPHERE_COST = 100   // mirrors Game.SPHERE_COST

export class HUD {
  private container: HTMLElement
  // Credit displays live in TWO places now: the player's full panel and the
  // opponent's slim readout. We update both unconditionally; CSS hides
  // whichever one isn't visible for the chosen side, so callers don't have
  // to know which is active.
  private creditsEls: HTMLElement[] = []
  private attCreditsEls: HTMLElement[] = []
  private phaseEls: HTMLElement[] = []
  private topBarEl!: HTMLElement
  private bottomBarEl!: HTMLElement
  private robotShopEl!: HTMLElement
  private cyborgShopEl!: HTMLElement
  private sidePickerEl!: HTMLElement
  private messageEl!: HTMLElement
  private loadingEl!: HTMLElement
  private planBarEl!: HTMLElement
  private planSelectionEl!: HTMLElement
  private combatLogEl!: HTMLElement
  // Sticky empty-state marker so we know whether to wipe the "(combat will
  // appear here…)" placeholder on first append.
  private combatLogEmpty = true
  private compassRoseEl: HTMLElement | null = null
  // Document-level mousedown listener installed when the rose opens. Closes
  // the rose on any click outside the rose DOM — works regardless of whether
  // the click lands on the canvas or another HUD element.
  private compassRoseOutsideListener: ((e: MouseEvent) => void) | null = null

  onSelectStructure: ((type: StructureType) => void) | null = null
  onSpawnUnit: ((type: UnitType) => void) | null = null
  onBuySphere: (() => void) | null = null
  onBuyDog: (() => void) | null = null
  onBattle: (() => void) | null = null
  // Side picker — fired after the player clicks their team card. Game uses
  // this to set playerSide and wire up the OpponentAI.
  onPickSide: ((side: 'defender' | 'attacker') => void) | null = null
  // Compass-rose callbacks. Game decides whether the purchase succeeds (cost,
  // credits, duplicate facing); HUD just forwards the click intent.
  onAddFacing: ((angle: number) => void) | null = null
  // Player clicked Refund on an opened rose. Game removes the structure and
  // returns the base cost. HUD will auto-close the rose after the callback.
  onRefundStructure: (() => void) | null = null
  // Rose closed (via the X button, document-level outside-click listener, or
  // hideCompassRose called by Game). Game uses this to clear editingStructure
  // and hide the arc-preview overlay.
  onRoseClose: (() => void) | null = null

  constructor() {
    this.container = document.getElementById('hud')!
    this.build()
  }

  private build() {
    const corners = '<div class="corner-bracket tl"></div><div class="corner-bracket tr"></div><div class="corner-bracket bl"></div><div class="corner-bracket br"></div>'

    const robotBtn = (id: string, label: string, cost: number, icon: string, opts: { preview?: boolean; dataType?: string } = {}) => {
      const cls = `shop-icon-btn${opts.preview ? ' preview' : ''}`
      const attrs = opts.dataType ? ` data-type="${opts.dataType}"` : ''
      const idAttr = id ? ` id="${id}"` : ''
      const iconHtml = icon === 'wall'
        ? '<div class="icon icon-wall"></div>'
        : `<div class="icon"><img src="${icon}" alt=""/></div>`
      return `<button${idAttr} class="${cls}"${attrs}>${iconHtml}<div class="label">${label}</div><div class="cost">${cost}cr</div></button>`
    }
    const cybBtn = (label: string, cost: number, icon: string, dataType: string) =>
      `<button class="shop-icon-btn att-btn" data-type="${dataType}"><div class="icon"><img src="${icon}" alt=""/></div><div class="label">${label}</div><div class="cost">${cost}cr</div></button>`

    this.container.innerHTML = `
      <div id="loading-screen">LOADING ASSETS...</div>

      <div id="side-picker" class="hidden">
        <div class="sp-title">ASTROHOLD</div>
        <div class="sp-headline">CHOOSE YOUR SIDE</div>
        <div class="sp-cards">
          <div class="sp-card def" data-side="defender" role="button" tabindex="0">
            <div class="sp-team-name">ROBOTS</div>
            <div class="sp-role">DEFEND THE POWER CORE</div>
            <div class="sp-hero"><img src="/sprites/sphere/south.png" alt=""/></div>
            <div class="sp-tagline">Spheres, towers, walls, and dogs.<br/>Hold the line — let nothing through.</div>
            <div class="sp-cta">PLAY ROBOTS</div>
          </div>
          <div class="sp-card att" data-side="attacker" role="button" tabindex="0">
            <div class="sp-team-name">CYBORGS</div>
            <div class="sp-role">DESTROY THE POWER CORE</div>
            <div class="sp-hero"><img src="/sprites/hulk/south.png" alt=""/></div>
            <div class="sp-tagline">Cannons, snipers, grenadiers, hulks.<br/>Push west — break the defenders.</div>
            <div class="sp-cta">PLAY CYBORGS</div>
          </div>
        </div>
      </div>

      <div id="top-bar" class="hidden">
        <div id="robot-panel" class="team-panel def">
          ${corners}
          <div class="panel-banner">
            <span class="banner-side-tag">ROBOTS</span>
            <span class="banner-phase" id="phase-banner-r">BUILD PHASE</span>
            <span class="credits-chip">CR <span class="cr-num" id="credits-val">200</span></span>
          </div>
          <div class="panel-grid">
            ${robotBtn('sphere-btn', 'Sphere',  100, '/sprites/sphere/south.png')}
            ${robotBtn('',           'Tower',    30, '/sprites/tower/south.png',   { dataType: 'turret' })}
            ${robotBtn('',           'Bomber',   70, '/sprites/bomber/south.png',  { dataType: 'bomber' })}
            ${robotBtn('',           'Wall',     20, 'wall',                       { dataType: 'wall'   })}
            ${robotBtn('dog-btn',    'Dog',      40, '/sprites/dog/south.png')}
            ${robotBtn('',           'Defense',  20, '/sprites/defense/south.png', { dataType: 'defense', preview: true })}
            ${robotBtn('',           'Gun',      30, '/sprites/gun/south.png',     { dataType: 'gun',     preview: true })}
            ${robotBtn('',           'Laser',    40, '/sprites/laser/south.png',   { dataType: 'laser',   preview: true })}
            ${robotBtn('',           'Signal',   20, '/sprites/signal/south.png',  { dataType: 'signal',  preview: true })}
          </div>
          <div class="panel-footer">
            <div class="vs-badge">
              <span class="vs-label">VS</span>
              <span class="vs-opponent">CYBORGS</span>
              <span class="vs-tag">AI</span>
            </div>
            <div class="intel-status">OPPONENT INTEL · REDACTED</div>
          </div>
        </div>

        <div id="cyborg-panel" class="team-panel att">
          ${corners}
          <div class="panel-banner">
            <span class="banner-side-tag">CYBORGS</span>
            <span class="banner-phase" id="phase-banner-c">BUILD PHASE</span>
            <span class="credits-chip">CR <span class="cr-num" id="att-credits-val-panel">200</span></span>
          </div>
          <div class="panel-grid">
            ${cybBtn('Cannon',    70, '/sprites/cannon/south.png',    'cannon')}
            ${cybBtn('Grenadier', 50, '/sprites/grenadier/south.png', 'grenadier')}
            ${cybBtn('Double Gun',90, '/sprites/doublegun/south.png', 'doublegun')}
            ${cybBtn('Hulk',     100, '/sprites/hulk/south.png',      'hulk')}
            ${cybBtn('Sniper',    90, '/sprites/sniper/south.png',    'sniper')}
          </div>
          <div class="panel-footer">
            <div class="vs-badge">
              <span class="vs-label">VS</span>
              <span class="vs-opponent">ROBOTS</span>
              <span class="vs-tag">AI</span>
            </div>
            <div class="intel-status">OPPONENT INTEL · REDACTED</div>
          </div>
        </div>
      </div>

      <div id="bottom-bar" class="hidden">
        <button id="battle-btn">
          <span class="btn-led"></span>
          <span class="btn-text">READY</span>
        </button>
      </div>

      <div id="plan-bar" class="hidden">
        <div id="plan-instructions">
          <strong>PLAN PHASE</strong>
          <span>Click a piece &middot; click a cell to queue Move &middot; Shift+click an enemy to queue Fire &middot; Right-click to clear / deselect</span>
        </div>
      </div>
      <div id="plan-selection" class="hidden"></div>
      <div id="combat-log" class="hidden"><div class="log-empty">(combat events appear here as the battle plays)</div></div>
      <div id="game-message" class="hidden"></div>
    `

    this.loadingEl        = this.container.querySelector('#loading-screen')!
    this.topBarEl         = this.container.querySelector('#top-bar')!
    this.bottomBarEl      = this.container.querySelector('#bottom-bar')!
    this.robotShopEl      = this.container.querySelector('#robot-panel')!
    this.cyborgShopEl     = this.container.querySelector('#cyborg-panel')!
    this.sidePickerEl     = this.container.querySelector('#side-picker')!
    this.messageEl        = this.container.querySelector('#game-message')!
    this.planBarEl        = this.container.querySelector('#plan-bar')!
    this.planSelectionEl  = this.container.querySelector('#plan-selection')!
    this.combatLogEl      = this.container.querySelector('#combat-log')!
    // Each panel has its own phase banner — both stay in sync via setPhase
    // so the inactive panel's text doesn't go stale if the player switches.
    this.phaseEls = Array.from(this.container.querySelectorAll<HTMLElement>('.banner-phase'))

    // Credits display lives in each panel header. The AI side's credits are
    // never shown to the player — opponent intel stays hidden until BATTLE.
    this.creditsEls = [
      this.container.querySelector('#credits-val'),
    ].filter(Boolean) as HTMLElement[]
    this.attCreditsEls = [
      this.container.querySelector('#att-credits-val-panel'),
    ].filter(Boolean) as HTMLElement[]

    // Side picker — clicking either card sets the player's side. Mouse-only
    // per the no-keyboard rule, so we don't bind Enter/Space here.
    this.container.querySelectorAll<HTMLElement>('#side-picker .sp-card').forEach(card => {
      card.addEventListener('click', () => {
        const side = card.dataset.side as 'defender' | 'attacker'
        this.onPickSide?.(side)
      })
    })

    this.container.querySelector('#sphere-btn')?.addEventListener('click', () => {
      this.onBuySphere?.()
    })

    this.container.querySelector('#dog-btn')?.addEventListener('click', () => {
      this.onBuyDog?.()
    })

    // Robot structure buttons: any shop-icon-btn with data-type inside the
    // robot panel. Excludes the att-btn class (those go to the cyborg handler).
    this.container.querySelectorAll('#robot-panel .shop-icon-btn[data-type]').forEach(btn => {
      btn.addEventListener('click', e => {
        const type = (e.currentTarget as HTMLElement).dataset.type as StructureType
        this.container.querySelectorAll('#robot-panel .shop-icon-btn').forEach(b => b.classList.remove('selected'))
        ;(e.currentTarget as HTMLElement).classList.add('selected')
        this.onSelectStructure?.(type)
      })
    })

    this.container.querySelectorAll('.att-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        const type = (e.currentTarget as HTMLElement).dataset.type as UnitType
        this.onSpawnUnit?.(type)
      })
    })

    this.container.querySelector('#battle-btn')!.addEventListener('click', () => {
      this.playBattleSound()
      this.onBattle?.()
    })
  }

  showGame() {
    this.loadingEl.classList.add('hidden')
    // Team labels + credits + phase display live inside #top-bar, which
    // setPhase() un-hides at the start of the build phase. Nothing extra here.
  }

  // Reveal the side picker. Game listens via onPickSide for the chosen team
  // and proceeds into BUILD once the player commits.
  showSidePicker() {
    this.loadingEl.classList.add('hidden')
    this.sidePickerEl.classList.remove('hidden')
  }

  // Lock in the player's chosen side. Adds the gating class on #top-bar
  // that hides the AI side's panel. The VS badge inside each panel footer
  // already names the opposite side, so no extra wiring needed.
  setPlayerSide(side: 'defender' | 'attacker') {
    this.sidePickerEl.classList.add('hidden')
    this.topBarEl.classList.remove('player-defender', 'player-attacker')
    this.topBarEl.classList.add(side === 'defender' ? 'player-defender' : 'player-attacker')
  }

  setCredits(amount: number) {
    for (const el of this.creditsEls) el.textContent = String(amount)
    this.refreshAffordability('robots', amount)
  }

  setAttCredits(amount: number) {
    for (const el of this.attCreditsEls) el.textContent = String(amount)
    this.refreshAffordability('cyborgs', amount)
  }

  // Grey out buttons whose cost exceeds current credits so failed placements
  // are obvious. Was previously silent — user thought placement was broken.
  private refreshAffordability(side: 'robots' | 'cyborgs', credits: number) {
    if (side === 'robots') {
      const sphereBtn = this.container.querySelector('#sphere-btn')
      sphereBtn?.classList.toggle('insufficient', credits < SPHERE_COST)
      const dogBtn = this.container.querySelector('#dog-btn')
      dogBtn?.classList.toggle('insufficient', credits < Config.UNITS.dog.cost)
      this.container.querySelectorAll('#robot-panel .shop-icon-btn[data-type]').forEach(b => {
        const type = (b as HTMLElement).dataset.type as StructureType
        const cost = Config.STRUCTURES[type]?.cost ?? 0
        b.classList.toggle('insufficient', credits < cost)
      })
    } else {
      this.container.querySelectorAll('#cyborg-panel .shop-icon-btn[data-type]').forEach(b => {
        const type = (b as HTMLElement).dataset.type as UnitType
        const cost = Config.UNITS[type]?.cost ?? 0
        b.classList.toggle('insufficient', credits < cost)
      })
    }
  }

  setSelectedUnitType(type: UnitType | null) {
    this.container.querySelectorAll('#cyborg-panel .shop-icon-btn').forEach(b => b.classList.remove('selected'))
    if (type) {
      this.container.querySelector(`#cyborg-panel .shop-icon-btn[data-type="${type}"]`)?.classList.add('selected')
    }
  }

  // Drop the visual "selected" highlight off any structure button — called
  // when the player picks a sphere/cyborg so the UI mirrors that the
  // structure placement was cancelled under the hood.
  clearStructureSelection() {
    this.container.querySelectorAll('#robot-panel .shop-icon-btn').forEach(b => b.classList.remove('selected'))
  }

  setPhase(phase: 'build' | 'planning' | 'reveal' | 'win' | 'lose') {
    // Top bar = player's team panel + banner. Bottom bar = READY button.
    // Both visible during BUILD + PLAN, hidden during REVEAL so the
    // battlefield is unobstructed.
    const setPhaseText = (s: string) => { for (const el of this.phaseEls) el.textContent = s }
    const setButtonText = (s: string) => {
      const btnText = this.container.querySelector('#battle-btn .btn-text')
      if (btnText) btnText.textContent = s
    }
    switch (phase) {
      case 'build':
        setPhaseText('BUILD PHASE')
        setButtonText('READY')
        this.topBarEl.classList.remove('hidden')
        this.bottomBarEl.classList.remove('hidden')
        this.robotShopEl.classList.remove('disabled')
        this.cyborgShopEl.classList.remove('disabled')
        this.planBarEl.classList.add('hidden')
        this.planSelectionEl.classList.add('hidden')
        this.combatLogEl.classList.add('hidden')
        this.messageEl.classList.add('hidden')
        break
      case 'planning':
        setPhaseText('PLAN PHASE')
        setButtonText('BATTLE')
        this.topBarEl.classList.remove('hidden')
        this.bottomBarEl.classList.remove('hidden')
        this.robotShopEl.classList.add('disabled')
        this.cyborgShopEl.classList.add('disabled')
        this.planBarEl.classList.remove('hidden')
        this.combatLogEl.classList.add('hidden')
        this.messageEl.classList.add('hidden')
        break
      case 'reveal':
        setPhaseText('BATTLE')
        this.topBarEl.classList.add('hidden')
        this.bottomBarEl.classList.add('hidden')
        this.planBarEl.classList.add('hidden')
        this.planSelectionEl.classList.add('hidden')
        this.combatLogEl.classList.remove('hidden')
        this.messageEl.classList.add('hidden')
        break
      case 'win':
        setPhaseText('BATTLE')
        this.showEndMessage('DEFENDER WINS', 'Power Core survived', '#00ffaa')
        break
      case 'lose':
        setPhaseText('BATTLE')
        this.showEndMessage('ATTACKER WINS', 'Power Core destroyed', '#ff4444')
        break
    }
  }

  // Win/lose overlay with a Play Again button. Reload-based reset — simplest
  // reliable path, avoids the partial-state landmines a hand-rolled reset
  // would hit (pending grenades, animation frames mid-clip, audio context).
  private showEndMessage(headline: string, subtitle: string, color: string) {
    this.messageEl.innerHTML = `
      ${headline}
      <small>${subtitle}</small>
      <button id="play-again-btn">Play Again</button>
    `
    this.messageEl.style.color = color
    this.messageEl.classList.remove('hidden')
    this.messageEl.querySelector('#play-again-btn')?.addEventListener('click', () => {
      window.location.reload()
    })
  }

  // Shown when a reveal completes with 0 planned actions — no piece on
  // either side can act (out of ammo, no targets in sight, no movement
  // options). Same Play Again affordance as win/lose so the player isn't
  // stuck staring at a frozen board.
  showStalemate(reason?: string) {
    this.showEndMessage(
      'STALEMATE',
      reason ?? 'No piece can act — start a new round?',
      '#ffcc44',
    )
  }

  hideMessage() {
    this.messageEl.classList.add('hidden')
    this.messageEl.innerHTML = ''
  }

  // ── Compass rose ─────────────────────────────────────────────────────────

  // Open the rose at a fixed screen position. activeFacings is the list of
  // currently-active math-angles (0=east, π/2=north, etc); cost is the price
  // to add ONE new facing; credits is the player's current balance (drives
  // the unaffordable greyout). The 'name' label is the structure type shown
  // in the title row.
  showCompassRose(screenX: number, screenY: number, opts: {
    name: string
    activeFacings: ReadonlyArray<number>
    cost: number
    credits: number
  }) {
    this.hideCompassRose()
    const el = document.createElement('div')
    el.id = 'compass-rose'
    el.style.left = `${screenX}px`
    el.style.top  = `${screenY}px`
    el.innerHTML = this.buildRoseInnerHtml(opts)
    this.wireRoseButtons(el)
    this.container.appendChild(el)
    this.compassRoseEl = el

    // Document-level mousedown: close the rose on ANY click outside its DOM.
    // Captures the event before Game's window-level handler so it can decide
    // whether to bubble (no stopPropagation here — Game's refund/place still
    // runs on the same click, which is exactly what the user expects: one
    // click closes the rose AND acts at the click target).
    this.compassRoseOutsideListener = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target && this.compassRoseEl?.contains(target)) return
      this.hideCompassRose()
    }
    document.addEventListener('mousedown', this.compassRoseOutsideListener, true)
  }

  hideCompassRose() {
    // Only fire onRoseClose if there was actually an open rose to close —
    // otherwise the internal-cleanup call at the top of showCompassRose
    // would clobber Game's editingStructure RIGHT AFTER it was set, breaking
    // the rose's button clicks.
    const wasOpen = this.compassRoseEl !== null
    if (this.compassRoseEl) {
      this.compassRoseEl.remove()
      this.compassRoseEl = null
    }
    if (this.compassRoseOutsideListener) {
      document.removeEventListener('mousedown', this.compassRoseOutsideListener, true)
      this.compassRoseOutsideListener = null
    }
    if (wasOpen) this.onRoseClose?.()
  }

  private wireRoseButtons(el: HTMLElement) {
    el.querySelectorAll<HTMLElement>('.rose-btn[data-angle]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) return
        if (btn.classList.contains('unaffordable')) return
        const angle = parseFloat(btn.dataset.angle!)
        this.onAddFacing?.(angle)
      })
    })
    el.querySelector<HTMLElement>('.rose-close-btn')?.addEventListener('click', () => {
      this.hideCompassRose()
    })
    el.querySelector<HTMLElement>('.rose-refund-btn')?.addEventListener('click', () => {
      this.onRefundStructure?.()
      this.hideCompassRose()
    })
  }

  isCompassRoseOpen(): boolean { return this.compassRoseEl !== null }

  // Re-render the rose's button states without recreating the DOM element.
  // Called by Game after a successful addFacing so the newly-active direction
  // flips to its "active" style and the cost recalculates.
  refreshCompassRose(opts: {
    name: string
    activeFacings: ReadonlyArray<number>
    cost: number
    credits: number
  }) {
    if (!this.compassRoseEl) return
    this.compassRoseEl.innerHTML = this.buildRoseInnerHtml(opts)
    this.wireRoseButtons(this.compassRoseEl)
  }

  private buildRoseInnerHtml(opts: {
    name: string
    activeFacings: ReadonlyArray<number>
    cost: number
    credits: number
  }): string {
    // Order: top row blank/N/blank, middle W/center/E, bottom blank/S/blank.
    // Cardinal labels in compass terms (top-down view): N = +Y (up on screen),
    // E = +X (right), S = -Y (down), W = -X (left). Math angles: E=0, N=π/2,
    // W=π, S=-π/2 (or 3π/2 normalized).
    const dirs: Array<{ key: string; angle: number; arrow: string; pos: number }> = [
      { key: 'N', angle:  Math.PI / 2,  arrow: '↑', pos: 2 },
      { key: 'W', angle:  Math.PI,      arrow: '←', pos: 4 },
      { key: 'E', angle:  0,            arrow: '→', pos: 6 },
      { key: 'S', angle: -Math.PI / 2,  arrow: '↓', pos: 8 },
    ]
    const TAU = Math.PI * 2
    const isActive = (a: number) =>
      opts.activeFacings.some(f => {
        const fn = ((f % TAU) + TAU) % TAU
        const an = ((a % TAU) + TAU) % TAU
        return Math.abs(fn - an) < 0.01
      })
    // Build the 3x3 grid by position index (1..9). Corners + center get fillers.
    const cells: string[] = []
    for (let i = 1; i <= 9; i++) {
      if (i === 5) {
        cells.push('<div class="rose-center">' + opts.activeFacings.length + '/4</div>')
        continue
      }
      const d = dirs.find(x => x.pos === i)
      if (!d) { cells.push('<div></div>'); continue }
      if (isActive(d.angle)) {
        cells.push(`<div class="rose-btn active" data-angle="${d.angle}"><span class="rose-arrow">${d.arrow}</span><span class="rose-on">ON</span></div>`)
      } else if (opts.credits < opts.cost) {
        cells.push(`<div class="rose-btn unaffordable" data-angle="${d.angle}"><span class="rose-arrow">${d.arrow}</span><span class="rose-cost">+${opts.cost}cr</span></div>`)
      } else {
        cells.push(`<div class="rose-btn" data-angle="${d.angle}"><span class="rose-arrow">${d.arrow}</span><span class="rose-cost">+${opts.cost}cr</span></div>`)
      }
    }
    return `
      <div class="rose-title">
        <span>${opts.name} arcs</span>
        <button class="rose-close-btn" type="button" aria-label="Close">✕</button>
      </div>
      ${cells.join('')}
      <div class="rose-footer">
        <button class="rose-refund-btn" type="button">Refund</button>
      </div>
    `
  }

  // Append one reveal's worth of combat-log entries under a "── Turn N ──"
  // header. Auto-scrolls to the bottom so the latest action is in view; trims
  // the DOM to the last ~200 entries so long battles don't bloat memory.
  appendCombatLog(turn: number, entries: ReadonlyArray<CombatLogEntry>) {
    if (entries.length === 0) return
    if (this.combatLogEmpty) {
      this.combatLogEl.innerHTML = ''
      this.combatLogEmpty = false
    }
    const header = document.createElement('div')
    header.className = 'log-turn'
    header.textContent = `── Turn ${turn} ──`
    this.combatLogEl.appendChild(header)
    for (const e of entries) {
      const row = document.createElement('div')
      row.className = `log-entry ${e.side}`
      row.textContent = e.text
      this.combatLogEl.appendChild(row)
    }
    const MAX_ROWS = 220
    while (this.combatLogEl.childElementCount > MAX_ROWS) {
      this.combatLogEl.removeChild(this.combatLogEl.firstChild!)
    }
    this.combatLogEl.scrollTop = this.combatLogEl.scrollHeight
  }

  setPlanningSelection(info: PlanningSelectionInfo | null) {
    if (!info) {
      this.planSelectionEl.classList.add('hidden')
      this.planSelectionEl.innerHTML = ''
      return
    }
    const queueLines = info.queuedActions.length === 0
      ? '<em>(no actions queued)</em>'
      : info.queuedActions.map((a, i) => {
          if (a.kind === 'move')  return `${i + 1}. Move → (${a.cell.col}, ${a.cell.row})`
          if (a.kind === 'fire')  return `${i + 1}. Fire → ${a.target.kind}:${a.target.id}`
          if (a.kind === 'throw') return `${i + 1}. Throw → (${a.cell.col}, ${a.cell.row})`
          return `${i + 1}. Hold`
        }).join('<br>')
    const sideColor = info.side === 'defender' ? '#66ccff' : '#ff7766'
    this.planSelectionEl.innerHTML = `
      <div class="plan-sel-header" style="color:${sideColor}">${info.label}</div>
      <div class="plan-sel-ap">AP: <strong>${info.apRemaining}</strong> / ${info.apBudget}</div>
      <div class="plan-sel-queue">${queueLines}</div>
    `
    this.planSelectionEl.classList.remove('hidden')
  }

  private playBattleSound() {
    try {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(220, ctx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.35)
      gain.gain.setValueAtTime(0.25, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.45)
      osc.onended = () => ctx.close()
    } catch { /* audio unavailable */ }
  }

  dispose() {
    this.container.innerHTML = ''
  }
}
