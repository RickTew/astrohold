# AstroHold — Stats & Game Mechanics

Living balance document. Update as we tune. Aim: "like chess but not strict" —
for any strong ability on one side, the other side gets a comparable counter.

**Status:** Single-player D&D-style turn-based grid strategy is LIVE (session 20).
Numbers below are the current Config values. The turn-system transition is
complete. AP budgets still ship on every piece for future use, but the active
flow is BUILD then REVEAL (PLAN phase is currently skipped, see Turn flow).

**S21 changes since S20 (unvalidated):**
- **Diminishing-returns heal scaling.** Repeated heals on the same target decay: 100% / 75% / 50% / 25% / 0%. Streak resets if (a) the target takes a single hit >=25% of maxHp, or (b) 5 reveals pass without a heal landing on it. Applies to BOTH sides (Repair tether/pad/refill on defender; Medic tether/pad/throw on attacker). Fixes the cannon vs Repair stalemate where 10 dmg/turn was being cancelled by 20 heal/turn forever. Multi-repair emergency stacks still cover real damage spikes (5+ uncapped heals across multiple bots), light chip-damage loops decay away. Tether/weld auto-releases when the streak hits 0 so the bot can re-target.
- **Pixel-perfect render foundation.** PPWU=2 contract, locked internal canvas, render-time position snap, native PNG sizes used as world-unit render sizes. No per-piece SPRITE_SIZE_OVERRIDE / STRUCTURE_SPRITE_SIZE / SPHERE_SCREEN_SIZE constants. Sprites are crisp at any window size and zoom level. Does NOT affect balance numbers. See `docs/PIXEL_PERFECT.md` for the full contract.
- **Cell-vs-sprite question OPEN.** Sprites are 104-124 px native, cells are 50 wu, so sprites overflow cells visually. User wants cells sized as structural tile containers. Past attempt to scale the world 2.56x was too invasive. S22 first task: pick the right approach (see `project_session_21_wrap` memory).

**S20 changes since S19 (unvalidated — retest first task next session):**
- **Sniper damage 135 → 110** (-19%). Snipers were averaging ~821 damage / 5 kills per game across 6-game losing streak.
- **Power Core HP 100 → 150** (+50%). Defender often outdamaged cyborgs but still lost to a single core-hit one-shot.
- **Sniper shoot-and-move.** After firing, the sniper is flagged for forced relocation. Next default action moves toward the target instead of firing again; movement breaks the crouch (existing rule), so the turn after that is a fresh settle/fire cycle. Cycle: settle → fire → move → settle → fire (~1 shot per 3 turns vs 1 shot per turn pre-S20). Snipers now have to relocate between shots — the player knows where they are and the sniper "runs to a new spot."
- **Sentry double-shot at N/S targets.** When the Sentry's target has `|dy| > |dx|`, a second identical projectile fires 180ms after the first. E/W targets keep the single shot. Mirrors the PixelLab south-anim where the top gun swivels R→L→R.
- **Sentry walks like a SpriteUnit.** Position lerp + walking-frame animation now applies to mobile structures with `STRUCTURE_HAS_WALK[type]` (sentry only today). New PixelLab walking + explosion frames shipped.
- **MORTAR → BLASTOR** rename in the HUD (internal type still `bomber`).
- **Robot anti-cluster rule.** Defender mobile units outside base (`x ≥ DEFENDER_MAX_X`) take a 40-point detour penalty per adjacent live defender piece, to dodge the death-explosion chain.
- **Stalker intro + cloak (S22d).** Spawns visible inside its red deployment zone, marches west, and calls out + cloaks together the instant it steps OFF the zone (`worldX < ATTACKER_MIN_X`). The zone edge is well outside any defender weapon range, so it goes dark before it can be shot. Replaced the old 350-range scan + 2s cloak timer (that timer spanned several reveal turns and let the visible Stalker get shot, since structures fire BEFORE cyborgs each turn).
- **Visual overhaul.** Dusty Planet procedural floor replaces Perlin dirt. Side-tinted soft drop shadows on every piece (per-sprite footFraction overrides). Phaser/Bomber/Laser/Signal sprite sizes rebalanced. Phaser beam Y offset recalibrated against the actual cyan barrel.
- **Speech callouts** capped at 20 chars/line. `intro` trigger added. `core_hit` expanded to 12 lines per side.

**S19 changes since S18:**
- **Phaser damage 40 → 36** and **Sniper damage 150 → 135** (-10% each; both were dominating their sides in the data).
- **Cyborg combat ammo 5 → 4** on cannon, bomber, grenadier, doublegun, sniper. Hulk + medic stay at 5. Defender combat ammo stays at 5.
- **Hulk HP 280 → 400.** Armor buff per user; data showed hulks dying en route to the core.
- **Doublegun is a burst weapon.** Two projectiles per turn 80ms apart, 23 dmg each. Same total throughput as the prior single 45 dmg shot.
- **Stalemate guard v2.** Counts no-progress reveals (no combat AND no movement) AFTER first combat event. Fixes opening-march and mid-match repositioning false trips.
- **Balance Health dashboard** at the top of `/stats.html` — per-piece-per-side dmg/cr, win rate when deployed, shots vs base ammo, outlier flags.

**S19 audio system.** Music (menu/robots/cyborgs themes) + 28 SFX events with sample pools (`/public/audio/Astrohold3 Suno Sounds/`) and synth fallbacks. Mute toggles in the MCC dial. Test page at `/build-test.html` exposes every active pool.

**S19 shield aura observability.** Cyan flash on every protected hit, `(shielded)` log tag on direct-fire damage, `SHIELD SAVES` + `SHIELD ABSORBED` + `GAMES W/ SHIELD` cards in the stats SUMMARY.

**S18 standardizations still apply:**
- **Equal credits.** Both sides get the same base pool. `Difficulty.aiCreditMultiplier()` is the only adjustment knob (easy 0.75x, normal 1.0x, hard 1.25x on AI side).
- **Cardinal-only fire arc.** Structures fire only in their facing lane (forward dot > 0 AND perp ≤ ½ cell). Extra lanes via compass rose.
- **Unified death explosion.** `Config.DEATH_EXPLOSION = { radius: 75, damage: 25 }` for both robot self-destruct and Hulk death blast.
- **Phaser beam.** "Cannon" renamed to PHASER in the HUD. Pierces the lane up to range 330; defender-only structure.
- **Mortar.** Defender Bomber renamed to MORTAR in the HUD. Mechanic unchanged.
- **Sphere is mobile.** Speed 110. Out-of-ammo spheres suicide-rush the nearest cyborg.
- **Sentry is mobile.** Speed 40. Stays a Structure (omni-fire turret, compass rose still works).
- **Shield aura.** Defender Shield (50cr) projects a 25% damage-reduction aura at 2.0 grid-cell radius.
- **Repair refill mechanic.** Repair bot has 3 refillCharges separate from heal charges; +1 ammo to adjacent friendlies per refill.
- **Power Core dock.** Repair units adjacent to the core regain +2 heal + +1 refill per turn.
- **Robots do NOT pick up ammo crates.** They restore via the core dock instead. Crates are cyborg-only.

