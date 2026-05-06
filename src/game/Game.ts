import * as THREE from 'three'
import { Config } from './GameConfig'
import { Background } from '../scene/Background'
import { PowerCore } from '../entities/PowerCore'
import { Unit } from '../entities/Unit'
import { HUD } from '../ui/HUD'
import { AIPlayer } from '../ai/AIPlayer'
import { BuildPhase } from './BuildPhase'
import { BattlePhase } from './BattlePhase'

type Phase = 'loading' | 'build' | 'battle' | 'win' | 'lose'

export class Game {
  private scene: THREE.Scene
  private camera: THREE.OrthographicCamera
  private renderer: THREE.WebGLRenderer
  private rafId = 0
  private lastTime = 0
  private phase: Phase = 'loading'

  private background!: Background
  private powerCore!: PowerCore
  private hud!: HUD
  private buildPhase: BuildPhase | null = null
  private battlePhase: BattlePhase | null = null
  private testUnits: Unit[] = []

  // Camera pan state
  private isPanning = false
  private lastPan = { x: 0, y: 0 }

  constructor(private canvas: HTMLCanvasElement) {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x1b1610)  // matches terrain base

    const halfH = 600 / (window.innerWidth / window.innerHeight)
    this.camera = new THREE.OrthographicCamera(-600, 600, halfH, -halfH, 0.1, 1000)
    this.camera.position.set(0, 0, 100)
    this.camera.lookAt(0, 0, 0)

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)

    this.scene.add(new THREE.AmbientLight(0xffffff, 2.5))
    const dir = new THREE.DirectionalLight(0xffffff, 1.2)
    dir.position.set(0, 0, 100)
    this.scene.add(dir)

    window.addEventListener('resize', this.onResize)
    window.addEventListener('wheel', this.onWheel, { passive: false })
    window.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('contextmenu', this.onContextMenu)
  }

  async init() {
    this.background = new Background(this.scene)
    this.powerCore = new PowerCore(this.scene)
    this.hud = new HUD()

    await Unit.preload()

    this.hud.showGame()
    this.enterBuildPhase()
  }

  private enterBuildPhase() {
    this.phase = 'build'
    this.testUnits = []
    this.hud.setPhase('build')
    this.buildPhase = new BuildPhase(this.scene, this.camera, this.hud, Config.START_CREDITS)

    // Auto-spawn one cyborg so it's visible immediately for model testing
    const testCyborg = new Unit(this.scene, 'scout', 300)
    testCyborg.mesh.position.y = 0
    this.testUnits.push(testCyborg)

    this.hud.onBattle = () => this.enterBattlePhase()
    this.hud.onSpawnUnit = (type) => {
      const unit = new Unit(this.scene, type, 350 + Math.random() * 150)
      this.testUnits.push(unit)
    }
  }

  private enterBattlePhase() {
    if (!this.buildPhase) return
    const structures = this.buildPhase.getStructures()
    this.buildPhase.cleanup()
    this.buildPhase = null

    const units = this.testUnits.length > 0
      ? this.testUnits
      : AIPlayer.buildArmy(Config.START_CREDITS).map(t => new Unit(this.scene, t, 420 + Math.random() * 100))
    this.testUnits = []

    this.phase = 'battle'
    this.hud.setPhase('battle')

    this.battlePhase = new BattlePhase(this.scene, this.powerCore, units, structures)
    this.battlePhase.onWin  = () => { this.phase = 'win';  this.hud.setPhase('win') }
    this.battlePhase.onLose = () => { this.phase = 'lose'; this.hud.setPhase('lose') }
  }

  start() {
    this.lastTime = performance.now()
    this.loop()
  }

  private loop = () => {
    this.rafId = requestAnimationFrame(this.loop)
    const now = performance.now()
    const delta = Math.min((now - this.lastTime) / 1000, 0.1)
    this.lastTime = now

    this.powerCore?.update(delta)
    this.battlePhase?.update(delta)

    this.renderer.render(this.scene, this.camera)
  }

  private onResize = () => {
    const { innerWidth: w, innerHeight: h } = window
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h)
    const halfH = 600 / (w / h)
    this.camera.top    =  halfH
    this.camera.bottom = -halfH
    this.camera.updateProjectionMatrix()
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 1.15 : 0.87
    const newWidth = (this.camera.right - this.camera.left) * factor
    if (newWidth > 2800 || newWidth < 200) return
    this.camera.left   *= factor
    this.camera.right  *= factor
    this.camera.top    *= factor
    this.camera.bottom *= factor
    this.camera.updateProjectionMatrix()
  }

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 1 || e.button === 2) {
      this.isPanning = true
      this.lastPan = { x: e.clientX, y: e.clientY }
    }
  }

  private onMouseMove = (e: MouseEvent) => {
    if (!this.isPanning) return
    const dx = e.clientX - this.lastPan.x
    const dy = e.clientY - this.lastPan.y
    const ww = this.camera.right - this.camera.left
    const wh = this.camera.top - this.camera.bottom
    this.camera.position.x -= (dx / window.innerWidth) * ww
    this.camera.position.y += (dy / window.innerHeight) * wh
    this.lastPan = { x: e.clientX, y: e.clientY }
  }

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 1 || e.button === 2) this.isPanning = false
  }

  private onContextMenu = (e: Event) => e.preventDefault()

  dispose() {
    cancelAnimationFrame(this.rafId)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('contextmenu', this.onContextMenu)
    this.buildPhase?.cleanup()
    this.renderer.dispose()
    this.scene.clear()
    this.hud?.dispose()
  }
}
