import { Config, StructureType, UnitType } from '../game/GameConfig'
import type { PlanningSelectionInfo } from '../game/PlanningPhase'
import type { CombatLogEntry } from '../game/RevealPhase'

const SPHERE_COST = 100   // mirrors Game.SPHERE_COST

export class HUD {
  private container: HTMLElement
  private creditsEl!: HTMLElement
  private attCreditsEl!: HTMLElement
  private robotShopEl!: HTMLElement
  private cyborgShopEl!: HTMLElement
  private messageEl!: HTMLElement
  private loadingEl!: HTMLElement
  private planSelectionEl!: HTMLElement
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
  // Side picker — Game listens here for the chosen team. Fires once with the
  // player's faction (visual identity) + role (defender or attacker). The AI
  // gets the opposite role with a randomly-chosen faction.
  onPickSide: ((faction: 'robot' | 'cyborg', role: 'defender' | 'attacker') => void) | null = null
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
    // 10 tiles per side panel. Reference image has Sphere/Tower/Bomber/Wall/
    // Dog over Defense/Gun/Gun/Laser/Signal — we duplicate Gun to fill the
    // 10th slot since we don't have a tenth distinct piece yet. Each panel
    // (left + right) shows the same set; both are clickable and route to
    // the same handlers via class selectors.
    type Tile = {
      label: string; cost: number; icon: string;
      action?: 'sphere' | 'dog'; dataType?: string; preview?: boolean
    }
    const robotTiles: Tile[] = [
      { label: 'SPHERE',  cost: 100, icon: '/sprites/sphere/south.png', action: 'sphere' },
      { label: 'TOWER',   cost:  30, icon: '/sprites/tower/south.png',  dataType: 'turret' },
      { label: 'BOMBER',  cost:  70, icon: '/sprites/bomber/south.png', dataType: 'bomber' },
      { label: 'WALL',    cost:  20, icon: 'wall',                       dataType: 'wall' },
      { label: 'DOG',     cost:  40, icon: '/sprites/dog/south.png',    action: 'dog' },
      { label: 'DEFENSE', cost:  20, icon: '/sprites/defense/south.png', dataType: 'defense', preview: true },
      { label: 'GUN',     cost:  30, icon: '/sprites/gun/south.png',     dataType: 'gun',     preview: true },
      { label: 'GUN',     cost:  30, icon: '/sprites/gun/south.png',     dataType: 'gun',     preview: true },
      { label: 'LASER',   cost:  40, icon: '/sprites/laser/south.png',   dataType: 'laser',   preview: true },
      { label: 'SIGNAL',  cost:  20, icon: '/sprites/signal/south.png',  dataType: 'signal',  preview: true },
    ]
    const cyborgTiles: Tile[] = [
      { label: 'CANNON',   cost:  70, icon: '/sprites/cannon/south.png',    dataType: 'cannon' },
      { label: 'GRENADIER',cost:  50, icon: '/sprites/grenadier/south.png', dataType: 'grenadier' },
      { label: 'DOUBLEGUN',cost:  90, icon: '/sprites/doublegun/south.png', dataType: 'doublegun' },
      { label: 'HULK',     cost: 100, icon: '/sprites/hulk/south.png',      dataType: 'hulk' },
      { label: 'SNIPER',   cost:  90, icon: '/sprites/sniper/south.png',    dataType: 'sniper' },
      // duplicates to fill the 10-slot grid until we have more cyborg pieces.
      { label: 'CANNON',   cost:  70, icon: '/sprites/cannon/south.png',    dataType: 'cannon' },
      { label: 'GRENADIER',cost:  50, icon: '/sprites/grenadier/south.png', dataType: 'grenadier' },
      { label: 'DOUBLEGUN',cost:  90, icon: '/sprites/doublegun/south.png', dataType: 'doublegun' },
      { label: 'HULK',     cost: 100, icon: '/sprites/hulk/south.png',      dataType: 'hulk' },
      { label: 'SNIPER',   cost:  90, icon: '/sprites/sniper/south.png',    dataType: 'sniper' },
    ]
    const tileHtml = (t: Tile, sideTag: 'def' | 'att') => {
      const classes = ['hud-tile', sideTag]
      if (t.preview) classes.push('preview')
      const data = t.action ? `data-action="${t.action}"`
                : t.dataType ? `data-type="${t.dataType}"`
                : ''
      const iconEl = t.icon === 'wall'
        ? '<div class="tile-icon icon-wall"></div>'
        : `<div class="tile-icon"><img src="${t.icon}" alt=""/></div>`
      // title attribute kicks in at narrow widths (≤640px) where the tile
      // label is CSS-hidden — browser shows it on hover, players can still
      // identify pieces.
      return `<button class="${classes.join(' ')}" ${data} title="${t.label} — ${t.cost}cr">` +
        iconEl +
        `<div class="tile-label">${t.label}</div>` +
        `<div class="tile-cost">${t.cost}cr</div>` +
      `</button>`
    }

