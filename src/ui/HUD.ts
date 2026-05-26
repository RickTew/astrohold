import { Config, StructureType, UnitType } from '../game/GameConfig'
import type { PlanningSelectionInfo } from '../game/PlanningPhase'
import type { CombatLogEntry } from '../game/RevealPhase'
import { Difficulty, getDifficulty, setDifficulty } from '../game/Difficulty'
import { playEventSfx } from '../audio/sfx'

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
  onBuyRepair: (() => void) | null = null
  onBattle: (() => void) | null = null
  // Side picker — Game listens here for the chosen team. Fires once with the
  // player's faction (visual identity) + role (defender or attacker). The AI
  // gets the opposite role with a randomly-chosen faction.
  onPickSide: ((faction: 'robot' | 'cyborg', role: 'defender' | 'attacker') => void) | null = null
  // Compass-rose callbacks. Game decides whether the purchase succeeds (cost,
  // credits, duplicate facing); HUD just forwards the click intent.
  onAddFacing: ((angle: number) => void) | null = null
  // Multi-mode active-click refunds that arc — gives the player a way to
  // back out of a mis-clicked +30cr direction without scrapping the whole
  // structure. Single-mode (sentry) ignores this — its active button is
  // a no-op click since the facing is already that direction.
  onRemoveFacing: ((angle: number) => void) | null = null
  // Single-mode click handler — replaces the structure's lone fire facing
  // with the picked direction. No cost. Used by structures with exactly
  // one fire arc at a time (currently just the Sentry).
  onSetFacing: ((angle: number) => void) | null = null
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
      action?: 'sphere' | 'dog' | 'repair'; dataType?: string; preview?: boolean
      // empty: invisible-but-grid-present upgrade slot. Renders as an
      // empty .hud-tile div (no content, no click). Same shape as a real
      // tile so the 4×2 grid stays aligned when fewer than 8 active
      // tiles are present.
      empty?: boolean
    }
    // Robot HUD — ported from /build-test.html AFTER (approved S17.3).
    // LEFT panel: 8 unique build pieces. RIGHT panel: 4 active + 4 empty
    // upgrade slots. Total 16 unique slots across the two panels (no
    // tile is duplicated). Cannon visual reuses the 'gun' twin-barrel
    // sprite as a stand-in; marked preview so the .preview CSS rule
    // shrinks the oversized sprite to scale 0.78 (no new style introduced,
    // uses the existing class). Same applies to Mine/Signal/Shield
    // sprites that ship at larger native sizes.
    const robotLeftTiles: Tile[] = [
      { label: 'PHASER', cost:  60, icon: '/sprites/gun/south.png',     dataType: 'cannon', preview: true },
      { label: 'TOWER',  cost:  30, icon: '/sprites/tower/south.png',   dataType: 'turret' },
      { label: 'MORTAR', cost:  70, icon: '/sprites/bomber/south.png',  dataType: 'bomber' },
      { label: 'LASER',  cost:  40, icon: '/sprites/laser/south.png',   dataType: 'laser', preview: true },
      { label: 'SPHERE', cost: 100, icon: '/sprites/sphere/south.png',  action: 'sphere'   },
      { label: 'SENTRY', cost:  60, icon: '/sprites/sentry/south.png',  dataType: 'sentry' },
      { label: 'DOG',    cost:  40, icon: '/sprites/dog/south.png',     action: 'dog'      },
      { label: 'REPAIR', cost:  70, icon: '/sprites/repair/south.png',  action: 'repair'   },
    ]
    const robotRightTiles: Tile[] = [
      { label: 'MINE',   cost: 20, icon: '/sprites/robot_mine/south.png', dataType: 'mine',    preview: true },
      { label: 'WALL',   cost: 20, icon: 'wall',                           dataType: 'wall' },
      { label: 'SIGNAL', cost: 70, icon: '/sprites/signal/south.png',     dataType: 'signal',  preview: true },
      { label: 'SHIELD', cost: 50, icon: '/sprites/defense/south.png',    dataType: 'defense', preview: true },
      { label: '', cost: 0, icon: '', empty: true },
      { label: '', cost: 0, icon: '', empty: true },
      { label: '', cost: 0, icon: '', empty: true },
      { label: '', cost: 0, icon: '', empty: true },
    ]
    // Cyborg HUD — drop the Grenadier/Hulk duplicates from the old 4×2
    // layout, leave those slots empty as visible "upgrade" placeholders
    // for future cyborg pieces. 6 active functional units + 2 empty.
    // CYBORG_MINE art is NOT wired here yet — no cyborg-side mine
    // mechanic exists, so a clickable tile would route to a missing
    // unit type. Add when the mechanic ships.
    const cyborgTiles: Tile[] = [
      { label: 'CANNON',   cost:  70, icon: '/sprites/cannon/south.png',    dataType: 'cannon' },
      { label: 'GRENADIER',cost:  50, icon: '/sprites/grenadier/south.png', dataType: 'grenadier' },
      { label: 'DOUBLEGUN',cost:  90, icon: '/sprites/doublegun/south.png', dataType: 'doublegun' },
      { label: 'HULK',     cost: 100, icon: '/sprites/hulk/south.png',      dataType: 'hulk' },
      { label: 'SNIPER',   cost:  90, icon: '/sprites/sniper/south.png',    dataType: 'sniper' },
      { label: 'MEDIC',    cost:  70, icon: '/sprites/medic/south.png',     dataType: 'medic' },
      // S17.16: Stalker is now a placeable cyborg piece (was AI-only).
      { label: 'STALKER',  cost:  70, icon: '/sprites/cyborg_stalker/south.png', dataType: 'stalker' },
      // Cyborg mine. Tile shows up; placement flow + trigger are PENDING.
      { label: 'CYBORG MINE', cost: 20, icon: '/sprites/cyborg_mine/south.png', dataType: 'cyborg_mine', preview: true },
    ]
    const tileHtml = (t: Tile, sideTag: 'def' | 'att') => {
      if (t.empty) {
        // Empty upgrade slot. Rendered with the SAME internal structure
        // as a real tile (tile-icon div + label + cost rows) so the
        // height matches — without these, the row would collapse to
        // padding-only height (~8px) and the layout would look broken.
        // Inner elements are empty (or &nbsp;) so they reserve space
        // without drawing icons/text. The cyan-bordered .tile-icon
        // appears as a visible empty box, reading as "unfilled slot".
        return `<div class="hud-tile ${sideTag}" aria-hidden="true">` +
          '<div class="tile-icon"></div>' +
          '<div class="tile-label">&nbsp;</div>' +
          '<div class="tile-cost">&nbsp;</div>' +
        '</div>'
      }
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
        <!-- Clean chamfered rectangle. Divider lines that used to split the
             panel into 3 sub-screens were removed — the panel is now a
             single combat-log readout, so the internal lines just looked
             like artifacts cutting through the text. -->
        <path d="M 14,4 L 306,4 L 316,14 L 316,196 L 306,206 L 14,206 L 4,196 L 4,14 Z"
              fill="rgba(8, 18, 32, 0.58)"
              stroke="${side === 'def' ? '#5aa7d4' : '#d45a7a'}"
              stroke-width="2.8" stroke-linejoin="miter"
              vector-effect="non-scaling-stroke"/>
        <!-- Decorative corner tick marks — read as "screw heads" anchoring
             the console panel. Subtle, just enough texture to feel mechanical. -->
        <circle cx="14" cy="14" r="1.6" fill="${side === 'def' ? '#8fd0f2' : '#f28fa6'}" fill-opacity="0.65"/>
        <circle cx="306" cy="14" r="1.6" fill="${side === 'def' ? '#8fd0f2' : '#f28fa6'}" fill-opacity="0.65"/>
        <circle cx="14" cy="196" r="1.6" fill="${side === 'def' ? '#8fd0f2' : '#f28fa6'}" fill-opacity="0.65"/>
        <circle cx="306" cy="196" r="1.6" fill="${side === 'def' ? '#8fd0f2' : '#f28fa6'}" fill-opacity="0.65"/>
      </svg>
      <!-- Edge-trace orbit: glowing dot circles the panel perimeter.
           Path matches the panel-frame chamfer exactly. -->
      <svg class="edge-trace" viewBox="0 0 320 210" preserveAspectRatio="none" aria-hidden="true">
        <circle r="3.5" fill="${side === 'def' ? '#b8e8ff' : '#ffc8d2'}">
          <animateMotion dur="6s" repeatCount="indefinite" rotate="auto"
            path="M 14,4 L 306,4 L 316,14 L 316,196 L 306,206 L 14,206 L 4,196 L 4,14 Z"/>
        </circle>
      </svg>`

    this.container.innerHTML = `
      <div id="loading-screen">LOADING ASSETS...</div>

      <div id="hud-top" class="hidden">
        <div class="hud-panel hud-left" data-side="def">
          ${sidePanelSvg('def', false)}
          <div class="panel-content">
            <div class="tile-grid">
              ${robotLeftTiles.map(t => tileHtml(t, 'def')).join('')}
            </div>
          </div>
        </div>

        <div class="hud-panel hud-center" data-side="def">
          ${centerPanelSvg('def')}
          <div class="panel-content">
            <!-- BUILD / PLAN content. Three console sections that match the
                 SVG divider lines: title / content / action. -->
            <div class="center-build-info">
              <div class="cc-title"><div class="center-phase">BUILD PHASE</div></div>
              <div class="cc-body">
                <div class="center-credits">CR<span class="cr-num" id="credits-val">1000</span></div>
                <div class="center-matchup">
                  <span class="vs-player">ROBOTS</span>
                  <span class="vs-label">VS</span>
                  <span class="vs-team">CYBORGS</span>
                </div>
                <div class="center-events"></div>
              </div>
              <div class="cc-action">
                <button class="center-action-btn" data-action="primary">READY</button>
              </div>
            </div>
            <!-- REVEAL content: combat log fills the panel. -->
            <div class="center-log hidden"><div class="log-empty">(combat events appear here)</div></div>
          </div>
        </div>

        <div class="hud-panel hud-right" data-side="def">
          ${sidePanelSvg('def', true)}
          <div class="panel-content">
            <div class="tile-grid">
              ${robotRightTiles.map(t => tileHtml(t, 'def')).join('')}
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
              <div class="cc-title"><div class="center-phase">BUILD PHASE</div></div>
              <div class="cc-body">
                <div class="center-credits">CR<span class="cr-num" id="att-credits-val">1000</span></div>
                <div class="center-matchup">
                  <span class="vs-player">CYBORGS</span>
                  <span class="vs-label">VS</span>
                  <span class="vs-team">ROBOTS</span>
                </div>
                <div class="center-events"></div>
              </div>
              <div class="cc-action">
                <button class="center-action-btn" data-action="primary">READY</button>
              </div>
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
          <div class="sp-difficulty" id="sp-difficulty">
            <div class="sp-diff-label">AI DIFFICULTY</div>
            <div class="sp-diff-buttons">
              <button class="sp-diff-btn" data-difficulty="easy">
                <div class="sp-diff-name">EASY</div>
                <div class="sp-diff-sub">AI gets 25% fewer credits</div>
              </button>
              <button class="sp-diff-btn" data-difficulty="normal">
                <div class="sp-diff-name">NORMAL</div>
                <div class="sp-diff-sub">Equal credits</div>
              </button>
              <button class="sp-diff-btn" data-difficulty="hard">
                <div class="sp-diff-name">HARD</div>
                <div class="sp-diff-sub">AI gets 25% more credits</div>
              </button>
            </div>
          </div>
          <details class="sp-howto">
            <summary>How to play</summary>
            <div class="sp-howto-body">
              <h4>The basics</h4>
              <p><strong>BUILD:</strong> Spend credits to place pieces inside your zone. Click a tile to pick a piece, then click a cell. Right-click a placed piece to refund it (only for the piece type currently selected). Right-click a placed tower to open the compass rose and pay 30 credits per extra firing direction.</p>
              <p><strong>BATTLE:</strong> Click BATTLE to start the reveal. Both sides act in initiative order (faster pieces go first). Reveals auto-chain turn after turn until the Power Core falls, every cyborg is dead, or no cyborg can still damage the core (defender attrition win).</p>
              <p><strong>SIDES:</strong> Pick DEFENDER (robots) and the AI plays cyborgs. Pick ATTACKER (cyborgs) and the AI plays robots.</p>
              <p><strong>DIFFICULTY:</strong> EASY shrinks the AI army by 25 percent. HARD grows it by 25 percent. Your credits are unchanged either way.</p>

              <h4>Combat rules</h4>
              <p><strong>Firing arcs:</strong> Towers shoot in a strict CARDINAL LANE only (the row of cells directly in front of them). Diagonals do NOT count as "in front." Buy more facings via the compass rose (right-click on tower, 30cr per direction) to widen coverage.</p>
              <p><strong>Per-game ammo:</strong> Every offensive piece carries a per-game shot budget (typically 5). Once spent the piece sits inert unless it can melee. Pick your shots.</p>
              <p><strong>Melee fallback:</strong> Out-of-ammo cyborgs (except Sniper, Medic) can still punch adjacent enemies for 10 damage with no ammo cost.</p>
              <p><strong>Death explosions:</strong> When any robot or any Hulk dies, an explosion damages all 8 surrounding cells (cardinal AND diagonal) for 25 damage. Cyborgs benefit from clustering attacks on packed towers (chain detonations). Defenders benefit from spacing towers ONE cell apart to avoid the chain.</p>
              <p><strong>Bomb stacking:</strong> No two bombs can sit on the same cell. A second throw to an occupied cell fizzles.</p>

              <h4>Robot side specials</h4>
              <p><strong>Phaser beam:</strong> Phaser fires a piercing beam down its facing row. Every cyborg in that row up to range takes the full damage. Walls and allies are skipped (anti-cyborg only). Stack Phasers behind each other for concentrated firepower.</p>
              <p><strong>Mortar:</strong> Lobs proximity mines onto empty cells. Arms after one turn. Detonates when a cyborg enters its AoE.</p>
              <p><strong>Sphere:</strong> The most mobile defender. Rolls toward enemies. When out of ammo it suicide-rushes the nearest cyborg and detonates on adjacency.</p>
              <p><strong>Sentry:</strong> Mobile heavy turret with omni-fire. Advances toward the cyborg push when no enemy is in range.</p>
              <p><strong>Dog:</strong> Fast harasser. Actively pursues the nearest cyborg from spawn.</p>
              <p><strong>Repair:</strong> Welds friendly pieces back to full HP and can REFILL their ammo (3 refills per trip, then must dock at the Power Core to recharge). Docking restores both heal charges (+2/turn) and refill charges (+1/turn).</p>
              <p><strong>Shield:</strong> Generates a translucent cyan dome covering the 8 adjacent cells. Friendlies inside take 25 percent less damage from every source.</p>
              <p><strong>Signal:</strong> EMP emitter. Stuns the cyborg furthest into the middle map for 2 turns. 2 strikes per game.</p>
              <p><strong>Mine:</strong> Stationary trap. Detonates with massive AoE when any cyborg steps adjacent.</p>
              <p><strong>Wall:</strong> 300 HP blocker. No weapon.</p>
              <p><strong>Power Core defense:</strong> The 4x4 zone around the core electrocutes any cyborg standing in it each turn.</p>

              <h4>Cyborg side specials</h4>
              <p><strong>Hulk:</strong> Heaviest unit. Unlimited fists at melee. Special POWER SLAM hits a 3-cell wedge for 40 damage (3 slams per game). When killed Hulk explodes in a death blast that damages all 8 adjacent cells, allies included.</p>
              <p><strong>Stalker:</strong> Cloaked melee bruiser. Spawns invisible. Defender targeting skips cloaked units. Cloak drops permanently on the first damage-dealing action. Melee-only, no ammo cost ever.</p>
              <p><strong>Sniper:</strong> Single precision shot. CROUCH-AND-SHOOT rule: cannot crouch and shoot the same turn. First turn in range plays the aim pose, next turn fires. Movement breaks the crouch.</p>
              <p><strong>Grenadier:</strong> Throws timed grenades. Must lob to the SIDE or BEHIND the nearest enemy, never in front. Wears explosive shielding so AoE damage is halved on Grenadiers themselves.</p>
              <p><strong>Bomber:</strong> Lobs proximity mines like the robot Mortar. Strict no-self-AoE rule.</p>
              <p><strong>Medic:</strong> Heals allies via three modes (med-pack throw, deployable medic-pad, weld-tether) sharing a 5-charge pool.</p>
              <p><strong>Crates:</strong> Resupply boxes spawn in the middle of the map every 5 turns (max 4 on field). Cyborgs grab them by walking on top. Robots do NOT pick up crates; they dock at the Power Core instead.</p>

              <h4>Win conditions</h4>
              <p><strong>Cyborgs win:</strong> Power Core HP reaches 0.</p>
              <p><strong>Defender wins:</strong> Either every cyborg is dead OR no living cyborg can still damage the core (every shooter is empty AND there are no Hulks or Stalkers alive AND no melee-fallback cyborg can reach the core).</p>
              <p>No stalemates. The game is strictly die-or-survive.</p>
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
      btn.addEventListener('click', () => { playEventSfx('button_click'); this.onBuySphere?.() })
    })
    this.container.querySelectorAll('.hud-tile[data-action="dog"]').forEach(btn => {
      btn.addEventListener('click', () => { playEventSfx('button_click'); this.onBuyDog?.() })
    })
    this.container.querySelectorAll('.hud-tile[data-action="repair"]').forEach(btn => {
      btn.addEventListener('click', () => { playEventSfx('button_click'); this.onBuyRepair?.() })
    })
    // Robot structures
    this.container.querySelectorAll<HTMLElement>('#hud-top .hud-tile[data-type]').forEach(btn => {
      btn.addEventListener('click', e => {
        const type = (e.currentTarget as HTMLElement).dataset.type as StructureType
        this.container.querySelectorAll('#hud-top .hud-tile').forEach(b => b.classList.remove('selected'))
        ;(e.currentTarget as HTMLElement).classList.add('selected')
        playEventSfx('button_click')
        this.onSelectStructure?.(type)
      })
    })
    // Cyborg units
    this.container.querySelectorAll<HTMLElement>('#hud-top-att .hud-tile[data-type]').forEach(btn => {
      btn.addEventListener('click', e => {
        const type = (e.currentTarget as HTMLElement).dataset.type as UnitType
        this.container.querySelectorAll('#hud-top-att .hud-tile').forEach(b => b.classList.remove('selected'))
        ;(e.currentTarget as HTMLElement).classList.add('selected')
        playEventSfx('button_click')
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
    // Difficulty selector. Persists immediately on click; the active
    // value is read by Game during BUILD when allocating AI credits.
    this.applyDifficultySelection(getDifficulty())
    this.container.querySelectorAll<HTMLElement>('#sp-difficulty .sp-diff-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const d = btn.dataset.difficulty as Difficulty
        setDifficulty(d)
        this.applyDifficultySelection(d)
        playEventSfx('button_click')
      })
    })
  }

  private applyDifficultySelection(d: Difficulty) {
    this.container.querySelectorAll<HTMLElement>('#sp-difficulty .sp-diff-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.difficulty === d)
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
      this.container.querySelectorAll('.hud-tile[data-action="repair"]').forEach(b => {
        b.classList.toggle('insufficient', credits < Config.UNITS.repair.cost)
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
    // Stamp the top strip with the current phase so CSS can switch
    // ambient effects on/off (e.g. hide the edge-trace orbit during
    // REVEAL where it competes with the combat log).
    this.container.querySelectorAll('#hud-top, #hud-top-att').forEach(el => {
      el.classList.toggle('phase-reveal', phase === 'reveal')
    })
    const setCenter = (title: string, buttonLabel: string | null) => {
      // Wrap each character in a .boot-char span so the CSS keyframe
      // (phase-boot-in in index.html) runs the letter-by-letter reveal.
      // All spans are nested inside one .phase-chars wrapper because
      // .center-phase is `display: inline-flex` with a gap — without
      // the wrapper, each letter would become a separate flex item and
      // the gap would explode the title spacing. The wrapper keeps the
      // flex container's child count at 1 (bracket / chars / bracket).
      // Per-char animation-delay staggers the entrance.
      const chars = title.split('').map((c, i) => {
        const ch = c === ' ' ? '&nbsp;' : c
        return `<span class="boot-char" style="animation-delay:${i * 45 + 50}ms">${ch}</span>`
      }).join('')
      const html = `<span class="phase-chars">${chars}</span>`
      this.container.querySelectorAll<HTMLElement>('.hud-panel.hud-center .center-phase')
        .forEach(el => { el.innerHTML = html })
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
        this.logSystemMessage('Place your forces. Click READY when set.', 'system')
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
    // Sci-fi action button: chamfered cyan panel with corner brackets and a
    // pulsing glow. Reads as a "primary system action" instead of a plain
    // browser button. Plays a short audio cue on hover too.
    this.messageEl.innerHTML = `
      ${headline}
      <small>${subtitle}</small>
      <button id="play-again-btn" type="button">
        <span class="pa-arrow"></span>
        <span class="pa-label">Play Again</span>
      </button>
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
    /** 'multi' = pay-to-add-arc rose (towers); 'single' = pick-one-direction
     * rose (sentry). Defaults to 'multi' for backwards-compatible callers. */
    mode?: 'multi' | 'single'
  }) {
    this.hideCompassRose()
    const el = document.createElement('div')
    el.id = 'compass-rose'
    el.style.left = `${screenX}px`
    el.style.top  = `${screenY}px`
    el.innerHTML = this.buildRoseInnerHtml(opts)
    this.wireRoseButtons(el, opts.mode ?? 'multi')
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

  private wireRoseButtons(el: HTMLElement, mode: 'multi' | 'single') {
    el.querySelectorAll<HTMLElement>('.rose-btn[data-angle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const angle = parseFloat(btn.dataset.angle!)
        const active = btn.classList.contains('active')
        if (mode === 'single') {
          // Single-facing structures: clicking any inactive direction switches
          // to that direction. Active button = current facing → no-op click.
          if (active) return
          this.onSetFacing?.(angle)
          return
        }
        // Multi-facing (towers/bombers): active click = refund this arc;
        // inactive click = buy this arc (if affordable).
        if (active) {
          this.onRemoveFacing?.(angle)
          return
        }
        if (btn.classList.contains('unaffordable')) return
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
    mode?: 'multi' | 'single'
  }) {
    if (!this.compassRoseEl) return
    this.compassRoseEl.innerHTML = this.buildRoseInnerHtml(opts)
    this.wireRoseButtons(this.compassRoseEl, opts.mode ?? 'multi')
  }

  private buildRoseInnerHtml(opts: {
    name: string
    activeFacings: ReadonlyArray<number>
    cost: number
    credits: number
    mode?: 'multi' | 'single'
  }): string {
    const mode = opts.mode ?? 'multi'
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
        // Center cell — in multi-mode, shows N/4 fraction. In single-mode it
        // would always read 1/4, which is noise, so render an empty filler.
        if (mode === 'multi') {
          cells.push('<div class="rose-center">' + opts.activeFacings.length + '/4</div>')
        } else {
          cells.push('<div class="rose-center"></div>')
        }
        continue
      }
      const d = dirs.find(x => x.pos === i)
      if (!d) { cells.push('<div></div>'); continue }
      const active = isActive(d.angle)
      if (mode === 'single') {
        // Single-facing rose (Sentry): only one direction is ON at a time.
        // Active button is highlighted "ON"; inactive directions show no
        // cost (clicking them is free, it just switches the facing).
        if (active) {
          cells.push(`<div class="rose-btn active" data-angle="${d.angle}"><span class="rose-arrow">${d.arrow}</span><span class="rose-on">ON</span></div>`)
        } else {
          cells.push(`<div class="rose-btn" data-angle="${d.angle}"><span class="rose-arrow">${d.arrow}</span><span class="rose-on" style="opacity:0.55">FACE</span></div>`)
        }
        continue
      }
      // Multi-mode (towers/bombers/cannon).
      if (active) {
        // Active arcs are now refundable — clicking them returns one
        // EXTRA_FACING_COST. Hint with "−Ncr" so the player can tell it's
        // a refund and not a no-op. The base arc (original facing on
        // placement) can't be refunded; Structure.removeFacing blocks
        // dropping below one facing, so a no-op refund is silently
        // ignored — fine, and a future tooltip can clarify if needed.
        cells.push(`<div class="rose-btn active" data-angle="${d.angle}"><span class="rose-arrow">${d.arrow}</span><span class="rose-refund">−${opts.cost}cr</span></div>`)
      } else if (opts.credits < opts.cost) {
        cells.push(`<div class="rose-btn unaffordable" data-angle="${d.angle}"><span class="rose-arrow">${d.arrow}</span><span class="rose-cost">+${opts.cost}cr</span></div>`)
      } else {
        cells.push(`<div class="rose-btn" data-angle="${d.angle}"><span class="rose-arrow">${d.arrow}</span><span class="rose-cost">+${opts.cost}cr</span></div>`)
      }
    }
    // Title suffix tells the player what the rose does. Multi = "arcs", single = "facing".
    const titleSuffix = mode === 'single' ? 'facing' : 'arcs'
    return `
      <div class="rose-title">
        <span>${opts.name} ${titleSuffix}</span>
        <button class="rose-close-btn" type="button" aria-label="Close">✕</button>
      </div>
      ${cells.join('')}
      <div class="rose-footer">
        <button class="rose-refund-btn" type="button">Refund</button>
      </div>
    `
  }

  // Last turn we wrote a header for. Streaming appendCombatLogEntry uses
  // this to know when to inject a new "── Turn N ──" divider — without it
  // every entry would either spam its own header or share a header with
  // entries from a different reveal.
  private lastLoggedTurn = 0

  // Append a single combat-log entry as it happens. Called from RevealPhase
  // via onLogEntry the instant a log line is recorded, so the HUD panel
  // moves in lockstep with the visible action rather than batching a whole
  // reveal's events at onComplete.
  appendCombatLogEntry(turn: number, entry: CombatLogEntry) {
    const logs = this.container.querySelectorAll<HTMLElement>('.center-log')
    logs.forEach(log => {
      if (this.combatLogEmpty) {
        log.innerHTML = ''
        this.combatLogEmpty = false
      }
      if (turn !== this.lastLoggedTurn) {
        const header = document.createElement('div')
        header.className = 'log-turn'
        header.textContent = `── Turn ${turn} ──`
        log.appendChild(header)
      }
      const row = document.createElement('div')
      row.className = `log-entry ${entry.side}`
      row.textContent = entry.text
      log.appendChild(row)
      const MAX_ROWS = 220
      while (log.childElementCount > MAX_ROWS) {
        log.removeChild(log.firstChild!)
      }
      log.scrollTop = log.scrollHeight
    })
    this.lastLoggedTurn = turn
  }

  // Batch-append kept for safety + the empty-turn case where a reveal has
  // zero log lines — we still want a "Turn N — (no activity)" placeholder
  // header so the player can see turns ticking by. Pass [] to emit only
  // the header.
  appendCombatLog(turn: number, entries: ReadonlyArray<CombatLogEntry>) {
    if (entries.length === 0) {
      // Only emit a header if no streaming entry already inserted one
      // for this turn.
      if (this.lastLoggedTurn !== turn) {
        const logs = this.container.querySelectorAll<HTMLElement>('.center-log')
        logs.forEach(log => {
          if (this.combatLogEmpty) {
            log.innerHTML = ''
            this.combatLogEmpty = false
          }
          const header = document.createElement('div')
          header.className = 'log-turn'
          header.textContent = `── Turn ${turn} — (no activity)`
          log.appendChild(header)
          log.scrollTop = log.scrollHeight
        })
        this.lastLoggedTurn = turn
      }
      return
    }
    // Non-empty path: streaming already wrote these via appendCombatLogEntry.
    // No-op so we don't double-emit.
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
