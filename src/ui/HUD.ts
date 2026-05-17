import { Config, StructureType, UnitType } from '../game/GameConfig'
import type { PlanningSelectionInfo } from '../game/PlanningPhase'

const SPHERE_COST = 100   // mirrors Game.SPHERE_COST

export class HUD {
  private container: HTMLElement
  private creditsEl!: HTMLElement
  private attCreditsEl!: HTMLElement
  private phaseEl!: HTMLElement
  private bottomBarEl!: HTMLElement
  private robotShopEl!: HTMLElement
  private cyborgShopEl!: HTMLElement
  private messageEl!: HTMLElement
  private loadingEl!: HTMLElement
  private planBarEl!: HTMLElement
  private planSelectionEl!: HTMLElement

  onSelectStructure: ((type: StructureType) => void) | null = null
  onSpawnUnit: ((type: UnitType) => void) | null = null
  onBuySphere: (() => void) | null = null
  onBuyDog: (() => void) | null = null
  onBattle: (() => void) | null = null

  constructor() {
    this.container = document.getElementById('hud')!
    this.build()
  }

  private build() {
    this.container.innerHTML = `
      <div id="loading-screen">LOADING ASSETS...</div>
      <div id="phase-display" class="hidden">BUILD PHASE</div>
      <div id="team-label-def" class="hidden">ROBOTS</div>
      <div id="credits-display" class="hidden">Credits: <span id="credits-val">200</span></div>
      <div id="team-label-att" class="hidden">CYBORGS</div>
      <div id="att-credits-display" class="hidden">Credits: <span id="att-credits-val">200</span></div>
      <div id="top-robot-shop" class="shop-panel hidden">
        <button id="sphere-btn" class="shop-btn">Sphere 100cr</button>
        <button class="shop-btn" data-type="turret">Tower 30cr</button>
        <button class="shop-btn" data-type="wall">Wall 20cr</button>
        <button id="dog-btn" class="shop-btn">Dog 40cr</button>
        <button class="shop-btn preview" data-type="defense">Defense 20cr</button>
        <button class="shop-btn preview" data-type="gun">Gun 30cr</button>
        <button class="shop-btn preview" data-type="laser">Laser 40cr</button>
        <button class="shop-btn preview" data-type="signal">Signal 20cr</button>
      </div>
      <div id="top-cyborg-shop" class="shop-panel att-panel hidden">
        <button class="att-btn" data-type="cannon">Cannon 70cr</button>
        <button class="att-btn" data-type="grenadier">Grenadier 50cr</button>
        <button class="att-btn" data-type="doublegun">Double Gun 90cr</button>
      </div>
      <div id="bottom-bar" class="hidden">
        <button id="battle-btn">READY</button>
      </div>
      <div id="plan-bar" class="hidden">
        <div id="plan-instructions">
          <strong>PLAN PHASE</strong>
          <span>Click a piece &middot; click a cell to queue Move &middot; Shift+click an enemy to queue Fire &middot; Right-click to clear / deselect</span>
        </div>
        <button id="plan-battle-btn">BATTLE</button>
      </div>
      <div id="plan-selection" class="hidden"></div>
      <div id="game-message" class="hidden"></div>
    `

    this.loadingEl        = this.container.querySelector('#loading-screen')!
    this.phaseEl          = this.container.querySelector('#phase-display')!
    this.creditsEl        = this.container.querySelector('#credits-val')!
    this.attCreditsEl     = this.container.querySelector('#att-credits-val')!
    this.bottomBarEl      = this.container.querySelector('#bottom-bar')!
    this.robotShopEl      = this.container.querySelector('#top-robot-shop')!
    this.cyborgShopEl     = this.container.querySelector('#top-cyborg-shop')!
    this.messageEl        = this.container.querySelector('#game-message')!
    this.planBarEl        = this.container.querySelector('#plan-bar')!
    this.planSelectionEl  = this.container.querySelector('#plan-selection')!

    this.container.querySelector('#sphere-btn')?.addEventListener('click', () => {
      this.onBuySphere?.()
    })

    this.container.querySelector('#dog-btn')?.addEventListener('click', () => {
      this.onBuyDog?.()
    })

    this.container.querySelectorAll('.shop-btn:not(#sphere-btn):not(#dog-btn)').forEach(btn => {
      btn.addEventListener('click', e => {
        const type = (e.currentTarget as HTMLElement).dataset.type as StructureType
        this.container.querySelectorAll('.shop-btn').forEach(b => b.classList.remove('selected'))
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

    this.container.querySelector('#plan-battle-btn')!.addEventListener('click', () => {
      this.playBattleSound()
      this.onBattle?.()
    })
  }

  showGame() {
    this.loadingEl.classList.add('hidden')
    this.phaseEl.classList.remove('hidden')
    this.container.querySelector('#credits-display')!.classList.remove('hidden')
    this.container.querySelector('#att-credits-display')!.classList.remove('hidden')
    this.container.querySelector('#team-label-def')!.classList.remove('hidden')
    this.container.querySelector('#team-label-att')!.classList.remove('hidden')
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
      const sphereBtn = this.container.querySelector('#sphere-btn')
      sphereBtn?.classList.toggle('insufficient', credits < SPHERE_COST)
      const dogBtn = this.container.querySelector('#dog-btn')
      dogBtn?.classList.toggle('insufficient', credits < Config.UNITS.dog.cost)
      this.container.querySelectorAll('#top-robot-shop .shop-btn[data-type]').forEach(b => {
        const type = (b as HTMLElement).dataset.type as StructureType
        const cost = Config.STRUCTURES[type]?.cost ?? 0
        b.classList.toggle('insufficient', credits < cost)
      })
    } else {
      this.container.querySelectorAll('#top-cyborg-shop .att-btn[data-type]').forEach(b => {
        const type = (b as HTMLElement).dataset.type as UnitType
        const cost = Config.UNITS[type]?.cost ?? 0
        b.classList.toggle('insufficient', credits < cost)
      })
    }
  }

  setSelectedUnitType(type: UnitType | null) {
    this.container.querySelectorAll('.att-btn').forEach(b => b.classList.remove('selected'))
    if (type) {
      this.container.querySelector(`.att-btn[data-type="${type}"]`)?.classList.add('selected')
    }
  }

  // Drop the visual "selected" highlight off any structure button — called
  // when the player picks a sphere/cyborg so the UI mirrors that the
  // structure placement was cancelled under the hood.
  clearStructureSelection() {
    this.container.querySelectorAll('.shop-btn').forEach(b => b.classList.remove('selected'))
  }

  setPhase(phase: 'build' | 'planning' | 'reveal' | 'win' | 'lose') {
    switch (phase) {
      case 'build':
        this.phaseEl.textContent = 'BUILD PHASE'
        this.bottomBarEl.classList.remove('hidden')
        this.robotShopEl.classList.remove('hidden')
        this.cyborgShopEl.classList.remove('hidden')
        this.planBarEl.classList.add('hidden')
        this.planSelectionEl.classList.add('hidden')
        this.messageEl.classList.add('hidden')
        break
      case 'planning':
        this.phaseEl.textContent = 'PLAN PHASE'
        this.bottomBarEl.classList.add('hidden')
        this.robotShopEl.classList.add('hidden')
        this.cyborgShopEl.classList.add('hidden')
        this.planBarEl.classList.remove('hidden')
        this.messageEl.classList.add('hidden')
        break
      case 'reveal':
        this.phaseEl.textContent = 'BATTLE'
        this.bottomBarEl.classList.add('hidden')
        this.robotShopEl.classList.add('hidden')
        this.cyborgShopEl.classList.add('hidden')
        this.planBarEl.classList.add('hidden')
        this.planSelectionEl.classList.add('hidden')
        this.messageEl.classList.add('hidden')
        break
      case 'win':
        this.phaseEl.textContent = 'BATTLE PHASE'
        this.messageEl.innerHTML = 'DEFENDER WINS<small>Power Core survived</small>'
        this.messageEl.style.color = '#00ffaa'
        this.messageEl.classList.remove('hidden')
        break
      case 'lose':
        this.phaseEl.textContent = 'BATTLE PHASE'
        this.messageEl.innerHTML = 'ATTACKER WINS<small>Power Core destroyed</small>'
        this.messageEl.style.color = '#ff4444'
        this.messageEl.classList.remove('hidden')
        break
    }
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
