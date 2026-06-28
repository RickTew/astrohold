# Faction Rosters - build plan

Goal: make picking a faction (Robots / Cyborgs / Humans) actually field
that faction's own pieces, instead of faction being a cosmetic label over
one shared role roster. Scoped 2026-06-28 after a playtest where "pick
Humans/Cyborgs as Defender" handed the player the shared robot-tech
structures.

This is an ART + a small CODE-SEAM build. Stats stay role-bound and
unchanged (a faction is a SKIN over the same stat block); only the
sprites/icons differ. So the engine work is "resolve art by faction,"
which units already do and structures do not yet.

## 1. Current state (what actually exists)

Faction is `'robot' | 'cyborg' | 'human'`, decoupled from role
(`'defender' | 'attacker'`) - the side picker lets any faction man either
card.

**Units (`SpriteUnit`) are already faction-aware.** `factionArtKey(faction,
type)` resolves `FACTION_ART[faction][type] ?? type` to an art key, and
`animSets`/`NATIVE_SIZE` are keyed by that art key. Today only one override
set exists:

```
FACTION_ART = { human: { cannon: 'human_warrior', doublegun: 'human_marine', medic: 'human_medic' } }
```

**Structures (`Structure`) are NOT faction-aware.** Art is keyed by TYPE
only (`STRUCTURE_SPRITE_FOLDERS[type]`), preloaded by type into
`structureTextures`/`structureRotationTextures`/`...`. The constructor
takes `team: 'player' | 'ai'` (for the red/blue tint) but no faction.
`SphereDefender` is the same (separate class, `team` only).

**Net effect:** the only faction-distinct pieces in the game are the three
Human attacker units. Everything else falls back to the default art, which
reads as "robot tech" on defense and "cyborg" on attack.

## 2. The roster matrix - what art is needed

Pieces that appear in the shops, by role:

**Defender role (11 art sets + procedural Wall):**
- Structures: Tower (`turret`), Phaser (`cannon`, currently borrows `gun`
  art), Blastor (`bomber`), Laser (`laser`), Sentry (`sentry`), Mine
  (`mine`), Signal (`signal`), Shield (`defense`). Wall (`wall`) is
  procedural geometry, no sprite.
- Mobile: Dog (`dog`), Repair (`repair`), Sphere (`sphere`, a
  `SphereDefender`).

**Attacker role (8 art sets):**
- `cannon`, `grenadier`, `doublegun`, `hulk`, `sniper`, `medic`,
  `stalker`, `hacker`. (`scout`/`tank`/`bomber`/`drone` exist in Config
  but are not shopped.)

Coverage today (DONE = art exists, GAP = needs art):

| Faction | Defender skin | Attacker skin |
|---|---|---|
| Robot  | DONE (this is the current shared structure art) | GAP (all 8 - robot-as-attacker currently shows cyborg art) |
| Cyborg | GAP (all 11) | DONE (current default attacker art) |
| Human  | GAP (all 11) | PARTIAL: cannon/doublegun/medic DONE; GAP = grenadier, hulk, sniper, stalker, hacker (5) |

Full decoupled coverage = every cell DONE. The expensive cells are the two
full GAP columns (Cyborg defender, Human defender = 11 each) and the two
attacker GAPs (Robot 8, Human 5).

## 3. Art asset spec (commission brief per piece)

Match the existing PixelLab deliveries in `/_zips/` and the layout in
`/public/sprites/<folder>/`:

- **Static rotations:** 8 PNGs `north,north-east,east,south-east,south,
  south-west,west,north-west.png`. Square canvas; native pixel width = the
  rendered world size (S21 1:1, PPWU 2). Keep transparent padding
  consistent so pieces read at the right relative scale.
