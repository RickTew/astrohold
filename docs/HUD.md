# AstroHold — HUD & UI Reference

Layout, panel composition, and chrome details for the in-game HUD,
side-picker modal, and Mini Control Center. **Read this AND the
"HUD HARD LOCK protocol" section in CLAUDE.md before touching any
HUD code.** Per-piece numbers live in `STATS.md`; per-file code map
lives in `ARCHITECTURE.md`.

## Top HUD strip (session 15)
Floating top strip with three SVG-silhouetted panels. **DO NOT
reserve canvas space for it.** Canvas is full window; HUD floats on
top with `rgba(8,18,32,0.58)` panel fill so the map shows through.

To stop the world top row from rendering BEHIND the HUD,
`Game.computeCameraYOffset()` reads `--hud-top-h` and shifts
`camera.position.y` so world top aligns with HUD bottom. Resize
re-applies via the delta to preserve user pan.

### Tile grid sizing
`.tile-grid` uses `grid-template-columns/-rows: repeat(N, auto)`
+ `justify-content: center` + `align-content: center` so each
`.hud-tile` is content-sized (icon + label + cost) and the cluster
sits centered with breathing room on all four sides of the cyan
panel border. Unit icons remain at `clamp(46px, 7vh, 64px)`.

**Don't go back to `1fr`.** It stretched tiles into the panel border
and left empty space under the cost text.

### Panel composition
- **LEFT panel** — 4x2 robot tile grid (8 pieces): Sphere/Tower/
  Bomber/Sentry over Dog/Wall/Laser/Repair. Laser is the lone
  "preview" piece left; the rest have real mechanics.
- **CENTER panel** — chamfered rectangle SVG with two internal
  dividers splitting it into three console "screens":
  - **Title bar** (`.cc-title`): BUILD PHASE / PLAN PHASE / BATTLE
    label in Orbitron, flanked by corner-bracket glyphs.
  - **Body** (`.cc-body`): CR chip (Orbitron number, green glow),
    matchup line ("ROBOTS VS CYBORGS"), single-line system status
    from `HUD.logSystemMessage`.
  - **Action bar** (`.cc-action`): primary action button
    (READY/BATTLE). Color follows role (.role-defender = blue,
    .role-attacker = red); `:active` translates 2px for mechanical feel.
- **RIGHT panel** — duplicate of LEFT, both clickable.
- Cyborg variant `#hud-top-att` has a 4x2 attacker grid (6 unique
  cyborgs + 2 duplicates after S15 added Medic). `setPlayerSide`
  toggles which strip variant renders; `.ai-side` hides the inactive
  one.
- Panel silhouettes are inline SVG with
  `vector-effect="non-scaling-stroke"` so chamfered corners stay
  crisp at any width. CSS clip-path was tried and abandoned (produces
  aliased corners against borders).

### Session 15 effects (shipped from build-test sandbox)
- Tile hover-pop (snappy scale + glow).
- CR bloom pulse (50% intensity).
- Letter-by-letter phase title reveal: `HUD.setPhase` wraps chars in
  `.boot-char` spans inside `.phase-chars`.
- Additive-blend selection pulse ring on `.hud-tile.selected`.
- Edge-trace orbit (SVG `<animateMotion>` dot on center panel,
  auto-hidden during REVEAL via `.phase-reveal` class).
- Unit icon glow.

All theme-matched (cyan defender / pink attacker).

## Mini Control Center (S18)
Floating bottom-right widget (`src/ui/MiniControlCenter.ts`,
"Variant C" dial). Beveled cyan ring + speed arc + 4 inner toggle
pips at 12/3/6/9 + BATTLE/PAUSE pill at the bottom. Procedural CSS
+ inline SVG. Hidden during loading + pick-side phases.

- **Speed dial** — `RevealSpeed.setRevealSpeed` slow (x5.0),
  normal (x2.5), fast (x1.0). Persisted localStorage.
- **BATTLE/PAUSE pill** — starts reveal during BUILD; toggles
  `RevealPhase.paused` during reveal (engine freezes step
  advancement but in-flight projectiles keep ticking); PLAY AGAIN
  full-reloads after game end.
- **Toggles** — Music / SFX / Speech / Combat log all
  localStorage-persisted via `AudioSettings.ts`. SFX gates
  `playGunshot` + `playExplosion`; Speech gates speech bubbles;
  Combat log toggles `.center-log` display.

## Side-picker modal (#side-picker)
Full-screen before BUILD. **2 cards**: DEFENDER and ATTACKER. Card color
follows ROLE: defender=blue, attacker=red. AI gets the opposite role +
opposite faction.

**Swap factions pill (S22d, `#sp-swap`).** A slim pill below the cards (above
AI DIFFICULTY) flips which FACTION (team name + mascot sprite + `data-faction`)
mans each role card. ROLE is fixed per card (label, color, tagline stay);
faction moves. The card click reads the live `data-faction`, so swapping is
all the wiring needs. Default = Robots defend / Cyborgs attack. Note: faction
is cosmetic (music + label); rosters are role-bound, so a swapped pairing does
NOT yet bring faction-specific pieces.

Layout uses `clamp()` everywhere (no fixed px) and the safe-centering
pattern (outer `overflow: auto` + inner `min-height: 100% + flex
center`). "How to play" expander below the cards.

Phase x Faction expansion (4 cards / same-faction matchups) is RETIRED
for now; `Faction` and `Role` types still in GameConfig in case it
comes back. **Do not redesign without explicit user direction.**

A difficulty selector sits on this modal (easy / normal / hard).
`Difficulty.aiCreditMultiplier()` is the only economic knob: easy
0.75x AI credits, normal 1.0x, hard 1.25x. Player credits never
change with difficulty.

## Combat history log
Streams every reveal action to a right-rail panel during BATTLE
(D&D-style turn log; side-coloured rows). Visibility toggled by the
MCC "Combat log" pip.

## Compass-rose UI
Right-click a placed firing structure during BUILD to buy extra
fire-arc directions (30cr per added cardinal). Fire-arc preview
appears under the placement ghost so the player sees coverage
before committing.

## Build-test sandbox
`build-test.html` (live at https://astrohold3.vercel.app/build-test.html)
is the HUD A/B surface and the audio-pool test page. Imports production
MCC + shield from `/src/*` via `src/devtools/buildTest.ts` (moved out
of `/public/` into Vite's input set during S19). All BEFORE rows must
render PIXEL-FAITHFUL to production. If the BEFORE row drifts, re-sync
CSS before anything else.

## Color conventions (session 14)
- **Defender = blue, Attacker = red.** Applied consistently across HUD
  theming, side-picker cards, action button, matchup line.
- **Player vs AI team tinting is OFF.** `TEAM_TINT` in `GameConfig.ts`
  is `{ player: 0xffffff, ai: 0xffffff }` (no-op). Position (left zone
  = your side) signals ownership.
- **Per-type sprite tints removed.** `SPRITE_TINT` in `SpriteUnit.ts`
  is `{}`. Pieces render with their natural sprite-art colors.