    // Clean octagonal silhouette for the side panels — chamfered top + bottom
    // corners so tiles fit cleanly inside without overflowing the outline.
    // 8px chamfers (viewBox 200×210, scaled by preserveAspectRatio="none").
    const sidePanelPath = 'M 12,4 L 188,4 L 196,12 L 196,198 L 188,206 L 12,206 L 4,198 L 4,12 Z'
    const sidePanelSvg = (side: 'def' | 'att', flip: boolean) => `
      <svg class="panel-frame" viewBox="0 0 200 210" preserveAspectRatio="none" aria-hidden="true"${flip ? ' style="transform:scaleX(-1)"' : ''}>
        <path d="${sidePanelPath}"
              fill="rgba(8, 18, 32, 0.55)"
              stroke="${side === 'def' ? '#5aa7d4' : '#d45a7a'}"
              stroke-width="2.8" stroke-linejoin="miter"
              vector-effect="non-scaling-stroke"/>
      </svg>`
    // Center panel — raised banner on top that protrudes upward, chamfered
    // corners on all sides, internal divider line under the banner area.
    const centerPanelSvg = (side: 'def' | 'att') => `
      <svg class="panel-frame" viewBox="0 0 320 210" preserveAspectRatio="none" aria-hidden="true">
        <path d="M 12,30 L 28,14 L 100,14 L 112,4 L 208,4 L 220,14 L 292,14 L 308,30 L 308,198 L 296,210 L 24,210 L 12,198 Z"
              fill="rgba(8, 18, 32, 0.55)"
              stroke="${side === 'def' ? '#5aa7d4' : '#d45a7a'}"
              stroke-width="2.8" stroke-linejoin="miter"
              vector-effect="non-scaling-stroke"/>
        <!-- Internal banner divider — separates BUILD PHASE area from below. -->
        <line x1="40" y1="62" x2="280" y2="62"
              stroke="${side === 'def' ? '#5aa7d4' : '#d45a7a'}"
              stroke-width="0.6" stroke-opacity="0.55"
              vector-effect="non-scaling-stroke"/>
        <!-- Decorative tick marks flanking the BUILD PHASE area. -->
        <line x1="32" y1="38" x2="48" y2="38"
              stroke="${side === 'def' ? '#8fd0f2' : '#f28fa6'}"
              stroke-width="1.4" stroke-opacity="0.85"
              vector-effect="non-scaling-stroke"/>
        <line x1="272" y1="38" x2="288" y2="38"
              stroke="${side === 'def' ? '#8fd0f2' : '#f28fa6'}"
              stroke-width="1.4" stroke-opacity="0.85"
              vector-effect="non-scaling-stroke"/>
      </svg>`

