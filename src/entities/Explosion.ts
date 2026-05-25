import * as THREE from 'three'

export class Explosion {
  private mesh: THREE.Mesh
  private time = 0
  isDone = false

  constructor(
    private scene: THREE.Scene,
    readonly x: number,
    readonly y: number,
    readonly radius: number,
    private duration = 0.5,
    color = 0xff6600,
  ) {
    const geo = new THREE.RingGeometry(0, radius, 24)
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.position.set(x, y, 1)
    scene.add(this.mesh)
  }

  update(delta: number) {
    this.time += delta
    const t = this.time / this.duration
    const mat = this.mesh.material as THREE.MeshBasicMaterial
    mat.opacity = Math.max(0, 1 - t)
    // S17.24: the ring stays at the radius it was constructed with
    // (matches the actual damage area). Previously the ring grew to
    // 1 + t * 1.5 = 2.5x its radius over the duration, so a 75-unit
    // damage area rendered as a 187-unit visual burst, making
    // explosions look much bigger than what actually took damage.
    // Now the visual is the same size as the damage area, just
    // fading from opacity 1 to 0.
    this.mesh.scale.setScalar(1)
    if (this.time >= this.duration) {
      this.isDone = true
      this.mesh.removeFromParent()
      this.mesh.geometry.dispose()
      mat.dispose()
    }
  }
}
