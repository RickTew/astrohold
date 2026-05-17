import * as THREE from 'three'
import { Config, StructureType } from './GameConfig'
import { Structure } from '../entities/Structure'
import { HUD } from '../ui/HUD'

const COLS = 8
const ROWS = 8  // 400 / 50 — used for placement bounds checking, not for any visible grid

export class BuildPhase {
  private structures: Structure[] = []
  private occupied = new Set<string>()
  private selectedType: StructureType | null = null
  private credits: number

  private hitPlane: THREE.Mesh
  private ghostMesh: THREE.Mesh | null = null

  private raycaster = new THREE.Raycaster()
  private mouse = new THREE.Vector2()

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    private hud: HUD,
    startCredits: number
  ) {
    this.credits = startCredits

    // Power Core has a 2x2 footprint. Its (X, Y) is the centroid (a grid
    // intersection), so the 4 cells are at (X ± 25, Y ± 25). Mark all four
    // as occupied so structures can't be placed underneath it.
    const half = Config.GRID_CELL / 2
    for (const cx of [Config.POWER_CORE.X - half, Config.POWER_CORE.X + half]) {
      for (const cy of [Config.POWER_CORE.Y - half, Config.POWER_CORE.Y + half]) {
        const c = Math.floor((cx - Config.WORLD.LEFT) / Config.GRID_CELL)
        const r = Math.floor((cy - Config.WORLD.BOTTOM) / Config.GRID_CELL)
        this.occupied.add(`${c},${r}`)
      }
    }

    this.hitPlane = this.buildHitPlane()

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
    this.mouse.x =  (event.clientX / window.innerWidth)  * 2 - 1
    this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1
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

  private onMouseMove = (e: MouseEvent) => {
    if (!this.selectedType) { this.hideGhost(); return }
    const cell = this.getCell(e)
    if (cell && !this.occupied.has(`${cell.col},${cell.row}`)) {
      this.showGhost(cell.wx, cell.wy)
    } else {
      this.hideGhost()
    }
  }

  private onClick = (e: MouseEvent) => {
    if (!this.selectedType) return
    const cell = this.getCell(e)
    if (!cell || this.occupied.has(`${cell.col},${cell.row}`)) return

    const cost = Config.STRUCTURES[this.selectedType].cost
    if (this.credits < cost) return

    this.credits -= cost
    this.hud.setCredits(this.credits)
    this.occupied.add(`${cell.col},${cell.row}`)
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
  }

  private hideGhost() {
    if (this.ghostMesh) {
      this.ghostMesh.removeFromParent()
      ;(this.ghostMesh.material as THREE.MeshBasicMaterial).dispose()
      this.ghostMesh.geometry.dispose()
      this.ghostMesh = null
    }
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
    this.hitPlane.removeFromParent()
  }
}
