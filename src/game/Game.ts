import * as THREE from 'three'
import { Config, StructureType, UnitType, Faction, Role } from './GameConfig'
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
import { MedicPad } from '../entities/MedicPad'
import { Tether } from '../entities/Tether'
import { RepairPad } from '../entities/RepairPad'
import { RepairTether } from '../entities/RepairTether'
import { AmmoBox, AmmoKitType, kitForUnit } from '../entities/AmmoBox'
import { FireArcPreview } from '../entities/FireArcPreview'
import { OpponentAI, OpponentSide } from '../ai/OpponentAI'
import { recordBattle, BattleRecord, PerPieceCounters } from './BattleStats'
import { getRevealSpeed } from './RevealSpeed'
import { aiCreditMultiplier } from './Difficulty'
import { MiniControlCenter } from '../ui/MiniControlCenter'
import { setMusicTrack, stopMusic } from '../audio/music'
import { preloadAllSamples, playEventSfx } from '../audio/sfx'
import type { CombatLogEntry } from './RevealPhase'

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
  // Floating bottom-right widget. Owns speed dial, audio + speech +
  // log toggles, and the BATTLE / PAUSE primary action pill.
  private mcc!: MiniControlCenter
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

  private attCredits: number = Config.START_CREDITS
  private attZoneMesh: THREE.LineSegments | null = null
  private defZoneMesh: THREE.LineSegments | null = null

  // Multi-sphere: now sprite-based (8 directional pixel-art PNGs, ~24 KB total
  // instead of the 60 MB GLB). Pre-loaded in preloadSphereSprites().
  private spheres: SphereDefender[] = []

  // Grenades that landed last reveal — detonated at the start of the next one.
  // Owned by Game (survives RevealPhase instances) and passed by reference so
  // each new reveal sees + clears + grows the same array.
  private pendingGrenades: PendingGrenade[] = []
  // Medic-pads dropped by the Cyborg Medic. Tick + animate alongside the
  // other battlefield entities; cleaned up when charges expire or HP hits 0.
  private medicPads: MedicPad[] = []
  // Active Tether bonds between a Medic and an ally. Updated per frame so
  // the beam tracks the units; ticked each reveal for the heal payload.
  private tethers: Tether[] = []
  // Defender-side counterparts: Robot Repair pads + weld-tethers. Same
  // lifecycle as the medic versions — animated each frame, ticked each
  // reveal, cleaned up on expire/death.
  private repairPads: RepairPad[] = []
  private repairTethers: RepairTether[] = []
  // Resupply crates that drop into the battlefield during BATTLE. One
  // spawns every AMMO_BOX_INTERVAL reveals (until MAX_AMMO_BOXES are on
  // the field). Picked up when a unit walks onto its cell.
  private ammoBoxes: AmmoBox[] = []
  // Monotonic counter for the combat-history log. First reveal after PLAN
  // is Turn 1; auto-chained reveals bump from there. Never reset within a
  // game — Play Again is a full reload.
  private revealTurn = 1

  // Running per-side battle stats. Updated each reveal in onComplete by
  // parsing the combat log; flushed to localStorage on game end via
  // recordBattleEnd. Resets on Play Again (full page reload).
  private statsDamage = { attacker: 0, defender: 0 }
  private statsKills  = { attacker: 0, defender: 0 }
  // S17.3 per-piece accumulators — keyed by actor type (e.g. 'hulk',
  // 'sphere', 'tower'). Fed by RevealPhase.onPieceEvent so we don't
  // re-parse log text. Action counts are also keyed by action name
  // (e.g. 'throw', 'slam', 'emp', 'mine_trigger').
  private damageByPieceType: Record<string, number> = {}
  private killsByPieceType:  Record<string, number> = {}
  private actionCounts:      Record<string, number> = {}
  // S17.4 additions — assists / movement / attacks / enemy-clear turn.
  private assistsByPieceType:     Record<string, number> = {}
  private cellsWalkedByPieceType: Record<string, number> = {}
  private attacksByPieceType:     Record<string, number> = {}
  // S17.10 telemetry expansion. Catches bugs the headline counters miss.
  private hitsByPieceType:          Record<string, number> = {}
  private missesByPieceType:        Record<string, number> = {}
  private friendlyFireByPieceType:  Record<string, number> = {}
  private friendlyFireHits:         Record<string, number> = {}  // ally targets hit, summed
  private weakeningByPieceType:     Record<string, number> = {}
  private oneShotsByPieceType:      Record<string, number> = {}  // attacks that one-shot a full HP target
  private oneShotVictimsByType:     Record<string, number> = {}  // counted by victim's piece type
  private resupplyCounts = { attackerCratePickups: 0, defenderCoreRecharges: 0 }
  private grenadeThrows: Array<{
    throwerType: string
    side: 'attacker' | 'defender'
    throwerX: number; throwerY: number
    landX: number; landY: number
    nearestEnemyX: number | null
    nearestEnemyY: number | null
    distFromEnemy: number | null
  }> = []
  // Hulk position telemetry. Captures starting X for every Hulk at the
  // start of the FIRST reveal so we can compare to their final X at
  // game end and surface "Hulks that never moved toward the core."
  private hulkStartByX: Record<string, number> = {}
  // S17.14: side-split per-piece counters. Replaces the type-only
  // flat counters above for accurate analysis. Same actorType can
  // exist on both sides (cannon, bomber). Track both, never collide.
  private piecesStats: {
    attacker: Record<string, PerPieceCounters>
    defender: Record<string, PerPieceCounters>
  } = { attacker: {}, defender: {} }
  // Turn on which the OPPOSITE side first reached 0 alive units. Set
  // once in onComplete when the condition is first true; null if never.
  private enemyEliminatedAtTurn: number | null = null
  // True if recordBattleEnd already fired for this game — prevents a
  // double-record if win/lose handlers ever stack.
  private battleRecorded = false
  // S17.25 stalemate guard. Counts consecutive reveals where the
  // RevealPhase reported combatThisReveal === false (no damage, no
  // movement, no combat events of any kind). When the streak hits
  // STALEMATE_LIMIT the game ends as a defender attrition win.
  // Without this, a stuck cyborg (no path to core, no targets in
  // range, no melee available) could spin the auto-loop forever
  // ("Turn 393 -- no activity" type bug).
  private noCombatStreak = 0
  // Wall-clock ms at first reveal start. Diff at recordBattleEnd = how
  // long the player actually watched. Skip BUILD/PLAN time so the metric
  // is "battle pacing" not "user think time."
  private battleStartMs: number | null = null

  // Single-player mode: the player picks one side at load; the other side
  // runs on autopilot via OpponentAI. Set after the side picker resolves.
  // playerSide stores the chosen ROLE ('defender' | 'attacker'); faction is
  // a separate axis controlling visual identity (currently cosmetic — both
  // factions share towers + power core; movable characters reuse existing
  // sprites until faction-specific sets are generated).
  private playerSide: OpponentSide | null = null
  private playerFaction: Faction | null = null
  private aiFaction: Faction | null = null
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
    // Camera is OFFSET in Y so the world content sits below the floating
    // HUD strip rather than partly behind it. Without this offset, the top
    // ~25% of the world (top row of defender cells) would be obscured by
    // the HUD tiles. See computeCameraYOffset for the math.
    const camY = this.computeCameraYOffset(halfH)
    this.camera.position.set(0, camY, 500)
    this.camera.lookAt(0, camY, 0)

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
    // Mini Control Center floats over the canvas at bottom-right.
    // BATTLE handler delegates to the existing HUD.onBattle chain so
    // both the legacy center-panel button and the new dial pill go
    // through the same code path. PAUSE forwards to the active
    // RevealPhase.paused flag.
    this.mcc = new MiniControlCenter({
      onBattle: () => this.hud.onBattle?.(),
      onPauseChange: paused => { if (this.revealPhase) this.revealPhase.paused = paused },
    })

    // Block UI until all sprite atlases are ready so placements never show the
    // swap from fallback geometry to final sprite. Sample SFX decode runs in
    // parallel; we await it so the first weapon fire isn't silent. Sample
    // failures are non-fatal (synth fallback kicks in per event).
    await Promise.all([
      preloadSphereSprites(),
      preloadSpriteUnit('cannon', 'cannon'),
      preloadSpriteUnit('grenadier', 'grenadier'),
      preloadSpriteUnit('doublegun', 'doublegun'),
      preloadSpriteUnit('dog', 'dog'),
      preloadSpriteUnit('hulk', 'hulk'),
      preloadSpriteUnit('sniper', 'sniper'),
      preloadSpriteUnit('medic', 'medic'),
      preloadSpriteUnit('repair', 'repair'),
      preloadSpriteUnit('stalker', 'cyborg_stalker'),
      preloadPixelPowerCore(),
      preloadStructureSprites(),
      preloadAllSamples(),
    ])

    // Pixel power core — 2x2 footprint stays at 100 world units of cell
    // occupancy, but the sprite renders at GRID_CELL * 3 (= 150) so it reads
    // as the dominant objective piece. Sprite overflows the footprint
    // visually — fine, it's billboard-only.
    this.powerCore = new PixelPowerCore(this.scene, Config.POWER_CORE.X, Config.POWER_CORE.Y, Config.GRID_CELL * 3)
    // Persistent visual overlay for the core's electric defense zone —
    // 12 cells around the 2×2 core. Translucent yellow tiles so the
    // player can see the danger area at all times.
    this.scene.add(this.makeCoreDefenseOverlay())

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
    this.hud.onPickSide = (faction, role) => this.onSidePicked(faction, role)
    this.hud.showSidePicker()
    // Main menu music plays under the side picker. The first click on a
    // faction card will both pick the side AND satisfy the browser's
    // autoplay-gesture requirement if the initial play() was blocked.
    setMusicTrack('menu')
  }

  private onSidePicked(faction: Faction, role: Role) {
    if (this.playerSide) return  // re-entry guard
    this.playerSide = role
    this.playerFaction = faction
    // AI gets the OPPOSITE role + OPPOSITE faction. With the 2-card
    // picker this means: player picks Robot Defender, AI is Cyborg
    // Attacker (and vice versa). Same-faction matchups will return when
    // we expand the picker after faction-specific rosters are generated.
    this.aiFaction = faction === 'robot' ? 'cyborg' : 'robot'
    const aiSide: OpponentSide = role === 'defender' ? 'attacker' : 'defender'
    this.opponentAI = new OpponentAI(aiSide, this.aiApi(aiSide))
    this.hud.setPlayerSide(role)
    // Apply player team tint to the Power Core if the player is defending,
    // or AI tint if the player is attacking (the core always sits on the
    // defender side, so it belongs to whoever picked defender).
    this.applyPowerCoreTeamTint(role === 'defender' ? 'player' : 'ai')
    // Swap menu music for the faction's in-game theme. Stays playing
    // through build / reveal / win / lose; PLAY AGAIN reloads the page
    // which brings the menu track back on its own.
    setMusicTrack(faction === 'robot' ? 'robots' : 'cyborgs')
    playEventSfx('power_up')
    this.enterBuildPhase()
  }

  // Re-tint the existing Power Core sprite after the player picks a role.
  // The PowerCore is constructed during init() (before side is known) with
  // the default 'player' tint; we update it here once ownership resolves.
  private applyPowerCoreTeamTint(team: 'player' | 'ai') {
    this.powerCore?.setTeam(team)
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
  // cell even if its scoring function got something wrong. Pieces spawned
  // here are AI-owned, so they get the AI team tint (red wash).
  private aiSpawnSphere(x: number, y: number): boolean {
    if (!this.buildPhase) return false
    if (this.isCellOccupied(x, y)) return false
    if (!this.buildPhase.spendCredits(SPHERE_COST)) return false
    this.spheres.push(new SphereDefender(this.scene, x, y, 'ai'))
    return true
  }
  private aiSpawnDefenderUnit(type: UnitType, x: number, y: number): boolean {
    if (!this.buildPhase) return false
    if (this.isCellOccupied(x, y)) return false
    const cost = Config.UNITS[type]?.cost ?? 0
    if (!this.buildPhase.spendCredits(cost)) return false
    this.defenderUnits.push(new SpriteUnit(this.scene, type, x, y, 'defender', 'ai'))
    return true
  }
  private aiSpawnAttackerUnit(type: UnitType, x: number, y: number): boolean {
    if (this.isCellOccupied(x, y)) return false
    const cost = Config.UNITS[type]?.cost ?? 0
    if (this.attCredits < cost) return false
    this.attCredits -= cost
    this.hud.setAttCredits(this.attCredits)
    this.attackerUnits.push(new SpriteUnit(this.scene, type, x, y, 'attacker', 'ai'))
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
    this.buildPhase.getStructures().push(new Structure(this.scene, type, col, row, 'ai'))
    return true
  }

  // Yellow translucent tiles over the core's electric-defense zone. One
  // mesh per cell (12 cells around the 2×2 core). Persistent — visible
  // from BUILD onwards so the player can plan around the threat area.
  // Cyborgs entering any of these cells eat the core's electric pulse
  // at the next reveal start (see RevealPhase.tickCoreDefense).
  private makeCoreDefenseOverlay(): THREE.Group {
    const group = new THREE.Group()
    const cs = Config.GRID_CELL
    const cells = this.powerCore.defenseZoneCells()
    // Bumped opacity 0.18 → 0.35 + electric-blue outline so the danger
    // zone reads at a glance during BUILD and BATTLE. Was too subtle.
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0x66ccff,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    })
    const tileGeo = new THREE.PlaneGeometry(cs - 4, cs - 4)
    // Outline geometry — square ring at cell edge for crisp boundary.
    const outlineGeo = new THREE.BufferGeometry()
    const w = (cs - 4) / 2
    outlineGeo.setAttribute('position', new THREE.Float32BufferAttribute([
      -w, -w, 0,  w, -w, 0,
       w, -w, 0,  w,  w, 0,
       w,  w, 0, -w,  w, 0,
      -w,  w, 0, -w, -w, 0,
    ], 3))
    const outlineMat = new THREE.LineBasicMaterial({
      color: 0x66ddff,
      transparent: true,
      opacity: 0.85,
    })
    for (const c of cells) {
      const tile = new THREE.Mesh(tileGeo, fillMat)
      tile.position.set(c.x, c.y, 0.35)
      group.add(tile)
      const outline = new THREE.LineSegments(outlineGeo, outlineMat)
      outline.position.set(c.x, c.y, 0.36)
      group.add(outline)
    }
    return group
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
    // S17.15 credit economy. Both sides get the SAME base budget
    // (Config.START_CREDITS, 1000). The AI side gets multiplied by
    // the user-selected Difficulty:
    //   easy   AI × 0.75 (smaller AI army)
    //   normal AI × 1.00 (parity)
    //   hard   AI × 1.25 (harder fight)
    // Player credits are unaffected by difficulty.
    const aiMul         = aiCreditMultiplier()
    const aiIsAttacker  = this.playerSide === 'defender'
    const aiIsDefender  = this.playerSide === 'attacker'
    const base          = Config.START_CREDITS
    const attackerCr    = aiIsAttacker ? Math.floor(base * aiMul) : base
    const defenderCr    = aiIsDefender ? Math.floor(base * aiMul) : base
    this.attCredits = attackerCr
    this.hud.setPhase('build')
    this.mcc?.setPhase('build')
    this.hud.setAttCredits(this.attCredits)
    const buildPhaseCredits = defenderCr
    this.buildPhase = new BuildPhase(
      this.scene, this.camera, this.hud, buildPhaseCredits,
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

    this.hud.onBuyRepair = () => {
      if (this.placement?.kind === 'repair') { this.endPlacement(); return }
      const cost = Config.UNITS.repair.cost
      if (!this.buildPhase || this.buildPhase.getCredits() < cost) return
      this.buildPhase?.selectStructure(null)
      this.hud.clearStructureSelection()
      this.startRepairPlacement()
    }

    // Build's "READY" button skips the separate PLAN phase and goes
    // directly to REVEAL. The reveal engine's default-action heuristics
    // (cyborgs march, towers fire, etc.) handle every piece without
    // requiring the player to click again. Planning will come back as an
    // opt-in feature when piece-action queuing is exposed elsewhere.
    this.hud.onBattle = () => this.startBattleFromBuild()

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
    // Active-arc click → refund that one direction (returns EXTRA_FACING_COST).
    // Lets the player back out of a mis-clicked +30cr without scrapping the
    // structure. Last-remaining facing is preserved by Structure.removeFacing.
    this.hud.onRemoveFacing = (angle) => this.tryRefundFacing(angle)
    // Single-facing rose (Sentry) — clicking a direction REPLACES the lone
    // fire facing with the picked one. No credit cost.
    this.hud.onSetFacing = (angle) => this.trySetFacing(angle)
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
      this.hud.logSystemMessage('AI forces deployed. Hidden until BATTLE.', 'ai')
    }
  }

  // Show/hide every piece on the AI's side of the field. Called with false
  // after the AI's BUILD turn and true at the start of the first REVEAL.
  // No-op if the player picked no side yet. DEAD pieces are deliberately
  // skipped — each reveal calls this with visible=true to drop the fog
  // again, and without the isDead guard dead bodies would briefly flash
  // back on screen until their own update() loop hid them 2s later. That
  // produced a "corpses blink every 3 seconds" effect.
  private setAiPiecesVisible(visible: boolean) {
    if (!this.playerSide) return
    const aiSide: OpponentSide = this.playerSide === 'defender' ? 'attacker' : 'defender'
    if (aiSide === 'attacker') {
      for (const u of this.attackerUnits) {
        if (u.isDead) continue
        u.mesh.visible = visible
      }
    } else {
      for (const u of this.defenderUnits) {
        if (u.isDead) continue
        u.mesh.visible = visible
      }
      for (const s of this.spheres) {
        if (s.isDead) continue
        s.mesh.visible = visible
      }
      // Structures live on BuildPhase before reveal, on Game.structures after.
      const structs = this.buildPhase?.getStructures() ?? this.structures
      for (const st of structs) {
        if (st.isDead) continue
        st.mesh.visible = visible
      }
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
      mode: this.roseModeFor(s),
    })
    return true
  }

  // Active-arc click on a multi-facing rose — remove the picked facing and
  // refund EXTRA_FACING_COST. No-op if it's the last remaining facing (the
  // structure needs at least one fire direction to function).
  private tryRefundFacing(angle: number): boolean {
    const s = this.editingStructure
    if (!s || s.isDead) { this.closeCompassRose(); return false }
    if (!this.buildPhase) { this.closeCompassRose(); return false }
    const removed = s.removeFacing(angle)
    if (!removed) return false
    this.buildPhase.addCredits(Config.EXTRA_FACING_COST)
    this.refreshEditingArcPreview()
    this.hud.refreshCompassRose({
      name: this.structureDisplayLabel(s),
      activeFacings: s.fireFacings,
      cost: Config.EXTRA_FACING_COST,
      credits: this.buildPhase.getCredits(),
      mode: this.roseModeFor(s),
    })
    return true
  }

  // Single-facing structure (Sentry) click — replace the lone fire facing
  // with the picked direction. Free; just rotates the gun.
  private trySetFacing(angle: number): boolean {
    const s = this.editingStructure
    if (!s || s.isDead) { this.closeCompassRose(); return false }
    if (!this.buildPhase) { this.closeCompassRose(); return false }
    const changed = s.setSingleFacing(angle)
    if (!changed) return false
    this.refreshEditingArcPreview()
    this.hud.refreshCompassRose({
      name: this.structureDisplayLabel(s),
      activeFacings: s.fireFacings,
      cost: Config.EXTRA_FACING_COST,
      credits: this.buildPhase.getCredits(),
      mode: this.roseModeFor(s),
    })
    return true
  }

  // Sentry has exactly one fire direction at a time; everything else uses
  // the pay-to-add multi-arc rose. Add structure types here as they earn
  // single-facing semantics (e.g. a future heavy-cannon emplacement).
  private roseModeFor(s: Structure): 'multi' | 'single' {
    return s.type === 'sentry' ? 'single' : 'multi'
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
      mode: this.roseModeFor(s),
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
    playEventSfx('refund')
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

  // Transition from BUILD directly to the first REVEAL, skipping the
  // separate PLAN phase. Tears down BuildPhase (same as enterPlanningPhase
  // does for initial=true) then jumps to the reveal loop, which uses
  // default-action heuristics for every piece.
  private startBattleFromBuild() {
    if (!this.buildPhase) return
    this.endPlacement()
    this.closeCompassRose()
    this.removeZoneTint('att')
    this.removeZoneTint('def')
    this.structures = this.buildPhase.getStructures()
    this.buildPhase.cleanup()
    this.buildPhase = null
    this.enterRevealPhase()
  }

  // Called once from BUILD (initial = true) and then again after every reveal
  // (initial = false) so the chess loop is BUILD → PLAN → REVEAL → PLAN ...
  // CURRENTLY UNUSED from BUILD: the READY button transitions directly to
  // REVEAL via startBattleFromBuild. Kept for future opt-in planning support.
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
    this.mcc?.setPhase('planning')

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
    this.mcc?.setPhase('reveal')
    this.hud.onBattle = null   // reveal can't be skipped via the button
    // Drop the fog: AI pieces become visible so the player can see what
    // they're up against as the round plays out.
    this.setAiPiecesVisible(true)
    // First reveal of this game → stamp the wall-clock start. Auto-chain
    // re-entries (every turn) leave it alone.
    if (this.battleStartMs == null) {
      this.battleStartMs = Date.now()
      // Snapshot Hulk starting positions ONCE per game so we can compare
      // to their final positions at recordBattleEnd. Catches a Hulk that
      // is supposed to march straight at the core but ends the game at
      // the same X it spawned.
      for (const u of this.attackerUnits) {
        if (u.type === 'hulk') this.hulkStartByX[u.id] = u.worldX
      }
    }

    this.revealPhase = new RevealPhase(
      this.scene, this.powerCore, this.attackerUnits, this.structures, this.spheres, this.defenderUnits,
      this.pendingGrenades, this.medicPads, this.tethers, this.repairPads, this.repairTethers,
      this.ammoBoxes,
    )
    this.revealPhase.onWin = () => {
      this.phase = 'win'; this.hud.setPhase('win'); this.mcc?.setPhase('win')
      this.recordBattleEnd('cyborgs_eliminated')
    }
    this.revealPhase.onLose = () => {
      this.phase = 'lose'; this.hud.setPhase('lose'); this.mcc?.setPhase('lose')
      this.recordBattleEnd('core_destroyed')
    }
    // Stream each log line to the HUD as it's recorded so the panel keeps
    // pace with the action visually instead of dumping a whole reveal's
    // events in one batch at onComplete.
    this.revealPhase.onLogEntry = entry => {
      this.hud.appendCombatLogEntry(this.revealTurn, entry)
    }
    // S17.3: per-piece + per-action telemetry. RevealPhase emits
    // structured events; we accumulate into BattleStats fields that
    // get flushed in recordBattleEnd.
    this.revealPhase.onPieceEvent = e => {
      // S17.14: bumpPiece writes side-split per-piece counters in
      // piecesStats. Old flat fields are kept in parallel for backward
      // compatibility with existing /stats.html and existing records.
      const bump = (side: 'attacker' | 'defender', actorType: string,
                    key: keyof PerPieceCounters, by = 1) => {
        const bucket = this.piecesStats[side]
        const entry = bucket[actorType] ?? (bucket[actorType] = {})
        entry[key] = (entry[key] ?? 0) + by
      }
      switch (e.kind) {
        case 'damage':
          this.damageByPieceType[e.actorType] = (this.damageByPieceType[e.actorType] ?? 0) + e.amount
          bump(e.side, e.actorType, 'damage', e.amount)
          break
        case 'kill':
          this.killsByPieceType[e.actorType] = (this.killsByPieceType[e.actorType] ?? 0) + 1
          bump(e.side, e.actorType, 'kills')
          break
        case 'action':
          this.actionCounts[e.action] = (this.actionCounts[e.action] ?? 0) + 1
          break
        case 'assist':
          this.assistsByPieceType[e.actorType] = (this.assistsByPieceType[e.actorType] ?? 0) + 1
          bump(e.side, e.actorType, 'assists')
          break
        case 'move':
          this.cellsWalkedByPieceType[e.actorType] = (this.cellsWalkedByPieceType[e.actorType] ?? 0) + 1
          bump(e.side, e.actorType, 'cellsWalked')
          break
        case 'attack':
          this.attacksByPieceType[e.actorType] = (this.attacksByPieceType[e.actorType] ?? 0) + 1
          bump(e.side, e.actorType, 'attacks')
          break
        // S17.10 additions
        case 'hit':
          this.hitsByPieceType[e.actorType] = (this.hitsByPieceType[e.actorType] ?? 0) + 1
          bump(e.side, e.actorType, 'hits')
          break
        case 'miss':
          this.missesByPieceType[e.actorType] = (this.missesByPieceType[e.actorType] ?? 0) + 1
          bump(e.side, e.actorType, 'misses')
          break
        case 'friendly_fire':
          this.friendlyFireByPieceType[e.actorType] = (this.friendlyFireByPieceType[e.actorType] ?? 0) + 1
          this.friendlyFireHits[e.actorType] = (this.friendlyFireHits[e.actorType] ?? 0) + e.count
          bump(e.side, e.actorType, 'friendlyFire')
          bump(e.side, e.actorType, 'friendlyFireHits', e.count)
          break
        case 'weakening':
          this.weakeningByPieceType[e.actorType] = (this.weakeningByPieceType[e.actorType] ?? 0) + 1
          bump(e.side, e.actorType, 'weakening')
          break
        case 'one_shot':
          this.oneShotsByPieceType[e.actorType] = (this.oneShotsByPieceType[e.actorType] ?? 0) + 1
          this.oneShotVictimsByType[e.targetType] = (this.oneShotVictimsByType[e.targetType] ?? 0) + 1
          bump(e.side, e.actorType, 'oneShots')
          break
        case 'crate_pickup':
          if (e.side === 'attacker') this.resupplyCounts.attackerCratePickups++
          break
        case 'core_recharge':
          this.resupplyCounts.defenderCoreRecharges++
          break
        case 'grenade_throw':
          this.grenadeThrows.push({
            throwerType: e.throwerType, side: e.side,
            throwerX: e.throwerX, throwerY: e.throwerY,
            landX: e.landX, landY: e.landY,
            nearestEnemyX: e.nearestEnemyX, nearestEnemyY: e.nearestEnemyY,
            distFromEnemy: e.distFromEnemy,
          })
          break
      }
    }
    this.revealPhase.onComplete = () => {
      // Flush this reveal's events to the combat-history log BEFORE we lose
      // the reference. Even a 0-action reveal gets a header so the lock-step
      // between gameplay and log stays obvious.
      const entries = this.revealPhase?.combatLog ?? []
      // S17.25: read combatThisReveal BEFORE the revealPhase is nulled.
      // This drives the no-progress stalemate guard below.
      const hadCombat = this.revealPhase?.combatThisReveal ?? false
      this.hud.appendCombatLog(this.revealTurn, entries)
      this.accumulateStatsFromLog(entries)
      this.revealTurn++
      this.revealPhase = null
      if (hadCombat) this.noCombatStreak = 0
      else this.noCombatStreak++
      // End-of-reveal bomb tick: unarmed → armed, already-armed gets its
      // turnsArmed counter bumped. RevealPhase force-detonates expired bombs
      // at the start of the next reveal (see ARMED_LIFETIME there).
      for (const g of this.pendingGrenades) g.advanceTurn()
      // Sweep crates that got picked up this reveal.
      for (let i = this.ammoBoxes.length - 1; i >= 0; i--) {
        if (this.ammoBoxes[i].isDead) this.ammoBoxes.splice(i, 1)
      }
      // Resupply crate scheduling: drop a new crate every N reveals up
      // to a soft cap so the battlefield doesn't fill with boxes.
      this.maybeSpawnAmmoBox()
      // Track the turn at which the OPPOSITE side first reached 0 alive
      // units. Player side determines which side counts as "enemy."
      if (this.enemyEliminatedAtTurn === null) {
        const enemySide = this.playerSide === 'defender' ? 'attacker' : 'defender'
        const enemyAlive = enemySide === 'attacker'
          ? this.attackerUnits.filter(u => !u.isDead).length
          : this.defenderUnits.filter(u => !u.isDead).length
            + this.spheres.filter(s => !s.isDead).length
            + this.structures.filter(s => !s.isDead).length
        if (enemyAlive === 0) this.enemyEliminatedAtTurn = this.revealTurn
      }
      if (this.phase !== 'reveal') return   // game ended mid-reveal
      // Defender-wins-by-attrition check: if no cyborg can damage the core
      // anymore (every shooter is out of ammo, no Hulk alive to punch
      // through), the defender survives by default. Without this rule
      // depleted cyborgs would wander the map indefinitely, the core
      // would stand untouched, and the auto-reveal loop would spin forever.
      if (!this.powerCore.isDead && !this.cyborgsCanAttack()) {
        this.phase = 'win'
        this.hud.setPhase('win')
        this.mcc?.setPhase('win')
        this.recordBattleEnd('attrition')
        return
      }
      // S17.25 stalemate guard. cyborgsCanAttack now returns true for any
      // alive non-medic cyborg (since melee-fallback covers ammo=0), so
      // a stuck cyborg that can NEVER reach a target (blocked path, no
      // melee range to anything) would otherwise spin the loop forever.
      // 3 consecutive reveals with zero combat events of any kind means
      // nothing is happening; call it a defender attrition win.
      const STALEMATE_LIMIT = 3
      if (!this.powerCore.isDead && this.noCombatStreak >= STALEMATE_LIMIT) {
        // eslint-disable-next-line no-console
        console.warn('[astrohold] stalemate: 3 consecutive no-combat reveals, forcing attrition')
        this.phase = 'win'
        this.hud.setPhase('win')
        this.mcc?.setPhase('win')
        this.recordBattleEnd('attrition')
        return
      }
      // No stalemate gate — battle is die-or-survive. Loop continues until
      // win (all cyborgs dead OR cyborgs disarmed) or lose (core dead).
      for (const u of this.attackerUnits) u.clearPlan()
      for (const u of this.defenderUnits) u.clearPlan()
      for (const s of this.spheres)       s.clearPlan()
      for (const s of this.structures)    s.clearPlan()
      // Yield to the browser before spinning up the next reveal. The
      // previous synchronous call (`this.enterRevealPhase()` direct here)
      // nested RevealPhase construction inside RevealPhase.update inside
      // the RAF tick — with 25+ entities + many pending grenades / tethers,
      // several short reveals could chain in a single frame, blow the
      // call stack, and freeze the tab (user reported turn-19 hang).
      // setTimeout(0) breaks the chain: the current RAF frame completes,
      // browser repaints, then the next reveal starts cleanly. No visible
      // change in cadence — reveals already paced by per-step animation.
      setTimeout(() => {
        if (this.phase === 'reveal') this.enterRevealPhase()
      }, 0)
    }
  }

  // Parse combat-log entries and add per-side damage + kill totals.
  // Log format from RevealPhase.log: "X hits Y (−25)" or "X AoE — N hit
  // (−123, M killed)". Side is set by the logger; we read damage out of
  // the parenthesized suffix. Used by recordBattleEnd to write a stats
  // snapshot for later balance analysis.
  private accumulateStatsFromLog(entries: ReadonlyArray<CombatLogEntry>) {
    for (const e of entries) {
      if (e.side !== 'attacker' && e.side !== 'defender') continue
      // Damage — "(−N" or "(−N," patterns. Uses Unicode minus U+2212.
      const dmgMatch = e.text.match(/\(−(\d+)/)
      if (dmgMatch) this.statsDamage[e.side] += parseInt(dmgMatch[1], 10)
      // Kills — every "killed" word in a damage line counts. AoE lines
      // include "N killed" with the count.
      const killCountMatch = e.text.match(/(\d+)\s+killed/)
      if (killCountMatch) this.statsKills[e.side] += parseInt(killCountMatch[1], 10)
      else if (e.text.includes('killed')) this.statsKills[e.side] += 1
    }
  }

  // Snapshot the current game state and persist a BattleRecord to
  // localStorage. Called from each terminal path (core dead / cyborgs
  // eliminated / attrition). endType is informational — the player POV
  // win/lose derives from playerSide + endType.
  private recordBattleEnd(endType: BattleRecord['endType']) {
    if (this.battleRecorded) return
    this.battleRecorded = true
    const playerWon =
      (this.playerSide === 'defender' && endType !== 'core_destroyed') ||
      (this.playerSide === 'attacker' && endType === 'core_destroyed')
    const aliveAttacker = this.attackerUnits.filter(u => !u.isDead).length
    const aliveDefender =
      this.defenderUnits.filter(u => !u.isDead).length +
      this.spheres.filter(s => !s.isDead).length +
      this.structures.filter(s => !s.isDead).length
    // S17.3 — snapshot what was BUILT (regardless of current alive count
    // so we can attribute behaviour to specific picks even after deaths).
    const piecesByType = { attacker: {} as Record<string, number>, defender: {} as Record<string, number> }
    for (const u of this.attackerUnits) piecesByType.attacker[u.type] = (piecesByType.attacker[u.type] ?? 0) + 1
    for (const u of this.defenderUnits) piecesByType.defender[u.type] = (piecesByType.defender[u.type] ?? 0) + 1
    for (const s of this.spheres)       piecesByType.defender.sphere = (piecesByType.defender.sphere ?? 0) + 1
    for (const s of this.structures)    piecesByType.defender[s.type] = (piecesByType.defender[s.type] ?? 0) + 1
    // S17.4 — credits spent per piece type. Derived from piecesByType ×
    // Config costs so /stats.html can compute damage-per-credit etc.
    const creditsSpentByPieceType = {
      attacker: {} as Record<string, number>,
      defender: {} as Record<string, number>,
    }
    for (const [t, n] of Object.entries(piecesByType.attacker)) {
      const cost = (Config.UNITS as Record<string, { cost: number }>)[t]?.cost ?? 0
      creditsSpentByPieceType.attacker[t] = cost * n
    }
    for (const [t, n] of Object.entries(piecesByType.defender)) {
      const cost = t === 'sphere'
        ? Config.SPHERE.cost
        : (Config.UNITS as Record<string, { cost: number }>)[t]?.cost
          ?? (Config.STRUCTURES as Record<string, { cost: number }>)[t]?.cost
          ?? 0
      creditsSpentByPieceType.defender[t] = cost * n
    }
    // S17.10 Hulk progress capture. For every Hulk that was tracked at
    // first reveal (or built and tracked late), record startX and endX.
    // Negative delta = moved west toward the core (the intended march).
    const hulkProgress: BattleRecord['hulkProgress'] = []
    for (const u of this.attackerUnits) {
      if (u.type !== 'hulk') continue
      const startX = this.hulkStartByX[u.id]
      if (startX === undefined) continue
      hulkProgress.push({ id: u.id, startX, endX: u.worldX, alive: !u.isDead })
    }
    // S17.14 damage reconciliation. Sum damageBy-piece-type from the
    // SIDE-SPLIT piecesStats (avoiding the cannon/bomber collision)
    // and compare to the statsDamage side totals collected by the
    // log parser. If the gap is over 5 percent, a damage path is
    // bypassing attribute() and we want to know about it.
    let attackerSum = 0
    let defenderSum = 0
    for (const c of Object.values(this.piecesStats.attacker)) attackerSum += c.damage ?? 0
    for (const c of Object.values(this.piecesStats.defender)) defenderSum += c.damage ?? 0
    const attackerReported = this.statsDamage.attacker
    const defenderReported = this.statsDamage.defender
    const pct = (a: number, b: number) => b === 0 ? (a === 0 ? 0 : 100) : Math.abs(a - b) / b * 100
    const reconciliation = {
      attackerSum,
      attackerReported,
      attackerDivergencePct: +pct(attackerSum, attackerReported).toFixed(1),
      defenderSum,
      defenderReported,
      defenderDivergencePct: +pct(defenderSum, defenderReported).toFixed(1),
    }
    if (reconciliation.attackerDivergencePct > 5 || reconciliation.defenderDivergencePct > 5) {
      // eslint-disable-next-line no-console
      console.warn('[astrohold] damage reconciliation gap', reconciliation)
    }
    recordBattle({
      endedAt: new Date().toISOString(),
      outcome: playerWon ? 'win' : 'lose',
      endType,
      playerSide: this.playerSide ?? 'defender',
      turns: this.revealTurn,
      alive: { attacker: aliveAttacker, defender: aliveDefender },
      damageDealt: { ...this.statsDamage },
      kills: { ...this.statsKills },
      coreHpEnd: this.powerCore.hp,
      coreMaxHp: this.powerCore.maxHp,
      piecesByType,
      damageByPieceType: { ...this.damageByPieceType },
      killsByPieceType: { ...this.killsByPieceType },
      actionCounts: { ...this.actionCounts },
      assistsByPieceType: { ...this.assistsByPieceType },
      cellsWalkedByPieceType: { ...this.cellsWalkedByPieceType },
      attacksByPieceType: { ...this.attacksByPieceType },
      creditsSpentByPieceType,
      enemyEliminatedAtTurn: this.enemyEliminatedAtTurn,
      durationMs: this.battleStartMs != null ? Date.now() - this.battleStartMs : undefined,
      speed: getRevealSpeed(),
      // S17.10 telemetry expansion fields:
      hitsByPieceType:         { ...this.hitsByPieceType },
      missesByPieceType:       { ...this.missesByPieceType },
      friendlyFireByPieceType: { ...this.friendlyFireByPieceType },
      friendlyFireHits:        { ...this.friendlyFireHits },
      weakeningByPieceType:    { ...this.weakeningByPieceType },
      oneShotsByPieceType:     { ...this.oneShotsByPieceType },
      oneShotVictimsByType:    { ...this.oneShotVictimsByType },
      resupply:                { ...this.resupplyCounts },
      grenadeThrows:           [...this.grenadeThrows],
      hulkProgress,
      damageReconciliation:    reconciliation,
      // S17.14 side-split per-piece stats. The flat counters above stay
      // for backward compat; new analysis on /stats.html prefers this.
      piecesStats: {
        attacker: { ...this.piecesStats.attacker },
        defender: { ...this.piecesStats.defender },
      },
    })
  }

  // Drop a resupply crate every N reveals during BATTLE. Capped at a
  // small number so the battlefield doesn't fill with boxes. Position
  // is a random empty cell inside the middle no-build zone
  // (DEFENDER_MAX_X < x < ATTACKER_MIN_X). Type is weighted: ammo is
  // common, grenades / medkits / repair kits are rarer so they feel
  // like a meaningful find for the unit that needs them.
  private readonly AMMO_BOX_INTERVAL = 5
  private readonly MAX_AMMO_BOXES = 4
  private maybeSpawnAmmoBox() {
    if (this.revealTurn % this.AMMO_BOX_INTERVAL !== 0) return
    if (this.ammoBoxes.filter(b => !b.isDead).length >= this.MAX_AMMO_BOXES) return
    const cs = Config.GRID_CELL
    const minCol = Math.floor((Config.DEFENDER_MAX_X - Config.WORLD.LEFT) / cs)
    const maxCol = Math.floor((Config.ATTACKER_MIN_X - Config.WORLD.LEFT) / cs) - 1
    const rowCount = Math.floor((Config.WORLD.TOP - Config.WORLD.BOTTOM) / cs)
    // Try up to 20 random cells to find an empty one
    for (let attempt = 0; attempt < 20; attempt++) {
      const col = minCol + Math.floor(Math.random() * (maxCol - minCol + 1))
      const row = Math.floor(Math.random() * rowCount)
      const x = Config.WORLD.LEFT + col * cs + cs / 2
      const y = Config.WORLD.BOTTOM + row * cs + cs / 2
      if (this.isCellOccupied(x, y)) continue
      if (this.ammoBoxes.some(b => !b.isDead && b.worldX === x && b.worldY === y)) continue
      // Type pick — weighted bag
      const roll = Math.random()
      const type: AmmoKitType =
        roll < 0.55 ? 'ammo' :
        roll < 0.75 ? 'grenade' :
        roll < 0.90 ? 'medkit' :
        'repair_kit'
      this.ammoBoxes.push(new AmmoBox(this.scene, col, row, type))
      // Callout: closest cyborg that CAN use this crate type announces
      // it so the player can track who's going for it. Defenders don't
      // pursue crates so we only check the attacker side.
      let nearest: SpriteUnit | null = null
      let nearestD = Infinity
      for (const u of this.attackerUnits) {
        if (u.isDead) continue
        if (kitForUnit(u.type) !== type) continue
        const d = Math.hypot(u.worldX - x, u.worldY - y)
        if (d < nearestD) { nearest = u; nearestD = d }
      }
      nearest?.announce('crate_spotted')
      return
    }
  }

  // True if at least one alive cyborg can still inflict damage on the
  // defender side. Used to gate the defender attrition-win condition
  // ("cyborgs are out of options, defender survives by default").
  //
  // The universal melee fallback in RevealPhase.executeAttack lets any
  // ammo-empty cyborg EXCEPT sniper / medic deal MELEE_FALLBACK_DAMAGE
  // (10) at adjacency for free. That means any of those alive cyborgs
  // can still walk up to the core and chip it, so the attrition
  // condition should not fire when they exist on the field.
  //
  // Per-type rules:
  //   medic            never attacks (heal-only role)
  //   sniper           attacks only with ammo > 0 (retreats when empty)
  //   hulk / stalker   always (melee-only, no ammo cost)
  //   others           always (melee fallback covers ammo=0 case)
  private cyborgsCanAttack(): boolean {
    for (const u of this.attackerUnits) {
      if (u.isDead) continue
      if (u.type === 'medic') continue
      if (u.type === 'sniper') {
        if (u.ammoRemaining > 0) return true
        continue
      }
      // Hulk / Stalker: melee-only units, no ammo gate.
      // Cannon / Grenadier / Doublegun / Bomber / Scout / Tank / Drone:
      // melee fallback (10 dmg) covers the ammo-empty case.
      return true
    }
    return false
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
        this.spheres.push(new SphereDefender(this.scene, x, y, 'player'))
        playEventSfx('structure_placement')
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
        this.defenderUnits.push(new SpriteUnit(this.scene, 'dog', x, y, 'defender', 'player'))
        playEventSfx('structure_placement')
        return false
      },
    }
  }

  private startRepairPlacement() {
    this.endPlacement()
    const color = Config.UNITS.repair.color
    const ghost = this.makeGhostRing(color, 12, 20)
    ghost.position.set(-400, 0, 1)
    this.scene.add(ghost)
    this.placement = {
      kind: 'repair',
      ghost, tint: null,
      zoneXMin: Config.WORLD.LEFT,
      zoneXMax: Config.DEFENDER_MAX_X,
      marginTop: 0, marginBottom: 0,
      onPlace: (x, y) => {
        if (this.isCellOccupied(x, y)) return false
        const cost = Config.UNITS.repair.cost
        if (!this.buildPhase || !this.buildPhase.spendCredits(cost)) return false
        this.defenderUnits.push(new SpriteUnit(this.scene, 'repair', x, y, 'defender', 'player'))
        playEventSfx('structure_placement')
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
        this.attackerUnits.push(new SpriteUnit(this.scene, type, x, y, 'attacker', 'player'))
        playEventSfx('structure_placement')
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
    for (const p of this.medicPads) {
      if (p.isDead) continue
      if (Math.abs(p.worldX - x) < E && Math.abs(p.worldY - y) < E) return true
    }
    for (const p of this.repairPads) {
      if (p.isDead) continue
      if (Math.abs(p.worldX - x) < E && Math.abs(p.worldY - y) < E) return true
    }
    for (const b of this.ammoBoxes) {
      if (b.isDead) continue
      if (Math.abs(b.worldX - x) < E && Math.abs(b.worldY - y) < E) return true
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
    for (const p of this.medicPads) p.animate(delta)
    for (const t of this.tethers) t.update(delta)
    for (const p of this.repairPads) p.animate(delta)
    for (const t of this.repairTethers) t.update(delta)
    for (const b of this.ammoBoxes) b.animate(delta)
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
    // Re-apply the HUD-aware Y offset on resize. We preserve any user pan
    // offset by computing the DELTA between the new and old base offsets
    // and shifting the camera by that delta — so a panned camera stays
    // visually anchored relative to the world.
    const oldBase = this.cameraBaseY
    const newBase = this.computeCameraYOffset(halfH)
    this.camera.position.y += (newBase - oldBase)
    this.cameraBaseY = newBase
    this.camera.updateProjectionMatrix()
  }

  // Tracks the HUD-aware base camera Y (what camera.position.y would be
  // with zero user pan applied). Used so resize handlers can shift the
  // camera by the delta without resetting the user's pan offset.
  private cameraBaseY = 0

  // Compute the camera Y shift needed to push the world content below the
  // floating HUD strip. The HUD covers the top ~--hud-top-h pixels of the
  // viewport; without this shift, the world (centered at origin) renders
  // with its top edge BEHIND the HUD tiles, hiding the top row of defender
  // pieces. We shift the camera to look at a point BELOW origin so the
  // world appears UP — its top edge aligns with the HUD bottom edge.
  //
  // Three.js ortho projection: a world point at Y=py projects to screen
  // y_screen = h * (halfH - py + camY) / (2*halfH).
  //
  // Solve for camY such that world TOP (py = WORLD.TOP = 200) lands at
  // screen y_screen = hudPx:
  //   hudPx / h = (halfH - 200 + camY) / (2 * halfH)
  //   camY = 2 * halfH * hudPx / h - halfH + 200
  private computeCameraYOffset(halfH: number): number {
    const hudCss = getComputedStyle(document.documentElement)
      .getPropertyValue('--hud-top-h').trim()
    const hudPx = parseInt(hudCss) || 195
    const offset = (2 * halfH * hudPx / window.innerHeight) - halfH + Config.WORLD.TOP
    this.cameraBaseY = offset
    return offset
  }

  private onWheel = (e: WheelEvent) => {
    // Don't capture wheel events fired inside HUD overlays — they need to
    // scroll naturally (side picker, how-to-play expander, combat log,
    // future settings panels, etc.). Without this guard, preventDefault()
    // here blocks the browser's native scroll on every HUD overlay.
    if ((e.target as HTMLElement | null)?.closest?.('#hud')) return
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
            // Walls don't have a compass rose (no fire arcs to add) — repurpose
            // right-click to rotate the laser barrier 90° instead. Lets the
            // player run a wall horizontally across the bottom of a column or
            // vertically along its edge.
            if (s.type === 'wall') {
              s.rotateWall()
              return
            }
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

  // Click on a placed sphere, cyborg, dog, or structure to remove and
  // refund it. Returns true if something was refunded (caller should
  // skip normal placement logic).
  //
  // Type-guard rule (S17.9): if a placement session is active (either
  // a mobile-unit Game.placement OR a structure BuildPhase.selectedType),
  // ONLY a piece of the matching type can be refunded by clicking. A
  // click on a different-typed piece is ignored, so accidentally placing
  // a Dog on a Laser cannot wipe the Laser. Free-click refund (no
  // placement active) still works on any piece type.
  private tryRefund(x: number, y: number): boolean {
    const REFUND_RADIUS_SQ = 35 * 35
    // Resolve the "active type" for this click. Three exclusive states:
    //   placementKind  -> mobile piece in flight (sphere / cyborg / dog / etc.)
    //   structureType  -> structure tile selected in BuildPhase
    //   neither         -> free click, any piece is refundable
    const placementKind = this.placement?.kind ?? null
    const structureType = this.buildPhase?.getSelectedType() ?? null

    // Spheres. Match only if we're actively placing a sphere (or free click).
    for (let i = 0; i < this.spheres.length; i++) {
      const s = this.spheres[i]
      const dx = s.worldX - x, dy = s.worldY - y
      if (dx * dx + dy * dy < REFUND_RADIUS_SQ) {
        // Block cross-type refund. If something else is selected, the
        // click on this sphere falls through to nothing.
        if (placementKind !== null && placementKind !== 'sphere') return false
        if (structureType !== null) return false
        this.spheres.splice(i, 1)
        this.scene.remove(s.mesh)
        this.buildPhase?.addCredits(SPHERE_COST)
        playEventSfx('refund')
        return true
      }
    }
    // Defender mobile units (dog, repair). Match by u.type === placementKind.
    for (let i = 0; i < this.defenderUnits.length; i++) {
      const u = this.defenderUnits[i]
      const dx = u.worldX - x, dy = u.worldY - y
      if (dx * dx + dy * dy < REFUND_RADIUS_SQ) {
        if (placementKind !== null && placementKind !== u.type) return false
        if (structureType !== null) return false
        this.defenderUnits.splice(i, 1)
        this.scene.remove(u.mesh)
        this.buildPhase?.addCredits(Config.UNITS[u.type].cost)
        playEventSfx('refund')
        return true
      }
    }
    // Attacker units (cyborg variants). Match by u.type === placementKind.
    for (let i = 0; i < this.attackerUnits.length; i++) {
      const u = this.attackerUnits[i]
      const dx = u.worldX - x, dy = u.worldY - y
      if (dx * dx + dy * dy < REFUND_RADIUS_SQ) {
        if (placementKind !== null && placementKind !== u.type) return false
        if (structureType !== null) return false
        this.attackerUnits.splice(i, 1)
        this.scene.remove(u.mesh)
        this.attCredits += Config.UNITS[u.type].cost
        this.hud.setAttCredits(this.attCredits)
        playEventSfx('refund')
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
        // Structure refund only when the active selection is the SAME
        // structure type. A different structure type, or any active
        // mobile placement, blocks the click.
        if (placementKind !== null) return false
        if (structureType !== null && structureType !== s.type) return false
        structs.splice(i, 1)
        s.dispose()
        this.buildPhase?.addCredits(Config.STRUCTURES[s.type].cost)
        // Selection STAYS so the player can immediately place a new piece
        // of the same type elsewhere. The skip-next-click tells BuildPhase
        // to ignore the click that's about to bubble up from this mousedown.
        // Without it BuildPhase would auto-replace the structure on the
        // very cell we just emptied, defeating the refund.
        this.buildPhase?.requestSkipNextClick()
        if (this.editingStructure === s) this.closeCompassRose()
        playEventSfx('refund')
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
    this.mcc?.dispose()
    stopMusic()
    this.buildPhase?.cleanup()
    this.endPlacement()
    this.removeZoneTint('att')
    this.removeZoneTint('def')
    for (const s of this.spheres) this.scene.remove(s.mesh)
    this.spheres = []
    for (const g of this.pendingGrenades) g.dispose()
    this.pendingGrenades = []
    for (const p of this.medicPads) p.dispose()
    this.medicPads = []
    for (const t of this.tethers) t.dispose()
    this.tethers = []
    for (const p of this.repairPads) p.dispose()
    this.repairPads = []
    for (const t of this.repairTethers) t.dispose()
    this.repairTethers = []
    for (const b of this.ammoBoxes) b.dispose()
    this.ammoBoxes = []
    this.renderer.dispose()
    this.scene.clear()
    this.hud?.dispose()
  }
}
