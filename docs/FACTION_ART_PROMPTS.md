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
  sealed visored helmet, armored gauntlets and boots, futuristic` (match the
  existing human_marine silhouette; the COLOR comes from the per-unit accent
  below, NOT a fixed navy/blue)

## Color variety (so units don't all look the same)

The first Human batch all came out navy/blue and blended together (the
preamble hard-coded "blue trim" on every unit). DO NOT paint a whole set one
palette. Give each piece a DISTINCT accent color - visor glow, armor trim,
shoulder lights, weapon energy - over the faction's base material. In-game the
team tint (blue for defender, red for attacker) re-unifies them, so the raw
art can be colorful. Reuse one accent per ROLE so the same role reads alike
across factions; append it to the subject (e.g. `...long sci-fi rail rifle,
acid-green visor and scope glow`):

| Role | Accent |
|---|---|
| Cannon / Warrior | crimson red |
| Double Gun / Marine | electric blue |
| Sniper | acid green |
| Grenadier | amber orange |
| Hulk | gold / heavy yellow |
| Medic | white + medical green |
| Stalker | violet purple |
| Hacker | cyan / teal |
| Dog | orange |
| Repair | white + green |
| Sphere | the faction core color |

## STRUCTURES (towers / guns) - PROMPT STYLE (use the user's voice)

WRITE A NATURAL, EVOCATIVE SENTENCE - not a dry technical parts-list. A
parts-list ("beam-cannon emplacement, one long focusing barrel, bio-mechanical
tech, chrome and cabling, glowing red core") made the model produce
"amalgamation" blobs, not a clean tower. Instead, name the WEAPON + the FACTION
team + a color hint + a material/vibe + a "looks like..." flavor line.

PROVEN example from the user (Pro, 64px) that produced a clean tower:
> `Space laser defense TOWER for the CYBORG team with red hints and junk metal
> with lots of wiring. Looks like it was hacked together from various pieces of
> super tech.`

Per-faction flavor to reuse in the sentence:
- **Cyborg**: red hints, junk metal and lots of wiring; looks hacked together from scavenged super tech.
- **Human**: blue hints, clean military-grade plating; looks like polished, well-engineered starbase tech.
- **Robot**: cyan hints, sleek chrome plating; looks like precision factory-built machinery.

Settings (same as the units): Humanoid, **Pro**, **64px**, Low Top-Down.

---

## CYBORG defender towers/guns - paste-ready prompts
(Cyborg attacker roster already exists.)

- **Tower** (`turret`): `Space auto-gun defense TOWER for the CYBORG team with red hints and junk metal with lots of wiring. A single-barrel turret that looks hacked together from various pieces of super tech.`
- **Phaser** (`cannon`/gun): `Space beam-cannon defense TOWER for the CYBORG team with red hints and junk metal with lots of wiring, one long focusing barrel. Looks hacked together from various pieces of super tech.`
- **Laser** (`laser`): `Space laser defense TOWER for the CYBORG team with red hints and junk metal with lots of wiring. Looks like it was hacked together from various pieces of super tech.`
- **Blastor** (`bomber`): `Space mortar defense TOWER for the CYBORG team with red hints and junk metal with lots of wiring, a stubby upward-angled launcher. Looks hacked together from various pieces of super tech.`
- **Sentry** (`sentry`): `Space heavy weapons turret on treads for the CYBORG team with red hints and junk metal with lots of wiring. A mobile gun platform that looks hacked together from various pieces of super tech.`

## HUMAN defender towers/guns - paste-ready prompts

- **Tower** (`turret`): `Space auto-gun defense TOWER for the HUMAN team with blue hints and clean military-grade plating, a single-barrel turret. Looks like polished, well-engineered starbase tech.`
- **Phaser** (`cannon`/gun): `Space beam-cannon defense TOWER for the HUMAN team with blue hints and clean military-grade plating, one long focusing barrel. Looks like polished, well-engineered starbase tech.`
- **Laser** (`laser`): `Space laser defense TOWER for the HUMAN team with blue hints and clean military-grade plating. Looks like polished, well-engineered starbase tech.`
- **Blastor** (`bomber`): `Space mortar defense TOWER for the HUMAN team with blue hints and clean military-grade plating, a stubby upward-angled launcher. Looks like polished, well-engineered starbase tech.`
- **Sentry** (`sentry`): `Space heavy weapons turret on treads for the HUMAN team with blue hints and clean military-grade plating. A mobile gun platform that looks like polished, well-engineered starbase tech.`

## SUPPORT STRUCTURES + POWER CORE - paste-ready prompts
Faction versions of the EXISTING piece types (no new gameplay types invented).
Same settings: Humanoid, Pro, 64px, Low Top-Down.

**POWER CORE** (`powercore` - the win/lose objective; each faction needs its own; the existing one is the robot/default):
- Cyborg: `Space POWER CORE reactor for the CYBORG team, a big glowing red energy core in a junk-metal housing with lots of wiring. Looks like it was hacked together from various pieces of super tech.`
- Human: `Space POWER CORE reactor for the HUMAN team, a big glowing blue energy core in clean military-grade housing. Looks like polished, well-engineered starbase tech.`

**SIGNAL** (`signal` - EMP satellite-dish tower):
- Cyborg: `Space EMP signal dish TOWER for the CYBORG team with red hints and junk metal with lots of wiring, a scavenged satellite dish on a mast. Looks hacked together from various pieces of super tech.`
- Human: `Space EMP signal dish TOWER for the HUMAN team with blue hints and clean military-grade plating, a polished satellite dish on a mast. Looks like well-engineered starbase tech.`

**SHIELD** (`defense` - dome shield generator):
- Cyborg: `Space shield generator for the CYBORG team with red hints and junk metal with lots of wiring, projecting a glowing red energy dome. Looks hacked together from various pieces of super tech.`
- Human: `Space shield generator for the HUMAN team with blue hints and clean military-grade plating, projecting a glowing blue energy dome. Looks like well-engineered starbase tech.`

**MINE** (`mine` - proximity mine):
- Cyborg: `Space proximity MINE for the CYBORG team, a small spiky device of red junk metal and wiring. Looks hacked together from super tech.`
- Human: `Space proximity MINE for the HUMAN team, a small clean blue military device. Looks like well-engineered starbase tech.`

**WALL** (`wall` - barrier segment; currently procedural geometry, would need art wiring):
- Cyborg: `Space barrier WALL segment for the CYBORG team, welded junk metal and wiring with red lights. Looks hacked together from super tech.`
- Human: `Space barrier WALL segment for the HUMAN team, clean military-grade armored plating with blue lights. Looks like well-engineered starbase tech.`

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
| Grenadier (`grenadier`) | 108 | `shouldering a sci-fi grenade launcher, amber-orange visor and trim` |
| Hulk (`hulk`) | 108 | `huge heavy trooper in massive powered exo-armor / heavy weapons, gold/yellow trim and lights` |
| Sniper (`sniper`) | 104 | `lean marksman aiming a long sci-fi rail / sniper rifle, acid-green visor and scope glow` |
| Stalker (`stalker`) | 112 | `stealth operative with an energy blade and cloak, crouched, violet-purple blade and visor` |
| Hacker (`hacker`) | 104 | `tech specialist holding a glowing holo-tablet, no firearm, cyan/teal screen and trim` |

## ROBOTS - ATTACKER units (OPTIONAL)
Only needed if you want Robots to be playable as the attacker with their own
look (today robot-as-attacker borrows the cyborg art). Prompt = Robot
war-machine preamble + subject.

| Unit | Canvas | Subject to append |
|---|---|---|
| Cannon (`cannon`) | 104 | `robot shouldering a heavy cannon, crimson-red optic and trim` |
| Grenadier (`grenadier`) | 108 | `robot with a grenade launcher, amber-orange optic and trim` |
| Double Gun (`doublegun`) | 112 | `robot dual-wielding heavy guns, electric-blue optic and trim` |
| Hulk (`hulk`) | 108 | `massive hulking battle-robot, heavy armored frame, gold/yellow lights` |
| Sniper (`sniper`) | 104 | `slim long-range robot with a rail/sniper rifle, acid-green optic and scope` |
| Medic (`medic`) | 108 | `support robot with a repair/med device, white + green lights` |
| Stalker (`stalker`) | 112 | `stealth assassin robot, blades, crouched, violet-purple optic and blades` |
| Hacker (`hacker`) | 104 | `spindly tech robot holding a hacking device, no gun, cyan/teal screen and optic` |

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
