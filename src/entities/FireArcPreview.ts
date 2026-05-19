import * as THREE from 'three'

// Visualizes a structure's fire arc + range underneath the placement ghost
// during BUILD phase. Two modes:
//   - Wedge:  one or more 120° pie slices at given facing angle(s). Towers,
//             bombers, gun/laser previews.
//   - Circle: full 360° disc. Sphere defender (omnidirectional).
//
// The mesh sits at z = 0.35 — above the ground (z=0) but below the green
// cell-ghost (z=0.4) so the ghost outline stays crisp on top. depthTest is
// disabled and renderOrder is forced to 1 so the wedge never disappears
// behind the terrain or fence sprites.

const WEDGE_HALF_RAD = (60 * Math.PI) / 180   // matches FIRE_ARC_HALF_RAD in RevealPhase
const COLOR_DEFENDER = 0x66ccff
const OPACITY = 0.18

export class FireArcPreview {
  private group: THREE.Group | null = null

  constructor(private scene: THREE.Scene) {}

  // Single-facing convenience — most structures ship with one facing today.
  showWedge(x: number, y: number, range: number, facings: readonly number[] = [0]) {
    this.replace(this.buildWedge(range, facings))
    this.group!.position.set(x, y, 0.35)
  }

  showCircle(x: number, y: number, range: number) {
    this.replace(this.buildCircle(range))
    this.group!.position.set(x, y, 0.35)
  }

  hide() {
    if (!this.group) return
    this.scene.remove(this.group)
    this.group.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose())
        else (obj.material as THREE.Material).dispose()
      }
    })
    this.group = null
  }

  private replace(group: THREE.Group) {
    this.hide()
    this.group = group
    this.scene.add(group)
  }

  private buildWedge(range: number, facings: readonly number[]): THREE.Group {
    const g = new THREE.Group()
    for (const facing of facings) {
      // CircleGeometry(radius, segments, thetaStart, thetaLength). thetaStart
      // is the angle of the FIRST radius; the wedge sweeps thetaLength radians
      // counter-clockwise. Centre the wedge on `facing` by offsetting back
      // half the arc width.
      const geom = new THREE.CircleGeometry(range, 48, facing - WEDGE_HALF_RAD, WEDGE_HALF_RAD * 2)
      const mat = new THREE.MeshBasicMaterial({
        color: COLOR_DEFENDER,
        transparent: true,
        opacity: OPACITY,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const wedge = new THREE.Mesh(geom, mat)
      wedge.renderOrder = 1
      g.add(wedge)

      // Outline along the two radial edges + the arc — same as the wedge but
      // line-only, so the edge of the firing cone reads clearly.
      const points: THREE.Vector3[] = []
      points.push(new THREE.Vector3(0, 0, 0))
      const start = facing - WEDGE_HALF_RAD
      const end   = facing + WEDGE_HALF_RAD
      const ARC_SEGMENTS = 24
      for (let i = 0; i <= ARC_SEGMENTS; i++) {
        const t = start + (end - start) * (i / ARC_SEGMENTS)
        points.push(new THREE.Vector3(Math.cos(t) * range, Math.sin(t) * range, 0))
      }
      points.push(new THREE.Vector3(0, 0, 0))
      const lineGeom = new THREE.BufferGeometry().setFromPoints(points)
      const lineMat = new THREE.LineBasicMaterial({
        color: COLOR_DEFENDER,
        transparent: true,
        opacity: 0.55,
        depthTest: false,
        depthWrite: false,
      })
      const line = new THREE.Line(lineGeom, lineMat)
      line.renderOrder = 2
      g.add(line)
    }
    return g
  }

  private buildCircle(range: number): THREE.Group {
    const g = new THREE.Group()
    const geom = new THREE.CircleGeometry(range, 64)
    const mat = new THREE.MeshBasicMaterial({
      color: COLOR_DEFENDER,
      transparent: true,
      opacity: OPACITY,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const disc = new THREE.Mesh(geom, mat)
    disc.renderOrder = 1
    g.add(disc)

    // Crisp outline ring at the range edge.
    const ringPts: THREE.Vector3[] = []
    const RING_SEGMENTS = 64
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const t = (i / RING_SEGMENTS) * Math.PI * 2
      ringPts.push(new THREE.Vector3(Math.cos(t) * range, Math.sin(t) * range, 0))
    }
    const ringGeom = new THREE.BufferGeometry().setFromPoints(ringPts)
    const ringMat = new THREE.LineBasicMaterial({
      color: COLOR_DEFENDER,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
      depthWrite: false,
    })
    const ring = new THREE.Line(ringGeom, ringMat)
    ring.renderOrder = 2
    g.add(ring)
    return g
  }
}
