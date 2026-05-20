import * as THREE from 'three'
import { Config, StructureType } from './GameConfig'
import { Structure } from '../entities/Structure'
import { FireArcPreview } from '../entities/FireArcPreview'
import { HUD } from '../ui/HUD'

const COLS = 8
const ROWS = 8  // 400 / 50 — used for placement bounds checking, not for any visible grid

export class BuildPhase {
  private structures: Structure[] = []
  // Power Core 2x2 footprint cells. Built once in the constructor and never
  // mutated — these are always blocked regardless of structure placement.
  // We previously kept a per-structure `occupied` Set too, but it could go
  // stale when Game.tryRefund spliced a structure out of `structures`. Now
  // structure occupancy is derived live in isCellBlocked() so there's no
  // sync to break.
  private coreCells = new Set<string>()
  private selectedType: StructureType | null = null
  private credits: number

  private hitPlane: THREE.Mesh
  private ghostMesh: THREE.Mesh | null = null
  // Wedge / circle overlay shown alongside the cell ghost so the player can
  // see what the structure can actually shoot before they commit. Lifecycle
  // is tied 1:1 to the ghost — appears when the ghost shows, disposes on hide.
  private firePreview: FireArcPreview

  private raycaster = new THREE.Raycaster()
  private mouse = new THREE.Vector2()

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    private hud: HUD,
    startCredits: number,
    // Cross-system occupancy check — Game injects this so structure placement
    // can see spheres/cyborgs (which BuildPhase doesn't otherwise know about).
    private externalOccupied: (col: number, row: number) => boolean = () => false,
  ) {
    this.credits = startCredits

    // Power Core has a 2x2 footprint. Its (X, Y) is the centroid (a grid
    // intersection), so the 4 cells are at (X ± 25, Y ± 25).
    const half = Config.GRID_CELL / 2
    for (const cx of [Config.POWER_CORE.X - half, Config.POWER_CORE.X + half]) {
      for (const cy of [Config.POWER_CORE.Y - half, Config.POWER_CORE.Y + half]) {
        const c = Math.floor((cx - Config.WORLD.LEFT) / Config.GRID_CELL)
        const r = Math.floor((cy - Config.WORLD.BOTTOM) / Config.GRID_CELL)
        this.coreCells.add(`${c},${r}`)
      }
    }

    this.hitPlane = this.buildHitPlane()
    this.firePreview = new FireArcPreview(scene)

    hud.setCredits(this.credits)
    // Game wires hud.onSelectStructure itself so it can cancel the
    // sphere/cyborg placement before forwarding here (otherwise both
    // placement systems fire on the same click).

    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('click', this.onClick)
  }

  // External API used by Game to swap the active placement mode. Passing null
  // clears the selection and hides the ghost — call this when a sphere/cyborg
  // placement starts so a tower/wall doesn't drop on the same click.
  selectStructure(type: StructureType | null) {
    this.selectedType = type
    if (!type) this.hideGhost()
  }