---

## Map & Grid

- S22c: the board is DERIVED from `STAGE` in `GameConfig.ts`. Edit `STAGE`
  to change the board; everything below is computed from it. Map #1 below.
- World extent: x [-750, +750], y [-450, +450] = 1500 × 900 world units
  (= STAGE.cols·cell × STAGE.rows·cell)
- Grid cell: **75 × 75** world units → **20 columns × 12 rows = 240 cells**
- Defender zone (Robots): x < -300 (6 columns, STAGE.defenderCols)
- Battlefield (no-build zone): -300 ≤ x ≤ 300 (8 columns)
- Attacker zone (Cyborgs): x > 300 (6 columns, STAGE.attackerCols)
- Placement is rule-driven via `canPlace(side, col, row)` (default `zones`)
- **One piece per cell.** Strict. No stacking. Enforced at placement;
  movement will enforce it once the turn system lands.
- Placement snaps to cell centers automatically. Cell centers are at
  (LEFT + col*50 + 25, BOTTOM + row*50 + 25) for col/row indices.

## Turn flow. build then reveal, continuous auto-chain (LIVE)

**The cinematic model.** Players make placement decisions FIRST, then
the game plays out. Build then click BATTLE then watch reveals
auto-chain until win or lose. PLAN phase is currently skipped (code
exists but the READY button jumps straight to REVEAL).

1. **Build.** Place pieces from credits (multiples of 10 so leftover
   credits always remain spendable by the cheapest piece). Click READY
   when done. READY calls startBattleFromBuild() which tears down
   BuildPhase and enters REVEAL directly.
2. **PLAN (skipped today).** The planner is still in src/game/Game.ts
   as enterPlanningPhase() but no path reaches it. Re-enable when
   piece-action queuing becomes useful (e.g. Hulk slam targeting that
   wants user input).
3. **Battle / Reveal.** The engine sorts every (actor, action) pair by
   **Initiative (descending)** and animates them one at a time. Step
   duration is ~0.6s per real action and ~0.08s per hold step, BOTH
   multiplied by the player-controlled speed setting (see Speed Control
   section below). Pieces from either side interleave by initiative.
4. **Auto-loop.** When a reveal finishes, the next reveal starts
   immediately. Queued actions clear so DEFAULT BEHAVIOUR takes over:
   cyborgs march toward the core (fire if anything is in range),
   spheres and towers auto-fire at the nearest cyborg, dogs hunt the
   nearest cyborg or wander when nothing is in sight.
5. **Attrition win for defender.** If at the end of any reveal no
   cyborg can damage the core (every shooter is out of ammo, no Hulk
   alive to punch through), the defender wins by attrition. Replaces
   the old stalemate guard. The game is strictly die-or-survive with
   no draw state.
6. **Win/lose** flips the phase and shows the message. PLAY AGAIN
   (in the Mini Control Center) reloads the page.

**Invalid actions strict-skip.** If your queued target died or your
destination cell got taken before your action's turn comes up, your
piece does *nothing* that step. No best-effort re-target. Mind-game
tension > forgiveness.

**Initiative source:** each piece's `speed` value verbatim. Stationary
pieces (Sphere, structures, core) use **`STATIONARY_INITIATIVE = 100`**
(raised from 10 mid-session because defenders fired LAST and felt
useless — now they fire BEFORE cyborgs each turn).

**Structures during the reveal:** turrets / cannons / bombers auto-fire
on their initiative tick at the closest enemy in range (or AoE splash
for bomber + cannon). Walls / mines stay passive (apBudget 0). The
defender doesn't queue actions for structures.

**Pricing rule (locked):** All piece costs in multiples of 10 so leftover
credits can always be spent down. Cheapest cyborg = Grenadier 50cr (was
55 — rounded). Cheapest defender = Wall 20cr.

**HP bars hidden globally** ("plan-then-watch model"). Wall is the
exception — the wall body itself shrinks from the top as it takes damage.
Code keeps the bar meshes in place but `visible = false`; one-line flip
to bring them back if a mid-battle decision mode is added later.

### Action Points (proposed AP budgets)

Each piece spends Action Points (AP) per turn. Default actions:

| Action | AP |
|---|---|
| Move one cell (orthogonal or diagonal) | 1 |
| Fire a direct-fire weapon | 1 |
| Throw a grenade (AoE) | 2 |
| Turn to face a new direction (cyborgs) | 1 |
| Turn (Sphere) | **0 — Sphere turns are free** |

**Line of sight & blocking:**
- Direct-fire weapons hit the first solid piece/wall on the line. They cannot
  shoot through other pieces.
- Grenadier grenades **arc over** intervening pieces and land at the target
  cell — they can be lobbed past walls and friendly units.

**Ammo budgets (D&D-style, per game) — S18 baseline = 5:**
- Every piece that can attack has a per-game ammo pool, NOT a per-turn one.
  Once spent, the piece is inert (still alive, still a target, just can't
  fire). Forces strategic shot allocation rather than RTS spam.
- S18 baseline is `ammo: 5` for every combat piece (both sides). Goal is
  parity so balance work isn't fighting an underlying asymmetry.
- Exceptions held for mechanic reasons:
  - Mine 1 (single-use trap)
  - Signal 2 (EMP, designed scarce)
  - Wall / Shield 0 (no weapon)
  - Stalker 0 (melee only, unlimited fists)
  - Hulk fists unlimited (slam uses separate `slamAmmo: 3`)
- Tuning rule of thumb: ammo budget × damage should be comparable to that
  piece's "fair share" of damage required to end the game.

**Melee reach + instant hit (S22d).** All melee reach derives from
`MELEE_REACH = round(GRID_CELL * 1.3)` (= 98 at cell 75) in RevealPhase. It
sits between cardinal-adjacent (1 cell = 75) and diagonal (~1.41 cells = 106),
so melee only connects with a CARDINALLY adjacent target - matching cardinal
movement, no half-cell-gap "distance" swings. Cell-relative so it survives
board resizes (a hardcoded 70 broke when cells went 50 -> 75). Melee strikes
(Hulk/Stalker fists + the fallback punch) land INSTANTLY with an impact spark
and the melee sound - NO flying projectile (a bolt on a melee unit read as
"shooting"). For the 2x2 core, aim resolves to the core CELL nearest the
attacker (not the centroid) so an adjacent melee unit is actually in range.

