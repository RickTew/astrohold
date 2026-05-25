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

// Player faction + role choice from the side picker. Faction is currently
// visual-only — the playable roster is determined by role, since both
// factions share towers/power core and the movable cyborg/robot mobile
// units don't have cross-faction sprite sets yet.
export type Faction = 'robot' | 'cyborg'
export type Role = 'defender' | 'attacker'

export const Config = {
  WORLD: { LEFT: -600, RIGHT: 600, TOP: 200, BOTTOM: -200 },
  DEFENDER_MAX_X: -200,
  ATTACKER_MIN_X: 200,
  GRID_CELL: 50,
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
  // S17.12 sphere overhaul. Sphere is now MOBILE (slow speed). It knows
  // it is a walking bomb: while it has ammo, it fires from current
  // position; once out of ammo, it rolls toward the nearest cyborg and
  // detonates on adjacency. The detonation is its existing on-death
  // self-destruct AoE (defender side), so the suicide rush slots
  // cleanly into the existing mechanic. Speed 35 is intentionally low
  // (vs Hulk's 45) so the sphere is a slow rolling threat, not a sprinter.
  SPHERE: { cost: 100, hp: 300, damage: 25, range: 300, sightRange: 400, apBudget: 3, ammo: 8, speed: 35 },

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
    turret:  { cost: 30, hp: 80,  damage: 25, range: 250, fireInterval: 2, apBudget: 1, aoeRadius: 0,  ammo: 6, label: 'Turret 30cr' },
    cannon:  { cost: 60, hp: 120, damage: 40, range: 280, fireInterval: 4, apBudget: 1, aoeRadius: 45, ammo: 4, label: 'Cannon 60cr' },
    // Bomber — mid-range proximity-trap thrower. Ammo 3 = three bombs per
    // game total. Combined with the one-bomb-on-field rule this means the
    // defender Bomber is a deliberate placement choice, not a turret.
    bomber:  { cost: 70, hp: 100, damage: 20, range: 200, fireInterval: 4, apBudget: 1, aoeRadius: 65, ammo: 3, label: 'Bomber 70cr' },
    wall:    { cost: 20, hp: 300, damage: 0,  range: 0,   fireInterval: 0, apBudget: 0, aoeRadius: 0,  ammo: 0, label: 'Wall   20cr' },
    // Sentry — heavy-armor turret (the art is a tracked vehicle with gun
    // arms — reads as a tower, not a wall). Tankier than a tower (HP 150
    // vs 80) but shorter range and slightly less ammo so it isn't a strict
    // upgrade. Originally shipped at HP 200 — balance pass showed that
    // combined with repair-bot healing it became effectively unkillable;
    // dropped to 150 (~2× tower HP at 2× cost) for honest value.
    sentry:  { cost: 60, hp: 150, damage: 25, range: 200, fireInterval: 2, apBudget: 1, aoeRadius: 0,  ammo: 5, label: 'Sentry 60cr' },
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
  },

  UNITS: {
    // ammo = D&D-style shots-per-game (see STRUCTURES comment above). When
    // 0, the unit is inert and falls through to move-only or hold.
    scout:     { cost: 20, hp: 120, speed: 130, damage: 10, range: 280, sightRange: 360, aoeRadius: 0,  apBudget: 3, ammo: 6, label: 'Scout',     color: 0x4488ff },
    tank:      { cost: 50, hp: 200, speed: 44,  damage: 25, range: 200, sightRange: 260, aoeRadius: 0,  apBudget: 3, ammo: 5, label: 'Tank',      color: 0xff4444 },
    bomber:    { cost: 60, hp: 80,  speed: 70,  damage: 25, range: 160, sightRange: 240, aoeRadius: 70, apBudget: 3, ammo: 3, label: 'Bomber',    color: 0xff8800 },
    drone:     { cost: 30, hp: 20,  speed: 160, damage: 8,  range: 350, sightRange: 420, aoeRadius: 0,  apBudget: 3, ammo: 8, label: 'Drone',     color: 0x44ffff },
    // Hand-cannon cyborg — heavy direct-fire infantry, slower than scout, stronger hit.
    cannon:    { cost: 70, hp: 180, speed: 55,  damage: 35, range: 240, sightRange: 320, aoeRadius: 0,  apBudget: 3, ammo: 4, label: 'Cannon',    color: 0xffaa55 },
    // Grenadier — AoE thrower without kamikaze. Bomber-tier damage with smaller radius.
    grenadier: { cost: 50, hp: 110, speed: 75,  damage: 20, range: 180, sightRange: 280, aoeRadius: 60, apBudget: 3, ammo: 3, label: 'Grenadier', color: 0x88dd44 },
    // Double Gun — dual hand-cannons, highest direct-fire damage, costlier and slightly squishier than Cannon.
    doublegun: { cost: 90, hp: 160, speed: 65,  damage: 45, range: 230, sightRange: 300, aoeRadius: 0,  apBudget: 3, ammo: 5, label: 'Double Gun',color: 0xff8866 },
    // Combat Dog — DEFENDER mobile unit. Fast and now armed: the sprite
    // has a gun mounted on top so it should shoot. range 150 + damage 15
    // = short-medium harasser. Closes the gap to flank cyborgs then fires.
    dog:       { cost: 40, hp: 80,  speed: 90,  damage: 15, range: 150, sightRange: 280, aoeRadius: 0,  apBudget: 3, ammo: 5, label: 'Dog',        color: 0x4488aa },
    // Cyborg Sniper — precision-strike specialist. Longest range in the game
    // (400 = covers half the world from spawn) and a single, heavy round
    // (ammo 1) that one-shots any single defender structure. Squishy and
    // slow — after firing the sniper is just a slow target. Use the shot
    // wisely: the cannon turret (HP 120) is the natural target.
    sniper:    { cost: 90, hp: 80, speed: 50,  damage: 150, range: 350, sightRange: 400, aoeRadius: 0, apBudget: 2, ammo: 1, label: 'Sniper',     color: 0x99bb66 },
    // Cyborg Hulk — exo-suited melee bruiser. Highest HP and damage in the
    // roster, slowest speed, very short range (must close to melee). Ammo
    // budget is low so each punch matters.
    // Slam (special, 2 AP): hits everything in the 3-cell-wide wedge one
    // tile forward. Lower per-target damage than a punch (40 vs 55) but
    // can hit up to 3 enemies at once. `slamAmmo` is a separate counter
    // from punch ammo — the Hulk picks his moments.
    hulk:      { cost: 100, hp: 280, speed: 45, damage: 55, range: 70,  sightRange: 220, aoeRadius: 0, apBudget: 2, ammo: 5, slamDamage: 40, slamAmmo: 3, label: 'Hulk',       color: 0x886622 },
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
    stalker:   { cost: 70, hp: 130, speed: 60,  damage: 40, range: 70,  sightRange: 220, aoeRadius: 0,  apBudget: 2, ammo: 99, label: 'Stalker',   color: 0xaaaaaa },
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