    this.container.innerHTML = `
      <div id="loading-screen">LOADING ASSETS...</div>

      <div id="hud-top" class="hidden">
        <div class="hud-panel hud-left" data-side="def">
          ${sidePanelSvg('def', false)}
          <div class="panel-content">
            <div class="tile-grid">
              ${robotTiles.map(t => tileHtml(t, 'def')).join('')}
            </div>
          </div>
        </div>

        <div class="hud-panel hud-center" data-side="def">
          ${centerPanelSvg('def')}
          <div class="panel-content">
            <!-- BUILD / PLAN content: phase title, credits, VS chip, status
                 message, primary action button. Hidden during REVEAL. -->
            <div class="center-build-info">
              <div class="center-banner-row">
                <div class="center-phase">BUILD PHASE</div>
              </div>
              <div class="center-credits">CR<span class="cr-num" id="credits-val">1000</span></div>
              <div class="center-matchup">
                <span class="vs-player">ROBOTS</span>
                <span class="vs-label">VS</span>
                <span class="vs-team">CYBORGS</span>
              </div>
              <div class="center-events"></div>
              <button class="center-action-btn" data-action="primary">READY</button>
            </div>
            <!-- REVEAL content: combat log fills the panel. -->
            <div class="center-log hidden"><div class="log-empty">(combat events appear here)</div></div>
          </div>
        </div>

        <div class="hud-panel hud-right" data-side="def">
          ${sidePanelSvg('def', true)}
          <div class="panel-content">
            <div class="tile-grid">
              ${robotTiles.map(t => tileHtml(t, 'def')).join('')}
            </div>
          </div>
        </div>

      </div>

      <!-- Cyborg variant. Same structure; swapped tile content and red palette. -->
      <div id="hud-top-att" class="hidden">
        <div class="hud-panel hud-left" data-side="att">
          ${sidePanelSvg('att', false)}
          <div class="panel-content">
            <div class="tile-grid">
              ${cyborgTiles.map(t => tileHtml(t, 'att')).join('')}
            </div>
          </div>
        </div>

        <div class="hud-panel hud-center" data-side="att">
          ${centerPanelSvg('att')}
          <div class="panel-content">
            <div class="center-build-info">
              <div class="center-banner-row">
                <div class="center-phase">BUILD PHASE</div>
              </div>
              <div class="center-credits">CR<span class="cr-num" id="att-credits-val">1000</span></div>
              <div class="center-matchup">
                <span class="vs-player">CYBORGS</span>
                <span class="vs-label">VS</span>
                <span class="vs-team">ROBOTS</span>
              </div>
              <div class="center-events"></div>
              <button class="center-action-btn" data-action="primary">READY</button>
            </div>
            <div class="center-log hidden"><div class="log-empty">(combat events appear here)</div></div>
          </div>
        </div>

        <div class="hud-panel hud-right" data-side="att">
          ${sidePanelSvg('att', true)}
          <div class="panel-content">
            <div class="tile-grid">
              ${cyborgTiles.map(t => tileHtml(t, 'att')).join('')}
            </div>
          </div>
        </div>

      </div>

      <!-- bottom-bar (READY) and plan-bar (BATTLE) moved INTO each center
           panel as .center-action-btn. Combat log lives in .center-log
           inside the visible center panel. -->
      <div id="plan-selection" class="hidden"></div>
      <div id="game-message" class="hidden"></div>
      <div id="side-picker" class="hidden">
        <div class="sp-inner">
          <div class="sp-title">ASTROHOLD</div>
          <div class="sp-headline">CHOOSE YOUR SIDE</div>
          <div class="sp-cards">
            <button class="sp-card defender" data-faction="robot" data-role="defender">
              <div class="sp-role-label">DEFENDER</div>
              <div class="sp-team-name">Robots</div>
              <div class="sp-hero"><img src="/sprites/sphere/south.png" alt=""/></div>
              <div class="sp-tagline">Hold the line. Protect the Power Core.</div>
              <div class="sp-cta">PLAY</div>
            </button>
            <button class="sp-card attacker" data-faction="cyborg" data-role="attacker">
              <div class="sp-role-label">ATTACKER</div>
              <div class="sp-team-name">Cyborgs</div>
              <div class="sp-hero"><img src="/sprites/hulk/south.png" alt=""/></div>
              <div class="sp-tagline">Break through. Reach the Power Core.</div>
              <div class="sp-cta">PLAY</div>
            </button>
          </div>
          <details class="sp-howto">
            <summary>How to play</summary>
            <div class="sp-howto-body">
              <p><strong>BUILD:</strong> Spend credits to place pieces inside your zone. Click a tile to pick a piece, then click a cell.</p>
              <p><strong>PLAN:</strong> Click any of your pieces, then click a cell to queue a move, or right-click an enemy to queue a shot. Right-click empty space to clear.</p>
              <p><strong>BATTLE:</strong> Both sides reveal their planned actions in initiative order. Watch the round play out. Repeat until the Power Core falls or every attacker is gone.</p>
              <p>The AI plays the opposite role. Pick DEFENDER and the AI attacks. Pick ATTACKER and the AI defends.</p>
            </div>
          </details>
        </div>
      </div>
    `

