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

// Unified placement session — covers both cyborg and sphere placement.
// Ghost mesh is the authoritative position; never re-raycast at click time.
// onPlace returns true to end the session (single-shot), false to stay
// in placement mode (multi-place).
type PlacementKind = 'sphere' | UnitType
type PlacementSession = {
  kind: PlacementKind
  ghost: THREE.Mesh
  tint: THREE.Mesh | null
  zoneXMin: number
  zoneXMax: number
  onPlace: (x: number, y: number) => boolean
  onEnd?: () => void
}

const SPHERE_COST = 100

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
  private attackerUnits: Unit[] = []

  private attCredits = Config.START_CREDITS
  private attZoneMesh: THREE.Mesh | null = null
  private defZoneMesh: THREE.Mesh | null = null

  // Multi-sphere: the raw GLB bytes are cached once; each placement re-parses a
  // fresh THREE scene from the buffer. Avoids Object3D.clone(true), which was
  // breaking shape on repeat placements.
  private sphereGlbBuffer: ArrayBuffer | null = null
  private sphereScale = 1
  private spheres: SphereDefender[] = []

  // Single source of truth for any active placement.
  private placement: PlacementSession | null = null

  // Camera pan/zoom state
  private isPanning = false
  private lastPan = { x: 0, y: 0 }
  private zoomVelocity = 0

  constructor(private canvas: HTMLCanvasElement) {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x201b14)  // matches terrain darkest tone

    const halfH = 600 / (window.innerWidth / window.innerHeight)
    this.camera = new THREE.OrthographicCamera(-600, 600, halfH, -halfH, 1, 1500)
    // 45° tilt — the known-good camera angle that shows units in 3/4 view.
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

    // Light map grid — rectangular, sized to actual world bounds (not the
    // square 1200×1200 GridHelper, which spilled past the playable area).
    const grid = this.buildGroundGrid(
      Config.WORLD.LEFT, Config.WORLD.RIGHT,
      Config.WORLD.BOTTOM, Config.WORLD.TOP,
      Config.GRID_CELL, 0xaaaaaa, 0.3
    )
    grid.position.z = 1.5
    this.scene.add(grid)

    // Block UI until all visuals are ready, so placements never show the swap.
    await Promise.all([
      Unit.preload(),
      this.loadSphereTemplate(),
    ])

    this.hud.showGame()
    this.enterBuildPhase()
  }

  // Loads sphere.glb as raw bytes once and pre-parses a sample to derive the
  // uniform scale factor. Each placement re-parses from the buffer (see
  // makeSphereModel) so we never share or clone Object3D instances between
  // placements — clone(true) was producing distorted shapes.
  private loadSphereTemplate(): Promise<void> {
    return fetch('/models/sphere.glb')
      .then(r => {
        if (!r.ok) throw new Error('sphere.glb fetch failed')
        return r.arrayBuffer()
      })
      .then(buffer => new Promise<void>((resolve, reject) => {
        this.sphereGlbBuffer = buffer
        new GLTFLoader().parse(buffer, '', gltf => {
          const box = new THREE.Box3().setFromObject(gltf.scene)
          const size = new THREE.Vector3()
          box.getSize(size)
          // Scale by the smallest bbox axis, not the largest. The asset is ~14%
          // wider on X than Y/Z (small features or slight body stretch). Using
          // min keeps the body at full target diameter; longer-axis features
          // just extend a touch past the 36-unit reference instead of forcing
          // the whole body to render compressed.
          const minDim = Math.min(size.x, size.y, size.z)
          this.sphereScale = minDim > 0 ? 36 / minDim : 1
          resolve()
        }, reject)
      }))
      .catch(() => {
        // Network or parse failure — leave buffer null; makeSphereModel will
        // hand out a MeshBasicMaterial fallback so the game still works.
        this.sphereGlbBuffer = null
      })
  }

  // Build a fresh sphere model for a single placement. Resolves with a
  // SphereGeometry fallback if the GLB buffer is missing or parse fails.
  // Swaps every MeshStandardMaterial for a MeshBasicMaterial that keeps the
  // base color texture but ignores scene lights — the scene's bright ambient
  // was blowing out the sphere's dark base color into a washed-out cap on
  // whatever side was facing the directional light.
  private makeSphereModel(): Promise<THREE.Object3D> {
    if (!this.sphereGlbBuffer) return Promise.resolve(this.makeSphereFallback())
    return new Promise(resolve => {
      new GLTFLoader().parse(
        this.sphereGlbBuffer!,
        '',
        gltf => {
          gltf.scene.scale.setScalar(this.sphereScale)
          gltf.scene.traverse(obj => {
            const m = obj as THREE.Mesh
            if (!m.isMesh) return
            const old = m.material as THREE.MeshStandardMaterial
            if (!old || !(old as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial) return
            m.material = new THREE.MeshBasicMaterial({
              map: old.map ?? null,
              color: 0xffffff,
            })
            old.dispose()
          })
          resolve(gltf.scene)
        },
        () => resolve(this.makeSphereFallback())
      )
    })
  }

  private makeSphereFallback(): THREE.Object3D {
    const group = new THREE.Group()
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(18, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0x44ccff })
    )
    group.add(ball)
    return group
  }

  private enterBuildPhase() {
    this.phase = 'build'
    this.attackerUnits = []
    this.attCredits = Config.START_CREDITS
    this.hud.setPhase('build')
    this.hud.setAttCredits(this.attCredits)
    this.buildPhase = new BuildPhase(this.scene, this.camera, this.hud, Config.START_CREDITS)

    // Permanent subtle tints so players see each zone before clicking a Buy.
    this.defZoneMesh = this.makeZoneTint(
      Config.WORLD.LEFT, Config.DEFENDER_MAX_X, 0x00ddff, 0.07, 0.3
    )
    this.attZoneMesh = this.makeZoneTint(
      Config.ATTACKER_MIN_X, Config.WORLD.RIGHT, 0xff4488, 0.07, 0.3
    )

    this.hud.onBuySphere = () => {
      if (this.placement?.kind === 'sphere') { this.endPlacement(); return }
      if (!this.buildPhase || this.buildPhase.getCredits() < SPHERE_COST) return
      this.startSpherePlacement()
    }

    this.hud.onBattle = () => this.enterBattlePhase()

    this.hud.onSpawnUnit = (type) => {
      if (this.placement?.kind === type) { this.endPlacement(); return }
      this.startCyborgPlacement(type)
    }
  }

  private enterBattlePhase() {
    if (!this.buildPhase) return
    this.endPlacement()
    this.removeZoneTint('att')
    this.removeZoneTint('def')

    const structures = this.buildPhase.getStructures()
    this.buildPhase.cleanup()
    this.buildPhase = null

    const units = this.attackerUnits.length > 0
      ? this.attackerUnits
      : AIPlayer.buildArmy(Config.START_CREDITS).map(t => new Unit(this.scene, t, 420 + Math.random() * 100))
    this.attackerUnits = []

    this.phase = 'battle'
    this.hud.setPhase('battle')

    this.battlePhase = new BattlePhase(this.scene, this.powerCore, units, structures, this.spheres)
    this.battlePhase.onWin  = () => { this.phase = 'win';  this.hud.setPhase('win') }
    this.battlePhase.onLose = () => { this.phase = 'lose'; this.hud.setPhase('lose') }
  }

  // ── Placement (unified) ──────────────────────────────────────────────────

  private startSpherePlacement() {
    const ghost = this.makeGhostRing(0x44aaff, 16, 24)
    ghost.position.set(-400, 0, 1)
    this.scene.add(ghost)
    const tint = this.makeZoneTint(
      Config.WORLD.LEFT, Config.DEFENDER_MAX_X, 0x00ddff, 0.32, 0.5
    )
    this.placement = {
      kind: 'sphere',
      ghost, tint,
      zoneXMin: Config.WORLD.LEFT,
      zoneXMax: Config.DEFENDER_MAX_X,
      onPlace: (x, y) => {
        if (!this.buildPhase) return false
        if (!this.buildPhase.spendCredits(SPHERE_COST)) return false
        // Parse a fresh GLB scene per placement (no clone). Credits are spent
        // synchronously above so the parse delay can't double-charge.
        this.makeSphereModel().then(model => {
          this.spheres.push(new SphereDefender(this.scene, x, y, model))
        })
        return false  // multi-place — keep selecting until user cancels or credits run out
      },
    }
  }

  private startCyborgPlacement(type: UnitType) {
    const color = Config.UNITS[type].color
    const ghost = this.makeGhostRing(color, 12, 20)
    ghost.position.set(400, 0, 1)
    this.scene.add(ghost)
    this.hud.setSelectedUnitType(type)
    this.placement = {
      kind: type,
      ghost, tint: null,
      zoneXMin: Config.ATTACKER_MIN_X,
      zoneXMax: Config.WORLD.RIGHT,
      onPlace: (x, y) => {
        const cost = Config.UNITS[type].cost
        if (this.attCredits < cost) return false
        this.attCredits -= cost
        this.hud.setAttCredits(this.attCredits)
        this.attackerUnits.push(new Unit(this.scene, type, x, y))
        return false
      },
      onEnd: () => this.hud.setSelectedUnitType(null),
    }
  }

  private endPlacement() {
    if (!this.placement) return
    const p = this.placement
    this.placement = null
    this.scene.remove(p.ghost)
    p.ghost.geometry.dispose()
    ;(p.ghost.material as THREE.Material).dispose()
    if (p.tint) {
      this.scene.remove(p.tint)
      p.tint.geometry.dispose()
      ;(p.tint.material as THREE.Material).dispose()
    }
    p.onEnd?.()
  }

  // Rectangular ground grid drawn as LineSegments. Spans exactly the world
  // bounds passed in, with line spacing = cell. Replaces the square
  // GridHelper that extended past the playable area.
  private buildGroundGrid(
    xMin: number, xMax: number,
    yMin: number, yMax: number,
    cell: number, color: number, opacity: number
  ): THREE.LineSegments {
    const verts: number[] = []
    for (let x = xMin; x <= xMax + 0.001; x += cell) {
      verts.push(x, yMin, 0, x, yMax, 0)
    }
    for (let y = yMin; y <= yMax + 0.001; y += cell) {
      verts.push(xMin, y, 0, xMax, y, 0)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity })
    return new THREE.LineSegments(geo, mat)
  }

  private makeGhostRing(color: number, inner: number, outer: number): THREE.Mesh {
    const geo = new THREE.RingGeometry(inner, outer, 24)
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
    return new THREE.Mesh(geo, mat)
  }

  private makeZoneTint(xMin: number, xMax: number, color: number, opacity: number, z: number): THREE.Mesh {
    const w = xMax - xMin
    const h = Config.WORLD.TOP - Config.WORLD.BOTTOM
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
    )
    mesh.position.set((xMin + xMax) / 2, 0, z)
    this.scene.add(mesh)
    return mesh
  }

  private removeZoneTint(side: 'att' | 'def') {
    const m = side === 'att' ? this.attZoneMesh : this.defZoneMesh
    if (!m) return
    this.scene.remove(m)
    m.geometry.dispose()
    ;(m.material as THREE.Material).dispose()
    if (side === 'att') this.attZoneMesh = null
    else this.defZoneMesh = null
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

    this.attackerUnits.forEach(u => { u.update(delta); u.faceCamera(this.camera) })
    this.powerCore?.update(delta)
    this.powerCore?.faceCamera(this.camera)
    this.spheres.forEach(s => { s.update(delta); s.faceCamera(this.camera) })
    this.buildPhase?.faceCamera(this.camera)
    this.battlePhase?.update(delta)
    this.battlePhase?.faceCamera(this.camera)

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
    this.zoomVelocity += Math.max(-0.015, Math.min(0.015, e.deltaY * 0.00015))
  }

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 1 || e.button === 2) {
      this.isPanning = true
      this.lastPan = { x: e.clientX, y: e.clientY }
    }
    if (e.button === 0 && this.phase === 'build') {
      if ((e.target as HTMLElement).closest('#hud')) return  // ignore HUD clicks

      if (this.placement) {
        if (!this.placement.ghost.visible) return
        const { x, y } = this.placement.ghost.position
        const shouldEnd = this.placement.onPlace(x, y)
        if (shouldEnd) this.endPlacement()
      }
    }
  }

  private onMouseMove = (e: MouseEvent) => {
    if (this.isPanning) {
      const dx = e.clientX - this.lastPan.x
      const dy = e.clientY - this.lastPan.y
      const ww = this.camera.right - this.camera.left
      const wh = this.camera.top - this.camera.bottom
      const panY = (dy / window.innerHeight) * wh
      // Camera local Y axis in world coords — has a small -Z component because
      // of the slight tilt. Read it directly from the camera's world matrix so
      // pan slides along the screen up direction instead of pitching the view.
      const camUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1)
      this.camera.position.x -= (dx / window.innerWidth) * ww
      this.camera.position.y += panY * camUp.y
      this.camera.position.z += panY * camUp.z
      this.lastPan = { x: e.clientX, y: e.clientY }
    }
    if (this.placement) {
      const pos = this.screenToWorld(e.clientX, e.clientY)
      const inZone = pos
        && pos.x >= this.placement.zoneXMin
        && pos.x <= this.placement.zoneXMax
      if (pos && inZone) {
        const clampedY = Math.max(Config.WORLD.BOTTOM + 20, Math.min(Config.WORLD.TOP - 20, pos.y))
        this.placement.ghost.position.set(pos.x, clampedY, 1)
        this.placement.ghost.visible = true
      } else {
        this.placement.ghost.visible = false
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
    this.endPlacement()
    this.removeZoneTint('att')
    this.removeZoneTint('def')
    for (const s of this.spheres) this.scene.remove(s.mesh)
    this.spheres = []
    this.sphereGlbBuffer = null
    this.renderer.dispose()
    this.scene.clear()
    this.hud?.dispose()
  }
}
