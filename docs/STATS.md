# AstroHold — Stats & Game Mechanics

Living balance document. Update as we tune. Aim: "like chess but not strict" —
for any strong ability on one side, the other side gets a comparable counter.

**Status:** game is mid-transition from real-time simultaneous combat → grid-based
turn-by-turn strategy. The numbers below are the current Config values; the
**Proposed AP / Behavior** column captures the rule we want once the turn system
lands.

---

## Map & Grid

- World extent: x [-600, +600], y [-200, +200] = 1200 × 400 world units
- Grid cell: **50 × 50** world units → **24 columns × 8 rows = 192 cells**
- Defender zone (Robots): x < -200 (8 columns)
- Battlefield (no-build zone): -200 ≤ x ≤ 200 (8 columns)
- Attacker zone (Cyborgs): x > 200 (8 columns)
- **One piece per cell.** Strict. No stacking. Enforced at placement;
  movement will enforce it once the turn system lands.
- Placement snaps to cell centers automatically. Cell centers are at
  (LEFT + col*50 + 25, BOTTOM + row*50 + 25) for col/row indices.

## Movement / Action Points (proposed, not yet implemented)

Each piece spends Action Points (AP) per turn. Default actions:

| Action | AP |
|---|---|
| Move one cell (orthogonal or diagonal) | 1 |
| Fire a direct-fire weapon | 1 |
| Throw a grenade (AoE) | 2 |
| Turn to face a new direction (cyborgs) | 1 |
| Turn (Sphere) | **0 — Sphere turns are free** |

Turns alternate: Robots → Cyborgs → Robots. Each piece can act multiple times
per turn limited by its AP budget.

**Line of sight & blocking:**
- Direct-fire weapons hit the first solid piece/wall on the line. They cannot
  shoot through other pieces.
- Grenadier grenades **arc over** intervening pieces and land at the target
  cell — they can be lobbed past walls and friendly units.

**Firing arc:**
- **All current pieces fire 8-directional** (N, NE, E, SE, S, SW, W, NW). The
  PixelLab rotation sets give us all 8 angles natively — no asset cost to
  support diagonal fire on every existing unit.
- Reasons a future piece might be **cardinal-only** (4 directions): hardpoint-
  mounted turret, heavy servo motors too slow to traverse diagonally, sniper
  rifle that only fires straight lines, energy emitter with a fixed beam axis.
  Designed cardinal-only pieces become natural counters to fast diagonal units.
  See "Proposed future pieces" below.

---

## Defenders (Robots, blue side)

### Sphere Defender
| Stat | Value |
|---|---|
| Cost | 100 |
| HP | 300 |
| Damage | 10 |
| Attack range | 300 |
| Sight range | 400 |
| Speed | — (stationary) |
| AP (live) | **3 shots/turn** |
| Behavior | Defensive / stationary; fires the moment a target enters its attack range |

**Special:** Spherical hero — fires in any direction, **turning costs 0 AP**.
Live implementation: picks the **3 nearest distinct enemies** in attack range
and fires one shot at each per turn. If fewer than 3 enemies are in range,
fewer shots fire.

### Structures (no shop yet — code exists, HUD button missing)

| Structure | Cost | HP | Damage | Range | Fire interval | AoE | Notes |
|---|---|---|---|---|---|---|---|
| Turret | 30 | 80 | 15 | 200 | 2 s | — | Single-target |
| Cannon | 60 | 120 | 40 | 280 | 4 s | 45 | AoE around target cell |
| Wall | 20 | 300 | 0 | 0 | — | — | Blocks line-of-sight & path |
| Mine | 20 | 50 | 60 | 60 | — | 70 | Detonates when attacker enters detection radius |

Once turn-based: structures are stationary defenders (no movement AP) but get
1 fire action per turn.

### Power Core (objective, not buyable)
| Stat | Value |
|---|---|
| HP | 100 |
| Radius | 18 |
| Position | (-550, 0) |

Defender loses if Power Core HP reaches 0.

---

## Attackers (Cyborgs, red side)

| Unit | Cost | HP | Speed | Damage | Atk range | Sight | AoE | AP | Behavior |
|---|---|---|---|---|---|---|---|---|---|
| **Cannon** | 70 | 180 | 55 | 35 | 240 | 320 | — | 3 | Aggressive — advance to attack range, hold, fire |
| **Grenadier** | 55 | 110 | 75 | 28 | 220 | 280 | 65 | 3 | Standoff — keep distance, lob grenades over cover, fall back if pressed |
| **Double Gun** | 90 | 160 | 65 | 45 | 230 | 300 | — | 3 | Aggressive — heavy direct fire from medium range |

Cyborgs spawn in the attacker zone (x > 200) and need to traverse the
battlefield to reach the Power Core at (-550, 0).

---

## Build-Phase Economy (proposed expansion)

Currently: place pieces only, fixed starting credits.

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

- **Plan-then-play vs one-action-at-a-time?**
  Plan-then-play = each side queues all moves, then the engine animates them in
  order. One-action-at-a-time = chess-like, click move, watch it execute.
  Need decision before implementing turn system.
- **Diagonal movement** — allowed (8-directional) or 4-directional only?
  Sphere should be 8-dir since it can shoot in any direction. Cyborgs?
- **Turning cost for cyborgs** — should turning take an AP, or piggyback on the
  move? Sphere is free; cyborgs need a tradeoff so they can't pivot+fire freely.
- **Ammo finite vs unlimited?** Finite ammo per piece + buyable refills creates
  resource pressure but adds inventory tracking.
- **Same-turn fire by structures?** Turrets fire automatically (AI), or do they
  need defender to spend an AP on them like other pieces?
- **Camp wandering frequency** — every turn (too chaotic) or every 2-3 turns
  (more natural)? Stationary pieces never wander.
- **Sight range blocking** — do walls / other pieces block sight the same way
  they block projectiles? Probably yes for symmetry, but sniper/spotter pieces
  may need a "elevated sight" exception.
- **Sneaky / flank routing** — does an Assassin pathfind around the enemy line,
  or just prefer cells away from the highest enemy density? Latter is simpler.