    this.loadingEl        = this.container.querySelector('#loading-screen')!
    this.creditsEl        = this.container.querySelector('#credits-val')!
    this.attCreditsEl     = this.container.querySelector('#att-credits-val')!
    this.robotShopEl      = this.container.querySelector('#hud-top')!
    this.cyborgShopEl     = this.container.querySelector('#hud-top-att')!
    this.messageEl        = this.container.querySelector('#game-message')!
    this.planSelectionEl  = this.container.querySelector('#plan-selection')!

    // Tile clicks. Both LEFT and RIGHT panels carry the same tiles, so we
    // bind by class selector. data-action covers sphere/dog (unit-based
    // robot pieces); data-type covers structures + cyborg units.
    this.container.querySelectorAll('.hud-tile[data-action="sphere"]').forEach(btn => {
      btn.addEventListener('click', () => this.onBuySphere?.())
    })
    this.container.querySelectorAll('.hud-tile[data-action="dog"]').forEach(btn => {
      btn.addEventListener('click', () => this.onBuyDog?.())
    })
    // Robot structures
    this.container.querySelectorAll<HTMLElement>('#hud-top .hud-tile[data-type]').forEach(btn => {
      btn.addEventListener('click', e => {
        const type = (e.currentTarget as HTMLElement).dataset.type as StructureType
        this.container.querySelectorAll('#hud-top .hud-tile').forEach(b => b.classList.remove('selected'))
        ;(e.currentTarget as HTMLElement).classList.add('selected')
        this.onSelectStructure?.(type)
      })
    })
    // Cyborg units
    this.container.querySelectorAll<HTMLElement>('#hud-top-att .hud-tile[data-type]').forEach(btn => {
      btn.addEventListener('click', e => {
        const type = (e.currentTarget as HTMLElement).dataset.type as UnitType
        this.container.querySelectorAll('#hud-top-att .hud-tile').forEach(b => b.classList.remove('selected'))
        ;(e.currentTarget as HTMLElement).classList.add('selected')
        this.onSpawnUnit?.(type)
      })
    })