**Universal melee fallback.** When a SpriteUnit hits `ammoRemaining = 0`
AND an enemy is within `MELEE_FALLBACK_RANGE` (= `MELEE_REACH`, cardinal-
adjacent), punches for `MELEE_FALLBACK_DAMAGE = 10` at no ammo cost, using the
melee body-impact sound (not the unit's ranged weapon). Excludes hulk (already
unlimited), sniper (retreats), and medic + repair (retreat).

**Firing arc (S18):** Structures fire CARDINAL-ONLY. The target must be in
the lane the structure faces: forward dot > 0 AND perpendicular distance
≤ half a cell. Diagonal cells require buying a second facing via the
compass rose (30cr). Old 120° wedge is gone. Mobile units still face
their target freely (8-direction). Sentry's omni-fire turret tracks
freely during combat regardless of placed facing.

**Bomb counterplay (reactive AI):**
- Direct-fire units automatically check for armed ENEMY bombs in their
  attack range. If any are far enough that the unit is outside the bomb's
  own AoE (safe shot), they prefer firing at the bomb over firing at an
  enemy unit. Detonating an enemy bomb early clears the lane.
- Moving units flee armed-bomb AoE cells when picking their next step.
  pickStepTowardPoint scores candidates by (distance + 2 × bomb damage in
  that cell) — any damage outweighs ~2 cell-lengths of distance, so units
  sidestep around primed bombs rather than walking into them.
- **Grenadier diffuse:** if a Grenadier auto-AI step finds an armed enemy
  bomb within 1.5 cells, they DIFFUSE it instead of moving/firing/throwing.
  Diffuse costs 1 AP, applies no damage, and the bomb vanishes with a
  small white puff. Only the Grenadier has this capability (it's their
  thematic counter to enemy proximity traps).

**Lobbed AoE — proximity bombs with 1-turn arming delay:**
- Robot Bomber (defender) and cyborg Bomber / Grenadier throw **proximity
  bombs**, not direct-fire blasts. The thrower lobs a grenade onto a target
  **empty cell within range**. The grenade lands as a pulsing sprite on
  that cell.
- **Arming delay:** the grenade lands UNARMED (yellow tint, slow pulse) and
  cannot trigger during the turn it lands. At the END of that reveal it
  arms (white tint, fast pulse). From the next turn onward, any enemy
  entering its AoE radius detonates it immediately.
- The arming delay is the strategic window — opponents see the yellow
  marker on their next planning turn and can route around / diffuse /
  shoot the bomb before it arms.
- **One bomb per thrower at a time.** A Bomber / Grenadier can't throw a
  new bomb while their previous one is still armed on the field. Once it
  detonates, they're free to throw again.
