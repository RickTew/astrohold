import * as THREE from 'three'

export class SphereDefender {
  worldX = -350
  worldY = 0
  hp: number
  readonly maxHp = 300
  isDead = false
  readonly range = 200
  readonly damage = 10

  private hpBarGroup: THREE.Group
  private hpBarFill: THREE.Mesh

  constructor(private scene: THREE.Scene, readonly mesh: THREE.Group) {
    this.hp = this.maxHp
    const { group, fill } = this.buildHpBar()
    this.hpBarGroup = group
    this.hpBarFill = fill
  }

  faceCamera(camera: THREE.Camera) {
    this.hpBarGroup.quaternion.copy(camera.quaternion)
  }

  takeDamage(amount: number) {
    if (this.isDead) return
    this.hp = Math.max(0, this.hp - amount)
    const ratio = this.hp / this.maxHp
    this.hpBarFill.scale.x = ratio
    this.hpBarFill.position.x = -(1 - ratio) * 15
    const mat = this.hpBarFill.material as THREE.MeshBasicMaterial
    mat.color.setHex(ratio > 0.5 ? 0x00cc44 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
    if (this.hp <= 0) {
      this.isDead = true
      this.mesh.visible = false
    }
  }

  private buildHpBar(): { group: THREE.Group; fill: THREE.Mesh } {
    const group = new THREE.Group()
    group.position.set(0, 30, 0)

    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 4),
      new THREE.MeshBasicMaterial({ color: 0x222222 })
    )
    bg.position.z = 0.1
    group.add(bg)

    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 4),
      new THREE.MeshBasicMaterial({ color: 0x00cc44 })
    )
    fill.position.z = 0.2
    group.add(fill)

    this.mesh.add(group)
    return { group, fill }
  }
}
