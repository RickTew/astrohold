export const Config = {
  WORLD: { LEFT: -600, RIGHT: 600, TOP: 200, BOTTOM: -200 },
  DEFENDER_MAX_X: -200,
  ATTACKER_MIN_X: 200,
  GRID_CELL: 50,
  START_CREDITS: 1000,  // testing budget — production should be lower (suggest 200-300)
  TURN_INTERVAL: 0.65,   // seconds per battle turn — also drives unit move speed
  // Power Core uses a 2x2 footprint (4 cells) per the size rule: small pieces
  // get one cell, large pieces step up to the next tier (4 cells). The (X, Y)
  // here is the CENTROID of the 2x2 block — it sits on a grid INTERSECTION,
  // not a cell center. With GRID_CELL=50 and WORLD.LEFT=-600 / BOTTOM=-200,
  // (-550, 0) is the corner where cols 0/1 meet rows 3/4, so the core covers
  // cells (0,3), (1,3), (0,4), (1,4).
  POWER_CORE: { X: -550, Y: 0, HP: 100, RADIUS: 18 },

  // Sphere defender — values were previously hardcoded in SphereDefender.ts.
  // Centralized here so the turn system can read apBudget alongside everything else.
  // Damage bumped 10→25 so the sphere actually deters cyborgs (was being
  // ignored because by the time it fired, multiple cyborgs had already
  // closed in for free).
  SPHERE: { cost: 100, hp: 300, damage: 25, range: 300, sightRange: 400, apBudget: 3 },

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
    turret:  { cost: 30, hp: 80,  damage: 25, range: 250, fireInterval: 2, apBudget: 1, label: 'Turret 30cr' },
    cannon:  { cost: 60, hp: 120, damage: 40, range: 280, fireInterval: 4, apBudget: 1, label: 'Cannon 60cr' },
    wall:    { cost: 20, hp: 300, damage: 0,  range: 0,   fireInterval: 0, apBudget: 0, label: 'Wall   20cr' },
    mine:    { cost: 20, hp: 50,  damage: 60, range: 60,  fireInterval: 0, apBudget: 0, label: 'Mine   20cr' },
    defense: { cost: 20, hp: 80,  damage: 0,  range: 0,   fireInterval: 0, apBudget: 0, label: 'Defense 20cr (preview)' },
    gun:     { cost: 30, hp: 80,  damage: 15, range: 200, fireInterval: 2, apBudget: 1, label: 'Gun 30cr (preview)' },
    laser:   { cost: 40, hp: 70,  damage: 25, range: 300, fireInterval: 3, apBudget: 1, label: 'Laser 40cr (preview)' },
    signal:  { cost: 20, hp: 50,  damage: 0,  range: 0,   fireInterval: 0, apBudget: 0, label: 'Signal 20cr (preview)' },
  },

  UNITS: {
    scout:     { cost: 20, hp: 120, speed: 130, damage: 10, range: 280, sightRange: 360, aoeRadius: 0,  apBudget: 3, label: 'Scout',     color: 0x4488ff },
    tank:      { cost: 50, hp: 200, speed: 44,  damage: 25, range: 200, sightRange: 260, aoeRadius: 0,  apBudget: 3, label: 'Tank',      color: 0xff4444 },
    bomber:    { cost: 60, hp: 80,  speed: 70,  damage: 35, range: 160, sightRange: 240, aoeRadius: 80, apBudget: 3, label: 'Bomber',    color: 0xff8800 },
    drone:     { cost: 30, hp: 20,  speed: 160, damage: 8,  range: 350, sightRange: 420, aoeRadius: 0,  apBudget: 3, label: 'Drone',     color: 0x44ffff },
    // Hand-cannon cyborg — heavy direct-fire infantry, slower than scout, stronger hit.
    cannon:    { cost: 70, hp: 180, speed: 55,  damage: 35, range: 240, sightRange: 320, aoeRadius: 0,  apBudget: 3, label: 'Cannon',    color: 0xffaa55 },
    // Grenadier — AoE thrower without kamikaze. Bomber-tier damage with smaller radius.
    grenadier: { cost: 50, hp: 110, speed: 75,  damage: 28, range: 220, sightRange: 280, aoeRadius: 65, apBudget: 3, label: 'Grenadier', color: 0x88dd44 },
    // Double Gun — dual hand-cannons, highest direct-fire damage, costlier and slightly squishier than Cannon.
    doublegun: { cost: 90, hp: 160, speed: 65,  damage: 45, range: 230, sightRange: 300, aoeRadius: 0,  apBudget: 3, label: 'Double Gun',color: 0xff8866 },
    // Combat Dog — DEFENDER mobile unit. Fast and now armed: the sprite
    // has a gun mounted on top so it should shoot. range 150 + damage 15
    // = short-medium harasser. Closes the gap to flank cyborgs then fires.
    dog:       { cost: 40, hp: 80,  speed: 90,  damage: 15, range: 150, sightRange: 280, aoeRadius: 0,  apBudget: 3, label: 'Dog',        color: 0x4488aa },
  },
} as const

export type StructureType = keyof typeof Config.STRUCTURES
export type UnitType = keyof typeof Config.UNITS