- Bombs are walkable (don't block movement). Friendly pieces can pass
  through their own side's bombs harmlessly; only enemies trigger them.
- Direct-fire AoE (Cannon turret, mines) still detonates instantly — only
  thrown grenades use the proximity mechanic.

**Firing arc:**
- **Mobile units fire 8-directional.** They pivot to face their target, so
  no angle is off-limits.
- **Structures (Tower, Bomber, etc.) fire in a 120° wedge.** They ship with
  a single facing (defender towers face east toward the cyborg corridor).
  Targets outside the wedge are ignored — the structure won't shoot a
  cyborg that flanks around to its rear. Bomb-throw cell picking obeys the
  same wedge for structure bombers (mobile bombers/grenadiers can lob in
  any direction since they pivot).
- Future: pay-per-additional-facing UI lets the player widen a structure's
  arc coverage during BUILD.
- Reasons a future piece might be **cardinal-only** (4 directions): hardpoint-
  mounted turret, heavy servo motors too slow to traverse diagonally, sniper
  rifle that only fires straight lines, energy emitter with a fixed beam axis.
  Designed cardinal-only pieces become natural counters to fast diagonal units.
  See "Proposed future pieces" below.

---

## Defenders (Robots, blue side)

### Sphere Defender (MOBILE in S18)
| Stat | Value |
|---|---|
| Cost | 100 |
| HP | 300 |
| Damage | **25** |
| Attack range | 300 |
| Sight range | 400 |
| Speed | **110** (S18, was 35; now the fastest piece in the game) |
| Initiative | 110 (= speed) |
| AP | 3 |
| Ammo (per game) | **5** (S18 baseline, was 8) |
| Behavior | Mobile, 3-branch AI: fire if in range, roll toward enemy if has ammo, suicide-rush if out |

**Special (S18):** Sphere is now mobile and the fastest piece in the game.
AI tree:
1. With ammo + cyborg in attack range: fire (auto-targets nearest).
2. With ammo + no cyborg in range: roll toward nearest cyborg.
3. Out of ammo: **suicide rush** toward nearest cyborg. On adjacency
   (≤ 1.5 cells), `sphere.takeDamage(hp)` self-destructs and triggers the
   unified `Config.DEATH_EXPLOSION` (radius 75, damage 25) in the cluster.

4-frame death explosion plus the unified blast on HP=0.

### Combat Dog (defender mobile unit)
| Stat | Value |
|---|---|
| Cost | 40 |
| HP | 80 |
| Speed | 90 (second only to Sphere now that Sphere is mobile) |
| Damage | 15 |
| Attack range | 150 |
| Sight range | 280 |
| Initiative | 90 (= speed) |
| Ammo | 5 (S18 baseline) |
| Behavior | **S18: no sight gate, hunts nearest cyborg from anywhere on the map** |

Placed in the defender zone. First mobile defender, wires through the
same SpriteUnit class as cyborgs, just `side='defender'` and faces east on
placement. Has its own walking animation; death plays the 4-frame
explosion (omnidirectional, same frames copied into every dir folder).

**S18:** Dog pursuit is aggressive. Previously the dog needed cyborgs to
enter its 280-unit sight before engaging; now it tracks nearest cyborg
from anywhere on the map (Stalker pattern).

### Robot Repair (defender mobile support — session 16, ammo refill added S18)
| Stat | Value |
|---|---|
| Cost | 70 |
| HP | 60 |
| Speed | 65 |
| Range (tether reach) | 150 |
| Repair amount | 15/tick (pad) · 20/turn (tether) |
| Heal charges (ammo) | 5 |
| Refill charges (S18) | **3** |
| AP | 3 |
| Diagonal movement | yes (`allowDiagonalMove: true`) |

Defender-side support unit. **Two repair modes** share the 5-charge ammo
pool: **deploy repair-pad** (2 charges, drops a wrench-glyph station that
ticks +15 HP to adjacent defender pieces for 4 ticks or until destroyed)
and **weld-tether** (1 charge/turn, glowing amber beam pins both endpoints,
+20 HP/turn). Repairs anything defender-side with HP: towers, walls,
bombers, cannons, sentries, sphere, the Combat Dog, and the Power Core.

**S18 ammo refill mechanic.** Separate pool `refillCharges: 3`. When the
repair bot ends a move adjacent to a friendly defender with
`ammoRemaining < max`, it transfers +1 ammo at the cost of one refill
charge. One target per turn. Walls, shields, and mines skipped (no ammo
concept). The cost-of-buying-a-non-attacker is justified by the now
multi-purpose role: heal AND rearm.

**S18 Power Core dock.** Adjacency to the Power Core restores +2 heal
charges AND +1 refill charge per turn. The round-trip cycle is: deploy
→ spend → walk back to core → top up.

**S21 diminishing returns.** Every heal applied to the same target
decays: 100% / 75% / 50% / 25% / 0% per consecutive hit. Resets on
big damage (>=25% maxHp in one event) or 5 quiet reveals. Saturated
tethers auto-release so the bot can re-target rather than channel for
zero benefit. Same rule applies to the Medic side.

(The PixelLab export ships a Repair animation but no throw clip, so the
throw mode the Medic uses isn't replicated here. The welding pose plays
every time the bot deploys a pad or attaches/ticks a tether.)

AI priority: weld the highest-priority piece in range (Power Core 12 →
Cannon 9 → Bomber 8 ≈ Gunwall 8 → Sphere 8 → Tower 7 → …), else drop a
pad on a cluster of 2+ wounded, else walk toward the most-damaged piece.

Sprite assets: 8-direction rotations + 9-frame walking (Moving) anim +
9-frame Repair anim (wired as `repair` AnimState, fires on
pad/tether actions and re-fires each tether tick). Death duplicates the
4-frame explodes anim into every direction folder, same as the Combat Dog.

### Sentry (defender structure, MOBILE in S18)
| Stat | Value |
|---|---|
| Cost | 60 |
| HP | 150 |
| Damage | 25 |
| Range | 200 |
| Ammo | 5 |
| Speed | **40 (S18)** |
| AP | 1 |
| Fire interval | 2 |
| Sprite size | 84 (matches Hulk) |
| Fire arc | Omnidirectional, sprite auto-rotates to target |

Heavy-armor tower on tracks. The art is a tracked vehicle with gun arms,
reads as a tower, not a wall. Tankier than a tower (HP 150 vs 80) with
the same damage but shorter range (200 vs 250). Built as a hard point on
the front line, eats hits and still bites back. 8-direction static
rotations, no animations. Repair-bot priority 8 (tied with Bomber).

**S18: now mobile.** Speed 40 (slow tracked vehicle). Stays a Structure
type (omni-fire turret + compass-rose mechanic preserved) but
`col / row` are no longer readonly and `moveTo()` is wired. AI: when no
cyborg in fire range, queue a move toward nearest cyborg. Initiative is
`max(STATIONARY_INITIATIVE, speed) = 100`. Compass rose still picks the
default facing during BUILD; combat omni-fire overrides per shot.

### Wall (procedural laser-wall — redesigned in session 16)
| Stat | Value |
|---|---|
| Cost | 20 |
| HP | 300 |
| Damage | 0 |
| Range | — |
| AoE | — |
| AP | 0 |
| Ammo | 0 |

Two metallic emitter plates at the top and bottom of the cell with a
glowing cyan energy beam between them. Replaces the brown-box wall visual
that used to fill this slot. **Stats are unchanged** — pure blocker, eats
300 HP of hits before failing, no offensive capability of its own.

The beam pulses every frame via `Structure.update()` (a subtle ~5 Hz
opacity oscillation, with the emitter sockets shimmering out of phase at
7 Hz). HP feedback: beam scale.x thins and beamMat opacity drops as the
wall takes damage, with emitter sockets fading in parallel — at low HP the
whole structure dims to a faint flicker.

HUD icon is a stacked CSS-gradient mini-version of the same visual (two
metallic bars top + bottom, beam between) so the shop tile reads the same
way as the in-game piece. **Wall is now buyable from the player's HUD**
(replaced the DEFENSE preview tile in the robot grid).

### Structures (production)

Ammo column is per-game shots (S18 baseline 5). Fire interval (in tick
units) is in Config but omitted here for readability. All directional
structures default to a single east-facing CARDINAL lane (S18, was 120°
wedge). The player pays 30cr per additional cardinal facing via the
compass rose.

| Structure | Cost | HP | Damage | Range | AoE | apBudget | Ammo | Sprite / notes |
|---|---|---|---|---|---|---|---|---|
| Turret (Tower) | 30 | 80 | 25 | 250 | 0 | 1 | 5 | Robot_Tower (faces east). |
| Mortar (Bomber) | 70 | 100 | 20 | 200 | 65 | 1 | 5 | Renamed in HUD S18. Throws proximity traps onto empty cells. Cardinal lane only. Sprite size 66 (S18, was 60). |
| Sentry | 60 | 150 | 25 | 200 | 0 | 1 | 5 | Mobile in S18 (speed 40). Omni-fire turret. See Sentry section. |
| Wall | 20 | 300 | 0 | 0 | 0 | 0 | 0 | Procedural cyan beam between two metallic emitter plates. Body itself thins as it takes damage. |
| Laser | 40 | 70 | 25 | 300 | 0 | 1 | 5 | Twin-laser direct-fire turret. Longest direct-fire range. Sprite size 44 (S18, was default). |
| Signal | 70 | 80 | 0 | 500 | 0 | 1 | 2 | EMP emitter. Stuns target cyborg for 2 turns. 2 EMP strikes per game. |
| Phaser (Cannon) | 60 | 120 | 40 | **330 (S18)** | 0 (beam) | 1 | 5 | Renamed in HUD S18. **Piercing beam** instead of AoE projectile. Damages every cyborg in lane up to range. Skips walls + allies. Visual starts at barrel tip, z=12. |
| Shield (Defense) | 50 | 80 | 0 | 0 (aura) | 100 (2.0 cells) | 0 | 0 | **S18 aura**: 25% damage reduction to defender pieces in 2.0 grid-cell radius. Translucent cyan dome visual (centered radial gradient). |
| Mine | 20 | 50 | 60 | 60 | 70 | 0 | 1 | Detonates when a cyborg moves on top. |

### Structures (preview pieces, dashed border in shop)
| Preview | Cost | HP | Damage | Range | Notes |
|---|---|---|---|---|---|
| Gun | 30 | 80 | 15 | 200 | Twin-barrel turret. User liked the visual. |
| Cyborg Mine (S18) | 20 | 50 | 60 | 60 | Cyborg-side mine. Tile in shop, Config entry exists, placement flow + side-aware trigger logic NOT yet implemented (BuildPhase is defender-only). |

### Power Core (objective, not buyable)
| Stat | Value |
|---|---|
| HP | 100 |
| Footprint | **2x2 cells** (size rule: small=1, large=4) |
| Sprite size | native PNG width × POWER_CORE.RENDER_SCALE (= 2); pixel-perfect integer scale, not tied to GRID_CELL |
| Position | (-525, 0); centroid on the grid intersection between cols 0/1 and the two center rows 2/3 (cells (0,2)(1,2)(0,3)(1,3)) |
| Death | 9-frame explosion + 180-unit AoE blast that wipes nearby cyborgs |

Defender loses if Power Core HP reaches 0.

---

## Attackers (Cyborgs, red side)

All combat cyborgs are `ammo: 5` in S18 baseline. Exceptions called out
inline.

| Unit | Cost | HP | Speed | Damage | Atk range | Sight | AoE | AP | Ammo | Behavior |
|---|---|---|---|---|---|---|---|---|---|---|
| **Cannon** | 70 | 180 | 55 | 35 | 240 | 320 | — | 3 | 5 | Aggressive, advance to attack range and fire |
| **Grenadier** | 50 | 110 | 75 | 20 | 180 | 280 | 60 | 3 | 5 | Standoff. Lobs TIMED grenades behind/side of nearest enemy. **50% AoE shielding** (blast plating). Can DIFFUSE adjacent armed enemy bombs (1 AP). |
| **Double Gun** | 90 | 160 | 65 | 45 | 230 | 300 | — | 3 | 5 | Aggressive, heavy direct fire from medium range |
| **Hulk** | 100 | 280 | 45 | 55 | 70 | 220 | — | 2 | unlimited fists (slamAmmo 3) | Melee bruiser. Slam wedge if 2+ clustered, else punch, else march at core. **S18: explodes on death** via unified `DEATH_EXPLOSION` (75 radius / 25 damage, friendly fire on). Chain-guarded. |
| **Sniper** | 90 | 80 | 50 | 150 | 350 | 400 | — | 2 | **5 (S18, was 1)** | Single-shot precision strike. **Crouch rule:** can NOT crouch + fire the same turn. Movement breaks crouch. Retreats east when empty. AI build enforces 3-cell spacing. |
| **Medic** | 70 | 50 | 70 | 30* | 150 | 280 | — | 3 | 5 (heal charges) | Three heal modes share the pool: med-pack throw, medic-pad deploy, tether. Diagonal movement. |
| **Stalker** | 70 | 130 | 60 | 40 | 70 | 220 | — | 2 | **0 (S18, melee only)** | Cloaked melee bruiser. Spawns at 35% opacity; defender AI skips cloaked targets. Cloak drops PERMANENTLY on first damage-dealing action OR on incoming damage. Charges nearest defender, melee on contact (unlimited fists via `meleeUnlimited`). |

**S18 ranged-cyborg core defense avoidance.** `pickStepTowardPoint`
adds +30 score penalty for cells inside the Power Core electric zone
when the actor is a non-melee cyborg (skip for hulk + stalker, who need
to enter for melee). Snipers and grenadiers detour one cell sideways
instead of taking 20 damage per turn from the core's tickCoreDefense.

Cyborgs spawn in the attacker zone (x > 200) and need to traverse the
battlefield to reach the Power Core at (-550, 0). All cyborg costs are
multiples of 10 so leftover credits stay spendable.

---

## Build-Phase Credit Allocation (S18 — equal credits + difficulty)
Both sides get the same base. The only adjustment is the AI-side
multiplier driven by the Difficulty selector on the side picker. Player
credits never change with difficulty.

| Difficulty | AI multiplier | Player budget | AI budget |
|---|---|---|---|
| Easy | 0.75 | **1000** | **750** |
| Normal | 1.00 | **1000** | **1000** |
| Hard | 1.25 | **1000** | **1250** |

`ATTACKER_CREDIT_BONUS = 0` and `AI_CREDIT_BONUS = 0` (both removed in
S18). Difficulty is persisted in localStorage via `Difficulty.ts`.

**Why the change.** Across 16 prior games the AI side received roughly
1.95x the player's credit pool (attacker x1.3 stacked with AI x1.5),
which produced a 0% defender win rate. Equal credits + difficulty
selector reframes the asymmetry as a player-chosen knob instead of a
hidden modifier.

## Ammo Crates (cyborgs only, S18)
Resupply boxes drop in the middle no-build zone every 5 reveals during
BATTLE (cap 4 on-field). Random cell, weighted bag:
- 55% ammo
- 20% grenade
- 15% medkit
- 10% repair_kit

Each pickup grants `+2` to the unit's `ammoRemaining` (capped at Config
max). Crates have 1 HP, destroyed by grenades in their AoE or by
defender direct-fire when no cyborg is in range. Gated by unit family
via `kitForUnit()`: a medic can't pick up a bullet crate.

