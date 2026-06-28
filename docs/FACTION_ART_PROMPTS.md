# Faction art - coming soon + PixelLab prompts

> **SETTING = SPACE.** AstroHold is a sci-fi space game. EVERY prompt must read
> as futuristic / space, NOT present-day Earth. Humans are SPACE MARINES in
> powered armor + sealed visored helmets with sci-fi/energy weapons - never
> "olive-drab / tactical / modern military / sandbagged". Towers are starbase /
> orbital defense tech, not field emplacements. Match the existing
> `human_marine` (dark powered armor) and `human_warrior` (visored helmet)
> sprites.

Placeholder policy (live now): until a faction's own art exists, every
faction uses the SHARED art - defender towers/structures render as the
robot/installation set for all factions, and any attacker unit without a
faction skin falls back to the default art. So nothing is broken while these
are produced; this is the commission list to replace the placeholders.

These are BASE-generation prompts only (the "original" character/object pass).
Do NOT run rotations/animations/explosion passes yet - approve the base look
first, then we generate the rest to match.

## PixelLab settings (apply to every prompt)

- View: **Low Top-Down** (the frontal 3/4 look matching the existing units;
  this is what the test generation used).
- Outline: **single colour black outline**, **low detail** (matches existing).
- Canvas size: **match the existing same piece** (sizes listed per row below).
- Directions: generate the **base / south facing first** only. Hold off on
  the full 8-direction + walk/shoot/die/explosion passes until the base is
  approved.
- Transparent background.

## Faction style preambles (the "matches each faction" part)

Prepend the matching line to each piece subject below.

- **Robots** (baseline - already in game): `sleek sci-fi war android, brushed
  steel and chrome space-armor plating, exposed servos, glowing cyan optic and
  joint lights, futuristic`
- **Cyborgs**: `cybernetic space trooper, half flesh half machine, chrome
  augmetic limbs, dark sci-fi armor with glowing red optics, gritty futuristic`
- **Humans**: `sci-fi SPACE MARINE, sleek powered combat exo-armor with a
  sealed visored helmet, armored gauntlets and boots, steel/navy plating with
  blue energy trim, futuristic` (match the existing human_marine art)

For STRUCTURES, swap the trooper/android wording for the faction's STARBASE
defense-tech flavor (all are sci-fi installations, never field emplacements):
- Robots: `automated orbital defense turret, sleek metal, cyan energy core`
- Cyborgs: `bio-mechanical defense turret, chrome and organic cabling, pulsing red core`
- Humans: `human starbase defense turret, sleek armored sci-fi plating, blue energy core`

---

## CYBORGS - missing DEFENDER towers/structures
(Cyborg attacker roster already exists.) Prompt = Cyborg structure preamble + subject.

| Piece | Canvas | Subject to append |
|---|---|---|
| Tower (`turret`) | 120 | `single-barrel auto gun turret on a round armored base` |
| Phaser (`cannon`/gun art) | 64 | `heavy beam-cannon emplacement, one long focusing barrel` |
| Blastor (`bomber`) | 124 | `mortar turret, short fat upward-angled launcher` |
| Laser (`laser`) | 64 | `twin-laser turret, two long thin emitters` |
| Sentry (`sentry`) | 116 | `mobile heavy weapons platform on treads/tracks` |
| Signal (`signal`) | 64 | `EMP emitter, satellite dish on a pedestal` |
| Shield (`defense`) | 64 | `dome shield generator projecting a translucent energy dome` |
| Mine (`mine`) | 64 | `squat spiky round proximity mine, single blinking light` |

## HUMANS - missing DEFENDER towers/structures
Prompt = Human structure preamble + the SAME subjects as the Cyborg table
above (Tower, Phaser, Blastor, Laser, Sentry, Signal, Shield, Mine), same
canvas sizes.

## DEFENDER MOBILE UNITS - Sphere, Dog, Repair
These are mobile UNITS, not towers/structures, so they belong in the
faction-art bucket (like the attacker units), NOT the shared-structure bucket.
They are machines/drones, so the per-faction flavor is a drone preamble, not a
soldier or installation one. Robot versions already exist (baseline). Note:
the Sphere is a `SphereDefender`, which still needs a small faction-art seam in
code before its skin can drop in (deferred, same as structures - see
docs/FACTION_ROSTERS.md); Dog and Repair are `SpriteUnit`s and are already
faction-art-ready.

Mobile-unit preambles (sci-fi space drones):
- Cyborgs: `bio-mechanical combat drone, chrome and organic cabling, glowing red accents`
- Humans: `sci-fi combat drone, sleek steel/navy armored plating, blue energy lights`

| Unit | Canvas | Subject to append |
|---|---|---|
| Sphere (`sphere`) | 108 | `armored rolling combat sphere/orb` |
| Dog (`dog`) | 112 | `fast four-legged hunter drone` |
| Repair (`repair`) | 108 | `utility repair drone with welding/tool arms` |

## HUMANS - missing ATTACKER units
(Have: Warrior=cannon, Marine=doublegun, Medic=medic.) Prompt = Human soldier preamble + subject.

| Unit | Canvas | Subject to append |
|---|---|---|
| Grenadier (`grenadier`) | 108 | `shouldering a sci-fi grenade launcher` |
| Hulk (`hulk`) | 108 | `huge heavy trooper in massive powered exo-armor / heavy weapons` |
| Sniper (`sniper`) | 104 | `lean marksman aiming a long sci-fi rail / sniper rifle` |
| Stalker (`stalker`) | 112 | `stealth operative with an energy blade and cloak, crouched` |
| Hacker (`hacker`) | 104 | `tech specialist holding a glowing holo-tablet, no firearm` |

## ROBOTS - ATTACKER units (OPTIONAL)
Only needed if you want Robots to be playable as the attacker with their own
look (today robot-as-attacker borrows the cyborg art). Prompt = Robot
war-machine preamble + subject.

| Unit | Canvas | Subject to append |
|---|---|---|
| Cannon (`cannon`) | 104 | `robot shouldering a heavy cannon` |
| Grenadier (`grenadier`) | 108 | `robot with a grenade launcher` |
| Double Gun (`doublegun`) | 112 | `robot dual-wielding heavy guns` |
| Hulk (`hulk`) | 108 | `massive hulking battle-robot, heavy armored frame` |
| Sniper (`sniper`) | 104 | `slim long-range robot with a rail/sniper rifle` |
| Medic (`medic`) | 108 | `support robot with a repair/med device` |
| Stalker (`stalker`) | 112 | `stealth assassin robot, blades, crouched` |
| Hacker (`hacker`) | 104 | `spindly tech robot holding a hacking device, no gun` |

---

## Drop-in checklist (per finished piece)

1. Put the art under `/public/sprites/<artkey>/` (e.g. `cyborg_dog/`),
   matching the existing folder layout for that piece type.
2. Add the override in `FACTION_ART` (`SpriteUnit.ts`) for units, or in
   `FACTION_STRUCTURE_ART` (`Structure.ts`) for structures (the latter also
   needs the deferred texture-cache keying - see docs/FACTION_ROSTERS.md).
3. Register it in `Game.ts` init: `preloadSpriteUnit('<artkey>','<artkey>')`.
4. For an ATTACKER roster, add the shop grid in `HUD.factionAttackerGrids`.
5. Update How to play + the Updates and fixes changelog (project rule).
