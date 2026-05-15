import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { Config, UnitType } from '../game/GameConfig'

// Tweak if Meshy model comes in wrong size or orientation
// Cyborg GLB is 1.65 units tall — scale 25 → ~41 world units tall
const MODEL_SCALE = 25
const MODEL_TILT_X = 0   // model faces camera; 0 = upright, PI/2 = flat on ground

type AnimName = 'idle' | 'running' | 'dead'

// Map gameplay state → clip name inside the merged animations.glb
const STATE_CLIP: Record<AnimName, string> = {
  idle: 'Idle',
  running: 'Running',
  dead: 'Dead',
}

// Module-level cache populated once by preload() and shared by every Unit.
const assets: {
  characterTemplate: THREE.Group | null
  clips: Map<string, THREE.AnimationClip>
  clipList: THREE.AnimationClip[]   // same clips, kept in file-order for the rotation test
} = {
  characterTemplate: null,
  clips: new Map(),
  clipList: [],
}

// Iterable list of all loaded clip objects for the rotation test mode in
// Game.ts. Returning objects (not names) so the label and the playback come
// from the exact same source — eliminates label/animation mismatch.
export function getAllAnimClips(): readonly THREE.AnimationClip[] {
  return assets.clipList
}
const loader = new GLTFLoader()

export class Unit {
  readonly mesh: THREE.Group
  hp: number
  readonly maxHp: number
  readonly type: UnitType
  isDead = false

  private bodyGroup: THREE.Group | null = null
  private mixer: THREE.AnimationMixer | null = null
  private hpBarGroup: THREE.Group
  private hpBarFill: THREE.Mesh
  private dyingTimer = 0
  private isDisposed = false

  // Logical position drives game logic; visual position lerps toward it
  private logicalX: number
  private logicalY: number
  private isMoving = false
  private readonly moveSpeedPS: number   // world units per second
  private currentAnim: AnimName = 'idle'
  // Persistent facing — written by move() and faceTarget(), re-applied
  // after each swapAnim so animation changes don't snap rotation back.
  private facingY = -Math.PI / 2
  // Optional override for the IDLE pose — set per-instance to test specific
  // animations (rotation test mode cycles through every loaded clip).
  // Running/dead still use their normal clips. Stored as the clip OBJECT
  // (not name) so playback and label can't drift apart.
  private testIdleClipObj: THREE.AnimationClip | null = null

  static async preload(): Promise<void> {
    // Load BOTH mesh and clips from the merged animations.glb. The separate
    // character.glb has a slightly different bind pose, which makes some
    // clips (Idle, Crouch_Pick_Gun) render at wrong scale / fragmented.
    await new Promise<void>(resolve => {
      loader.load(
        '/models/cyborg/animations.glb',
        gltf => {
          assets.characterTemplate = gltf.scene
          for (const clip of gltf.animations) {
            // Strip baked scale tracks (we control scale via MODEL_SCALE), and
            // strip Hips translation so root motion doesn't drift the unit off
            // its placed spot during test mode.
            clip.tracks = clip.tracks.filter(t =>
              !t.name.endsWith('.scale') && !t.name.startsWith('Hips.position')
            )
            assets.clips.set(clip.name, clip)
            assets.clipList.push(clip)
          }
          console.log('[Unit] loaded clips:', gltf.animations.map(c => c.name))
          resolve()
        },
        undefined,
        () => { console.warn('animations.glb missing — using fallback'); resolve() }
      )
    })
  }

  constructor(
    scene: THREE.Scene,
    type: UnitType,
    spawnX: number,
    spawnY?: number,
    testIdleClip?: THREE.AnimationClip
  ) {
    this.type = type
    this.hp = this.maxHp = Config.UNITS[type].hp
    this.moveSpeedPS = Config.UNITS[type].speed / Config.TURN_INTERVAL
    this.testIdleClipObj = testIdleClip ?? null

    const spread = Config.WORLD.TOP - Config.WORLD.BOTTOM - 40
    const y = spawnY ?? (Math.random() - 0.5) * spread

    this.logicalX = spawnX
    this.logicalY = y

    this.mesh = new THREE.Group()
    this.mesh.position.set(spawnX, y, 0)

    this.swapAnim('idle')
    if (testIdleClip) this.buildAnimLabel(testIdleClip.name)
    const { group, fill } = this.buildHpBar()
    this.hpBarGroup = group
    this.hpBarFill = fill
    scene.add(this.mesh)
  }

  faceCamera(camera: THREE.Camera) {
    this.hpBarGroup.quaternion.copy(camera.quaternion)
    // Also billboard the anim test label (if present)
    for (const c of this.mesh.children) {
      if (c.userData.isAnimLabel) c.quaternion.copy(camera.quaternion)
    }
  }

  // Rotate the model to face a world-space point. Mirrors the formula used
  // while moving (atan2 + π/2 to match the model's default -X facing).
  faceTarget(x: number, y: number) {
    const dx = x - this.logicalX
    const dy = y - this.logicalY
    if (dx * dx + dy * dy < 0.01) return
    this.facingY = Math.atan2(dy, dx) + Math.PI / 2
    if (this.bodyGroup) this.bodyGroup.rotation.y = this.facingY
  }

  // Where a projectile should leave from on this unit — a point a short
  // distance in front of the unit at chest height. Spawn-from-belly looks wrong.
  getMuzzlePoint(): { x: number; y: number } {
    const forward = this.facingY - Math.PI / 2   // inverse of faceTarget's offset
    return {
      x: this.logicalX + Math.cos(forward) * 22,
      y: this.logicalY + Math.sin(forward) * 22,
    }
  }

