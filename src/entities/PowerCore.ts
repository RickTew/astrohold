import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Config } from '../game/GameConfig'

// Power Core = the base the defender is protecting. Three Meshy variants
// (plain / textured / super) are loaded at startup. Game.ts instantiates all
// three side-by-side so the user can compare without swapping.
//
// Per user feedback (session 9): we deliberately do NOT overwrite Meshy's
// materials with a procedural cyan emissive. That made the plain export
// render as a flat blue silhouette. Each variant now shows its honest output;
// only ambient overlays (point light + orbiting particles + slow Y rotation
// + pulse on whatever emissive the variant already has) are layered on top.

export type CoreVariant = 'plain' | 'textured' | 'super'

const MODELS: Record<CoreVariant, string> = {
  plain:    '/models/powercore/plain.glb',
  textured: '/models/powercore/textured.glb',
  super:    '/models/powercore/super.glb',
}

const TARGET_HEIGHT = 85
const ROTATION_RAD_PER_SEC = 0.18
const PARTICLE_COUNT = 10
const PARTICLE_RADIUS = TARGET_HEIGHT * 0.55

const templates: Partial<Record<CoreVariant, { scene: THREE.Group; scale: number }>> = {}

export async function preloadPowerCore(): Promise<void> {
  const loader = new GLTFLoader()
  await Promise.all((Object.keys(MODELS) as CoreVariant[]).map(key =>
    new Promise<void>((resolve) => {
      loader.load(
        MODELS[key],
        gltf => {
          const bbox = new THREE.Box3().setFromObject(gltf.scene)
          const size = new THREE.Vector3(); bbox.getSize(size)
          const native = size.y || 1
          templates[key] = { scene: gltf.scene, scale: TARGET_HEIGHT / native }
          resolve()
        },
        undefined,
        err => { console.warn(`[PowerCore] ${key} failed to load`, err); resolve() }
      )
    })
  ))
}

type MaterialBaseline = {
  mat: THREE.MeshStandardMaterial
  emissiveHex: number
  emissiveIntensity: number
}

interface Particle {
  mesh: THREE.Mesh
  angle: number
  angularSpeed: number
  yOffset: number
  yPhase: number
  yAmp: number
}

export class PowerCore {
  readonly mesh: THREE.Group
  readonly variant: CoreVariant
  hp: number
  readonly maxHp: number
  private hpBarGroup: THREE.Group
  private hpBar: THREE.Mesh
  private bodyGroup: THREE.Group | null = null
  private pointLight: THREE.PointLight
  private pulseTime = Math.random() * Math.PI * 2   // phase offset so showcase trio isn't synchronized
  private baselines: MaterialBaseline[] = []
  private particles: Particle[] = []
  private label: THREE.Mesh | null = null