**S18:** Robots do NOT pick up crates. Cyborg-only mechanic. Defender
resupply is via the Power Core dock (repair bots regain heal + refill
charges in core adjacency).

## Build-Phase Economy (proposed expansion)

Currently: place pieces only, fixed starting credits + extra fire-arc
purchases for directional structures.

### Live: Extra fire arcs (compass-rose UI)
Every directional structure ships with one east-facing 120° wedge.
Right-click the placed structure during BUILD to open a compass rose;
pay `Config.EXTRA_FACING_COST` (30cr) per additional cardinal facing
(max 4 = omnidirectional coverage). Right-click on empty space still
pans the camera. Left-click anywhere outside the rose closes it.
Refunding a structure refunds only its base cost — extra-facing spend
is sunk.

Planned shop additions (apply per-piece):
| Upgrade | Effect | Suggested cost |
|---|---|---|
| Extra ammo | +N shots / turn (or unlimited) | 15-25 |
| Health pack | Restore HP for one piece | 20-30 |
| Shield | Absorbs next N damage points before HP is hit | 25-40 |
| AP boost | +1 AP for one turn for one piece | 15-25 |

Goal: small economic decisions that let weaker pieces threaten bigger ones
(e.g. cheap turret + shield can survive a Cannon push).

---

## AI Behavior States

