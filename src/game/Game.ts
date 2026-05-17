import * as THREE from 'three'
import { Config, UnitType } from './GameConfig'
import { Background } from '../scene/Background'
import { PixelPowerCore, preloadPixelPowerCore } from '../entities/PixelPowerCore'
import { SphereDefender, preloadSphereSprites } from '../entities/SphereDefender'
import { SpriteUnit, preloadSpriteUnit } from '../entities/SpriteUnit'
import { HUD } from '../ui/HUD'
import { AIPlayer } from '../ai/AIPlayer'
import { BuildPhase } from './BuildPhase'
import { BattlePhase } from './BattlePhase'
import { PlanningPhase } from './PlanningPhase'

type Phase = 'loading' | 'build' | 'planning' | 'battle' | 'win' | 'lose'

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
  // How far the entity center must stay from world Y edges so the visual
  // fits inside the zone (sphere is taller than cyborg, asymmetric).
  marginTop: number
  marginBottom: number
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
  private powerCore!: PixelPowerCore
  private hud!: HUD
  private buildPhase: BuildPhase | null = null
  private battlePhase: BattlePhase | null = null
  private planningPhase: PlanningPhase | null = null
  // All attackers are pixel sprites now (the 3D Meshy cyborg was retired).
  private attackerUnits: SpriteUnit[] = []

  private attCredits = Config.START_CREDITS
  private attZoneMesh: THREE.LineSegments | null = null
  private defZoneMesh: THREE.LineSegments | null = null

  // Multi-sphere: now sprite-based (8 directional pixel-art PNGs, ~24 KB total
  // instead of the 60 MB GLB). Pre-loaded in preloadSphereSprites().
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
    // Top-down view — square grid cells project as on-screen squares. Sprites
    // are billboarded so they still face the camera with the same image.
    this.camera.position.set(0, 0, 500)
    this.camera.lookAt(0, 0, 0)

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)

    // Lighting rig — tuned so the dark Meshy power core reads against the
    // dark terrain from all angles.
    //   - Ambient: base scene-wide brightness (sprites aren't lit, only PBR).
    //   - Hemisphere: sky/ground gradient so upward-facing surfaces (antennas,
    //     dome top) catch a subtle cyan, and downward-facing ones catch warm
    //     terrain bounce.
    //   - Key directional: camera-side, lights the front of the model.
    //   - Fill directional: opposite side at lower intensity so the back of
    //     the model isn't pure shadow — used to be invisible against the
    //     brown background.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.8))
    this.scene.add(new THREE.HemisphereLight(0xaaccff, 0x4a3422, 0.7))

    const dirKey = new THREE.DirectionalLight(0xffffff, 1.2)
    dirKey.position.set(0, 0, 100)
    this.scene.add(dirKey)

    const dirFill = new THREE.DirectionalLight(0xbbccff, 0.7)
    dirFill.position.set(0, -100, -80)   // from below-back; hits the rear faces and antenna spikes
    this.scene.add(dirFill)

    window.addEventListener('resize', this.onResize)
    window.addEventListener('wheel', this.onWheel, { passive: false })
    window.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('contextmenu', this.onContextMenu)
  }

  async init() {
    this.background = new Background(this.scene)
    this.hud = new HUD()

    // Block UI until all visuals are ready, so placements never show the swap.
    // PowerCore is constructed AFTER preload so the GLB template is in place
    // when its setVariant() runs — otherwise the first frame would render the
    // fallback geometry.
    await Promise.all([
      preloadSphereSprites(),
      preloadSpriteUnit('cannon', 'cannon'),
      preloadSpriteUnit('grenadier', 'grenadier'),
      preloadSpriteUnit('doublegun', 'doublegun'),
      preloadPixelPowerCore(),
      // GLB Power Core preload skipped — switched to pixel sprite. super.glb
      // + textured.glb + plain.glb stay on disk for future repurposing.
    ])

    // Pixel power core — 2x2 footprint (100 world units = 2 cells across).
    // Per the piece-size rule, large pieces step up to the next tier (4 cells).
    this.powerCore = new PixelPowerCore(this.scene, Config.POWER_CORE.X, Config.POWER_CORE.Y, Config.GRID_CELL * 2)

    // Map-wide strategy grid. Game is shifting toward chess-like turn-based
    // play with one piece per square (see docs/STATS.md). The grid makes the
    // playable cells visible so positioning is obvious during build phase.
    this.scene.add(this.makeMapGrid())

    this.hud.showGame()
    this.enterBuildPhase()
  }

  private makeMapGrid(): THREE.LineSegments {
    const verts: number[] = []
    const left = Config.WORLD.LEFT
    const right = Config.WORLD.RIGHT
    const top = Config.WORLD.TOP
    const bottom = Config.WORLD.BOTTOM
    const cell = Config.GRID_CELL
    const z = 0.3   // just below fence borders (z=0.4), above terrain
    // Vertical lines
    for (let x = left; x <= right + 0.5; x += cell) {
      verts.push(x, bottom, z, x, top, z)
    }
    // Horizontal lines
    for (let y = bottom; y <= top + 0.5; y += cell) {
      verts.push(left, y, z, right, y, z)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    // Cool blue-gray contrasts against the warm brown dirt; higher opacity so
    // every cell boundary reads clearly.
    const mat = new THREE.LineBasicMaterial({
      color: 0xaabbcc, transparent: true, opacity: 0.55,
    })
    return new THREE.LineSegments(geo, mat)
  }

private enterBuildPhase() {
    this.phase = 'build'
    this.attackerUnits = []
    this.attCredits = Config.START_CREDITS
    this.hud.setPhase('build')
    this.hud.setAttCredits(this.attCredits)
    this.buildPhase = new BuildPhase(this.scene, this.camera, this.hud, Config.START_CREDITS)

    // Thin fence borders mark each zone without covering sprites.
    this.defZoneMesh = this.makeZoneBorder(
      Config.WORLD.LEFT, Config.DEFENDER_MAX_X, 0x00ddff
    )
    this.attZoneMesh = this.makeZoneBorder(
      Config.ATTACKER_MIN_X, Config.WORLD.RIGHT, 0xff4488
    )

    this.hud.onBuySphere = () => {
      if (this.placement?.kind === 'sphere') { this.endPlacement(); return }
      if (!this.buildPhase || this.buildPhase.getCredits() < SPHERE_COST) return
      // Cancel any active structure selection so its click handler doesn't
      // fire alongside the sphere placement.
      this.buildPhase?.selectStructure(null)
      this.hud.clearStructureSelection()
      this.startSpherePlacement()
    }

    // Build phase's "BATTLE" button now opens the planning phase first. The
    // actual reveal still happens in BattlePhase (phase 3 will swap that for
    // the initiative-sorted reveal engine).
    this.hud.onBattle = () => this.enterPlanningPhase()

    this.hud.onSpawnUnit = (type) => {
      if (this.placement?.kind === type) { this.endPlacement(); return }
      this.buildPhase?.selectStructure(null)
      this.hud.clearStructureSelection()
      this.startCyborgPlacement(type)
    }

    // Structure selection — cancel any active sphere/cyborg placement first
    // so both systems don't fire on the same click.
    this.hud.onSelectStructure = (type) => {
      this.endPlacement()
      this.buildPhase?.selectStructure(type)
    }
  }

  private enterPlanningPhase() {
    if (!this.buildPhase) return
    this.endPlacement()
    this.removeZoneTint('att')
    this.removeZoneTint('def')

    // Snapshot the structures + units from build phase. After this point the
    // BuildPhase is gone; planning + battle work off these arrays.
    const structures = this.buildPhase.getStructures()
    this.buildPhase.cleanup()
    this.buildPhase = null

    const units = this.attackerUnits

    this.phase = 'planning'
    this.hud.setPhase('planning')

    this.planningPhase = new PlanningPhase(
      this.scene, this.spheres, units, structures, this.powerCore,
    )
    this.planningPhase.onSelectionChange = info => this.hud.setPlanningSelection(info)

    // From planning, the BATTLE button advances to the actual combat.
    this.hud.onBattle = () => this.enterBattlePhase(units, structures)
  }

  private enterBattlePhase(units?: SpriteUnit[], structures?: ReturnType<BuildPhase['getStructures']>) {
    // Tear down planning UI + overlays if we came through it.
    if (this.planningPhase) {
      // Log queued plans so phase 2 can be verified without the reveal engine.
      // Phase 3 will consume these for real.
      const dump: Record<string, unknown>[] = []
      for (const c of (units ?? this.attackerUnits))
        if (c.queuedActions.length) dump.push({ id: c.id, type: c.type, actions: c.queuedActions })
      for (const s of this.spheres)
        if (s.queuedActions.length) dump.push({ id: s.id, kind: 'sphere', actions: s.queuedActions })
      if (dump.length) console.log('[planning] queued plans →', dump)

      this.planningPhase.dispose()
      this.planningPhase = null
      this.hud.setPlanningSelection(null)
    }

    // Fallback path: enterBattlePhase called without going through planning
    // (no longer wired, but keep the safety net so direct calls don't crash).
    if (!units || !structures) {
      this.endPlacement()
      this.removeZoneTint('att')
      this.removeZoneTint('def')
      if (this.buildPhase) {
        structures = this.buildPhase.getStructures()
        this.buildPhase.cleanup()
        this.buildPhase = null
      }
      units = this.attackerUnits
    }

    // If no cyborgs placed (testing), auto-spawn an AI army so the battle has
    // something to fight.
    let battleUnits: SpriteUnit[] = units!
    if (battleUnits.length === 0) {
      battleUnits = AIPlayer.buildArmy(Config.START_CREDITS).map(t =>
        new SpriteUnit(this.scene, t, 420 + Math.random() * 100)
      )
    }
    this.attackerUnits = []

    this.phase = 'battle'
    this.hud.setPhase('battle')

    this.battlePhase = new BattlePhase(this.scene, this.powerCore, battleUnits, structures!, this.spheres)
    this.battlePhase.onWin  = () => { this.phase = 'win';  this.hud.setPhase('win') }
    this.battlePhase.onLose = () => { this.phase = 'lose'; this.hud.setPhase('lose') }
  }

  // ── Placement (unified) ──────────────────────────────────────────────────

  private startSpherePlacement() {
    // Tear down any previous placement (cyborg ring etc.) so the old ghost
    // doesn't orphan in the scene — bug previously left a stale colored ring
    // behind when switching attacker types.
    this.endPlacement()
    const ghost = this.makeGhostRing(0x44aaff, 16, 24)
    ghost.position.set(-400, 0, 1)
    this.scene.add(ghost)
    this.placement = {
      kind: 'sphere',
      ghost, tint: null,
      zoneXMin: Config.WORLD.LEFT,
      zoneXMax: Config.DEFENDER_MAX_X,
      marginTop: 0, marginBottom: 0,   // grid snap supersedes margins
      onPlace: (x, y) => {
        if (!this.buildPhase) return false
        if (this.isCellOccupied(x, y)) return false   // one piece per cell
        if (!this.buildPhase.spendCredits(SPHERE_COST)) return false
        this.spheres.push(new SphereDefender(this.scene, x, y))
        return false  // multi-place — keep selecting until user cancels or credits run out
      },
    }
  }

  private startCyborgPlacement(type: UnitType) {
    // Tear down any previous placement so its ghost ring doesn't orphan.
    this.endPlacement()
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
      marginTop: 0, marginBottom: 0,   // grid snap supersedes margins
      onPlace: (x, y) => {
        if (this.isCellOccupied(x, y)) return false
        const cost = Config.UNITS[type].cost
        if (this.attCredits < cost) return false
        this.attCredits -= cost
        this.hud.setAttCredits(this.attCredits)
        this.attackerUnits.push(new SpriteUnit(this.scene, type, x, y))
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

private makeGhostRing(color: number, inner: number, outer: number): THREE.Mesh {
    const geo = new THREE.RingGeometry(inner, outer, 24)
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
    return new THREE.Mesh(geo, mat)
  }

  // Snap a world-space point to the center of its grid cell, restricted to
  // columns inside the active placement zone. Returns valid=false if cursor
  // falls outside the zone's columns or the map's row range.
  private snapToGridCell(
    x: number, y: number, zoneXMin: number, zoneXMax: number,
  ): { x: number; y: number; valid: boolean } {
    const cell = Config.GRID_CELL
    const cols = Math.floor((zoneXMax - zoneXMin) / cell)
    const rows = Math.floor((Config.WORLD.TOP - Config.WORLD.BOTTOM) / cell)
    const colIdx = Math.floor((x - zoneXMin) / cell)
    const rowIdx = Math.floor((y - Config.WORLD.BOTTOM) / cell)
    if (colIdx < 0 || colIdx >= cols || rowIdx < 0 || rowIdx >= rows) {
      return { x: 0, y: 0, valid: false }
    }
    return {
      x: zoneXMin + colIdx * cell + cell / 2,
      y: Config.WORLD.BOTTOM + rowIdx * cell + cell / 2,
      valid: true,
    }
  }

  // One piece per cell rule (per design — see docs/STATS.md). Pieces snap to
  // exact cell centers, so equality-with-epsilon catches collisions. The
  // Power Core has a 2x2 footprint and blocks all 4 of its cells.
  private isCellOccupied(x: number, y: number): boolean {
    const E = 1
    for (const s of this.spheres) {
      if (Math.abs(s.worldX - x) < E && Math.abs(s.worldY - y) < E) return true
    }
    for (const u of this.attackerUnits) {
      if (Math.abs(u.worldX - x) < E && Math.abs(u.worldY - y) < E) return true
    }
    for (const cc of this.powerCore.cellCenters()) {
      if (Math.abs(cc.x - x) < E && Math.abs(cc.y - y) < E) return true
    }
    return false
  }

  // Thin outline rectangle marking the playable zone. Replaces the old
  // semi-transparent tint plane, which covered sprites and washed them out.
  private makeZoneBorder(xMin: number, xMax: number, color: number): THREE.LineSegments {
    const yMin = Config.WORLD.BOTTOM
    const yMax = Config.WORLD.TOP
    const z = 0.4
    const verts = [
      xMin, yMin, z, xMax, yMin, z,
      xMax, yMin, z, xMax, yMax, z,
      xMax, yMax, z, xMin, yMax, z,
      xMin, yMax, z, xMin, yMin, z,
    ]
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })
    const lines = new THREE.LineSegments(geo, mat)
    this.scene.add(lines)
    return lines
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
    if (e.button === 1) {
      this.isPanning = true
      this.lastPan = { x: e.clientX, y: e.clientY }
    }

    if (e.button === 2 && this.phase === 'planning') {
      // Right-click in planning = clear queued actions / deselect (handled in
      // PlanningPhase). Don't enter pan mode.
      if ((e.target as HTMLElement).closest('#hud')) return
      this.planningPhase?.onSecondaryClick()
      return
    }
    if (e.button === 2) {
      this.isPanning = true
      this.lastPan = { x: e.clientX, y: e.clientY }
    }

    if (e.button === 0 && this.phase === 'build') {
      if ((e.target as HTMLElement).closest('#hud')) return  // ignore HUD clicks

      // Refund-and-remove if clicking on an already-placed sphere or cyborg.
      const world = this.screenToWorld(e.clientX, e.clientY)
      if (world && this.tryRefund(world.x, world.y)) return

      if (this.placement) {
        if (!this.placement.ghost.visible) return
        const { x, y } = this.placement.ghost.position
        const shouldEnd = this.placement.onPlace(x, y)
        if (shouldEnd) this.endPlacement()
      }
    }

    if (e.button === 0 && this.phase === 'planning') {
      if ((e.target as HTMLElement).closest('#hud')) return
      const world = this.screenToWorld(e.clientX, e.clientY)
      if (!world) return
      this.planningPhase?.onPrimaryClick(world.x, world.y, e.shiftKey)
    }
  }

  // Click on a placed sphere or cyborg → remove + refund. Returns true if
  // something was refunded (caller should skip normal placement logic).
  private tryRefund(x: number, y: number): boolean {
    const REFUND_RADIUS_SQ = 35 * 35
    for (let i = 0; i < this.spheres.length; i++) {
      const s = this.spheres[i]
      const dx = s.worldX - x, dy = s.worldY - y
      if (dx * dx + dy * dy < REFUND_RADIUS_SQ) {
        this.spheres.splice(i, 1)
        this.scene.remove(s.mesh)
        this.buildPhase?.addCredits(SPHERE_COST)
        return true
      }
    }
    for (let i = 0; i < this.attackerUnits.length; i++) {
      const u = this.attackerUnits[i]
      const dx = u.worldX - x, dy = u.worldY - y
      if (dx * dx + dy * dy < REFUND_RADIUS_SQ) {
        this.attackerUnits.splice(i, 1)
        this.scene.remove(u.mesh)
        this.attCredits += Config.UNITS[u.type].cost
        this.hud.setAttCredits(this.attCredits)
        return true
      }
    }
    return false
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
      if (pos) {
        const snap = this.snapToGridCell(
          pos.x, pos.y,
          this.placement.zoneXMin, this.placement.zoneXMax,
        )
        if (snap.valid) {
          this.placement.ghost.position.set(snap.x, snap.y, 1)
          this.placement.ghost.visible = true
        } else {
          this.placement.ghost.visible = false
        }
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
    this.renderer.dispose()
    this.scene.clear()
    this.hud?.dispose()
  }
}
