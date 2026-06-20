// Team tints (player blue / AI red) were added for same-faction matchups
// where both teams would render the same sprites; the tint disambiguated
// ownership. We simplified to 2 cards which removed same-faction matchups,
// so the team tint now just MUDDIES the per-piece tints (grenadier green ×
// AI red = olive, etc.). Identity is communicated by zone position: player
// is on the side they picked, AI is on the opposite side.
// Both tints set to identity (white) so the multiplication is a no-op.
// Restore non-white values here if same-faction matchups return.
export type Team = 'player' | 'ai'
export const TEAM_TINT: Record<Team, number> = {
  player: 0xffffff,
  ai:     0xffffff,
}

// Player faction + role choice from the side picker. Faction drives the
// cosmetic identity (name, hero, music, voice) AND, where cross-faction
// sprite sets exist, the unit ART (see FACTION_ART in SpriteUnit.ts).
// Robots/Cyborgs share the role-bound roster; the Human faction (S22d)
// fields its own mobile units (warrior + medic art) reusing existing
// attacker stat blocks. Role is independent of faction - the side picker
// lets any faction take either role.
export type Faction = 'robot' | 'cyborg' | 'human'
export type Role = 'defender' | 'attacker'

// ─── STAGE / MAP DEFINITION ───────────────────────────────────────────────
// S22c: the "set the stage" seam. A match's board is one StageDef. The lobby
// will eventually pick or generate one ("Planet Zooboobo", random, etc.); for
// now there is a single hand-authored Map #1. All world geometry below
// (WORLD bounds, zone dividers, cell size, core position, theme colors) is
// DERIVED from this object, so swapping the stage swaps the whole board with
// no other edits. See the project_lobby_configurable_stage memory.
//
// Placement is rule-driven via canPlace() rather than hardcoded x-bounds, so
// a future lobby can offer 'zones' / 'coreRadius' / 'half' / 'free' without a
// geometry refactor. Obstacles (blocking pixel-art cover: rocks, wreckage)
// will be added to StageDef later and fed into canPlace + movement/targeting.
export type PlacementMode = 'zones' | 'coreRadius' | 'half' | 'free'
export interface StageDef {
  name: string
  cols: number          // board width in cells
  rows: number          // board height in cells (keep EVEN so a grid line
                        // sits on y=0 for the Power Core's centered 2x2)
  cell: number          // world units per cell
  defenderCols: number  // buildable columns from the LEFT edge (defender)
  attackerCols: number  // buildable columns from the RIGHT edge (attacker)
  placement: PlacementMode
  theme: {
    background: number       // scene clear color behind the floor
    floor: number            // flat procedural floor color
    grid: number             // grid line color
    defenderBorder: number   // defender base outline (blue)
    attackerBorder: number   // attacker base outline (red)
  }
}

// Map #1. cols*cell = 1500 wide, rows*cell = 900 tall. 6 defender + 8 middle
// + 6 attacker columns; 12 rows (even). Bigger than the old 16x6 so the
// camera reads more zoomed out and each base has real room to build.
export const STAGE: StageDef = {
  name: 'Proving Ground',
  cols: 20,
  rows: 12,
  cell: 75,
  defenderCols: 6,
  attackerCols: 6,
  placement: 'zones',
  theme: {
    background: 0x2a2620,
    floor: 0x39322a,
    grid: 0xaabbcc,
    defenderBorder: 0x00ddff,
    attackerBorder: 0xff4488,
  },
}

const STAGE_W = STAGE.cols * STAGE.cell  // 1500
const STAGE_H = STAGE.rows * STAGE.cell  // 900

// Territory rule for one cell. Occupancy (core/structures/units) is checked
// separately by the placement code; this is purely "is this cell in the side's
// buildable territory" per the active placement mode.
export function canPlace(side: Role, col: number, row: number): boolean {
  if (col < 0 || col >= STAGE.cols || row < 0 || row >= STAGE.rows) return false
  switch (STAGE.placement) {
    case 'half':
      return side === 'defender' ? col < STAGE.cols / 2 : col >= STAGE.cols / 2
    case 'free':
      return true
    case 'zones':
    case 'coreRadius':  // coreRadius rule not implemented yet; falls back to zones
    default:
      return side === 'defender'
        ? col < STAGE.defenderCols
        : col >= STAGE.cols - STAGE.attackerCols
  }
}

