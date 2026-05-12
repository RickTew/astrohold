import * as THREE from 'three'
import { Config, StructureType } from './GameConfig'
import { Structure } from '../entities/Structure'
import { HUD } from '../ui/HUD'

const COLS = 8
const ROWS = 8  // 400 / 50 = 8 (world height changed from 700 to 400)

export class BuildPhase {
  private structures: Structure[] = []
  private occupied = new Set<string>()
  private selectedType: StructureType | null = null
  private credits: number

  private gridGroup: THREE.Group
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
    this.gridGroup = new THREE.Group()
    scene.add(this.gridGroup)

    const pcCol = Math.floor((Config.POWER_CORE.X - Config.WORLD.LEFT) / Config.GRID_CELL)
    const pcRow = Math.floor((Config.POWER_CORE.Y - Config.WORLD.BOTTOM) / Config.GRID_CELL)
    this.occupied.add(`${pcCol},${pcRow}`)

    this.hitPlane = this.buildHitPlane()
    this.buildGrid()

    hud.setCredits(this.credits)
    hud.onSelectStructure = (type) => { this.selectedType = type }

    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('click', this.onClick)
  }

  private buildGrid() {
    const mat = new THREE.LineBasicMaterial({ color: 0x1a3a55, transparent: true, opacity: 0.25 } as THREE.LineBasicMaterialParameters)
    for (let c = 0; c <= COLS; c++) {
      const x = Config.WORLD.LEFT + c * Config.GRID_CELL
      const pts = [
        new THREE.Vector3(x, Config.WORLD.BOTTOM, 0.3),
        new THREE.Vector3(x, Config.WORLD.TOP, 0.3),
      ]
      this.gridGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat))
    }
    for (let r = 0; r <= ROWS; r++) {
      const y = Config.WORLD.BOTTOM + r * Config.GRID_CELL
      const pts = [
        new THREE.Vector3(Config.WORLD.LEFT, y, 0.3),
        new THREE.Vector3(Config.DEFENDER_MAX_X, y, 0.3),
      ]
      this.gridGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat))
    }
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

  getStructures(): Structure[] { return this.structures }

  cleanup() {
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('click', this.onClick)
    this.hideGhost()
    this.gridGroup.removeFromParent()
    this.hitPlane.removeFromParent()
  }
}
