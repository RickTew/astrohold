import * as THREE from 'three'

// ─── Background ───────────────────────────────────────────────────────────────

export class Background {
  private group: THREE.Group

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group()
    this.buildGround()
    this.buildZoneOverlays()
    scene.add(this.group)
  }

  private buildGround() {
    // DUSTY PLANET surface (Vector-Grid Pixel Hybrid style). Pure
    // procedural gradient. No Perlin noise, no specks, no crack lines.
    // The visual style guide calls for vector-clean floors that let
    // pixel sprites pop off the surface. See docs/VISUAL_STYLE.md.
    //
    // Three layered gradients on a single canvas:
    //   1. Base vertical fade from lighter sand-tan to darker.
    //   2. Soft warm-light pool top-left (sun bias).
    //   3. Soft warm pool bottom-right (atmospheric depth).
    //
    // 1024x512 canvas is enough resolution for smooth gradients on a
    // 4000x4000 world plane; no detail to alias since it's all
    // continuous color.
    const W = 1024
    const H = 512
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!

    // Base vertical gradient (the Dusty Planet color stops match the
    // FLOOR COLOR LAB variant 2 in build-test.html).
    const base = ctx.createLinearGradient(0, 0, 0, H)
    base.addColorStop(0, '#4a3e2e')
    base.addColorStop(1, '#322820')
    ctx.fillStyle = base
    ctx.fillRect(0, 0, W, H)

    // Warm sun-light pool from the upper-left.
    const sun = ctx.createRadialGradient(
      W * 0.25, H * 0.20, 0,
      W * 0.25, H * 0.20, Math.min(W, H) * 0.85,
    )
    sun.addColorStop(0, 'rgba(255, 220, 170, 0.22)')
    sun.addColorStop(1, 'rgba(255, 220, 170, 0)')
    ctx.fillStyle = sun
    ctx.fillRect(0, 0, W, H)

    // Soft warm pool toward the lower-right for atmospheric depth.
    const pool = ctx.createRadialGradient(
      W * 0.80, H * 0.80, 0,
      W * 0.80, H * 0.80, Math.min(W, H) * 0.7,
    )
    pool.addColorStop(0, 'rgba(180, 130, 90, 0.15)')
    pool.addColorStop(1, 'rgba(180, 130, 90, 0)')
    ctx.fillStyle = pool
    ctx.fillRect(0, 0, W, H)

    const texture = new THREE.CanvasTexture(canvas)
    texture.wrapS = THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    // Smooth filtering since this is continuous gradient, not pixel art.
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter

    const geo = new THREE.PlaneGeometry(4000, 4000)
    const mat = new THREE.MeshBasicMaterial({ map: texture })
    const plane = new THREE.Mesh(geo, mat)
    plane.position.z = -6
    this.group.add(plane)
  }

  private buildZoneOverlays() {
    const H = 4000

    // Defender zone — subtle blue tint
    const defMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(400, H),
      new THREE.MeshBasicMaterial({ color: 0x001133, transparent: true, opacity: 0.12 })
    )
    defMesh.position.set(-400, 0, -4)
    this.group.add(defMesh)

    // Attacker zone — subtle red tint
    const attMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(400, H),
      new THREE.MeshBasicMaterial({ color: 0x220000, transparent: true, opacity: 0.12 })
    )
    attMesh.position.set(400, 0, -4)
    this.group.add(attMesh)

    // Zone divider lines
    const lineMat = new THREE.LineBasicMaterial({ color: 0x334455 })
    const mkLine  = (pts: THREE.Vector3[]) =>
      new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat)

    this.group.add(mkLine([new THREE.Vector3(-200, -2000, -3), new THREE.Vector3(-200, 2000, -3)]))
    this.group.add(mkLine([new THREE.Vector3( 200, -2000, -3), new THREE.Vector3( 200, 2000, -3)]))
  }

  dispose() {
    this.group.traverse(obj => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points || obj instanceof THREE.Line) {
        obj.geometry.dispose()
        const m = obj.material
        if (Array.isArray(m)) m.forEach(x => x.dispose())
        else m.dispose()
      }
    })
  }
}
