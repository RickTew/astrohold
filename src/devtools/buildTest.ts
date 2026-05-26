// Entry for the build-test sandbox page. Imports actual production
// classes so the previews never drift from what ships in-game. This is
// the answer to "if it can be built for the game, it can be built for
// the test page" - same code path, no mirror to keep in sync.
//
// Two mounts handled here:
//   • MINI CONTROL CENTER -> instantiate the production class, reparent
//     its floating host into the sandbox preview slot, override the
//     position so it sits inline instead of fixed bottom-right.
//   • SHIELD AURA -> import the shield-dome sprite factory, render it
//     into a tiny Three.js orthographic scene scoped to a single canvas.
//
// Other sandbox sections (HUD A/B, speech-bubble callouts, sound test,
// WIP gallery) keep their inline plain-JS so this file stays small.
//
// Loaded by build-test.html via:
//   <script type="module" src="/src/devtools/buildTest.ts"></script>

import * as THREE from 'three'
import { MiniControlCenter } from '../ui/MiniControlCenter'
import { makeShieldDomeSprite } from '../entities/Structure'

mountMiniControlCenter()
mountShieldAura()

// ── Mini Control Center ─────────────────────────────────────────────
// The MCC class appends a fixed-position div to document.body. For the
// sandbox we move that div into a host element and override the position
// so it renders inline inside the preview frame.

function mountMiniControlCenter() {
  const slot = document.getElementById('mcc-preview-host')
  if (!slot) return
  const mcc = new MiniControlCenter({
    onBattle: () => { /* no-op in sandbox */ },
    onPauseChange: () => { /* no-op in sandbox */ },
  })
  // setPhase('build') unhides the widget; without this it stays
  // display:none waiting for the game state machine.
  mcc.setPhase('build')

  // The class appends to body. Move the host element into our slot and
  // strip the fixed positioning so it lays out as a normal block. Keep
  // the visual size (240x240) which matches the in-game widget.
  const host = document.getElementById('mini-control-center') as HTMLElement | null
  if (!host) return
  slot.appendChild(host)
  host.style.position = 'relative'
  host.style.right = 'auto'
  host.style.bottom = 'auto'
  host.style.left = 'auto'
  host.style.top = 'auto'
  host.style.margin = '0 auto'
}

// ── Shield aura dome ────────────────────────────────────────────────
// Small Three.js scene that renders the same sprite production uses on
// the SHIELD structure. Scaled to fill a 280x280 canvas so the dome
// reads at sandbox size. Breathing pulse runs via RAF.

function mountShieldAura() {
  const slot = document.getElementById('shield-preview-host')
  if (!slot) return

  const W = 280
  const H = 280
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.style.width = `${W}px`
  canvas.style.height = `${H}px`
  canvas.style.display = 'block'
  slot.appendChild(canvas)

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  // Ortho camera sized so the sprite's natural 220 world-unit scale
  // (set inside makeShieldDomeSprite) fits with breathing room.
  const camera = new THREE.OrthographicCamera(-150, 150, 150, -150, 1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)

  const dome = makeShieldDomeSprite()
  // The production grow animation lerps the sprite scale from 0 to its
  // natural 220 over 2.5s. For the static sandbox preview we want the
  // settled state, so snap to the captured full scale here. The pulse
  // below modulates opacity, not scale, matching production.
  scene.add(dome)

  let t = 0
  function tick() {
    t += 1 / 60
    // Match the production breathing pulse from Structure.update():
    // opacity = 0.82 + 0.18 * sin(t * 2.0). No grow factor (settled).
    const k = 0.82 + 0.18 * Math.sin(t * 2.0)
    ;(dome.material as THREE.SpriteMaterial).opacity = k
    renderer.render(scene, camera)
    requestAnimationFrame(tick)
  }
  tick()
}
