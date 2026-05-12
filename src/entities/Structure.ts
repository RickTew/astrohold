import * as THREE from 'three'
import { Config, StructureType } from '../game/GameConfig'

export class Structure {
  readonly mesh: THREE.Group
  hp: number
  readonly maxHp: number
  readonly type: StructureType
  readonly col: number
  readonly row: number
  private hpBarGroup!: THREE.Group
  private hpBar: THREE.Mesh

  constructor(scene: THREE.Scene, type: StructureType, col: number, row: number) {
    this.type = type
    this.col = col
    this.row = row
    this.hp = this.maxHp = Config.STRUCTURES[type].hp

    this.mesh = new THREE.Group()
    this.mesh.position.set(this.worldX, this.worldY, 0)
    this.hpBar = this.buildVisual()
    scene.add(this.mesh)
  }

  private buildVisual(): THREE.Mesh {
    switch (this.type) {
      case 'turret': {
        const body = new THREE.Mesh(
          new THREE.CylinderGeometry(8, 10, 14, 8),
          new THREE.MeshBasicMaterial({ color: 0x00aa44 })
        )
        this.mesh.add(body)
        const barrel = new THREE.Mesh(
          new THREE.BoxGeometry(4, 20, 4),
          new THREE.MeshBasicMaterial({ color: 0x007733 })
        )
        barrel.position.set(0, 17, 0)
        this.mesh.add(barrel)
        break
      }
      case 'cannon': {
        const body = new THREE.Mesh(
          new THREE.BoxGeometry(22, 20, 14),
          new THREE.MeshBasicMaterial({ color: 0x888888 })
        )
        this.mesh.add(body)
        const barrel = new THREE.Mesh(
          new THREE.BoxGeometry(6, 32, 6),
          new THREE.MeshBasicMaterial({ color: 0x555555 })
        )
        barrel.position.set(0, 22, 0)
        this.mesh.add(barrel)
        break
      }
      case 'wall': {
        this.mesh.add(new THREE.Mesh(
          new THREE.BoxGeometry(16, 48, 12),
          new THREE.MeshBasicMaterial({ color: 0x996633 })
        ))
        break
      }
      case 'mine': {
        this.mesh.add(new THREE.Mesh(
          new THREE.SphereGeometry(10, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xffcc00 })
        ))
        this.mesh.add(new THREE.Mesh(
          new THREE.TorusGeometry(14, 2, 6, 20),
          new THREE.MeshBasicMaterial({ color: 0xff6600 })
        ))
        break
      }
    }

    // HP bar — grouped so we can billboard the group to face the camera
    this.hpBarGroup = new THREE.Group()
    this.hpBarGroup.position.set(0, 34, 0)
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 5),
      new THREE.MeshBasicMaterial({ color: 0x222222 })
    )
    bg.position.z = 0.1
    this.hpBarGroup.add(bg)

    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 5),
      new THREE.MeshBasicMaterial({ color: 0x00cc44 })
    )
    fill.position.z = 0.2
    this.hpBarGroup.add(fill)
    this.mesh.add(this.hpBarGroup)
    return fill
  }

  faceCamera(camera: THREE.Camera) {
    this.hpBarGroup.quaternion.copy(camera.quaternion)
  }

  takeDamage(amount: number) {
    this.hp = Math.max(0, this.hp - amount)
    const ratio = this.hp / this.maxHp
    this.hpBar.scale.x = ratio
    this.hpBar.position.x = -(1 - ratio) * 20
    const mat = this.hpBar.material as THREE.MeshBasicMaterial
    mat.color.setHex(ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
    if (this.isDead) this.mesh.removeFromParent()
  }

  get isDead() { return this.hp <= 0 }
  get worldX() { return Config.WORLD.LEFT   + this.col * Config.GRID_CELL + Config.GRID_CELL / 2 }
  get worldY() { return Config.WORLD.BOTTOM + this.row * Config.GRID_CELL + Config.GRID_CELL / 2 }
  get range()        { return Config.STRUCTURES[this.type].range }
  get damage()       { return Config.STRUCTURES[this.type].damage }
  get fireInterval() { return Config.STRUCTURES[this.type].fireInterval }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        ;(obj.material as THREE.MeshBasicMaterial).dispose()
      }
    })
  }
}
