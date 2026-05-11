import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Config, UnitType } from './GameConfig'
import { Background } from '../scene/Background'
import { PowerCore } from '../entities/PowerCore'
import { SphereDefender } from '../entities/SphereDefender'
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

  private attCredits = Config.START_CREDITS
  private selectedAttUnitType: UnitType | null = null
  private attGhostMesh: THREE.Mesh | null = null
  private attZoneMesh: THREE.Mesh | null = null
  private attPendingCost = 0
  private sphereChar: THREE.Group | null = null
  private sphereInner: THREE.Group | null = null
  private sphereFallback: THREE.Mesh | null = null
  private sphereDefender: SphereDefender | null = null
  private sphereGhostMesh: THREE.Mesh | null = null
  private sphereZoneMesh: THREE.Mesh | null = null
  private sphereSelecting = false
  private spherePlaced = false

  // Camera pan/zoom state
  private isPanning = false
  private lastPan = { x: 0, y: 0 }
  private zoomVelocity = 0

  constructor(private canvas: HTMLCanvasElement) {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x201b14)  // matches terrain darkest tone

    const halfH = 600 / (window.innerWidth / window.innerHeight)
    this.camera = new THREE.OrthographicCamera(-600, 600, halfH, -halfH, 1, 1500)
    this.camera.position.set(0, 300, 300)
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

    // Light map grid (50-unit cells)
    const grid = new THREE.GridHelper(1200, 24, 0xaaaaaa, 0x777777)
    grid.rotation.x = Math.PI / 2
    grid.position.z = 1.5
    const gridMats = Array.isArray(grid.material) ? grid.material : [grid.material]
    gridMats.forEach(m => { const lm = m as THREE.LineBasicMaterial; lm.transparent = true; lm.opacity = 0.3 })
    this.scene.add(grid)

    await Unit.preload()
    this.initSphereCharacter()

    this.hud.showGame()
    this.enterBuildPhase()
  }

  private initSphereCharacter() {
    // Outer group: fixed position, HP bars attach here (never rotates)
    const group = new THREE.Group()
    group.position.set(-350, 0, 0)

    // Inner group: rotates, contains the model
    const inner = new THREE.Group()
    const fallbackGeo = new THREE.SphereGeometry(18, 16, 16)
    const fallbackMat = new THREE.MeshStandardMaterial({
      color: 0x4488cc,
      emissive: new THREE.Color(0x112244),
      emissiveIntensity: 0.6,
    })
    const fallback = new THREE.Mesh(fallbackGeo, fallbackMat)
    inner.add(fallback)
    group.add(inner)

    group.visible = false  // hidden until purchased during build phase
    this.scene.add(group)
    this.sphereChar = group
    this.sphereInner = inner
    this.sphereFallback = fallback
    this.sphereDefender = new SphereDefender(this.scene, group)

    const loader = new GLTFLoader()
    loader.load(
      '/models/sphere.glb',
      gltf => {
        if (!this.sphereInner || !this.sphereFallback) return
        const model = gltf.scene
        const box = new THREE.Box3().setFromObject(model)
        const size = new THREE.Vector3()
        box.getSize(size)
        const maxDim = Math.max(size.x, size.y, size.z)
        if (maxDim > 0) model.scale.setScalar(36 / maxDim)
        this.sphereInner.remove(this.sphereFallback)
        this.sphereFallback.geometry.dispose()
        ;(this.sphereFallback.material as THREE.Material).dispose()
        this.sphereFallback = null
        this.sphereInner.add(model)
      },
      undefined,
      () => { /* sphere.glb missing — fallback stays */ }
    )
  }

  private enterBuildPhase() {
    this.phase = 'build'
    this.testUnits = []
    this.attCredits = Config.START_CREDITS
    this.hud.setPhase('build')
    this.hud.setAttCredits(this.attCredits)
    this.buildPhase = new BuildPhase(this.scene, this.camera, this.hud, Config.START_CREDITS)

    // Subtle tint showing where attackers can be placed
    const zoneGeo = new THREE.PlaneGeometry(400, 400)
    const zoneMat = new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false })
    this.attZoneMesh = new THREE.Mesh(zoneGeo, zoneMat)
    this.attZoneMesh.position.set(400, 0, 0.3)
    this.scene.add(this.attZoneMesh)

    this.hud.onBuySphere = () => {
      if (this.spherePlaced) return
      // Toggle selection — second click cancels
      if (this.sphereSelecting) {
        this.clearSphereGhost()
        return
      }
      if (!this.buildPhase || this.buildPhase.getCredits() < 100) return
      this.sphereSelecting = true
      this.createSphereGhost()
    }

    this.hud.onBattle = () => this.enterBattlePhase()
    this.hud.onSpawnUnit = (type) => {
      // Same button again → cancel placement
      if (this.selectedAttUnitType === type) {
        this.clearAttPlacement(false)
        return
      }
      if (this.selectedAttUnitType) this.clearAttPlacement(false)
      this.selectedAttUnitType = type
      this.hud.setSelectedUnitType(type)
      this.createAttGhost(type)
    }
  }

  private enterBattlePhase() {
    if (!this.buildPhase) return
    this.clearAttPlacement(false)
    this.clearSphereGhost()
    if (this.attZoneMesh) {
      this.scene.remove(this.attZoneMesh)
      this.attZoneMesh.geometry.dispose()
      ;(this.attZoneMesh.material as THREE.Material).dispose()
      this.attZoneMesh = null
    }
    const structures = this.buildPhase.getStructures()
    this.buildPhase.cleanup()
    this.buildPhase = null

    const units = this.testUnits.length > 0
      ? this.testUnits
      : AIPlayer.buildArmy(Config.START_CREDITS).map(t => new Unit(this.scene, t, 420 + Math.random() * 100))
    this.testUnits = []

    this.phase = 'battle'
    this.hud.setPhase('battle')

    this.battlePhase = new BattlePhase(this.scene, this.powerCore, units, structures, this.sphereDefender)
    this.battlePhase.onWin  = () => { this.phase = 'win';  this.hud.setPhase('win') }
    this.battlePhase.onLose = () => { this.phase = 'lose'; this.hud.setPhase('lose') }
  }

  private createSphereGhost() {
    this.clearSphereGhost()
    const geo = new THREE.RingGeometry(16, 24, 24)
    const mat = new THREE.MeshBasicMaterial({ color: 0x44aaff, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
    this.sphereGhostMesh = new THREE.Mesh(geo, mat)
    this.sphereGhostMesh.position.set(-400, 0, 1)
    this.scene.add(this.sphereGhostMesh)

    // Bright tint over the defender zone — so it's impossible to miss where
    // to click. Pulses subtly during placement (handled in the render loop).
    const zoneW = Config.DEFENDER_MAX_X - Config.WORLD.LEFT
    const zoneH = Config.WORLD.TOP - Config.WORLD.BOTTOM
    const zoneGeo = new THREE.PlaneGeometry(zoneW, zoneH)
    const zoneMat = new THREE.MeshBasicMaterial({ color: 0x00ddff, transparent: true, opacity: 0.32, depthWrite: false })
    this.sphereZoneMesh = new THREE.Mesh(zoneGeo, zoneMat)
    this.sphereZoneMesh.position.set((Config.WORLD.LEFT + Config.DEFENDER_MAX_X) / 2, 0, 0.5)
    this.scene.add(this.sphereZoneMesh)
  }

  private clearSphereGhost() {
    this.sphereSelecting = false
    if (this.sphereGhostMesh) {
      this.scene.remove(this.sphereGhostMesh)
      this.sphereGhostMesh.geometry.dispose()
      ;(this.sphereGhostMesh.material as THREE.Material).dispose()
      this.sphereGhostMesh = null
    }
    if (this.sphereZoneMesh) {
      this.scene.remove(this.sphereZoneMesh)
      this.sphereZoneMesh.geometry.dispose()
      ;(this.sphereZoneMesh.material as THREE.Material).dispose()
      this.sphereZoneMesh = null
    }
  }

  private createAttGhost(type: UnitType) {
    if (this.attGhostMesh) {
      this.scene.remove(this.attGhostMesh)
      this.attGhostMesh.geometry.dispose()
      ;(this.attGhostMesh.material as THREE.Material).dispose()
    }
    const color = Config.UNITS[type].color
    const geo = new THREE.RingGeometry(12, 20, 24)
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.75 })
    this.attGhostMesh = new THREE.Mesh(geo, mat)
    this.attGhostMesh.position.set(400, 0, 1)
    this.scene.add(this.attGhostMesh)
  }

  private clearAttPlacement(refund: boolean) {
    if (refund && this.attPendingCost > 0) {
      this.attCredits += this.attPendingCost
      this.hud.setAttCredits(this.attCredits)
    }
    this.attPendingCost = 0
    this.selectedAttUnitType = null
    this.hud.setSelectedUnitType(null)
    if (this.attGhostMesh) {
      this.scene.remove(this.attGhostMesh)
      this.attGhostMesh.geometry.dispose()
      ;(this.attGhostMesh.material as THREE.Material).dispose()
      this.attGhostMesh = null
    }
  }

  private screenToWorld(clientX: number, clientY: number): THREE.Vector2 | null {
    const ndcX = (clientX / window.innerWidth) * 2 - 1
    const ndcY = -(clientY / window.innerHeight) * 2 + 1
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera)
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    const target = new THREE.Vector3()
    if (!raycaster.ray.intersectPlane(groundPlane, target)) return null
    return new THREE.Vector2(target.x, target.y)
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

    this.testUnits.forEach(u => u.update(delta))
    this.powerCore?.update(delta)
    this.battlePhase?.update(delta)
    if (this.sphereInner) this.sphereInner.rotation.y += delta * 0.5

    // Smooth zoom with damping
    if (Math.abs(this.zoomVelocity) > 0.0002) {
      const factor = 1 + this.zoomVelocity
      const newWidth = (this.camera.right - this.camera.left) * factor
      if (newWidth >= 200 && newWidth <= 2800) {
        this.camera.left   *= factor
        this.camera.right  *= factor
        this.camera.top    *= factor
        this.camera.bottom *= factor
        this.camera.updateProjectionMatrix()
      }
      this.zoomVelocity *= 0.82
    }

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
    // Accumulate zoom velocity for smooth deceleration
    this.zoomVelocity += Math.max(-0.015, Math.min(0.015, e.deltaY * 0.00015))
  }

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 1 || e.button === 2) {
      this.isPanning = true
      this.lastPan = { x: e.clientX, y: e.clientY }
    }
    if (e.button === 0 && this.phase === 'build') {
      if ((e.target as HTMLElement).closest('#hud')) return  // ignore HUD clicks

      // Place sphere at ghost position — same flow as cyborg below.
      // Ghost visibility (set in onMouseMove based on zone) is the gate.
      if (this.sphereSelecting && this.buildPhase) {
        if (!this.sphereGhostMesh?.visible) return
        if (!this.buildPhase.spendCredits(100)) return
        const { x, y } = this.sphereGhostMesh.position
        if (this.sphereChar) {
          this.sphereChar.position.set(x, y, 0)
          this.sphereChar.visible = true
        }
        if (this.sphereDefender) {
          this.sphereDefender.worldX = x
          this.sphereDefender.worldY = y
        }
        this.spherePlaced = true
        this.clearSphereGhost()
        this.hud.markSpherePurchased()
        return
      }

      // Place attacker unit at ghost position — canonical placement flow
      if (this.selectedAttUnitType) {
        if (!this.attGhostMesh?.visible) return
        const cost = Config.UNITS[this.selectedAttUnitType].cost
        if (this.attCredits < cost) return
        this.attCredits -= cost
        this.hud.setAttCredits(this.attCredits)
        const { x, y } = this.attGhostMesh.position
        this.testUnits.push(new Unit(this.scene, this.selectedAttUnitType, x, y))
      }
    }
  }

  private onMouseMove = (e: MouseEvent) => {
    if (this.isPanning) {
      const dx = e.clientX - this.lastPan.x
      const dy = e.clientY - this.lastPan.y
      const ww = this.camera.right - this.camera.left
      const wh = this.camera.top - this.camera.bottom
      const panX = (dx / window.innerWidth) * ww
      const panY = (dy / window.innerHeight) * wh
      this.camera.position.x -= panX
      this.camera.position.y += panY * 0.707
      this.camera.position.z -= panY * 0.707
      this.lastPan = { x: e.clientX, y: e.clientY }
    }
    // Move ghost — only visible when mouse is over the valid attacker zone
    if (this.attGhostMesh && this.selectedAttUnitType) {
      const pos = this.screenToWorld(e.clientX, e.clientY)
      if (pos && pos.x >= Config.ATTACKER_MIN_X && pos.x <= Config.WORLD.RIGHT) {
        const clampedY = Math.max(Config.WORLD.BOTTOM + 20, Math.min(Config.WORLD.TOP - 20, pos.y))
        this.attGhostMesh.position.set(pos.x, clampedY, 1)
        this.attGhostMesh.visible = true
      } else {
        this.attGhostMesh.visible = false
      }
    }
    // Move sphere ghost — visible only when cursor is over the defender zone
    // (mirrors attacker-ghost flow above so onMouseDown can use ghost.visible
    // as the placement gate)
    if (this.sphereGhostMesh && this.sphereSelecting) {
      const pos = this.screenToWorld(e.clientX, e.clientY)
      if (pos && pos.x >= Config.WORLD.LEFT && pos.x <= Config.DEFENDER_MAX_X) {
        const clampedY = Math.max(Config.WORLD.BOTTOM + 20, Math.min(Config.WORLD.TOP - 20, pos.y))
        this.sphereGhostMesh.position.set(pos.x, clampedY, 1)
        this.sphereGhostMesh.visible = true
      } else {
        this.sphereGhostMesh.visible = false
      }
    }
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
    this.clearAttPlacement(false)
    this.clearSphereGhost()
    if (this.attZoneMesh) { this.scene.remove(this.attZoneMesh); this.attZoneMesh = null }
    if (this.sphereChar) { this.scene.remove(this.sphereChar); this.sphereChar = null }
    this.sphereInner = null
    this.sphereFallback = null
    this.renderer.dispose()
    this.scene.clear()
    this.hud?.dispose()
  }
}