- **Animation states** live at `<folder>/<state>/<dir>/frame_NNN.png`.
  Required states per piece TYPE (mirror the same-type cyborg/robot art so
  the engine's manifest just works):
  - Attacker gunner (cannon/doublegun/sniper): `idle, walking, shoot, die`
    (+ `aim` for sniper/human gunners).
  - Thrower (grenadier/bomber/hacker): `idle, walking, throw, die`.
  - Hulk: `walking, shoot, throw, die`.
  - Medic/Repair: `idle, walking, die` (+ `repair` for repair).
  - Dog: `walking, die`.
  - Structures: a single `south.png` is enough for static turrets;
    Tower-class wants 8 rotations (compass-rose facings). Add
    `explosion/frame_NNN.png` for pieces that should blow up (Tower,
    Blastor, Sentry do today). Sentry additionally needs `walking/`
    (it is mobile).
  - Sphere/Power Core: 8 rotations + `explosion/`.
- A single `south.png` per piece is also needed for the HUD shop ICON.

Manifest: each new ANIMATED art key needs an entry in `MANIFEST` in
`SpriteUnit.ts` (frame counts, fps, present dirs). Static-only structures
do not.

## 4. The code seam

Small and mechanical. Three changes, then it is data-only per piece.

1. **Make structures faction-aware (mirror units).**
   - Add `factionStructureFolder(faction, type)` returning a faction
     override folder or the default `STRUCTURE_SPRITE_FOLDERS[type]`. Add a
     `FACTION_STRUCTURE_ART` map (empty = all fall back, zero behavior
     change).
   - Key the texture caches by an art key (`<faction>:<type>` or a folder
     string) instead of bare `type`, exactly like `animSets`. Update
     `structureSizeFor`, explosion/rotation/walk lookups to take the key.
   - Add `faction: Faction` to the `Structure` constructor and
     `SphereDefender`; resolve the art key in `buildVisual`.
   - `preloadStructureSprites()` loops the faction overrides too (only the
     keys present in `FACTION_STRUCTURE_ART`, so no wasted fetches).

2. **Thread faction into placement.** Player structures are spawned in
   `Game.ts` placement (BuildPhase). Pass `this.playerFaction` to
   `new Structure(...)` / `new SphereDefender(...)`; AI passes
   `this.aiFaction`. (Units already receive faction.)

3. **HUD shop swap by faction (extends the existing pattern).**
   `setPlayerSide` already swaps the attacker grid to the Human roster.
   Generalize it: pick the shop tile array + icons by `(role, faction)`.
   Add `robot... / cyborg... / human...` defender tile arrays as their art
   lands. Icons just point at the faction folder's `south.png`. This is
   HUD CONTENT (tile arrays), not the frozen HUD style - safe under the
   HUD hard lock as long as tile shape/CSS is untouched.

Register new animated art keys with `preloadSpriteUnit(key, folder)` in
`Game.ts` init (like the three human keys already there).

## 5. Recommended phasing (ship value incrementally)

- **Phase 0 (optional, cheap, no art): per-faction tint.** Multiply a
  faction palette over the shared structure/unit art (like the existing
  team tint) so factions at least read differently right now. Hours, not
  weeks. Good stopgap while real art is produced.
- **Phase 1 (code seam, no art):** land section 4 with empty override
  maps. Zero visual change, but every later faction skin becomes a
  data-only drop-in. De-risks the whole build.
- **Phase 2 (highest visibility): finish the Human ATTACKER roster** (5
  missing units). Humans already partly exist and attacker units are the
  most-watched pieces.
- **Phase 3: one full DEFENDER faction skin** (Cyborg or Human) - the
  exact gap the playtest hit. ~11 pieces.
- **Phase 4+:** remaining columns as desired (Robot attacker, the other
  defender column).

## 6. Open decisions (these drive the cost)

- **D1 - Keep faction fully decoupled from role?** Full decoupling needs
  all 6 faction x role combos (~57 piece-skins). If instead each faction
  has ONE canonical role (e.g. Robots defend, Cyborgs + Humans attack), the
  matrix roughly halves and the picker constrains accordingly.
- **D2 - Art source + budget.** Same PixelLab pipeline as `/_zips/`? How
  many pieces are we willing to commission, and in what order?
- **D3 - Real redraws vs palette-swap for structures.** Bespoke per-faction
  structure art is the big cost. A recolor/palette-swap (Phase 0) is far
  cheaper if "distinct enough" is acceptable for some factions.
- **D4 - Sphere + Power Core.** Faction-skin these too, or keep them
  shared as neutral "objective" tech?

## 7. Files in scope

- `src/entities/SpriteUnit.ts` - `FACTION_ART`, `MANIFEST`, preload.
- `src/entities/Structure.ts` - faction-aware art (the main code work).
- `src/entities/SphereDefender.ts` - faction param + art.
- `src/game/Game.ts` - thread faction into placement + preload registration.
- `src/ui/HUD.ts` - per-faction shop tile arrays + icons (content only).
- `public/sprites/<faction_piece>/` - the new art.
- Update `docs/STATS.md` only if a faction ever diverges on stats (it
  should not - faction is a skin).
