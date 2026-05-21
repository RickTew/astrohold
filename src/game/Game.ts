import * as THREE from 'three'
import { Config, StructureType, UnitType } from './GameConfig'
import { Background } from '../scene/Background'
import { PixelPowerCore, preloadPixelPowerCore } from '../entities/PixelPowerCore'
import { SphereDefender, preloadSphereSprites } from '../entities/SphereDefender'
import { SpriteUnit, preloadSpriteUnit } from '../entities/SpriteUnit'
import { HUD } from '../ui/HUD'
import { BuildPhase } from './BuildPhase'
import { PlanningPhase } from './PlanningPhase'
import { RevealPhase } from './RevealPhase'
import { Structure, preloadStructureSprites } from '../entities/Structure'
import { PendingGrenade } from '../entities/PendingGrenade'
import { FireArcPreview } from '../entities/FireArcPreview'
import { OpponentAI, OpponentSide } from '../ai/OpponentAI'

type Phase = 'loading' | 'pick-side' | 'build' | 'planning' | 'reveal' | 'win' | 'lose'

// Unified placement session — covers both cyborg and sphere placement.
// Ghost mesh is the authoritative position; never re-raycast at click time.
// onPlace returns true to end the session (single-shot), false to stay
// in placement mode (multi-place).
type PlacementKind = 'sphere' | UnitType
type PlacementSession = {
  kind: PlacementKind
  ghost: THREE.Mesh
  tint: THREE.Mesh | null
  zoneXMin: number
  zoneXMax: number
  // How far the entity center must stay from world Y edges so the visual
  // fits inside the zone (sphere is taller than cyborg, asymmetric).
  marginTop: number
  marginBottom: number
  onPlace: (x: number, y: number) => boolean
  onEnd?: () => void
}

const SPHERE_COST = 100

export class Game {
  private scene: THREE.Scene
  private camera: THREE.OrthographicCamera
  private renderer: THREE.WebGLRenderer
  private rafId = 0
  private lastTime = 0
  private phase: Phase = 'loading'

  private background!: Background
  private powerCore!: PixelPowerCore
  private hud!: HUD
  private buildPhase: BuildPhase | null = null
  private planningPhase: PlanningPhase | null = null
  private revealPhase: RevealPhase | null = null
  // All attackers are pixel sprites now (the 3D Meshy cyborg was retired).
  private attackerUnits: SpriteUnit[] = []
  // Defender-side mobile units (combat dogs today). Separate from spheres
  // (stationary) and structures.
  private defenderUnits: SpriteUnit[] = []
  // Structures are owned by Game after the Build phase tears down — Planning
  // and Reveal both read from this array across turns.
  private structures: Structure[] = []

  private attCredits = Config.START_CREDITS
  private attZoneMesh: THREE.LineSegments | null = null
  private defZoneMesh: THREE.LineSegments | null = null

  // Multi-sphere: now sprite-based (8 directional pixel-art PNGs, ~24 KB total
  // instead of the 60 MB GLB). Pre-loaded in preloadSphereSprites().
  private spheres: SphereDefender[] = []

  // Grenades that landed last reveal — detonated at the start of the next one.
  // Owned by Game (survives RevealPhase instances) and passed by reference so
  // each new reveal sees + clears + grows the same array.
  private pendingGrenades: PendingGrenade[] = []
  // Tracks reveals in a row that had zero combat events (no shots, no bombs,
  // no diffuses). After NO_PROGRESS_LIMIT consecutive idle reveals, the
  // auto-loop halts with a stalemate — prevents the "robot dog wanders
  // forever while everyone else is out of ammo" lockup.
  private noProgressReveals = 0
  // Monotonic counter for the combat-history log. First reveal after PLAN
  // is Turn 1; auto-chained reveals bump from there. Never reset within a
  // game — Play Again is a full reload.
  private revealTurn = 1

  // Single-player mode: the player picks one side at load; the other side
  // runs on autopilot via OpponentAI. Set after the side picker resolves.
  private playerSide: OpponentSide | null = null
  private opponentAI: OpponentAI | null = null

  // Single source of truth for any active placement.
  private placement: PlacementSession | null = null
  // Range/arc overlay shown beneath the sphere placement ghost so the player
  // can see how much of the field one sphere covers before committing. Reused
  // — created once, show/hide as the placement session starts/ends.
  private placementArcPreview!: FireArcPreview
  // Compass-rose state — set when the player shift+clicks a placed firing
  // structure during BUILD. The rose's DOM lives in the HUD; Game owns the
  // structure reference + arc overlay that mirrors its fireFacings array.
  private editingStructure: Structure | null = null

  // Camera pan/zoom state
  private isPanning = false
  private lastPan = { x: 0, y: 0 }
  private zoomVelocity = 0

  constructor(private canvas: HTMLCanvasElement) {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x201b14)  // matches terrain darkest tone
    this.placementArcPreview = new FireArcPreview(this.scene)