private buildHitPlane(): THREE.Mesh {
    const W = Config.DEFENDER_MAX_X - Config.WORLD.LEFT   // 400
    const H = Config.WORLD.TOP - Config.WORLD.BOTTOM       // 400
    const geo = new THREE.PlaneGeometry(W, H)
    const mat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
    const plane = new THREE.Mesh(geo, mat)
    plane.position.set(-400, 0, 0.2)
    this.scene.add(plane)
    return plane
  }

  private getCell(event: MouseEvent): { col: number; row: number; wx: number; wy: number } | null {
    // Canvas sits below the HUD top strip. Keep in sync with Game.HUD_TOP_HEIGHT.
    const HUD_TOP = 210
    const canvasH = Math.max(1, window.innerHeight - HUD_TOP)
    this.mouse.x =  (event.clientX / window.innerWidth) * 2 - 1
    this.mouse.y = -((event.clientY - HUD_TOP) / canvasH) * 2 + 1
    this.raycaster.setFromCamera(this.mouse, this.camera)

    const hits = this.raycaster.intersectObject(this.hitPlane)
    if (!hits.length) return null

    const p = hits[0].point
    const col = Math.floor((p.x - Config.WORLD.LEFT)   / Config.GRID_CELL)
    const row = Math.floor((p.y - Config.WORLD.BOTTOM) / Config.GRID_CELL)
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null

    const wx = Config.WORLD.LEFT   + col * Config.GRID_CELL + Config.GRID_CELL / 2
    const wy = Config.WORLD.BOTTOM + row * Config.GRID_CELL + Config.GRID_CELL / 2
    return { col, row, wx, wy }
  }

  // Live occupancy check. Single source of truth — no Sets that can go
  // out of sync when structures are removed.
  private isCellBlocked(col: number, row: number): boolean {
    if (this.coreCells.has(`${col},${row}`)) return true
    for (const s of this.structures) {
      if (!s.isDead && s.col === col && s.row === row) return true
    }
    return this.externalOccupied(col, row)
  }

  private onMouseMove = (e: MouseEvent) => {
    if (!this.selectedType) { this.hideGhost(); return }
    const cell = this.getCell(e)
    if (cell && !this.isCellBlocked(cell.col, cell.row)) {
      this.showGhost(cell.wx, cell.wy)
    } else {
      this.hideGhost()
    }
  }

  private onClick = (e: MouseEvent) => {
    if (!this.selectedType) return
    const cell = this.getCell(e)
    if (!cell || this.isCellBlocked(cell.col, cell.row)) return

    const cost = Config.STRUCTURES[this.selectedType].cost
    if (this.credits < cost) return

    this.credits -= cost
    this.hud.setCredits(this.credits)
    this.structures.push(new Structure(this.scene, this.selectedType, cell.col, cell.row))
  }

  private showGhost(wx: number, wy: number) {
    if (!this.ghostMesh) {
      this.ghostMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(Config.GRID_CELL - 2, Config.GRID_CELL - 2),
        new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.25 })
      )
      this.ghostMesh.position.z = 0.4
      this.scene.add(this.ghostMesh)
    }
    this.ghostMesh.position.x = wx
    this.ghostMesh.position.y = wy
    this.updateFirePreview(wx, wy)
  }

  // Re-draw the wedge/circle overlay for the currently selected structure
  // type at (wx, wy). Walls/mines/signal don't fire — they get no overlay.
  private updateFirePreview(wx: number, wy: number) {
    const type = this.selectedType
    if (!type) { this.firePreview.hide(); return }
    const stats = Config.STRUCTURES[type]
    if (!stats || stats.range <= 0 || stats.ammo <= 0) { this.firePreview.hide(); return }
    // Mirrors Structure's fireFacings default — until the multi-arc UI ships,
    // every directional structure points east at placement time.
    this.firePreview.showWedge(wx, wy, stats.range, [0])
  }

  private hideGhost() {
    if (this.ghostMesh) {
      this.ghostMesh.removeFromParent()
      ;(this.ghostMesh.material as THREE.MeshBasicMaterial).dispose()
      this.ghostMesh.geometry.dispose()
      this.ghostMesh = null
    }
    this.firePreview.hide()
  }

  faceCamera(camera: THREE.Camera) {
    for (const s of this.structures) s.faceCamera(camera)
  }

  getCredits(): number { return this.credits }

  spendCredits(amount: number): boolean {
    if (this.credits < amount) return false
    this.credits -= amount
    this.hud.setCredits(this.credits)
    return true
  }

  addCredits(amount: number) {
    this.credits += amount
    this.hud.setCredits(this.credits)
  }

  getStructures(): Structure[] { return this.structures }

  cleanup() {
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('click', this.onClick)
    this.hideGhost()
    this.firePreview.hide()
    this.hitPlane.removeFromParent()
  }
}