  constructor(scene: THREE.Scene, variant: CoreVariant, x: number, y: number) {
    this.variant = variant
    this.hp = this.maxHp = Config.POWER_CORE.HP
    this.mesh = new THREE.Group()
    this.mesh.position.set(x, y, 0)

    this.pointLight = new THREE.PointLight(0x00aaff, 3.2, 220)
    this.pointLight.position.set(0, TARGET_HEIGHT * 0.5, 0)
    this.mesh.add(this.pointLight)

    this.buildParticles()

    this.hpBarGroup = new THREE.Group()
    this.hpBarGroup.position.set(0, TARGET_HEIGHT * 1.12, 0)
    const bgBar = new THREE.Mesh(
      new THREE.PlaneGeometry(70, 8),
      new THREE.MeshBasicMaterial({ color: 0xcc2222 })
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

    this.buildLabel(variant)

    this.installVariant()
    scene.add(this.mesh)
  }

  private installVariant() {
    const tpl = templates[this.variant]
    if (!tpl) { this.buildFallback(); return }

    const clone = tpl.scene.clone(true)
    clone.scale.setScalar(tpl.scale)

    // Capture per-material baselines so the pulse can multiply against the
    // variant's authored emissive, and so flashHit can restore exactly what
    // it changed. No material replacement — Meshy's output ships as-is.
    this.baselines = []
    clone.traverse(obj => {
      if (!(obj instanceof THREE.Mesh)) return
      const mat = obj.material as THREE.MeshStandardMaterial
      if (!mat || !('emissive' in mat)) return
      this.baselines.push({
        mat,
        emissiveHex: mat.emissive.getHex(),
        emissiveIntensity: mat.emissiveIntensity ?? 1,
      })
    })

    this.bodyGroup = clone
    this.mesh.add(clone)
  }

  // Small canvas-textured label above the HP bar so each showcase core is
  // identifiable from the screenshot. Billboards with the HP bar.
  private buildLabel(name: string) {
    const canvas = document.createElement('canvas')
    canvas.width = 256; canvas.height = 48
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#00ddff'
    ctx.font = 'bold 28px monospace'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(name.toUpperCase(), canvas.width / 2, canvas.height / 2)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 11),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    )
    plane.position.set(0, TARGET_HEIGHT * 1.05, 0)
    this.label = plane
    this.mesh.add(plane)
  }

  faceCamera(camera: THREE.Camera) {
    this.hpBarGroup.quaternion.copy(camera.quaternion)
    if (this.label) this.label.quaternion.copy(camera.quaternion)
  }

  takeDamage(amount: number) {
    this.hp = Math.max(0, this.hp - amount)
    const ratio = this.hp / this.maxHp
    this.hpBar.scale.x = ratio
    this.hpBar.position.x = -(1 - ratio) * 35
    const mat = this.hpBar.material as THREE.MeshBasicMaterial
    mat.color.setHex(ratio > 0.5 ? 0x00ff88 : ratio > 0.25 ? 0xffaa00 : 0xff2200)
    this.flashHit()
  }

  private flashHit() {
    this.pointLight.color.setHex(0xff2200)
    this.pointLight.intensity = 6
    for (const b of this.baselines) {
      b.mat.emissive.setHex(0xff2200)
      b.mat.emissiveIntensity = 2.5
    }
    setTimeout(() => {
      this.pointLight.color.setHex(0x00aaff)
      for (const b of this.baselines) {
        b.mat.emissive.setHex(b.emissiveHex)
        b.mat.emissiveIntensity = b.emissiveIntensity
      }
    }, 200)
  }

  private buildFallback() {
    const size = Config.POWER_CORE.RADIUS * 2.4
    const group = new THREE.Group()
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size * 0.75),
      new THREE.MeshStandardMaterial({ color: 0x335577, emissive: 0x00aaff, emissiveIntensity: 0.6 })
    )
    box.position.set(0, size / 2, 0)
    group.add(box)
    this.bodyGroup = group
    this.mesh.add(group)
  }

  private buildParticles() {
    const geo = new THREE.SphereGeometry(1.8, 6, 6)
    const mat = new THREE.MeshBasicMaterial({
      color: 0x66eeff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    })
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const m = new THREE.Mesh(geo, mat)
      m.renderOrder = 5
      this.mesh.add(m)
      this.particles.push({
        mesh: m,
        angle: (i / PARTICLE_COUNT) * Math.PI * 2,
        angularSpeed: 0.6 + Math.random() * 0.6,
        yOffset: TARGET_HEIGHT * (0.25 + Math.random() * 0.6),
        yPhase: Math.random() * Math.PI * 2,
        yAmp: 4 + Math.random() * 4,
      })
    }
  }

  get isDead() { return this.hp <= 0 }

  update(delta: number) {
    this.pulseTime += delta

    if (this.bodyGroup) this.bodyGroup.rotation.y += ROTATION_RAD_PER_SEC * delta

    // Pulse only multiplies baseline emissive. Plain export has 0 baseline →
    // no visible pulse on plain (honest output). Textured/super have authored
    // emissive → they breathe in their own colors.
    const pulse = 1 + Math.sin(this.pulseTime * 2.2) * 0.3
    for (const b of this.baselines) {
      b.mat.emissiveIntensity = b.emissiveIntensity * pulse
    }

    this.pointLight.intensity = 3.2 + Math.sin(this.pulseTime * 2.2) * 0.8

    for (const p of this.particles) {
      p.angle += p.angularSpeed * delta
      const x = Math.cos(p.angle) * PARTICLE_RADIUS
      const z = Math.sin(p.angle) * PARTICLE_RADIUS
      const y = p.yOffset + Math.sin(this.pulseTime * 2 + p.yPhase) * p.yAmp
      p.mesh.position.set(x, y, z)
    }
  }
}