    const halfH = 600 / (window.innerWidth / window.innerHeight)
    this.camera = new THREE.OrthographicCamera(-600, 600, halfH, -halfH, 1, 1500)
    // Top-down view — square grid cells project as on-screen squares. Sprites
    // are billboarded so they still face the camera with the same image.
    this.camera.position.set(0, 0, 500)
    this.camera.lookAt(0, 0, 0)

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)

    window.addEventListener('resize', this.onResize)
    window.addEventListener('wheel', this.onWheel, { passive: false })
    window.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('contextmenu', this.onContextMenu)
  }

  async init() {
    this.background = new Background(this.scene)
    this.hud = new HUD()

    // Block UI until all sprite atlases are ready so placements never show the
    // swap from fallback geometry to final sprite.
    await Promise.all([
      preloadSphereSprites(),
      preloadSpriteUnit('cannon', 'cannon'),
      preloadSpriteUnit('grenadier', 'grenadier'),
      preloadSpriteUnit('doublegun', 'doublegun'),
      preloadSpriteUnit('dog', 'dog'),
      preloadSpriteUnit('hulk', 'hulk'),
      preloadSpriteUnit('sniper', 'sniper'),
      preloadPixelPowerCore(),
      preloadStructureSprites(),
    ])

    // Pixel power core — 2x2 footprint stays at 100 world units of cell
    // occupancy, but the sprite renders at GRID_CELL * 3 (= 150) so it reads
    // as the dominant objective piece. Sprite overflows the footprint
    // visually — fine, it's billboard-only.
    this.powerCore = new PixelPowerCore(this.scene, Config.POWER_CORE.X, Config.POWER_CORE.Y, Config.GRID_CELL * 3)

    // Map-wide strategy grid. Game is shifting toward chess-like turn-based
    // play with one piece per square (see docs/STATS.md). The grid makes the
    // playable cells visible so positioning is obvious during build phase.
    this.scene.add(this.makeMapGrid())

    this.hud.showGame()
    this.enterPickSide()
  }

  // After loading, the player chooses which team to play. The other team is
  // handed off to OpponentAI. Game.enterBuildPhase fires only after a side
  // is committed so the AI can take its first BUILD turn alongside the player.
  private enterPickSide() {
    this.phase = 'pick-side'
    this.hud.onPickSide = (side) => this.onSidePicked(side)
    this.hud.showSidePicker()
  }

  private onSidePicked(side: OpponentSide) {
    if (this.playerSide) return  // re-entry guard
    this.playerSide = side
    const aiSide: OpponentSide = side === 'defender' ? 'attacker' : 'defender'
    this.opponentAI = new OpponentAI(aiSide, this.aiApi(aiSide))
    this.hud.setPlayerSide(side)
    this.enterBuildPhase()
  }

  // Build the AI's spend-and-spawn API. `side` is the AI's side (the OPPOSITE
  // of playerSide). All credit access routes through the canonical source for
  // that side — BuildPhase for defenders, Game.attCredits for attackers.
  private aiApi(side: OpponentSide) {
    return {
      getCredits: () => side === 'defender'
        ? (this.buildPhase?.getCredits() ?? 0)
        : this.attCredits,
      spendCredits: (amount: number): boolean => {
        if (side === 'defender') return this.buildPhase?.spendCredits(amount) ?? false
        if (this.attCredits < amount) return false
        this.attCredits -= amount
        this.hud.setAttCredits(this.attCredits)
        return true
      },
      spawnSphere: (x: number, y: number) => this.aiSpawnSphere(x, y),
      spawnDefenderUnit: (type: UnitType, x: number, y: number) =>
        this.aiSpawnDefenderUnit(type, x, y),
      spawnAttackerUnit: (type: UnitType, x: number, y: number) =>
        this.aiSpawnAttackerUnit(type, x, y),
      spawnStructure: (type: StructureType, col: number, row: number) =>
        this.aiSpawnStructure(type, col, row),
      isCellOccupied: (x: number, y: number) => this.isCellOccupied(x, y),
    }
  }

  // AI spawn primitives — mouse-free counterparts to the placement system.
  // All include a final occupancy check so the AI can never double-place a
  // cell even if its scoring function got something wrong.
  private aiSpawnSphere(x: number, y: number): boolean {
    if (!this.buildPhase) return false
    if (this.isCellOccupied(x, y)) return false
    if (!this.buildPhase.spendCredits(SPHERE_COST)) return false
    this.spheres.push(new SphereDefender(this.scene, x, y))
    return true
  }
  private aiSpawnDefenderUnit(type: UnitType, x: number, y: number): boolean {
    if (!this.buildPhase) return false
    if (this.isCellOccupied(x, y)) return false
    const cost = Config.UNITS[type]?.cost ?? 0
    if (!this.buildPhase.spendCredits(cost)) return false
    this.defenderUnits.push(new SpriteUnit(this.scene, type, x, y, 'defender'))
    return true
  }
  private aiSpawnAttackerUnit(type: UnitType, x: number, y: number): boolean {
    if (this.isCellOccupied(x, y)) return false
    const cost = Config.UNITS[type]?.cost ?? 0
    if (this.attCredits < cost) return false
    this.attCredits -= cost
    this.hud.setAttCredits(this.attCredits)
    this.attackerUnits.push(new SpriteUnit(this.scene, type, x, y))
    return true
  }
  private aiSpawnStructure(type: StructureType, col: number, row: number): boolean {
    if (!this.buildPhase) return false
    const cell = Config.GRID_CELL
    const x = Config.WORLD.LEFT   + col * cell + cell / 2
    const y = Config.WORLD.BOTTOM + row * cell + cell / 2
    if (this.isCellOccupied(x, y)) return false
    const cost = Config.STRUCTURES[type]?.cost ?? 0
    if (!this.buildPhase.spendCredits(cost)) return false
    this.buildPhase.getStructures().push(new Structure(this.scene, type, col, row))
    return true
  }

  private makeMapGrid(): THREE.LineSegments {
    const verts: number[] = []
    const left = Config.WORLD.LEFT
    const right = Config.WORLD.RIGHT
    const top = Config.WORLD.TOP
    const bottom = Config.WORLD.BOTTOM
    const cell = Config.GRID_CELL
    const z = 0.3   // just below fence borders (z=0.4), above terrain
    // Vertical lines
    for (let x = left; x <= right + 0.5; x += cell) {
      verts.push(x, bottom, z, x, top, z)
    }
    // Horizontal lines
    for (let y = bottom; y <= top + 0.5; y += cell) {
      verts.push(left, y, z, right, y, z)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    // Cool blue-gray contrasts against the warm brown dirt; higher opacity so
    // every cell boundary reads clearly.
    const mat = new THREE.LineBasicMaterial({
      color: 0xaabbcc, transparent: true, opacity: 0.55,
    })
    return new THREE.LineSegments(geo, mat)
  }

private enterBuildPhase() {
    this.phase = 'build'
    this.attackerUnits = []
    this.defenderUnits = []
    this.attCredits = Config.START_CREDITS
    this.hud.setPhase('build')
    this.hud.setAttCredits(this.attCredits)
    this.buildPhase = new BuildPhase(
      this.scene, this.camera, this.hud, Config.START_CREDITS,
      // Cross-system occupancy: structures must respect existing
      // spheres/cyborgs/core, which BuildPhase doesn't track.
      (col, row) => {
        const x = Config.WORLD.LEFT   + col * Config.GRID_CELL + Config.GRID_CELL / 2
        const y = Config.WORLD.BOTTOM + row * Config.GRID_CELL + Config.GRID_CELL / 2
        return this.isCellOccupied(x, y)
      },
    )

    // Thin fence borders mark each zone without covering sprites.
    this.defZoneMesh = this.makeZoneBorder(
      Config.WORLD.LEFT, Config.DEFENDER_MAX_X, 0x00ddff
    )
    this.attZoneMesh = this.makeZoneBorder(
      Config.ATTACKER_MIN_X, Config.WORLD.RIGHT, 0xff4488
    )

    this.hud.onBuySphere = () => {
      if (this.placement?.kind === 'sphere') { this.endPlacement(); return }
      if (!this.buildPhase || this.buildPhase.getCredits() < SPHERE_COST) return
      // Cancel any active structure selection so its click handler doesn't
      // fire alongside the sphere placement.
      this.buildPhase?.selectStructure(null)
      this.hud.clearStructureSelection()
      this.startSpherePlacement()
    }

    this.hud.onBuyDog = () => {
      if (this.placement?.kind === 'dog') { this.endPlacement(); return }
      const cost = Config.UNITS.dog.cost
      if (!this.buildPhase || this.buildPhase.getCredits() < cost) return
      this.buildPhase?.selectStructure(null)
      this.hud.clearStructureSelection()
      this.startDogPlacement()
    }

    // Build's "READY" button opens the planning phase (first turn).
    this.hud.onBattle = () => this.enterPlanningPhase()

    this.hud.onSpawnUnit = (type) => {
      if (this.placement?.kind === type) { this.endPlacement(); return }
      this.buildPhase?.selectStructure(null)
      this.hud.clearStructureSelection()
      this.startCyborgPlacement(type)
    }

    // Structure selection — cancel any active sphere/cyborg placement first
    // so both systems don't fire on the same click.
    this.hud.onSelectStructure = (type) => {
      this.endPlacement()
      this.buildPhase?.selectStructure(type)
    }

    // Compass-rose: clicking a cardinal direction buys an extra fire arc on
    // the currently-edited structure. Credits are charged here, the rose UI
    // re-renders to reflect the new facing, and the arc overlay updates.
    this.hud.onAddFacing = (angle) => this.tryBuyFacing(angle)
    // Rose Refund button: tear down the editing structure and reimburse its
    // base cost (extra-facing spend is sunk by design).
    this.hud.onRefundStructure = () => this.refundEditingStructure()
    // Rose closed by any means (X button, document-level outside click,
    // explicit Game-side close). Clear the editing structure + arc preview.
    this.hud.onRoseClose = () => {
      this.editingStructure = null
      this.placementArcPreview.hide()
    }

    // Hand the AI side its BUILD turn now that credits + structure storage
    // are wired. Runs once per game (BUILD is one-shot in this chess flow).
    this.opponentAI?.runBuildTurn()
    // Hide everything the AI just placed — the player must not see opponent
    // pieces (or credits, handled in HUD) until BATTLE plays out. Re-shown
    // at the start of enterRevealPhase.
    this.setAiPiecesVisible(false)
    // Log opponent activity (intentionally vague — no count, no pieces).
    if (this.opponentAI) {
      this.hud.logSystemMessage('Opponent has deployed forces. Position: REDACTED.', 'ai')
    }
  }

  // Show/hide every piece on the AI's side of the field. Called with false
  // after the AI's BUILD turn and true at the start of the first REVEAL.
  // No-op if the player picked no side yet.
  private setAiPiecesVisible(visible: boolean) {
    if (!this.playerSide) return
    const aiSide: OpponentSide = this.playerSide === 'defender' ? 'attacker' : 'defender'
    if (aiSide === 'attacker') {
      for (const u of this.attackerUnits) u.mesh.visible = visible
    } else {
      for (const u of this.defenderUnits) u.mesh.visible = visible
      for (const s of this.spheres)       s.mesh.visible = visible
      // Structures live on BuildPhase before reveal, on Game.structures after.
      const structs = this.buildPhase?.getStructures() ?? this.structures
      for (const st of structs) st.mesh.visible = visible
    }
  }

  // Compass-rose purchase. Returns true on success. Silently rejects if the
  // facing already exists, the structure went away, or credits ran out (the
  // unaffordable styling already greys those buttons, but defend anyway).
  private tryBuyFacing(angle: number): boolean {
    const s = this.editingStructure
    if (!s || s.isDead) { this.closeCompassRose(); return false }
    if (!this.buildPhase) { this.closeCompassRose(); return false }
    const cost = Config.EXTRA_FACING_COST
    if (this.buildPhase.getCredits() < cost) return false
    const added = s.addFacing(angle)
    if (!added) return false
    this.buildPhase.spendCredits(cost)
    this.refreshEditingArcPreview()
    this.hud.refreshCompassRose({
      name: this.structureDisplayLabel(s),
      activeFacings: s.fireFacings,
      cost,
      credits: this.buildPhase.getCredits(),
    })
    return true
  }

  // Open the compass rose for a placed structure during BUILD. Skipped for
  // walls / mines / signal (no firing) and any preview pieces that won't
  // actually shoot. Anchored at the structure's screen-projected coords.
  // Cancels any active sphere/dog/cyborg placement AND the structure shop
  // selection so the rose is a focused edit mode — clicks while it's open
  // won't accidentally drop a new piece in the background.
  private openCompassRose(s: Structure) {
    const stats = Config.STRUCTURES[s.type]
    if (!stats || stats.range <= 0 || stats.ammo <= 0) return
    this.endPlacement()
    this.buildPhase?.selectStructure(null)
    this.hud.clearStructureSelection()
    const screen = this.worldToScreen(s.worldX, s.worldY)
    // showCompassRose internally hides any previous rose; that hide fires
    // onRoseClose which would zero out editingStructure. So set the field
    // AFTER showCompassRose finishes.
    this.hud.showCompassRose(screen.x, screen.y, {
      name: this.structureDisplayLabel(s),
      activeFacings: s.fireFacings,
      cost: Config.EXTRA_FACING_COST,
      credits: this.buildPhase?.getCredits() ?? 0,
    })
    this.editingStructure = s
    this.refreshEditingArcPreview()
  }

  private closeCompassRose() {
    if (!this.editingStructure && !this.hud.isCompassRoseOpen()) return
    this.hud.hideCompassRose()
    // hideCompassRose fires onRoseClose which clears editingStructure + the
    // arc preview, so no further cleanup needed here.
  }

  // Refund the currently-edited structure. Returns base cost only — extra-
  // facing spend is sunk per design. Closes the rose afterward.
  private refundEditingStructure() {
    const s = this.editingStructure
    if (!s || !this.buildPhase) return
    const structs = this.buildPhase.getStructures()
    const idx = structs.indexOf(s)
    if (idx >= 0) structs.splice(idx, 1)
    s.dispose()
    this.buildPhase.addCredits(Config.STRUCTURES[s.type].cost)
  }

  // Show the live arc-preview overlay for whatever structure the compass rose
  // is currently open on, reflecting its full fireFacings array. Shares the
  // placement-preview overlay so only one is on-screen at a time.
  private refreshEditingArcPreview() {
    const s = this.editingStructure
    if (!s) { this.placementArcPreview.hide(); return }
    this.placementArcPreview.showWedge(s.worldX, s.worldY, s.range, s.fireFacings)
  }

  // Strip the "30cr" suffix from the Config label so the rose title reads
  // cleanly ("Turret arcs" instead of "Turret 30cr arcs").
  private structureDisplayLabel(s: Structure): string {
    return Config.STRUCTURES[s.type].label.replace(/\s*\d+cr.*$/, '').trim()
  }

  // Called once from BUILD (initial = true) and then again after every reveal
  // (initial = false) so the chess loop is BUILD → PLAN → REVEAL → PLAN ...
  private enterPlanningPhase(initial = true) {
    if (initial) {
      if (!this.buildPhase) return
      this.endPlacement()
      this.closeCompassRose()
      this.removeZoneTint('att')
      this.removeZoneTint('def')
      this.structures = this.buildPhase.getStructures()
      this.buildPhase.cleanup()
      this.buildPhase = null
    }

    this.phase = 'planning'
    this.hud.setPhase('planning')

    this.planningPhase = new PlanningPhase(
      this.scene, this.spheres, this.attackerUnits, this.structures, this.powerCore,
    )
    this.planningPhase.onSelectionChange = info => this.hud.setPlanningSelection(info)
    this.hud.onBattle = () => this.enterRevealPhase()
  }

  // First BATTLE click → enters reveal. Subsequent reveals auto-chain (no
  // planning phase in between) until win/lose. Plans queued in the initial
  // planning phase are honoured on the FIRST reveal; later reveals use default
  // behaviour (cyborgs advance, spheres/towers auto-fire).
  private enterRevealPhase() {
    // First entry comes from planning; auto-chain entries skip this tear-down.
    if (this.planningPhase) {
      this.planningPhase.dispose()
      this.planningPhase = null
      this.hud.setPlanningSelection(null)
    }

    this.phase = 'reveal'
    this.hud.setPhase('reveal')
    this.hud.onBattle = null   // reveal can't be skipped via the button
    // Drop the fog: AI pieces become visible so the player can see what
    // they're up against as the round plays out.
    this.setAiPiecesVisible(true)

    this.revealPhase = new RevealPhase(
      this.scene, this.powerCore, this.attackerUnits, this.structures, this.spheres, this.defenderUnits,
      this.pendingGrenades,
    )
    this.revealPhase.onWin = () => {
      this.phase = 'win'; this.hud.setPhase('win')
    }
    this.revealPhase.onLose = () => {
      this.phase = 'lose'; this.hud.setPhase('lose')
    }
    this.revealPhase.onComplete = () => {
      const hadActions = (this.revealPhase?.totalSteps ?? 0) > 0
      const hadCombat = this.revealPhase?.combatThisReveal === true
      // Flush this reveal's events to the combat-history log BEFORE we lose
      // the reference. Even a 0-action reveal gets a header (the player sees
      // "Turn N — no activity") so the lock-step between gameplay and log
      // stays obvious.
      const entries = this.revealPhase?.combatLog ?? []
      this.hud.appendCombatLog(this.revealTurn, entries)
      this.revealTurn++
      this.revealPhase = null
      // End-of-reveal bomb tick: unarmed → armed, already-armed gets its
      // turnsArmed counter bumped. RevealPhase force-detonates expired bombs
      // at the start of the next reveal (see ARMED_LIFETIME there).
      for (const g of this.pendingGrenades) g.advanceTurn()
      // Tick the no-combat counter. Wandering / advancing without anyone
      // ever shooting is a deadlock — call stalemate after a few rounds so
      // the auto-loop can't spin indefinitely.
      this.noProgressReveals = hadCombat ? 0 : this.noProgressReveals + 1
      if (this.phase !== 'reveal') return   // game ended mid-reveal
      const NO_PROGRESS_LIMIT = 5
      if (!hadActions || this.noProgressReveals >= NO_PROGRESS_LIMIT) {
        // Stalemate: either no piece could act this turn, or no combat has
        // happened for several reveals in a row. Tell the player which case
        // we hit so they can see whether it's ammo exhaustion vs gridlock.
        const reason = !hadActions
          ? 'No piece could move or fire this turn — every cyborg is blocked or out of ammo, and every defender is out of range or out of ammo.'
          : `No combat for ${NO_PROGRESS_LIMIT} consecutive turns — pieces are wandering with nothing to hit.`
        this.hud.showStalemate(reason)
        return
      }
      // Clear queued plans so the next auto-reveal uses default actions
      // (cyborgs advance / spheres + towers auto-fire) instead of replaying
      // the original plan turn after turn.
      for (const u of this.attackerUnits) u.clearPlan()
      for (const u of this.defenderUnits) u.clearPlan()
      for (const s of this.spheres)       s.clearPlan()
      for (const s of this.structures)    s.clearPlan()
      // Chain straight into the next reveal — no PLAN phase between turns.
      this.enterRevealPhase()
    }
  }

  // ── Placement (unified) ──────────────────────────────────────────────────

  private startSpherePlacement() {
    // Tear down any previous placement (cyborg ring etc.) so the old ghost
    // doesn't orphan in the scene — bug previously left a stale colored ring
    // behind when switching attacker types.
    this.endPlacement()
    const ghost = this.makeGhostRing(0x44aaff, 16, 24)
    ghost.position.set(-400, 0, 1)
    this.scene.add(ghost)
    this.placement = {
      kind: 'sphere',
      ghost, tint: null,
      zoneXMin: Config.WORLD.LEFT,
      zoneXMax: Config.DEFENDER_MAX_X,
      marginTop: 0, marginBottom: 0,   // grid snap supersedes margins
      onPlace: (x, y) => {
        if (!this.buildPhase) return false
        if (this.isCellOccupied(x, y)) return false   // one piece per cell
        if (!this.buildPhase.spendCredits(SPHERE_COST)) return false
        this.spheres.push(new SphereDefender(this.scene, x, y))
        return false  // multi-place — keep selecting until user cancels or credits run out
      },
    }
  }

  private startDogPlacement() {
    this.endPlacement()
    const color = Config.UNITS.dog.color
    const ghost = this.makeGhostRing(color, 12, 20)
    ghost.position.set(-400, 0, 1)
    this.scene.add(ghost)
    this.placement = {
      kind: 'dog',
      ghost, tint: null,
      zoneXMin: Config.WORLD.LEFT,
      zoneXMax: Config.DEFENDER_MAX_X,
      marginTop: 0, marginBottom: 0,
      onPlace: (x, y) => {
        if (this.isCellOccupied(x, y)) return false
        const cost = Config.UNITS.dog.cost
        if (!this.buildPhase || !this.buildPhase.spendCredits(cost)) return false
        this.defenderUnits.push(new SpriteUnit(this.scene, 'dog', x, y, 'defender'))
        return false
      },
    }
  }

  private startCyborgPlacement(type: UnitType) {
    // Tear down any previous placement so its ghost ring doesn't orphan.
    this.endPlacement()
    const color = Config.UNITS[type].color
    const ghost = this.makeGhostRing(color, 12, 20)
    ghost.position.set(400, 0, 1)
    this.scene.add(ghost)
    this.hud.setSelectedUnitType(type)
    this.placement = {
      kind: type,
      ghost, tint: null,
      zoneXMin: Config.ATTACKER_MIN_X,
      zoneXMax: Config.WORLD.RIGHT,
      marginTop: 0, marginBottom: 0,   // grid snap supersedes margins
      onPlace: (x, y) => {
        if (this.isCellOccupied(x, y)) return false
        const cost = Config.UNITS[type].cost
        if (this.attCredits < cost) return false
        this.attCredits -= cost
        this.hud.setAttCredits(this.attCredits)
        this.attackerUnits.push(new SpriteUnit(this.scene, type, x, y))
        return false
      },
      onEnd: () => this.hud.setSelectedUnitType(null),
    }
  }

  private endPlacement() {
    if (!this.placement) return
    const p = this.placement
    this.placement = null
    this.scene.remove(p.ghost)
    p.ghost.geometry.dispose()
    ;(p.ghost.material as THREE.Material).dispose()
    if (p.tint) {
      this.scene.remove(p.tint)
      p.tint.geometry.dispose()
      ;(p.tint.material as THREE.Material).dispose()
    }
    this.placementArcPreview.hide()
    p.onEnd?.()
  }

// Single ghost style for every placement (spheres / dogs / cyborgs / etc).
  // Used to be a coloured ring; replaced with a cell-aligned green square so
  // the placement UX matches the structure-placement ghost from BuildPhase.
  // `color` is ignored — kept in the signature for caller compatibility.
  private makeGhostRing(_color: number, _inner: number, _outer: number): THREE.Mesh {
    const size = Config.GRID_CELL - 2
    const geo = new THREE.PlaneGeometry(size, size)
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00ff88, side: THREE.DoubleSide, transparent: true, opacity: 0.25,
    })
    return new THREE.Mesh(geo, mat)
  }

  // Snap a world-space point to the center of its grid cell, restricted to
  // columns inside the active placement zone. Returns valid=false if cursor
  // falls outside the zone's columns or the map's row range.
  private snapToGridCell(
    x: number, y: number, zoneXMin: number, zoneXMax: number,
  ): { x: number; y: number; valid: boolean } {
    const cell = Config.GRID_CELL
    const cols = Math.floor((zoneXMax - zoneXMin) / cell)
    const rows = Math.floor((Config.WORLD.TOP - Config.WORLD.BOTTOM) / cell)
    const colIdx = Math.floor((x - zoneXMin) / cell)
    const rowIdx = Math.floor((y - Config.WORLD.BOTTOM) / cell)
    if (colIdx < 0 || colIdx >= cols || rowIdx < 0 || rowIdx >= rows) {
      return { x: 0, y: 0, valid: false }
    }
    return {
      x: zoneXMin + colIdx * cell + cell / 2,
      y: Config.WORLD.BOTTOM + rowIdx * cell + cell / 2,
      valid: true,
    }
  }

  // One piece per cell rule (per design — see docs/STATS.md). Pieces snap to
  // exact cell centers, so equality-with-epsilon catches collisions. The
  // Power Core has a 2x2 footprint and blocks all 4 of its cells. Also
  // checks placed structures so the two placement systems can't cohabit.
  private isCellOccupied(x: number, y: number): boolean {
    const E = 1
    for (const s of this.spheres) {
      if (Math.abs(s.worldX - x) < E && Math.abs(s.worldY - y) < E) return true
    }
    for (const u of this.attackerUnits) {
      if (Math.abs(u.worldX - x) < E && Math.abs(u.worldY - y) < E) return true
    }
    for (const u of this.defenderUnits) {
      if (Math.abs(u.worldX - x) < E && Math.abs(u.worldY - y) < E) return true
    }
    for (const cc of this.powerCore.cellCenters()) {
      if (Math.abs(cc.x - x) < E && Math.abs(cc.y - y) < E) return true
    }
    for (const s of this.buildPhase?.getStructures() ?? []) {
      if (s.isDead) continue
      if (Math.abs(s.worldX - x) < E && Math.abs(s.worldY - y) < E) return true
    }
    return false
  }

  // Thin outline rectangle marking the playable zone. Replaces the old
  // semi-transparent tint plane, which covered sprites and washed them out.
  private makeZoneBorder(xMin: number, xMax: number, color: number): THREE.LineSegments {
    const yMin = Config.WORLD.BOTTOM
    const yMax = Config.WORLD.TOP
    const z = 0.4
    const verts = [
      xMin, yMin, z, xMax, yMin, z,
      xMax, yMin, z, xMax, yMax, z,
      xMax, yMax, z, xMin, yMax, z,
      xMin, yMax, z, xMin, yMin, z,
    ]
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })
    const lines = new THREE.LineSegments(geo, mat)
    this.scene.add(lines)
    return lines
  }

  private removeZoneTint(side: 'att' | 'def') {
    const m = side === 'att' ? this.attZoneMesh : this.defZoneMesh
    if (!m) return
    this.scene.remove(m)
    m.geometry.dispose()
    ;(m.material as THREE.Material).dispose()
    if (side === 'att') this.attZoneMesh = null
    else this.defZoneMesh = null
  }

  private screenToWorld(clientX: number, clientY: number): THREE.Vector2 | null {
    const ndcX = (clientX / window.innerWidth) * 2 - 1
    const ndcY = -(clientY / window.innerHeight) * 2 + 1
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera)
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    const target = new THREE.Vector3()
    if (!raycaster.ray.intersectPlane(groundPlane, target)) return null
    return new THREE.Vector2(target.x, target.y)
  }

  // Inverse of screenToWorld for points at z=0. Used to anchor the compass-rose
  // popup over a clicked structure in pixel coordinates.
  private worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const v = new THREE.Vector3(wx, wy, 0).project(this.camera)
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
    }
  }

  start() {
    this.lastTime = performance.now()
    this.loop()
  }

  private loop = () => {
    this.rafId = requestAnimationFrame(this.loop)
    const now = performance.now()
    const delta = Math.min((now - this.lastTime) / 1000, 0.1)
    this.lastTime = now

    this.attackerUnits.forEach(u => { u.update(delta); u.faceCamera(this.camera) })
    this.defenderUnits.forEach(u => { u.update(delta); u.faceCamera(this.camera) })
    this.powerCore?.update(delta)
    this.powerCore?.faceCamera(this.camera)
    this.spheres.forEach(s => { s.update(delta); s.faceCamera(this.camera) })
    // Tick every structure (whether owned by BuildPhase or post-build by Game)
    // so explosion animations advance regardless of phase.
    const liveStructures = this.buildPhase?.getStructures() ?? this.structures
    for (const s of liveStructures) s.update(delta)
    this.buildPhase?.faceCamera(this.camera)
    this.revealPhase?.update(delta)
    this.revealPhase?.faceCamera(this.camera)

    // Smooth zoom with damping
    if (Math.abs(this.zoomVelocity) > 0.0002) {
      const factor = 1 + this.zoomVelocity
      const newWidth = (this.camera.right - this.camera.left) * factor
      if (newWidth >= 200 && newWidth <= 2800) {
        this.camera.left   *= factor
        this.camera.right  *= factor
        this.camera.top    *= factor
        this.camera.bottom *= factor
        this.camera.updateProjectionMatrix()
      }
      this.zoomVelocity *= 0.82
    }

    this.renderer.render(this.scene, this.camera)
  }

  private onResize = () => {
    const { innerWidth: w, innerHeight: h } = window
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h)
    const halfH = 600 / (w / h)
    this.camera.top    =  halfH
    this.camera.bottom = -halfH
    this.camera.updateProjectionMatrix()
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    this.zoomVelocity += Math.max(-0.015, Math.min(0.015, e.deltaY * 0.00015))
  }

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 1) {
      this.isPanning = true
      this.lastPan = { x: e.clientX, y: e.clientY }
    }

    if (e.button === 2 && this.phase === 'planning') {
      // Right-click in planning = clear queued actions / deselect (handled in
      // PlanningPhase). Don't enter pan mode.
      if ((e.target as HTMLElement).closest('#hud')) return
      this.planningPhase?.onSecondaryClick()
      return
    }
    // Right-click in BUILD over an existing firing structure → open the
    // compass rose (or close it if it's already showing that structure —
    // right-click acts as a toggle). Over empty space → pan the camera.
    // Mouse-only gesture, no keyboard modifiers.
    if (e.button === 2 && this.phase === 'build') {
      if (!(e.target as HTMLElement).closest('#hud')) {
        const world = this.screenToWorld(e.clientX, e.clientY)
        if (world) {
          const s = this.findStructureNear(world.x, world.y)
          if (s) {
            if (s === this.editingStructure) {
              this.closeCompassRose()
            } else {
              this.openCompassRose(s)
            }
            return
          }
        }
      }
      this.isPanning = true
      this.lastPan = { x: e.clientX, y: e.clientY }
      return
    }
    if (e.button === 2) {
      this.isPanning = true
      this.lastPan = { x: e.clientX, y: e.clientY }
    }

    if (e.button === 0 && this.phase === 'build') {
      if ((e.target as HTMLElement).closest('#hud')) return  // ignore HUD clicks

      // (Rose closing on outside-click is handled by HUD's own document-level
      // listener — it doesn't consume the click, so refund/place below still
      // run on the same click target as the user expects.)
      const world = this.screenToWorld(e.clientX, e.clientY)

      // Refund-and-remove if clicking on a placed sphere, cyborg, or structure.
      if (world && this.tryRefund(world.x, world.y)) return

      if (this.placement) {
        if (!this.placement.ghost.visible) return
        const { x, y } = this.placement.ghost.position
        const shouldEnd = this.placement.onPlace(x, y)
        if (shouldEnd) this.endPlacement()
      }
    }

    if (e.button === 0 && this.phase === 'planning') {
      if ((e.target as HTMLElement).closest('#hud')) return
      const world = this.screenToWorld(e.clientX, e.clientY)
      if (!world) return
      this.planningPhase?.onPrimaryClick(world.x, world.y, e.shiftKey)
    }
  }

  // Locate a live structure whose centre falls within ~half a cell of the
  // clicked world position. Used by the compass-rose shift+click detection
  // during BUILD. Returns null if nothing's there.
  private findStructureNear(x: number, y: number): Structure | null {
    const R_SQ = 35 * 35   // mirrors REFUND_RADIUS_SQ — same "hit" hitbox
    const structs = this.buildPhase?.getStructures() ?? this.structures
    for (const s of structs) {
      if (s.isDead) continue
      const dx = s.worldX - x, dy = s.worldY - y
      if (dx * dx + dy * dy < R_SQ) return s
    }
    return null
  }

  // Click on a placed sphere or cyborg → remove + refund. Returns true if
  // something was refunded (caller should skip normal placement logic).
  private tryRefund(x: number, y: number): boolean {
    const REFUND_RADIUS_SQ = 35 * 35
    for (let i = 0; i < this.spheres.length; i++) {
      const s = this.spheres[i]
      const dx = s.worldX - x, dy = s.worldY - y
      if (dx * dx + dy * dy < REFUND_RADIUS_SQ) {
        this.spheres.splice(i, 1)
        this.scene.remove(s.mesh)
        this.buildPhase?.addCredits(SPHERE_COST)
        return true
      }
    }
    for (let i = 0; i < this.defenderUnits.length; i++) {
      const u = this.defenderUnits[i]
      const dx = u.worldX - x, dy = u.worldY - y
      if (dx * dx + dy * dy < REFUND_RADIUS_SQ) {
        this.defenderUnits.splice(i, 1)
        this.scene.remove(u.mesh)
        this.buildPhase?.addCredits(Config.UNITS[u.type].cost)
        return true
      }
    }
    for (let i = 0; i < this.attackerUnits.length; i++) {
      const u = this.attackerUnits[i]
      const dx = u.worldX - x, dy = u.worldY - y
      if (dx * dx + dy * dy < REFUND_RADIUS_SQ) {
        this.attackerUnits.splice(i, 1)
        this.scene.remove(u.mesh)
        this.attCredits += Config.UNITS[u.type].cost
        this.hud.setAttCredits(this.attCredits)
        return true
      }
    }
    // Structures (towers, bombers, walls, mines, preview pieces). During
    // BUILD the live array lives on BuildPhase; once BUILD ends the same
    // ref is handed to Game. Splice on whichever owns it right now.
    const structs = this.buildPhase?.getStructures() ?? this.structures
    for (let i = 0; i < structs.length; i++) {
      const s = structs[i]
      const dx = s.worldX - x, dy = s.worldY - y
      if (dx * dx + dy * dy < REFUND_RADIUS_SQ) {
        structs.splice(i, 1)
        s.dispose()
        this.buildPhase?.addCredits(Config.STRUCTURES[s.type].cost)
        // Clear the active shop selection — otherwise BuildPhase's `click`
        // handler fires AFTER our mousedown, sees the cell is now empty, and
        // places a fresh structure of the selected type. To the player that
        // looks like the click "didn't remove" the piece. Spheres/dogs use
        // a different placement system so they don't have this issue.
        this.buildPhase?.selectStructure(null)
        this.hud.clearStructureSelection()
        // Also tear down the rose if it was editing this structure.
        if (this.editingStructure === s) this.closeCompassRose()
        return true
      }
    }
    return false
  }

  private onMouseMove = (e: MouseEvent) => {
    if (this.isPanning) {
      const dx = e.clientX - this.lastPan.x
      const dy = e.clientY - this.lastPan.y
      const ww = this.camera.right - this.camera.left
      const wh = this.camera.top - this.camera.bottom
      const panY = (dy / window.innerHeight) * wh
      // Camera local Y axis in world coords — has a small -Z component because
      // of the slight tilt. Read it directly from the camera's world matrix so
      // pan slides along the screen up direction instead of pitching the view.
      const camUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1)
      this.camera.position.x -= (dx / window.innerWidth) * ww
      this.camera.position.y += panY * camUp.y
      this.camera.position.z += panY * camUp.z
      this.lastPan = { x: e.clientX, y: e.clientY }
    }
    if (this.placement) {
      const pos = this.screenToWorld(e.clientX, e.clientY)
      if (pos) {
        const snap = this.snapToGridCell(
          pos.x, pos.y,
          this.placement.zoneXMin, this.placement.zoneXMax,
        )
        if (snap.valid) {
          this.placement.ghost.position.set(snap.x, snap.y, 1)
          this.placement.ghost.visible = true
          if (this.placement.kind === 'sphere') {
            this.placementArcPreview.showCircle(snap.x, snap.y, Config.SPHERE.range)
          }
        } else {
          this.placement.ghost.visible = false
          this.placementArcPreview.hide()
        }
      } else {
        this.placement.ghost.visible = false
        this.placementArcPreview.hide()
      }
    }
  }

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 1 || e.button === 2) this.isPanning = false
  }

  private onContextMenu = (e: Event) => e.preventDefault()

  dispose() {
    cancelAnimationFrame(this.rafId)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('contextmenu', this.onContextMenu)
    this.buildPhase?.cleanup()
    this.endPlacement()
    this.removeZoneTint('att')
    this.removeZoneTint('def')
    for (const s of this.spheres) this.scene.remove(s.mesh)
    this.spheres = []
    for (const g of this.pendingGrenades) g.dispose()
    this.pendingGrenades = []
    this.renderer.dispose()
    this.scene.clear()
    this.hud?.dispose()
  }
}
