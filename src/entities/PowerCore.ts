import * as THREE from 'three'
import { Config } from '../game/GameConfig'

export class PowerCore {
  readonly mesh: THREE.Group
  hp: number
  readonly maxHp: number
  private hpBarGroup: THREE.Group
  private hpBar: THREE.Mesh
  private coreMesh: THREE.Mesh
  private ring1: THREE.Mesh
  private ring2Container: THREE.Group
  private pulseTime = 0

  constructor(scene: THREE.Scene) {
    this.hp = this.maxHp = Config.POWER_CORE.HP
    this.mesh = new THREE.Group()
    this.mesh.position.set(Config.POWER_CORE.X, Config.POWER_CORE.Y, 0)

    // Point light — actual 3D illumination on surroundings
    const light = new THREE.PointLight(0x00aaff, 4, 140)
    this.mesh.add(light)

    // Ring 1 — in XY plane, spins around Z
    const ringGeo1 = new THREE.TorusGeometry(Config.POWER_CORE.RADIUS + 10, 3, 8, 48)
    const ringMat1 = new THREE.MeshStandardMaterial({
      color: 0x00aadd,
      emissive: new THREE.Color(0x005577),
      emissiveIntensity: 1.1,
    })
    this.ring1 = new THREE.Mesh(ringGeo1, ringMat1)
    this.mesh.add(this.ring1)

    // Ring 2 — perpendicular to ring 1 (in YZ plane), spins around its own Z
    const ringGeo2 = new THREE.TorusGeometry(Config.POWER_CORE.RADIUS + 10, 3, 8, 48)
    const ringMat2 = new THREE.MeshStandardMaterial({
      color: 0x0066ff,
      emissive: new THREE.Color(0x002288),
      emissiveIntensity: 1.1,
    })
    this.ring2Container = new THREE.Group()
    this.ring2Container.rotation.y = Math.PI / 2  // stand it perpendicular to ring 1
    const ring2Mesh = new THREE.Mesh(ringGeo2, ringMat2)
    this.ring2Container.add(ring2Mesh)
    this.mesh.add(this.ring2Container)

    // Core — octahedron crystal (angular and clearly 3D from any camera angle)
    const coreGeo = new THREE.OctahedronGeometry(Config.POWER_CORE.RADIUS * 0.85, 0)
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x00ffee,
      emissive: new THREE.Color(0x00bbaa),
      emissiveIntensity: 2.0,
      roughness: 0.1,
      metalness: 0.4,
    })
    this.coreMesh = new THREE.Mesh(coreGeo, coreMat)
    this.mesh.add(this.coreMesh)

    // HP bar — billboarded to face camera each frame (faceCamera method)
    this.hpBarGroup = new THREE.Group()
    this.hpBarGroup.position.set(0, 44, 0)
    const bgBar = new THREE.Mesh(
      new THREE.PlaneGeometry(70, 8),
      new THREE.MeshBasicMaterial({ color: 0x222222 })
    )
    bgBar.position.z = 0.1
    this.hpBarGroup.add(bgBar)
    this.hpBar = new THREE.Mesh(
      new THREE.PlaneGeometry(70, 8),
      new THREE.MeshBasicMaterial({ color: 0x00ff88 })
    )
    this.hpBar.position.z = 0.2
    this.hpBarGroup.add(this.hpBar)
    this.mesh.add(this.hpBarGroup)

    scene.add(this.mesh)
  }

  faceCamera(camera: THREE.Camera) {
    this.hpBarGroup.quaternion.copy(camera.quaternion)
  }

  takeDamage(amount: number) {
    this.hp = Math.max(0, this.hp - amount)
    const ratio = this.hp / this.maxHp
    this.hpBar.scale.x = ratio
    this.hpBar.position.x = -(1 - ratio) * 35
    const mat = this.hpBar.material as THREE.MeshBasicMaterial
    mat.color.setHex(ratio > 0.5 ? 0x00ff88 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
    this.flashCore()
  }

  private flashCore() {
    const mat = this.coreMesh.material as THREE.MeshStandardMaterial
    const savedHex = mat.emissive.getHex()
    mat.emissive.setHex(0xff2200)
    mat.emissiveIntensity = 3.5
    setTimeout(() => {
      mat.emissive.setHex(savedHex)
      mat.emissiveIntensity = 2.0
    }, 200)
  }

  get isDead() { return this.hp <= 0 }

  update(delta: number) {
    this.pulseTime += delta
    this.ring1.rotation.z += delta * 0.8
    this.ring2Container.rotation.z += delta * -0.5   // opposite direction
    this.coreMesh.rotation.y += delta * 0.4           // tumbling crystal
    this.coreMesh.rotation.x += delta * 0.25
    const mat = this.coreMesh.material as THREE.MeshStandardMaterial
    mat.emissiveIntensity = 1.8 + Math.sin(this.pulseTime * 3.5) * 0.4
  }
}