Every piece runs a small state machine. Default transitions:

```
                       (target in sight)              (target lost / dead)
   ┌──────────┐   ───────────────────►   ┌───────────┐   ──────────►   ┌──────────┐
   │  CAMP    │                          │ ENGAGED   │                  │  CAMP    │
   │ (idle)   │   ◄───────────────       │ (behavior │                  │          │
   └──────────┘   (return to spawn)      │  routine) │                  └──────────┘
                                          └───────────┘
```

**CAMP** — no enemy in sight. Piece can:
- Wander: move 1 random adjacent cell every N turns (low frequency so it
  doesn't drift far from spawn). Skip for stationary pieces (Sphere, structures).
- Hold: stationary, idle animation.

**Live implementation (cyborgs):** when no defender / structure / core is
within the unit's `sightRange`, there's a **50% chance per turn** to wander
to a random unoccupied adjacent cell. The other 50% the unit advances toward
the core normally (so they still close the distance, just less directly).

**ENGAGED** — a target is in sight. Piece runs its behavior routine:

| Behavior | Description |
|---|---|
| **Aggressive** | Advance to attack range, fire whenever ready. Cannon, Double Gun. |
| **Standoff** | Stay at max attack range; if enemy closes inside (range × 0.6) retreat one cell. Grenadier. |
| **Defensive** | Stationary; fire whenever a target enters attack range. Spheres, turrets. |
| **Sneaky** (future) | Try to flank — route around enemy front line to hit from behind. Assassin. |
| **Sniper** (future) | Halt and crouch (different sprite state) before firing. Long range, slow rate of fire. |
| **Suicide rush** (future) | Charge nearest target ignoring losses; explode on contact. |

**Sight range** is separate from attack range:
- Sight > attack lets a piece spot threats before engaging (most pieces).
- Sight < attack would make a piece "blind" beyond a certain distance —
  potential weakness for a long-range piece that needs a spotter.

---

## Proposed future pieces

These would deepen the rock-paper-scissors. Listed as design seeds — none are
built yet.

| Side | Name | Cost guess | Behavior | Special |
|---|---|---|---|---|
| Robots | **Heavy Laser Turret** | 80 | Defensive | Cardinal-only fire (N/S/E/W). High damage, long cooldown. Cyborgs that approach diagonally avoid it briefly. |
| Robots | **Sniper Spire** | 60 | Sniper | Cardinal-only, very long range (450). Single shot per turn. Counters fast cyborgs from across the map. |
| Robots | **Shield Generator** | 50 | Defensive | Stationary. Adds shield HP to adjacent friendly pieces per turn. |
| Robots | **Recon Drone** | 35 | Sneaky | Mobile spotter. Long sight, no weapon. Reveals fog of war for nearby allies (future fog-of-war system). |
| Cyborgs | **Sapper** | 40 | Aggressive | Slow, low HP. Can disable a wall by sitting next to it for one turn. |
| Cyborgs | **Sniper Cyborg** | 65 | Sniper | Cardinal-only, attack range 380, sight 450, single shot per turn. Crouches to aim — visible "crouch" sprite. Soft counter to the Sphere. |
| Cyborgs | **Assassin** | 75 | Sneaky | High speed, low HP, short range melee. Tries to flank around the front line and hit defenders from the side or back. |
| Cyborgs | **Berserker** | 50 | Suicide rush | Charges nearest target ignoring fire; detonates on contact for big AoE. |

## S18 mechanics added since the last audit

### Mini Control Center widget

Floating bottom-right dial (`src/ui/MiniControlCenter.ts`, "Variant C"
beveled-ring design). Hides during loading and pick-side. Procedural
CSS + inline SVG, no images. Hosts:

- **Speed dial** at the top. Three positions:
  - Slow: ×5.0 multiplier on RevealPhase step duration (3.0 s per step)
  - Normal: ×2.5 (1.5 s per step)
  - Fast: ×1.0 (0.6 s per step)
- **4 toggle pips** at 12 / 3 / 6 / 9 o'clock: Music, SFX, Speech,
  Combat Log. All persisted via `AudioSettings.ts` localStorage flags.
  SFX gates `playGunshot` + `playExplosion`; Speech gates speech
  bubbles; Combat Log toggles `.center-log` display.
- **BATTLE / PAUSE pill** at the bottom. Starts reveal during BUILD,
  toggles `RevealPhase.paused` during reveal (engine freezes step
  advancement but visuals keep ticking so projectiles finish), PLAY
  AGAIN full-reloads after game end.

All states persist across Play Again (which is a full page reload).

### Unified death explosion

`Config.DEATH_EXPLOSION = { radius: 75, damage: 25 }`. Used by both
defender self-destruct AND Hulk death blast for consistency.

- Radius 75 catches all 8 adjacent cells (cardinal at 50, diagonal at
  ~71). Cells two out (100) are excluded.
- Friendly fire applies. Cluster placement is a real risk.
- Chain-reaction guard: a piece dying from another piece's death blast
  (`killerType === 'self_destruct'` or `'hulk_blast'`) still gets its
  on-death speech but does NOT trigger a second explosion. Prevents
  infinite cascades.
- Visual matches damage area: `Explosion` no longer scales the ring
  from 1.0 → 2.5x. Stays at the constructed radius, fades opacity 1
  → 0 over the duration.

### Phaser beam (Cannon)

`Config.STRUCTURES.cannon` keeps the internal type but the HUD label
is "PHASER 60cr".

- Range bumped 280 → 330.
- aoeRadius set to 0 (beam, not blast).
- `firePhaserBeam` picks the facing whose cardinal lane covers the
  queued target, scans every cyborg in that lane up to range, applies
  full damage to each.
- Walls + allies are skipped (cyborg-only piercing).
- Stacking Phasers in a row: both can contribute to the same cyborg
  lane since allies don't block.
- Beam visual is a translucent cyan plane from the barrel tip (cell
  edge in facing dir) to end of range, z=12, renderOrder=14. Fades
  over 0.6s.

### Mortar (Bomber rename)

Defender Bomber labelled "MORTAR" in the HUD. Internal type still
`bomber`. Mechanic unchanged (proximity mine, 3-reveal safety fuse).
Sprite size 60 → 66.

### Shield aura

Defender Shield structure (`type: 'defense'`, 50cr) now functional.

- Aura radius: 2.0 grid cells.
- Reduction: 25% (damage scaled to 0.75x at the three main damage
  sites: direct fire, AoE tick, Hulk slam).
- Applies only to defender pieces in range of any alive Shield.
- Visual: translucent cyan dome (Structure child sprite). Centered
  radial gradient, no top highlight band, no outer rim. Subtle
  ~0.33 Hz breathing pulse.

### Repair refill mechanic

Separate from heal charges. `Config.UNITS.repair.refillCharges = 3`.

- Trigger: repair bot ends a move adjacent to a friendly defender
  with `ammoRemaining < ammoMax`.
- Effect: +1 ammo on target, -1 refill charge.
- One target per turn.
- Walls / shields / mines skipped (no ammo concept).

Power Core dock: adjacency to the core restores +2 heal + +1 refill
per turn.

### Speech triggers (S18 additions)

The previously-pending hooks are all wired in `RevealPhase.attribute`
and `handleDeath`:

| Trigger | Hook |
|---|---|
| `on_kill` | Attacker speaks on non-sniper kill |
| `on_death` | Dying piece speaks (cyborgs + robots) |
| `core_hit` | Paired callout when Power Core takes non-fatal damage |
| `mine_spotted` | Cyborg approaching core sees armed enemy mine within 4 cells, once per unit per game |

The "Mine!" line was previously inside `crate_spotted`, which read as
ownership; it moved to its own trigger.

Robot voice rewritten to ENERGY-only vocabulary: "CHARGES", "BATTERY",
"PULSE", "RECHARGE". Kinetic terms ("rounds", "magazine") removed, will
be reserved for a future Humans faction.

### Stalemate guard

A safety net, NOT a balance rule. RevealPhase tracks
`combatThisReveal` (false unless any damage/kill/move event fires).
After 3 consecutive silent reveals, force a defender attrition win
and log a console warning. Catches stuck-loop bugs (e.g. the
Turn 393 freeze from S17).

### Telemetry expansion

New `BattleRecord` fields on `BattleStats`:

- `hitsByPieceType` / `missesByPieceType` (accuracy)
- `friendlyFireByPieceType` / `friendlyFireHits` (AoE targeting bugs;
  intentional friendly-fire from self_destruct + hulk_blast skipped)
- `weakeningByPieceType` (target dropped below 50% HP first time)
- `oneShotsByPieceType` / `oneShotVictimsByType` (full-HP kills)
- `resupply` (attackerCratePickups vs defenderCoreRecharges)
- `grenadeThrows` (landing position + nearest enemy per throw)
- `hulkProgress` (per-Hulk startX vs endX in world coords)
- `damageReconciliation` (statsDamage vs piecesStats sum, divergence
  pct, sanity check for damage-attribution bugs)
- `piecesStats` (side-split: `attacker[type] + defender[type]` each
  carrying full counter object). Fixes the cannon/bomber type
  collision where both sides had the same actorType key.

`/stats.html` got matching panels: ERROR-HUNTING TELEMETRY, PER-PIECE
BY SIDE, PER-PIECE DETAIL dropdown, GRENADIER + BOMBER THROW
LANDINGS, HULK CORE PROGRESS, plus AVG SECONDS / AVG SEC PER TURN /
SPEED MIX summary cards.

Core blast attribution fix: `applyCoreBlast` now calls `attribute()`
with `actorType: 'core_blast'` so cyborgs killed by the final core
explosion show up in damage + kill telemetry instead of being lost.

### HOW TO PLAY dropdown (5 sections)

Side picker home page has an expandable HOW TO PLAY block with five
sections: The Basics, Combat Rules, Robot Specials, Cyborg Specials,
Win Conditions. Memory note saved (`feedback-keep-howto-in-sync`)
so future balance changes prompt a dropdown audit.

### Sprite size rebalance

- Bomber 60 → 66 (was reading too small for a tower piece).
- Laser default → explicit 44 (was visually dominant due to chunky
  sprite art).

---

## S17 mechanics added since the last audit

### Power Core recharge (Robot Repair docking)

Robot Repair bots that run out of charges can detour to the Power Core
to recharge. Mirrors the cyborg ammo-crate pattern. Defender-side
advantage: a stationary energy source the repair bot can always reach
since the core is required and lives in the defender backline.

  Out-of-charge AI search order:
    1. Compatible repair-kit crate in sight (fastest top-up).
    2. The Power Core (within sight).
    3. Retreat west toward the backline.

  Docking trigger fires at the end of any move step. If the repair bot
  ends within 1.5 grid cells of any of the 4 core sub-cell centers, it
  siphons **+2 charges per turn** (capped at Config.UNITS.repair.ammo).
  Core is unharmed by the recharge. Full bots do not farm (gate on
  ammoRemaining < max).

### Robot self-destruct AoE on death

Every defender piece (sphere, structure, defender mobile unit) that
dies triggers a small explosion at the death position. Backs the
dramatic "DETONATION SET" and "SELF-DESTRUCT PROTOCOL ENGAGED"
callouts with actual mechanical bite.

  Radius: 60 world units (just over 1 grid cell).
  Damage: 25 (light; will not one-shot full-HP cyborgs).
  Friendly fire: yes (matches the rest of the AoE system).
  VFX: two-layered Explosion (orange outer halo + bright inner flash).
  SFX: standard playExplosion.

Chain-reaction guard: if a robot dies from another robot's self-
destruct AoE (killerType === 'self_destruct'), the dying robot still
gets its on_death speech bubble but does NOT trigger a second
explosion. Only the first robot in any kill chain detonates, so a
tight defender cluster cannot infinite-cascade.

### Speed control (Mini Control Center)

Floating bottom-right widget owns reveal pacing, audio + speech +
combat-log toggles, and the BATTLE / PAUSE primary action pill.
Default toggles all start ON. All states persist in localStorage so
choices survive Play Again (which is a full page reload).

Multipliers applied on top of the RevealPhase base step duration
(0.6s real, 0.08s hold):

| Setting | Multiplier | Per real step | Per hold |
|---|---|---|---|
| Slow | 5.0 | 3.0 s | 0.40 s |
| Normal | 2.5 | 1.5 s | 0.20 s |
| Fast | 1.0 | 0.6 s | 0.08 s |

Pause is implemented as a `paused` flag on RevealPhase that gates
step advancement (visuals continue ticking so in-flight projectiles
resolve).

### Speech bubble triggers

Floating callouts appear above units at significant moments. Voices:
cyborg (red bubble, italic peach, kinetic + energy mix) and robot
(blue bubble, monospace cyan, energy-only vocabulary).

Active triggers:

| Trigger | When it fires |
|---|---|
| `low_hp` | HP drops to 25 percent or below. |
| `low_ammo` | Ammo down to last few shots. {n} substitutes count. |
| `out_of_ammo` | Ammo hits zero. |
| `rearmed` | Unit picks up an ammo/grenade/medkit/repair crate, or repair bot docks at the Power Core. |
| `crate_spotted` | Out-of-ammo unit sights a compatible crate. |
| `sniper_shot` | Sniper or precision strike scores a confirmed kill. |
| `medic_low_packs` | Medic or repair bot down to last 1-2 charges. |
| `no_repairs_needed` | Repair bot has full reserves and nothing damaged in sight (robot voice only). |
| `on_kill` | Killer announces. SpriteUnit only; structures and spheres stay silent. |
| `on_death` | Dying piece announces. Robots get dramatic self-destruct lines. |
| `core_hit` | Power Core takes non-fatal damage. Spawns a paired bubble: nearest defender reports the breach, nearest cyborg gloats. Once per reveal. |

Speech bubbles can be globally toggled off via the MCC. When off,
spawnSpeechBubble bails out immediately and nothing renders.

### Cross-type refund blocking

When a placement is active, clicking a piece of a different type is
a no-op instead of refunding it. Same-type clicks still refund (so
relocating an identical piece is unchanged). Free-click refund (no
placement active) still works on any piece type. Prevents the player
from accidentally wiping a Laser while trying to place a Dog.

### Single-player mode and AI opponent

Session 13 onward. The side picker shows two cards (DEFENDER /
Robots vs ATTACKER / Cyborgs); the player picks one, the other side
runs on autopilot via `src/ai/OpponentAI.ts`.

  Fog of war. AI-side pieces have mesh.visible=false during BUILD
  and PLAN, revealed at REVEAL start. Opponent credits are never shown.
  AI build rule (S17). One of each piece TYPE first, then spend all
  remaining credits on random picks (no per-turn cap since there is
  no PLAN phase to spend extra turns of credits in).

---

## Battle stats and pacing telemetry

Per-game records are written to localStorage on game end and viewable
at `/stats.html`. Each record carries:

  outcome (win/lose from player POV) and endType
    (core_destroyed, cyborgs_eliminated, attrition)
  turns (reveal count)
  durationMs (wall-clock from first reveal start to end)
  speed (slow/normal/fast at time of end)
  alive counts per side
  damageDealt + kills per side
  per-piece breakdowns: piecesByType, damageByPieceType,
    killsByPieceType, assistsByPieceType, cellsWalkedByPieceType,
    attacksByPieceType, creditsSpentByPieceType, actionCounts
  enemyEliminatedAtTurn (when the opposite side hit zero, if ever)

Console helpers installed on `window.astrohold`:
  astrohold.statsSummary()   high-level aggregate
  astrohold.dumpStats()      console.table of all records
  astrohold.statsJSON()      copy-paste JSON dump
  astrohold.clearStats()     wipe records

Cap: 50 records (oldest pruned). The stats page surfaces per-piece
damage-per-credit and kills-per-100cr tables for cost-effectiveness
analysis.

---

## Balance Principles

1. **Mirror power, not abilities.** If Grenadier can hit behind cover, Robots
   need a piece that detects/snipes behind cover too.
2. **Action economy beats raw damage.** A piece with 2 AP that fires twice often
   out-trades a piece with 1 AP that fires once at higher damage.
3. **Cost reflects role, not just stats.** A pricey unit can be balanced by
   limiting how many of it can fit in the build zone.
4. **The Power Core is the only objective.** Side missions (eliminate all units)
   are secondary.

---

## Open design questions

Resolved or shipped:

- ~~Plan-then-play vs one-action-at-a-time?~~ Locked: plan-then-play
  with initiative-interleaved reveal, strict-skip on invalid actions.
  See Turn flow above. PLAN phase is currently skipped in production
  but the engine still consumes pre-built default-action queues.
- ~~Same-turn fire by structures?~~ Locked: structures auto-fire on
  their initiative tick. Defender does not queue actions for them.
- ~~Directional firing arcs?~~ Shipped: compass-rose UI buys extra
  cardinal facings at 30cr each.
- ~~Stalemate rule?~~ Replaced with attrition win for the defender
  via cyborgsCanAttack() in onComplete. Strictly die-or-survive.
- ~~Ammo finite vs unlimited?~~ Locked: per-game ammo budget on every
  offensive piece. Crates + Power Core docking provide top-ups.

Still open going into next session:

- **Cyborg Mine placement + trigger logic.** Tile is in the cyborg
  shop with `preview: true`, Config entry exists, but placement
  flow + side-aware trigger logic NOT yet implemented (BuildPhase
  is defender-only). Needs an attacker-side structure placement
  path.
- **Sniper at 5 ammo.** S18 standardized to 5; the 5 × 150 = 750
  damage ceiling per sniper is potentially too strong. Watch
  telemetry for the next 3-5 games; tune down if defender pieces
  are being vaporized too easily.
- **Stalker `ammo: 0` field.** Mechanically correct (unlimited
  fists) but the field is still in Config. Future cleanup could
  remove or migrate to a dedicated `meleeOnly` flag.
- **HOW TO PLAY dropdown mentions PLAN phase.** PLAN is currently
  skipped (BUILD jumps to BATTLE). Either re-enable PLAN for
  piece-specific targeting (Hulk slam picker, etc.) or rewrite
  the dropdown to drop the mention. Architecture still supports
  PLAN.
- **Defender win rate at parity.** Equal credits + difficulty +
  all the S18 buffs (mobile sphere, mobile sentry, shield aura,
  repair refill, core dock) have not been measured against the
  previous 0% defender win rate. Need 3-5 fresh games post-S17.25
  to see actual parity.
- **Robot health tint convention.** Saved as memory
  (`project_robot_health_tint`). Reuse the repair-pulse pattern
  as a persistent HP indicator (green / yellow / red). Not wired
  yet.
- **Diagonal movement** for cyborgs broadly. Currently opt-in per
  unit (`allowDiagonalMove`). Medic and Repair are
  diagonal-capable.
- **Turning cost** for cyborgs. Currently free (units pivot before
  firing with no AP cost). Sphere remains free by design.
- **Sight range blocking.** Do walls / other pieces block sight the
  same way they block projectiles?
- **Sneaky / flank routing.** Future Assassin pathfinding.
- **Death explosion tuning.** S18 unified at 75 radius / 25 damage,
  friendly fire on. Watch for cluster cascades that wipe defender
  lines.
- **Music system.** The MCC has a music toggle that persists a
  flag, but no audio source consults it yet. Add a backing track.