  // ── Public API for game logic ──────────────────────────────────────────────

  get worldX() { return this.logicalX }
  get worldY() { return this.logicalY }

  moveTo(x: number, y: number) {
    this.logicalX = x
    this.logicalY = y
    this.isMoving = true
    this.playAnim('running')
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
      this.kill()
    } else {
      this.flashHit()
    }
  }

  kill() {
    if (this.isDead) return
    this.isDead = true
    this.dyingTimer = 1.5
    this.isMoving = false
    this.swapAnim('dead')
  }

  get speed()    { return Config.UNITS[this.type].speed }
  get damage()   { return Config.UNITS[this.type].damage }
  get range()    { return Config.UNITS[this.type].range }
  get isScout()  { return this.type === 'scout' }
  get isBomber() { return this.type === 'bomber' }

  // ── Update ─────────────────────────────────────────────────────────────────

  update(delta: number) {
    this.mixer?.update(delta)

    // Smooth visual movement toward logical position
    if (this.isMoving) {
      const dx = this.logicalX - this.mesh.position.x
      const dy = this.logicalY - this.mesh.position.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const step = this.moveSpeedPS * delta
      if (step >= dist) {
        this.mesh.position.x = this.logicalX
        this.mesh.position.y = this.logicalY
        this.isMoving = false
        if (!this.isDead) this.playAnim('idle')
      } else {
        this.mesh.position.x += (dx / dist) * step
        this.mesh.position.y += (dy / dist) * step
      }

      // Rotate model to face movement direction
      if (dist > 0.1) {
        this.facingY = Math.atan2(dy, dx) + Math.PI / 2
        if (this.bodyGroup) this.bodyGroup.rotation.y = this.facingY
      }
    }

    // Body stays on ground — stop updating mixer after animation settles
    if (this.isDead && !this.isDisposed) {
      this.dyingTimer -= delta
      if (this.dyingTimer <= 0) {
        this.isDisposed = true  // stop ticking mixer; body stays in scene
      }
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private playAnim(name: AnimName) {
    if (this.currentAnim === name) return
    this.currentAnim = name
    this.swapAnim(name)
  }

  private swapAnim(name: AnimName) {
    if (this.bodyGroup) {
      this.mesh.remove(this.bodyGroup)
      this.bodyGroup = null
    }
    this.mixer = null

    if (!assets.characterTemplate) { this.buildFallback(); return }

    const clone = skeletonClone(assets.characterTemplate) as THREE.Group
    clone.scale.setScalar(MODEL_SCALE)
    clone.rotation.x = MODEL_TILT_X
    clone.rotation.y = this.facingY

    const emissive = new THREE.Color(Config.UNITS[this.type].color)
    clone.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        const mat = (obj.material as THREE.MeshStandardMaterial).clone()
        mat.emissive = emissive.clone()
        mat.emissiveIntensity = 0.35
        obj.material = mat
      }
    })

    this.bodyGroup = clone
    this.mesh.add(clone)

    // Pick the clip: test mode overrides only the idle pose. Test mode uses
    // the clip OBJECT directly so label and playback always match. Normal
    // gameplay still uses the name lookup against assets.clips.
    const clip = name === 'idle' && this.testIdleClipObj
      ? this.testIdleClipObj
      : assets.clips.get(STATE_CLIP[name])
    if (clip) {
      this.mixer = new THREE.AnimationMixer(clone)
      const action = this.mixer.clipAction(clip)
      if (name === 'dead') {
        action.clampWhenFinished = true
        action.loop = THREE.LoopOnce
      }
      action.play()
    }
  }

  // Small canvas-textured plane above the unit showing which animation clip
  // is being played. Used only in rotation test mode.
  private buildAnimLabel(text: string) {
    const canvas = document.createElement('canvas')
    canvas.width = 512; canvas.height = 64
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 36px monospace'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(text, canvas.width / 2, canvas.height / 2)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(72, 9),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    )
    plane.position.set(0, 64, 0)
    plane.userData.isAnimLabel = true
    this.mesh.add(plane)
  }

  private buildFallback() {
    const geo = new THREE.BoxGeometry(20, 26, 14)
    const mat = new THREE.MeshBasicMaterial({ color: Config.UNITS[this.type].color })
    const group = new THREE.Group()
    group.add(new THREE.Mesh(geo, mat))
    this.bodyGroup = group
    this.mesh.add(group)
  }

  private buildHpBar(): { group: THREE.Group; fill: THREE.Mesh } {
    // y=52 puts bar above the head (model head is at ~y=41 with MODEL_SCALE=25)
    const group = new THREE.Group()
    group.position.set(0, 52, 0)

    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 4),
      new THREE.MeshBasicMaterial({ color: 0xcc2222 })
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

  private flashHit() {
    if (!this.bodyGroup) return
    this.bodyGroup.traverse(obj => {
      if (!(obj instanceof THREE.Mesh)) return
      const mat = obj.material as THREE.MeshStandardMaterial
      if (!('emissive' in mat)) return
      const prev = mat.emissiveIntensity
      mat.emissive.setHex(0xff1100)
      mat.emissiveIntensity = 1.5
      setTimeout(() => {
        mat.emissive.setHex(new THREE.Color(Config.UNITS[this.type].color).getHex())
        mat.emissiveIntensity = prev
      }, 150)
    })
  }
}