    // Primary action button lives inside each center HUD panel. Same handler
    // for BUILD's "READY" and PLAN's "BATTLE" — Game decides what happens
    // based on current phase. Both panels (def + att variants) carry one.
    this.container.querySelectorAll<HTMLButtonElement>('.center-action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.playBattleSound()
        this.onBattle?.()
      })
    })

    // Side-picker cards. Mouse-only per the no-keyboard rule. Each card
    // carries data-faction + data-role; both feed Game so it can place the
    // player's pieces with the right tint and let the AI pick its own faction.
    this.container.querySelectorAll<HTMLElement>('#side-picker .sp-card').forEach(card => {
      card.addEventListener('click', () => {
        const faction = card.dataset.faction as 'robot' | 'cyborg'
        const role = card.dataset.role as 'defender' | 'attacker'
        this.onPickSide?.(faction, role)
      })
    })
  }

  // ─── Side picker / single-player mode ──────────────────────────────────

  // Shown after preload — player picks Robots or Cyborgs. AI takes the
  // other side via Game.opponentAI.
  showSidePicker() {
    this.loadingEl.classList.add('hidden')
    const picker = this.container.querySelector('#side-picker')
    picker?.classList.remove('hidden')
  }

  // Lock in the player's chosen side. The two HUD-top variants (#hud-top
  // for defender roster, #hud-top-att for attacker roster) are pre-built;
  // we toggle visibility based on the ROLE. Faction only affects piece tint
  // (handled by Game) and the side-picker visuals, not the HUD shop layout.
  private playerSide: 'defender' | 'attacker' = 'defender'
  setPlayerSide(role: 'defender' | 'attacker') {
    const picker = this.container.querySelector('#side-picker')
    picker?.classList.add('hidden')
    this.playerSide = role
    // Mark the inactive HUD with .ai-side; setPhase will show the active
    // one when appropriate.
    if (role === 'defender') {
      this.container.querySelector('#hud-top-att')?.classList.add('ai-side')
    } else {
      this.container.querySelector('#hud-top')?.classList.add('ai-side')
    }
    // Color the primary action button to match the role: blue for DEFENDER,
    // red for ATTACKER. Matches the side-picker card the player just picked.
    this.container.querySelectorAll<HTMLButtonElement>('.center-action-btn').forEach(btn => {
      btn.classList.toggle('role-defender', role === 'defender')
      btn.classList.toggle('role-attacker', role === 'attacker')
    })
  }

  // Show the latest system event as a single-line status inside the
  // center HUD panel. Each call REPLACES the prior message rather than
  // appending — the center panel is too narrow to scroll a multi-message
  // feed cleanly without clipping. Writes to both center variants so the
  // status survives a faction switch.
  logSystemMessage(text: string, kind: 'system' | 'player' | 'ai' = 'system') {
    this.container.querySelectorAll<HTMLElement>('.center-events').forEach(feed => {
      feed.innerHTML = ''
      const row = document.createElement('div')
      row.className = `center-event center-event-${kind}`
      row.textContent = text
      feed.appendChild(row)
    })
  }

  showGame() {
    this.loadingEl.classList.add('hidden')
    // HUD-top visibility is driven by setPhase() once the side picker
    // resolves; nothing else to reveal here.
  }

  setCredits(amount: number) {
    this.creditsEl.textContent = String(amount)
    this.refreshAffordability('robots', amount)
  }

  setAttCredits(amount: number) {
    this.attCreditsEl.textContent = String(amount)
    this.refreshAffordability('cyborgs', amount)
  }

  // Grey out buttons whose cost exceeds current credits so failed placements
  // are obvious. Was previously silent — user thought placement was broken.
  private refreshAffordability(side: 'robots' | 'cyborgs', credits: number) {
    if (side === 'robots') {
      this.container.querySelectorAll('.hud-tile[data-action="sphere"]').forEach(b => {
        b.classList.toggle('insufficient', credits < SPHERE_COST)
      })
      this.container.querySelectorAll('.hud-tile[data-action="dog"]').forEach(b => {
        b.classList.toggle('insufficient', credits < Config.UNITS.dog.cost)
      })
      this.container.querySelectorAll('#hud-top .hud-tile[data-type]').forEach(b => {
        const type = (b as HTMLElement).dataset.type as StructureType
        const cost = Config.STRUCTURES[type]?.cost ?? 0
        b.classList.toggle('insufficient', credits < cost)
      })
    } else {
      this.container.querySelectorAll('#hud-top-att .hud-tile[data-type]').forEach(b => {
        const type = (b as HTMLElement).dataset.type as UnitType
        const cost = Config.UNITS[type]?.cost ?? 0
        b.classList.toggle('insufficient', credits < cost)
      })
    }
  }

  setSelectedUnitType(type: UnitType | null) {
    this.container.querySelectorAll('#hud-top-att .hud-tile').forEach(b => b.classList.remove('selected'))
    if (type) {
      this.container.querySelectorAll(`#hud-top-att .hud-tile[data-type="${type}"]`).forEach(b => b.classList.add('selected'))
    }
  }

  // Drop the visual "selected" highlight off any tile — called when the
  // player picks a sphere/cyborg so the UI mirrors that the structure
  // placement was cancelled under the hood.
  clearStructureSelection() {
    this.container.querySelectorAll('.hud-tile').forEach(b => b.classList.remove('selected'))
  }

  setPhase(phase: 'build' | 'planning' | 'reveal' | 'win' | 'lose') {
    const setCenter = (title: string, buttonLabel: string | null) => {
      this.container.querySelectorAll<HTMLElement>('.hud-panel.hud-center .center-phase')
        .forEach(el => { el.textContent = title })
      this.container.querySelectorAll<HTMLButtonElement>('.center-action-btn').forEach(btn => {
        if (buttonLabel === null) {
          btn.classList.add('hidden')
        } else {
          btn.classList.remove('hidden')
          btn.textContent = buttonLabel
        }
      })
    }
    const showBuildInfo = (visible: boolean) => {
      this.container.querySelectorAll<HTMLElement>('.center-build-info').forEach(el => {
        el.classList.toggle('hidden', !visible)
      })
    }
    const showCenterLog = (visible: boolean) => {
      this.container.querySelectorAll<HTMLElement>('.center-log').forEach(el => {
        el.classList.toggle('hidden', !visible)
      })
    }
    // Hide only the SIDE shop panels (.hud-left, .hud-right). The HUD strip
    // and the CENTER panel stay visible so the action button + status feed
    // + combat log remain on-screen across all phases.
    const showShopPanels = (visible: boolean) => {
      this.container.querySelectorAll<HTMLElement>('.hud-panel.hud-left, .hud-panel.hud-right')
        .forEach(el => { el.classList.toggle('hidden', !visible) })
    }

    switch (phase) {
      case 'build':
        setCenter('BUILD PHASE', 'READY')
        showBuildInfo(true)
        showCenterLog(false)
        showShopPanels(true)
        this.robotShopEl.classList.remove('hidden')
        this.cyborgShopEl.classList.remove('hidden')
        this.planSelectionEl.classList.add('hidden')
        this.messageEl.classList.add('hidden')
        this.logSystemMessage('BUILD PHASE. Place your forces.', 'system')
        break
      case 'planning':
        setCenter('PLAN PHASE', 'BATTLE')
        showBuildInfo(true)
        showCenterLog(false)
        showShopPanels(false)
        this.messageEl.classList.add('hidden')
        this.logSystemMessage('PLAN PHASE. Queue moves and shots.', 'system')
        break
      case 'reveal':
        setCenter('BATTLE', null)
        showBuildInfo(false)
        showCenterLog(true)
        showShopPanels(false)
        this.planSelectionEl.classList.add('hidden')
        this.messageEl.classList.add('hidden')
        break
      case 'win':
        setCenter('BATTLE', null)
        this.showEndMessage('DEFENDER WINS', 'Power Core survived', '#00ffaa')
        break
      case 'lose':
        setCenter('BATTLE', null)
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
  // header. Writes to BOTH center-panel variants (def + att) so the log is
  // populated regardless of which side the player picked. Auto-scrolls and
  // trims to the last ~200 rows so long battles don't bloat memory.
  appendCombatLog(turn: number, entries: ReadonlyArray<CombatLogEntry>) {
    if (entries.length === 0) return
    const logs = this.container.querySelectorAll<HTMLElement>('.center-log')
    logs.forEach(log => {
      if (this.combatLogEmpty) {
        log.innerHTML = ''
      }
      const header = document.createElement('div')
      header.className = 'log-turn'
      header.textContent = `── Turn ${turn} ──`
      log.appendChild(header)
      for (const e of entries) {
        const row = document.createElement('div')
        row.className = `log-entry ${e.side}`
        row.textContent = e.text
        log.appendChild(row)
      }
      const MAX_ROWS = 220
      while (log.childElementCount > MAX_ROWS) {
        log.removeChild(log.firstChild!)
      }
      log.scrollTop = log.scrollHeight
    })
    this.combatLogEmpty = false
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