export const Config = {
  WORLD: { LEFT: -STAGE_W / 2, RIGHT: STAGE_W / 2, TOP: STAGE_H / 2, BOTTOM: -STAGE_H / 2 },
  // Zone dividers derived from the stage's buildable-column counts.
  DEFENDER_MAX_X: -STAGE_W / 2 + STAGE.defenderCols * STAGE.cell,
  ATTACKER_MIN_X:  STAGE_W / 2 - STAGE.attackerCols * STAGE.cell,
  GRID_CELL: STAGE.cell,

  // S21 pixel-perfect contract. PPWU = pixels per world unit at base zoom.
  // The internal renderer canvas is sized so 1 wu = PPWU integer pixels,
  // regardless of the browser viewport. The canvas element is then CSS
  // scaled to fit the window with `image-rendering: pixelated` so the
  // browser nearest-neighbor stretches without blur. World gameplay code
  // stays in float wu; the render loop snaps each sprite/projectile to
  // the nearest 1/PPWU wu so on-screen pixels are integer.
  //
  // Don't change PPWU casually — every sprite asset is sized assuming this
  // value, and changing it requires re-tuning sprite scales OR re-exporting
  // PNGs. See docs/STATS.md "S21" entry + docs/PIXEL_PERFECT.md.
  PPWU: 2,
  // World width = stage width (cols * cell). Visible vertical extent depends
  // on window aspect (camera adapts). PPWU × WORLD_WIDTH_WU = base internal
  // canvas width. A wider stage frames more world = reads as zoomed out.
  WORLD_WIDTH_WU: STAGE_W,
  START_CREDITS: 1000,  // testing budget — production should be lower (suggest 200-300)
  // ─── S17.15 credit economy ─────────────────────────────────────────
  // Both teams now start with the SAME base credit budget. Earlier
  // sessions stacked ATTACKER_CREDIT_BONUS (×1.3) on top of an
  // AI_CREDIT_BONUS (×1.5) which gave the AI cyborg ~1950cr against
  // a player-defender's 1000cr (nearly 2x). Telemetry confirmed
  // that gap was the structural imbalance behind the 0% defender
  // win rate. Both bonuses now zero. The AI credit multiplier is
  // driven by the user-selected Difficulty (see src/game/Difficulty.ts):
  //   easy   AI × 0.75 (smaller AI army)
  //   normal AI × 1.00 (parity)
  //   hard   AI × 1.25 (harder fight)
  // Player credits are unaffected by difficulty.
  AI_CREDIT_BONUS: 0,
  ATTACKER_CREDIT_BONUS: 0,
  TURN_INTERVAL: 0.65,   // seconds per battle turn — also drives unit move speed
  // Cost to add an extra fire-arc facing to a directional structure (turret /
  // bomber / cannon / gun / laser). Player opens the compass-rose popup by
  // shift+clicking the structure during BUILD. Flat per-direction cost — a
  // 4-arc tower runs 30 base + 3*30 = 120cr total.
  EXTRA_FACING_COST: 30,
  // Power Core uses a 2x2 footprint (4 cells) per the size rule: small pieces
  // get one cell, large pieces step up to the next tier (4 cells). The (X, Y)
  // here is the CENTROID of the 2x2 block. It sits on a grid INTERSECTION,
  // not a cell center. X is DERIVED as one cell in from the left edge
  // (WORLD.LEFT + cell), which lands on a vertical grid line; Y = 0 sits on
  // the horizontal midline (STAGE.rows is even), so the 2x2 covers the two
  // center rows and is vertically centered. With Map #1 (cell 75, left -750)
  // that is (-675, 0) covering cells (0,5)(1,5)(0,6)(1,6).
  // RENDER_SCALE: the core's billboard renders at native PNG width * this
  // factor. Kept an INTEGER so one source texel maps to a whole block of
  // screen pixels (stays pixel-perfect crisp, identical pixel look, just
  // bigger). The core PNG is ~73% transparent padding (art is 34x59 inside
  // a 124 canvas), so native 1:1 renders it smaller than any unit. 2x makes
  // it read as the dominant 2x2 objective. Visual only -- occupancy/footprint
  // math reads GRID_CELL, not this, so the core still occupies a clean 2x2.
  POWER_CORE: { X: -STAGE_W / 2 + STAGE.cell, Y: 0, HP: 150, RADIUS: 18, RENDER_SCALE: 2 },

  // S17.21 unified death-explosion AoE. Every piece that detonates on
  // death (defender self-destruct, cyborg Hulk death blast) uses these
  // shared values so balance has ONE knob instead of two.
  //
  //   radius 75: cardinal neighbors (50 units) and diagonal neighbors
  //              (~71 units) are inside; 2-cells-away cardinal (100
  //              units) is outside. So an explosion damages only the
  //              eight adjacent cells. This makes cyborg clustering on
  //              packed defender lines meaningful (chain detonations)
  //              and lets defenders space towers one cell apart to
  //              avoid the chain.
  //   damage 25: light per-target hit. Won't usually one-shot a piece
  //              at full HP. Tune up/down after observation.
  DEATH_EXPLOSION: { radius: 75, damage: 25 },

  // Sphere defender — values were previously hardcoded in SphereDefender.ts.
  // Centralized here so the turn system can read apBudget alongside everything else.
  // Damage bumped 10→25 so the sphere actually deters cyborgs (was being
  // ignored because by the time it fired, multiple cyborgs had already
  // closed in for free).
  // S17.12 sphere overhaul. Sphere is now MOBILE (slow speed). It knows
  // it is a walking bomb: while it has ammo, it fires from current
  // position; once out of ammo, it rolls toward the nearest cyborg and
  // detonates on adjacency. The detonation is its existing on-death
  // self-destruct AoE (defender side), so the suicide rush slots
  // cleanly into the existing mechanic. Speed 35 is intentionally low
  // (vs Hulk's 45) so the sphere is a slow rolling threat, not a sprinter.
  // S17.16: speed bumped 35 -> 110 per user spec ("sphere is the most
  // mobile of them all"). Now clearly above Dog at 90. Ammo equalized
  // to 5 (BASE_AMMO baseline). The 8-shot pool is gone; sphere will
  // hit suicide-rush mode sooner, making it a more aggressive walking
  // bomb instead of a stationary turret that eventually wanders.
  SPHERE: { cost: 100, hp: 300, damage: 25, range: 300, sightRange: 400, apBudget: 3, ammo: 5, speed: 110 },

  // Per-piece Action Point budgets used by the plan-then-play turn system.
  // Walls/mines stay passive (apBudget 0 → reveal skips them). Turrets/cannons
  // get 1 fire-action per turn, auto-fired by the reveal engine.
  // defense/dog/gun/laser/signal are PREVIEW pieces — single-angle
  // (unknown.png) renders dropped in so the player can evaluate visuals
  // before committing to full 8-direction art. Stats are placeholder.
  STRUCTURES: {
    // Tower damage 15→25, range 200→250 — defenders were getting steamrolled
    // because their first shot didn't kill anything and cyborgs closed in
    // quickly. Stronger tower means each one actually threatens the wave.
    // ammo = D&D-style shots-per-game. Once 0, the piece is inert (its
    // weapon is spent). Drives strategic resource-allocation — towers can't
    // hold the line forever, bombers can't carpet the map.
    turret:  { cost: 30, hp: 80,  damage: 25, range: 250, fireInterval: 2, apBudget: 1, aoeRadius: 0,  ammo: 5, label: 'Turret 30cr' },
    // Phaser (S17.19 rename of internal type 'cannon'). Fires a piercing
    // beam along its facing direction. Every enemy in the cardinal
    // lane takes the listed damage. aoeRadius left at 0 since the beam
    // is per-target, not an explosion. Range 280 keeps the longest
    // direct-fire profile on the defender side.
    // S17.20 Phaser range bumped 280 -> 330 (one cell longer per user
    // request). Beam length follows. Damage stays 40 per enemy in lane.
    cannon:  { cost: 60, hp: 120, damage: 36, range: 330, fireInterval: 4, apBudget: 1, aoeRadius: 0, ammo: 5, label: 'Phaser' },
    // Bomber — mid-range proximity-trap thrower. Ammo 3 = three bombs per
    // game total. Combined with the one-bomb-on-field rule this means the
    // defender Bomber is a deliberate placement choice, not a turret.
    // Blastor (S20 rename, was Mortar in S17.19). Internal type stays
    // 'bomber'; player-facing label distinguishes the robot-side
    // proximity-trap thrower from the cyborg-side Bomber unit.
    // "Blastor" reads more robotic than the historical "Mortar".
    bomber:  { cost: 70, hp: 100, damage: 20, range: 200, fireInterval: 4, apBudget: 1, aoeRadius: 65, ammo: 5, label: 'Blastor 70cr' },
    wall:    { cost: 20, hp: 300, damage: 0,  range: 0,   fireInterval: 0, apBudget: 0, aoeRadius: 0,  ammo: 0, label: 'Wall   20cr' },
    // Sentry — heavy-armor turret (the art is a tracked vehicle with gun
    // arms — reads as a tower, not a wall). Tankier than a tower (HP 150
    // vs 80) but shorter range and slightly less ammo so it isn't a strict
    // upgrade. Originally shipped at HP 200 — balance pass showed that
    // combined with repair-bot healing it became effectively unkillable;
    // dropped to 150 (~2× tower HP at 2× cost) for honest value.
    // S17.16: Sentry is now MOBILE. Tracked vehicle art reads as a slow
    // crawler so speed 40 fits (between Hulk 45 and a stationary 0).
    // Sentry advances toward the cyborg push when no enemy is in range,
    // then plants itself when something enters its fire arc. Defenders
    // now have THREE mobile pieces: Dog (90), Repair (65), Sentry (40).
    sentry:  { cost: 60, hp: 150, damage: 25, range: 200, fireInterval: 2, apBudget: 1, aoeRadius: 0,  ammo: 5, speed: 40, label: 'Sentry 60cr' },
    mine:    { cost: 20, hp: 50,  damage: 60, range: 60,  fireInterval: 0, apBudget: 0, aoeRadius: 0,  ammo: 1, label: 'Mine   20cr' },
    // Shield generator. HUD tile labels this as SHIELD and prices it at
    // 50cr. Cost aligned to 50 so the BUILD ledger matches what the
    // shop displays. Currently NO active shield mechanic is wired:
    // the piece just sits there as a 50cr 80hp blocker. See open
    // questions in docs/STATS.md re: the aura design (damage reduction
    // for adjacent allies, shield HP pool, or visual-only dome).
    defense: { cost: 50, hp: 80,  damage: 0,  range: 0,   fireInterval: 0, apBudget: 0, aoeRadius: 0,  ammo: 0, label: 'Shield 50cr (preview)' },
    gun:     { cost: 30, hp: 80,  damage: 15, range: 200, fireInterval: 2, apBudget: 1, aoeRadius: 0,  ammo: 5, label: 'Gun 30cr (preview)' },
    // Laser — twin-laser direct-fire turret. Promoted out of "preview" in
    // S17.2: stats kept (damage 25, range 300 = longest direct-fire on the
    // defender side, ammo 5). HP 70 — squishier than tower (80) so it
    // demands repair support to last.
    laser:   { cost: 40, hp: 70,  damage: 25, range: 300, fireInterval: 3, apBudget: 1, aoeRadius: 0,  ammo: 5, label: 'Laser  40cr' },
    // Signal — EMP emitter (satellite dish art). NO direct damage. Auto-
    // targets the cyborg currently FURTHEST INSIDE the middle map and stuns
    // them for 2 turns (no fire, no move). 2 ammo = 2 EMP strikes per game
    // per Signal. Range 500 covers the full middle corridor. Designed as a
    // strategic counter to back-line snipers/hulks before they engage.
    signal:  { cost: 70, hp: 80,  damage: 0,  range: 500, fireInterval: 0, apBudget: 1, aoeRadius: 0,  ammo: 2, label: 'Signal 70cr (EMP)' },
    // S17.16 cyborg-side mine. Same stats as the defender mine but
    // placed in the attacker zone and triggered when a DEFENDER mobile
    // unit (sphere, dog, repair) steps within MINE_DETECT_RADIUS.
    // Config entry + HUD tile are wired now; full placement-flow + side-
    // aware trigger logic is the next push (BuildPhase is defender-only
    // today, so cyborg structures need a new placement path).
    cyborg_mine: { cost: 20, hp: 50, damage: 60, range: 60, fireInterval: 0, apBudget: 0, aoeRadius: 0, ammo: 1, label: 'Cyborg Mine 20cr' },
  },

  UNITS: {
    // ammo = D&D-style shots-per-game (see STRUCTURES comment above). When
    // 0, the unit is inert and falls through to move-only or hold.
    // S17.16: all combat pieces start at ammo: 5 (BASE_AMMO baseline).
    // Exceptions (mine, signal, walls/shields) stay at their mechanic-
    // dictated values. Sniper jumps from 1 to 5 and Stalker drops from
    // 99 to 5. The user wants observation-then-tuning, not unique
    // starting values for each piece.
    scout:     { cost: 20, hp: 120, speed: 130, damage: 10, range: 280, sightRange: 360, aoeRadius: 0,  apBudget: 3, ammo: 5, label: 'Scout',     color: 0x4488ff },
    tank:      { cost: 50, hp: 200, speed: 44,  damage: 25, range: 200, sightRange: 260, aoeRadius: 0,  apBudget: 3, ammo: 5, label: 'Tank',      color: 0xff4444 },
    bomber:    { cost: 60, hp: 80,  speed: 70,  damage: 25, range: 160, sightRange: 240, aoeRadius: 70, apBudget: 3, ammo: 4, label: 'Bomber',    color: 0xff8800 },
    drone:     { cost: 30, hp: 20,  speed: 160, damage: 8,  range: 350, sightRange: 420, aoeRadius: 0,  apBudget: 3, ammo: 5, label: 'Drone',     color: 0x44ffff },
    cannon:    { cost: 70, hp: 180, speed: 55,  damage: 35, range: 240, sightRange: 320, aoeRadius: 0,  apBudget: 3, ammo: 4, label: 'Cannon',    color: 0xffaa55 },
    grenadier: { cost: 50, hp: 110, speed: 75,  damage: 20, range: 180, sightRange: 280, aoeRadius: 60, apBudget: 3, ammo: 4, label: 'Grenadier', color: 0x88dd44 },
    // Double Gun — dual hand-cannons. Fires TWO shots per turn (RevealPhase
    // schedules the second projectile 80ms after the first). Per-shot damage
    // is halved (23) so total burst ~46 matches the prior single-shot 45,
    // i.e. same throughput with a burst-weapon feel. Total game damage budget
    // is therefore unchanged (5 turns × 2 shots × 23 ≈ 230).
    doublegun: { cost: 90, hp: 160, speed: 65,  damage: 23, range: 230, sightRange: 300, aoeRadius: 0,  apBudget: 3, ammo: 4, label: 'Double Gun',color: 0xff8866 },
    // Combat Dog — DEFENDER mobile unit. Fast and now armed: the sprite
    // has a gun mounted on top so it should shoot. range 150 + damage 15
    // = short-medium harasser. Closes the gap to flank cyborgs then fires.
    dog:       { cost: 40, hp: 80,  speed: 90,  damage: 15, range: 150, sightRange: 280, aoeRadius: 0,  apBudget: 3, ammo: 5, label: 'Dog',        color: 0x4488aa },
    // Cyborg Sniper — precision-strike specialist. Longest range in the game
    // (400 = covers half the world from spawn) and a single, heavy round
    // (ammo 1) that one-shots any single defender structure. Squishy and
    // slow — after firing the sniper is just a slow target. Use the shot
    // wisely: the cannon turret (HP 120) is the natural target.
    sniper:    { cost: 90, hp: 80, speed: 50,  damage: 110, range: 350, sightRange: 400, aoeRadius: 0, apBudget: 2, ammo: 4, label: 'Sniper',     color: 0x99bb66 },
    // Cyborg Hulk — exo-suited melee bruiser. Highest HP and damage in the
    // roster, slowest speed, very short range (must close to melee). Ammo
    // budget is low so each punch matters.
    // Slam (special, 2 AP): hits everything in the 3-cell-wide wedge one
    // tile forward. Lower per-target damage than a punch (40 vs 55) but
    // can hit up to 3 enemies at once. `slamAmmo` is a separate counter
    // from punch ammo — the Hulk picks his moments.
    hulk:      { cost: 100, hp: 400, speed: 45, damage: 55, range: 70,  sightRange: 220, aoeRadius: 0, apBudget: 2, ammo: 5, slamDamage: 40, slamAmmo: 3, label: 'Hulk',       color: 0x886622 },
    // Cyborg Medic — support unit with three heal modes (med-pack throw,
    // deployable medic-pad, tether). Fragile (HP 50) so positioning matters.
    // `damage` repurposed as heal amount per tick; `range` is throw range
    // (3 cells); `ammo` is the SHARED heal-charge pool: throw=1, pad-deploy=2,
    // tether tick=1 per turn. `allowDiagonalMove: true` per the spec.
    medic:     { cost: 70, hp: 50,  speed: 70,  damage: 30, range: 150, sightRange: 280, aoeRadius: 0,  apBudget: 3, ammo: 5, allowDiagonalMove: true, label: 'Medic',     color: 0xffffff },
    // Cyborg Stalker — cloaked melee unit. Spawns invisible (cyborg-side
    // ghost sprite at 35% opacity; defender targeting AI skips cloaked
    // units). Cloak drops permanently on Stalker's first damage-dealing
    // action — at that point the gloves are off, defenders lock on. The
    // mechanic creates a "stealth approach → commit to combat" decision:
    // delay swinging to get closer vs swing now and trade as a normal
    // tanky melee. Counter: AoE/splash still hits cloaked units
    // (geometry-based, not targeting-based). Unlimited fists like Hulk.
    // Stalker: melee-only, no ammo. Cloak is the bonus, not a finite
    // weapon pool. ammo:0 here is intentional; RevealPhase.executeAttack
    // treats stalker as meleeUnlimited (same as Hulk fists) so hits
    // never decrement and the ammo field stays at zero forever.
    // Compare to Hulk who DOES have meaningful ammo via slamAmmo (3).
    stalker:   { cost: 70, hp: 130, speed: 60,  damage: 40, range: 70,  sightRange: 220, aoeRadius: 0,  apBudget: 2, ammo: 0, label: 'Stalker',   color: 0xaaaaaa },
    // Cyborg Nerd / HACKER — support saboteur. No gun (damage 0); instead
    // his `ammo` is a pool of HACKS (2). When an enemy robot piece (tower or
    // mobile defender) is within `range` (200), he plays the space-ipad cast
    // and hacks it: for 3 reveals that piece turns traitor - it attacks other
    // robots, and cyborgs ignore it. Fragile (HP 60), so he hangs back behind
    // the front line. Behavior lives in RevealPhase (hack action); these are
    // just the numbers. `allowDiagonalMove` keeps him nimble while repositioning.
    hacker:    { cost: 80, hp: 60,  speed: 60,  damage: 0,  range: 200, sightRange: 320, aoeRadius: 0,  apBudget: 3, ammo: 2, allowDiagonalMove: true, label: 'Hacker',    color: 0x66ccff },
    // Robot Repair — defender-side support unit, the medic's structural twin.
    // Three repair modes: pack-throw, deployable repair-pad, weld-tether.
    // Targets are anything defender-side with HP — towers, walls, mines,
    // bombers, cannons, sphere, the Combat Dog, and the Power Core. `damage`
    // is repurposed as repair amount per tick. Diagonal-capable so it can
    // weave through structure clusters to reach a damaged piece.
    //
    // refillCharges (S17.13): separate pool from heal charges. When
    // adjacent to a friendly defender piece that has burned through
    // its ammo, the bot can give +1 ammo at the cost of 1 refillCharge.
    // 3 refills per docking trip. Must roll back to the Power Core to
    // restore both heal AND refill charges. Designed so an in-the-field
    // tower keeps firing as long as a repair bot is shuttling between
    // it and the core, but only one tower at a time before the bot
    // has to come back. By the time the trip completes the cyborg push
    // is usually already at the gate.
    repair:    { cost: 70, hp: 60,  speed: 65,  damage: 30, range: 150, sightRange: 280, aoeRadius: 0,  apBudget: 3, ammo: 5, refillCharges: 3, allowDiagonalMove: true, label: 'Repair',    color: 0xffffff },
  },
} as const

export type StructureType = keyof typeof Config.STRUCTURES
export type UnitType = keyof typeof Config.UNITS
