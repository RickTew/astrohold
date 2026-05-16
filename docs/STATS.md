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
| Range | 300 |
| Speed | — (stationary) |
| Proposed AP | 2 |

**Special:** Spherical hero — can fire in any direction, **turning costs 0 AP**.
With 2 AP per turn it can fire twice at different targets. Stationary; no
movement AP needed.

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

| Unit | Cost | HP | Speed | Damage | Range | AoE | Proposed AP | Special |
|---|---|---|---|---|---|---|---|---|
| **Cannon** | 70 | 180 | 55 | 35 | 240 | — | 3 | Heavy direct-fire infantry. Slowest cyborg, hits hard. |
| **Grenadier** | 55 | 110 | 75 | 28 | 220 | 65 | 3 | Lobs grenade *over* intervening pieces — hits the target cell behind walls/units. Not kamikaze. |
| **Double Gun** | 90 | 160 | 65 | 45 | 230 | — | 3 | Highest direct-fire damage (dual hand cannons). |

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

## Proposed future pieces

These would deepen the rock-paper-scissors. Listed as design seeds — none are
built yet.

| Side | Name | Cost guess | Special |
|---|---|---|---|
| Robots | **Heavy Laser Turret** | 80 | Cardinal-only fire (N/S/E/W). High damage, long cooldown. Cyborgs that approach diagonally avoid it briefly. |
| Robots | **Sniper Spire** | 60 | Cardinal-only, very long range (450). Single shot per turn. Counters fast cyborgs from across the map. |
| Robots | **Shield Generator** | 50 | Stationary. Adds shield HP to adjacent friendly pieces per turn. |
| Cyborgs | **Sapper** | 40 | Slow, low HP. Can disable a wall by sitting next to it for one turn. |
| Cyborgs | **Sniper Cyborg** | 65 | Cardinal-only, range 380, single shot per turn. Soft counter to the Sphere. |

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
