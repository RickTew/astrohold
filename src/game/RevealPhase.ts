import * as THREE from 'three'
import { Config, StructureType } from './GameConfig'
import { CellRef, QueuedAction, TargetRef } from './TurnTypes'
import { SpriteUnit } from '../entities/SpriteUnit'
import { SphereDefender } from '../entities/SphereDefender'
import { Structure, getGrenadeTexture, getMedPackTexture } from '../entities/Structure'
import { PixelPowerCore } from '../entities/PixelPowerCore'
import { Projectile } from '../entities/Projectile'
import { Explosion } from '../entities/Explosion'
import { PendingGrenade } from '../entities/PendingGrenade'
import { MedicPad } from '../entities/MedicPad'
import { Tether } from '../entities/Tether'
import { RepairPad } from '../entities/RepairPad'
import { RepairTether, RepairTetherTarget } from '../entities/RepairTether'
import { AmmoBox, KIT_AMOUNT } from '../entities/AmmoBox'
import { playExplosion, playWeaponSfx, playEventSfx, WeaponSfxId } from '../audio/sfx'
import { revealSpeedMultiplier } from './RevealSpeed'
import { spawnSpeechBubble } from '../entities/SpeechBubble'

// Phase 3 reveal engine: consumes the queued plans the player set up during
// Planning, sorts every (actor, action) pair by Initiative descending, and
// animates them one at a time cinematically. Strict-skip on invalid actions
// per the locked design — if your queued target died from an earlier action,
// or your destination cell got taken, the piece does nothing for that step.

type Actor = SpriteUnit | SphereDefender | Structure
type AnyTarget = Actor | PixelPowerCore

interface PlannedStep {
  actor: Actor
  action: QueuedAction
  // True if `action` is a placeholder and the REAL action should be
  // computed fresh at execute time by calling defaultMobileUnitAction(actor).
  // Without this, slow units (Hulk = lowest initiative) plan their step
  // based on the start-of-reveal state — where faster cyborgs are still
  // blocking their west cell — and end up locked into N/S sidesteps even
  // after the blockers have moved out of the way by execute time.
  isDefault?: boolean
}

// One line in the D&D-style turn log. Side drives the row colour in the HUD
// (defender = blue, attacker = red, neutral = grey). RevealPhase emits these
// as actions resolve; Game flushes them to the HUD after each reveal completes.
export interface CombatLogEntry {
  side: 'defender' | 'attacker' | 'neutral'
  text: string
}

// Telemetry event emitted from damage / kill / action sites so Game can
// roll them into BattleStats. Avoids re-parsing log text.
export type PieceEvent =
  | { kind: 'damage'; actorType: string; side: 'attacker' | 'defender'; amount: number }
  | { kind: 'kill';   actorType: string; side: 'attacker' | 'defender' }
  | { kind: 'action'; actorType: string; side: 'attacker' | 'defender'; action: string }
  | { kind: 'assist'; actorType: string; side: 'attacker' | 'defender' }
  | { kind: 'move';   actorType: string; side: 'attacker' | 'defender' }
  | { kind: 'attack'; actorType: string; side: 'attacker' | 'defender' }
  // S17.10 telemetry expansion. Each event below feeds a per-piece-type
  // counter on the BattleRecord so /stats.html can surface bugs the
  // headline counters miss (accuracy issues, AoE targeting bugs,
  // resupply parity, setup-damage credit, one-shot detection).
  | { kind: 'hit';    actorType: string; side: 'attacker' | 'defender' }
  | { kind: 'miss';   actorType: string; side: 'attacker' | 'defender' }
  | { kind: 'friendly_fire'; actorType: string; side: 'attacker' | 'defender'; count: number }
  | { kind: 'weakening'; actorType: string; side: 'attacker' | 'defender' }
  | { kind: 'one_shot'; actorType: string; side: 'attacker' | 'defender'; targetType: string }
  | { kind: 'crate_pickup'; side: 'attacker' | 'defender' }
  | { kind: 'core_recharge'; side: 'defender' }
  | { kind: 'grenade_throw'; throwerType: string; side: 'attacker' | 'defender'; throwerX: number; throwerY: number; landX: number; landY: number; nearestEnemyX: number | null; nearestEnemyY: number | null; distFromEnemy: number | null }

interface AoeSummary { hits: number; damageDealt: number; kills: number }

// Seconds per action in the reveal. Slow enough that the player can read each
// step ("ok the sphere just fired at the cannon"), fast enough that a full
// turn doesn't drag. Projectile flight may exceed this — projectiles keep
// flying during subsequent steps, which actually reads nicely.
const STEP_DURATION = 0.6

const MINE_DETECT_RADIUS = 65

// Half-angle of a structure's fire arc, in radians. 60° each side = 120°
// total wedge. East-facing defender towers cover everything between NE and
// SE (the cyborg corridor). Future UI lets the player pay credits to add
// extra facings to the structure's fireFacings array.
// S17.19: FIRE_ARC_HALF_RAD retired. Old 120-degree wedge let towers
// shoot diagonally. The arc check now uses a cardinal-lane rule (see
// targetInFireArc).

// Structures that fire in any direction (no arc gating). Their sprite
// rotates each turn to face whichever target they're shooting — the
// compass-rose direction picker is treated as a starting orientation,
// not a fire restriction. Sentry's tracked-vehicle art has gun arms that
// turn naturally; users expect adjacent enemies to be shot regardless
// of where the sentry was last pointing.
const STRUCTURE_OMNI_FIRE: Partial<Record<StructureType, true>> = {
  sentry: true,
}

// Universal melee fallback — out-of-ammo non-support units swing for a
// small fixed damage if an enemy is adjacent. Keeps battles from grinding
// to a halt when both sides have burned through their ammo. Excluded:
//   - Hulk: already has unlimited fists at his full damage (55)
//   - Sniper: no melee — retreats to base when empty
//   - Medic + Repair: support, retreat when charges are spent
const MELEE_FALLBACK_DAMAGE = 10
// Melee reach, derived from GRID_CELL so it survives board / cell resizes.
// CARDINAL-adjacent only: a touching N/S/E/W cell is exactly one GRID_CELL
// away (center to center); a diagonal cell is GRID_CELL*sqrt(2) (~1.41 cells)
// away. The reach sits BETWEEN those (1.3 cells) so it covers the cardinal
// neighbor with margin but excludes the diagonal — matching cardinal-only
// movement, so a melee unit must be truly next to its target, not a half-cell
// gap away. (1.5 reached the diagonal, which read on screen as "attacking from
// a distance.") Must also stay under 2.0 so it never hits a cell two out.
// Was a hardcoded 70 ("~1.4 cells" at the old 50px cell, also cardinal-only);
// the S22b bump to 75px left 70 < one cell, so melee units couldn't reach the
// 2x2 Power Core or an adjacent enemy — they marched up and "danced" til dead.
const MELEE_REACH = Math.round(Config.GRID_CELL * 1.3)
const MELEE_FALLBACK_RANGE = MELEE_REACH

// Cyborg Nerd HACK — how many reveals a hacked robot stays a turncoat before
// it reverts to fighting cyborgs. Decremented once per reveal in tickHack.
const HACK_DURATION = 3
// Structure types the Hacker can turn — single-target direct-fire towers
// that route through the standard (side-agnostic) projectile path, so a
// hacked one cleanly shoots robots. Excluded: walls/mines/shields (no
// weapon), bomber/signal (lob + EMP special actions), and the Phaser
// 'cannon' (its piercing-beam path scans cyborgs directly).
const HACKABLE_STRUCTURES: Partial<Record<StructureType, true>> = {
  turret: true, laser: true, sentry: true,
}

// Each bomb now carries its own timerTurns based on triggerMode (see
// PendingGrenade). Proximity bombs default to 3 armed reveals (safety
// fuse against ignored traps); timed grenades default to 1 (grenadier
// cooked grenade). This constant is no longer used — kept for now as
// documentation; remove if no other reference picks it up.

// Repair-priority for a given defender structure type. Higher = the repair
// bot will tether/throw at it before lower-priority pieces tie-breaking on
// missing HP. Tuned so the bot defends the offensive arsenal first (cannon
// > bomber > tower > gun > laser > defense), and walls only after a real
// piece runs low.
function structureRepairPriority(type: string): number {
  switch (type) {
    case 'cannon':  return 9
    case 'bomber':  return 8
    case 'sentry':  return 8  // tankier than tower, mid-cost — high priority for repair bots
    case 'turret':  return 7
    case 'laser':   return 6
    case 'gun':     return 5
    case 'defense':
    case 'signal':  return 3
    case 'wall':    return 2
    case 'mine':    return 1
    default:        return 1
  }
}

// 4 cardinal neighbors (N/S/E/W). All standard units move on this grid —
// no diagonals — making positioning sharper and slower-paced. A future
// special-character unit can opt into 8-direction movement via the
// per-unit allowDiagonalMove flag in Config.
const CARDINAL_STEPS: readonly [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
]
const DIAGONAL_STEPS: readonly [number, number][] = [
  ...CARDINAL_STEPS, [1, 1], [1, -1], [-1, 1], [-1, -1],
]

export class RevealPhase {
  private steps: PlannedStep[]
  private idx = 0
  private stepTime = 0
  private firstTickOfStep = true
  private projectiles: Projectile[] = []
  private explosions: Explosion[] = []
  private done = false
  private over = false   // win or lose triggered — wait for projectiles to settle then complete
  // True if any combat-relevant event happened during this reveal: shots
  // fired, bombs detonated, mines triggered, grenadier diffuse. Game uses
  // this to detect a "no-progress" stalemate when all sides are out of
  // ammo and movement loops indefinitely.
  combatThisReveal = false
  // True if any unit actually moved this reveal (successful executeMove,
  // not a blocked attempt). Game combines this with combatThisReveal: a
  // reveal that produced NEITHER is a true no-progress reveal. Marching
  // cyborgs counted as no-combat reveals were tripping the stalemate
  // guard while units were still pathing toward each other.
  movementThisReveal = false

  // Shield aura observability. Bumped every time shieldedDamage returns
  // a reduced amount; `absorbed` accumulates the (original - reduced)
  // delta so post-game stats can show how much damage the shield ate.
  // Game reads these in onComplete and folds into the BattleRecord.
  shieldSaves = 0
  shieldAbsorbed = 0

  // D&D-style turn log. Each combat-relevant event pushes one entry here as
  // it resolves. Game reads this after onComplete and forwards it to the HUD.
  readonly combatLog: CombatLogEntry[] = []

  onComplete: (() => void) | null = null
  onWin: (() => void) | null = null
  onLose: (() => void) | null = null
  // Fires immediately each time a log line is recorded — Game wires this to
  // HUD.appendCombatLogEntry so the panel updates in step with the visible
  // action, instead of dumping a whole reveal's events in a batch after
  // every animation finishes. The combatLog array is still maintained for
  // anything that wants the full transcript at end-of-reveal.
  onLogEntry: ((entry: CombatLogEntry) => void) | null = null

  // Per-piece + per-action telemetry. Game subscribes and accumulates
  // into BattleStats so we can spot balance issues across many games
  // (e.g. "Hulk dealt 60% of cyborg damage in 20 games"). Fired from
  // the damage / kill / action sites directly so we don't re-parse
  // log text. Optional — if no listener, events are dropped silently.
  onPieceEvent: ((e: PieceEvent) => void) | null = null
  private emit(e: PieceEvent) { this.onPieceEvent?.(e) }
  private actorTypeKey(actor: Actor): string {
    if (actor instanceof SphereDefender) return 'sphere'
    return actor.type   // SpriteUnit + Structure both have .type
  }
  // Map an actor to its weapon SFX id. Centralized so adding a new
  // unit/structure only needs one new case. Defaults to 'rifle' for
  // anything unmapped so the game never goes silent on a fire action.
  private weaponSfxFor(actor: Actor): WeaponSfxId {
    if (actor instanceof SphereDefender) return 'sphere'
    if (actor instanceof Structure) {
      switch (actor.type) {
        case 'cannon':   return 'phaser'   // defender Cannon is the Phaser beam
        case 'sentry':   return 'sentry'
        case 'bomber':   return 'bomb_throw'  // mortar lob (detonation uses playExplosion)
        case 'turret':   return 'rifle'
        case 'gun':      return 'rifle'
        case 'laser':    return 'phaser'
        default:         return 'rifle'
      }
    }
    // SpriteUnit
    switch (actor.type) {
      case 'sniper':     return 'sniper'
      case 'doublegun':  return 'doublegun'
      case 'grenadier':  return 'bomb_throw'
      case 'hulk':       return 'melee_hit'
      case 'stalker':    return 'stalker_swing'
      case 'dog':        return 'melee_hit'
      case 'medic':      return 'heal'
      case 'repair':     return 'weld'
      case 'cannon':     return 'rifle'   // cyborg cannon
      default:           return 'rifle'
    }
  }
  // Assist tracking — for each target that has taken damage this match,
  // remember the set of attacker types that hit it. On kill, every non-
  // killer attacker in the set gets an 'assist' event. Target IDs:
  // SpriteUnit/Structure/SphereDefender use .id; PowerCore uses 'core'.
  private damageHistory = new Map<string, Set<string>>()
  private targetId(target: { id?: string } | PixelPowerCore): string {
    if (target instanceof PixelPowerCore) return 'core'
    return target.id ?? '?'
  }

  // Diminishing-returns heal scaling. Each successive heal on the same
  // target multiplies by HEAL_DR_FACTORS[count]; count 5+ means zero
  // healing applied (loop dies). Streak resets in two places:
  //   1. A single damage event >= HEAL_DR_RESET_PCT of maxHp lands on
  //      the target (handled in attribute()).
  //   2. The target sat unhealed for HEAL_DR_QUIET_TURNS reveals (gated
  //      below when looking up the streak).
  // healStreaks Map is owned by Game so it survives RevealPhase rebuilds.
  private readonly HEAL_DR_FACTORS = [1.0, 0.75, 0.5, 0.25, 0]
  private readonly HEAL_DR_QUIET_TURNS = 5
  private readonly HEAL_DR_RESET_PCT = 0.25

  // Scaled heal application. Computes the streak factor, applies it,
  // then calls target.heal() with the scaled amount. Returns the actual
  // amount healed (after scaling + target.heal's full-HP clamp) so
  // callers can log it. A scaled amount of 0 means "loop is dying" and
  // the heal is skipped entirely (no VFX, no log).
  private applyHeal(
    target: { id?: string; hp: number; maxHp: number; isDead: boolean;
             heal(n: number, v?: 'number' | 'plus' | 'bubble'): boolean }
            | PixelPowerCore,
    amount: number,
    vfxVariant?: 'number' | 'plus' | 'bubble',
  ): { healed: boolean; scaled: number } {
    if (target.isDead) return { healed: false, scaled: 0 }
    if (target.hp >= target.maxHp) return { healed: false, scaled: 0 }
    const id = this.targetId(target)
    let entry = this.healStreaks.get(id)
    // Quiet-turns reset: if the target hasn't been healed in N reveals,
    // forget the streak and start fresh at full strength.
    if (entry && this.currentTurn - entry.lastHealTurn >= this.HEAL_DR_QUIET_TURNS) {
      entry = undefined
      this.healStreaks.delete(id)
    }
    const count = entry?.count ?? 0
    const factor = this.HEAL_DR_FACTORS[Math.min(count, this.HEAL_DR_FACTORS.length - 1)]
    const scaled = Math.max(0, Math.round(amount * factor))
    if (scaled <= 0) return { healed: false, scaled: 0 }
    const healed = target.heal(scaled, vfxVariant)
    if (healed) {
      if (!entry) {
        entry = { count: 0, lastHealTurn: this.currentTurn }
        this.healStreaks.set(id, entry)
      }
      entry.count = count + 1
      entry.lastHealTurn = this.currentTurn
    }
    return { healed, scaled }
  }

  // Bound version for callers that want a single-arg heal(target, amount, vfx)
  // function pointer (pad.tick() takes a callback so the pad doesn't need to
  // know about heal scaling).
  private boundApplyHeal = (
    target: { id?: string; hp: number; maxHp: number; isDead: boolean;
             heal(n: number, v?: 'number' | 'plus' | 'bubble'): boolean }
            | PixelPowerCore,
    amount: number,
    vfxVariant?: 'number' | 'plus' | 'bubble',
  ): boolean => this.applyHeal(target, amount, vfxVariant).healed
  // Centralized damage attribution. Emits damage, kill, and assist events
  // and updates damageHistory. Call this whenever takeDamage is applied
  // by a known attacker (skip for unattributed sources like wall self-damage).
  // Targets we've already credited a 'weakening' event for. One-shot per
  // target: a piece only counts as weakened the first time it drops
  // below 50 percent. Resets implicitly per RevealPhase instance.
  private weakenedTargets = new Set<string>()

  private attribute(
    target: { id?: string; isDead: boolean } | PixelPowerCore,
    attackerType: string,
    side: 'attacker' | 'defender',
    amount: number,
    killed: boolean,
  ) {
    this.emit({ kind: 'damage', actorType: attackerType, side, amount })
    const id = this.targetId(target)
    const wasInHistory = this.damageHistory.has(id)
    // Big hit resets the diminishing-returns heal streak. If a chunk of HP
    // gets blown off in one event, the target genuinely needs the next heal
    // at full strength, not the decayed loop value.
    const hpInfo = this.targetHpInfo(target)
    if (hpInfo && amount >= hpInfo.maxHp * this.HEAL_DR_RESET_PCT) {
      this.healStreaks.delete(id)
    }
    if (killed) {
      this.emit({ kind: 'kill', actorType: attackerType, side })
      // ONE-SHOT detection. If target had no prior damageHistory entries
      // and this single damage event killed it, the target was at full
      // HP when struck. Flags Sniper kills (expected) and anything else
      // that one-shots a full-HP piece (likely a bug we want to find).
      if (!wasInHistory) {
        const targetType = this.targetTypeKey(target)
        this.emit({ kind: 'one_shot', actorType: attackerType, side, targetType })
      }
      // Fire assist credit for any prior damager that wasn't the killer.
      const damagers = this.damageHistory.get(id)
      if (damagers) {
        for (const damagerType of damagers) {
          if (damagerType !== attackerType) {
            this.emit({ kind: 'assist', actorType: damagerType, side })
          }
        }
        this.damageHistory.delete(id)   // free memory; target is dead
      }
      // Speech + side-effects for the death. PixelPowerCore deaths run
      // through their own cinematic sequence elsewhere, so skip the
      // generic death handler for the core.
      if (!(target instanceof PixelPowerCore)) {
        this.handleDeath(target, side, attackerType)
      }
      // Killer (attacker) gets an on_kill brag if it's a SpriteUnit on
      // the field. Structures + spheres don't currently have an announce
      // method so they stay silent on kill.
      this.announceKill(attackerType, side)
    } else {
      if (!this.damageHistory.has(id)) this.damageHistory.set(id, new Set())
      this.damageHistory.get(id)!.add(attackerType)
      // Non-killing core hits get a reaction bubble from both factions.
      if (target instanceof PixelPowerCore) this.announceCoreHit()
      // WEAKENING detection. Target survived the hit but crossed below
      // 50 percent HP for the first time. Credits Grenadier and Bomber
      // for setup damage that enables an ally's kill, which raw kill
      // counts under-credit. Only fires once per target.
      if (!this.weakenedTargets.has(id)) {
        const hpInfo = this.targetHpInfo(target)
        if (hpInfo && hpInfo.hp > 0 && hpInfo.hp < hpInfo.maxHp * 0.5) {
          this.weakenedTargets.add(id)
          this.emit({ kind: 'weakening', actorType: attackerType, side })
        }
      }
    }
  }

  // Resolve a target's current HP + maxHp for weakening detection.
  // Returns null for targets where the concept doesn't apply (e.g.
  // future target types that haven't been wired in).
  private targetHpInfo(target: { isDead: boolean } | PixelPowerCore): { hp: number; maxHp: number } | null {
    if (target instanceof PixelPowerCore) return { hp: target.hp, maxHp: target.maxHp }
    if (target instanceof SpriteUnit) return { hp: target.hp, maxHp: target.maxHp }
    if (target instanceof Structure) return { hp: target.hp, maxHp: target.maxHp }
    if (target instanceof SphereDefender) return { hp: target.hp, maxHp: target.maxHp }
    return null
  }
  // Resolve a target's piece type for one_shot telemetry. Returns 'core'
  // for the Power Core, the piece type for other targets, or 'unknown'
  // as a fallback.
  private targetTypeKey(target: { isDead: boolean } | PixelPowerCore): string {
    if (target instanceof PixelPowerCore) return 'core'
    if (target instanceof SpriteUnit) return target.type
    if (target instanceof Structure) return target.type
    if (target instanceof SphereDefender) return 'sphere'
    return 'unknown'
  }

  // Resolve the dying target's position + side, spawn an on_death
  // speech bubble, and for ROBOT (defender) deaths fire a small
  // self-destruct AoE: the robot's "I chose to detonate" callouts are
  // backed by actual mechanical bite. Friendly fire applies (matches
  // the rest of the AoE system), so robot deaths can chain-detonate
  // a tight defender cluster which is the trade-off for the dramatic
  // exit lines.
  private handleDeath(
    target: { id?: string; isDead: boolean },
    killerSide: 'attacker' | 'defender',
    killerType: string,
  ) {
    let x = 0, y = 0
    let voice: 'cyborg' | 'robot' = 'robot'
    let isRobot = false
    if (target instanceof SpriteUnit) {
      x = target.worldX; y = target.worldY
      voice = target.side === 'attacker' ? 'cyborg' : 'robot'
      isRobot = target.side === 'defender'
    } else if (target instanceof Structure) {
      x = target.worldX; y = target.worldY
      voice = 'robot'
      isRobot = true
    } else if (target instanceof SphereDefender) {
      x = target.worldX; y = target.worldY
      voice = 'robot'
      isRobot = true
    } else {
      return
    }
    spawnSpeechBubble(this.scene, x, y, voice, 'on_death')

    // S17.21 unified death explosion. Both Hulk death and defender
    // self-destruct use Config.DEATH_EXPLOSION values for radius +
    // damage. One balance knob covers both pieces. Visual + log labels
    // still differentiate the two source types.
    const DEATH_R = Config.DEATH_EXPLOSION.radius
    const DEATH_DMG = Config.DEATH_EXPLOSION.damage

    // Hulk death (cyborg side).
    if (target instanceof SpriteUnit && target.type === 'hulk') {
      // Chain-guard: hulk killed by another death-blast does not
      // re-detonate. Otherwise tight cyborg clusters could daisy
      // chain through their own Hulks.
      if (killerType === 'hulk_blast' || killerType === 'self_destruct') return
      this.explosions.push(new Explosion(this.scene, x, y, DEATH_R, 0.6, 0xff7755))
      this.explosions.push(new Explosion(this.scene, x, y, DEATH_R * 0.55, 0.4, 0xffe0a0))
      playExplosion()
      const summary = this.applyAoeForSide(x, y, DEATH_R, DEATH_DMG, 'attacker', 'hulk_blast')
      if (summary.hits > 0) {
        this.combatThisReveal = true
        this.log('attacker', `Hulk death blast hits ${summary.hits} (−${summary.damageDealt}${summary.kills > 0 ? `, ${summary.kills} killed` : ''})`)
      }
      return
    }
    if (!isRobot) return
    // Defender self-destruct. Same chain-guard idea.
    if (killerType === 'self_destruct') return
    this.explosions.push(new Explosion(this.scene, x, y, DEATH_R, 0.55, 0xff9a4a))
    this.explosions.push(new Explosion(this.scene, x, y, DEATH_R * 0.55, 0.35, 0xffe0c0))
    playExplosion()
    void killerSide  // kept on signature for future per-killer tuning
    const summary = this.applyAoeForSide(x, y, DEATH_R, DEATH_DMG, 'defender', 'self_destruct')
    if (summary.hits > 0) {
      this.combatThisReveal = true
      this.log('defender', `Self-destruct AoE hits ${summary.hits} (−${summary.damageDealt}${summary.kills > 0 ? `, ${summary.kills} killed` : ''})`)
    }
  }

  // Find the attacker entity by type + side and fire its on_kill brag.
  // Best-effort: structures and spheres have no announce method so
  // they go silent on kill. Hulks / cannons / cyborgs all speak.
  // Shield aura. Defender pieces within 1.5 grid cells of any alive
  // defender Shield generator (type 'defense') take 25 percent less
  // damage. Applied at the major damage sites (direct fire, slam,
  // AoE). Returns the reduced amount, floored at 1 so a shielded
  // target never absorbs a hit entirely. Non-defender targets pass
  // through unchanged.
  private shieldedDamage(target: { isDead: boolean } | PixelPowerCore, amount: number): number {
    let isDefender = false
    let x = 0, y = 0
    if (target instanceof PixelPowerCore) {
      isDefender = true
      const cc = target.cellCenters()[0]
      x = cc.x + Config.GRID_CELL / 2
      y = cc.y + Config.GRID_CELL / 2
    } else if (target instanceof Structure) {
      isDefender = true
      x = target.worldX; y = target.worldY
    } else if (target instanceof SphereDefender) {
      isDefender = true
      x = target.worldX; y = target.worldY
    } else if (target instanceof SpriteUnit) {
      isDefender = target.side === 'defender'
      x = target.worldX; y = target.worldY
    }
    if (!isDefender) return amount
    // 2.0 grid cells = 100 world units. Covers the full 3x3 ring of
    // cells around the shield (cardinal neighbors at 50 units,
    // diagonal neighbors at ~71 units, both well inside 100). The
    // dome visual is sized to match this radius so what you see is
    // what gets protected.
    const AURA_RADIUS = Config.GRID_CELL * 2.0
    const DR = 0.25
    for (const s of this.structures) {
      if (s.type !== 'defense' || s.isDead) continue
      const d = Math.hypot(s.worldX - x, s.worldY - y)
      if (d <= AURA_RADIUS) {
        const reduced = Math.max(1, Math.round(amount * (1 - DR)))
        // Verification telemetry. saves = number of hits the shield
        // reduced; absorbed = total damage points eaten across the
        // match. Bumped every time the aura actually fires.
        this.shieldSaves++
        this.shieldAbsorbed += Math.max(0, amount - reduced)
        // Quick cyan flash on the target so the player SEES the shield
        // working in real time. Small explosion sprite tinted cyan,
        // shorter duration than a hit explosion so it doesn't compete
        // with the actual damage feedback.
        this.explosions.push(new Explosion(this.scene, x, y, 18, 0.22, 0x88e6ff))
        return reduced
      }
    }
    return amount
  }

  // Mine-spotted announcer. Cyborg sees an armed enemy mine in the
  // map (no strict sight gate, but within a reasonable proximity so
  // we don't spam "Mine!" from across the map). Uses SpriteUnit's
  // spokenSet dedupe so each unit only warns once per game.
  private maybeAnnounceMineSpotted(unit: SpriteUnit) {
    if (unit.side !== 'attacker') return
    const PROX = Config.GRID_CELL * 4   // within 4 cells
    for (const s of this.structures) {
      if (s.type !== 'mine' || s.isDead) continue
      const d = Math.hypot(s.worldX - unit.worldX, s.worldY - unit.worldY)
      if (d <= PROX) {
        unit.announceOnce('mine_spotted')
        return
      }
    }
  }

  private announceKill(attackerType: string, side: 'attacker' | 'defender') {
    const pool = side === 'attacker' ? this.units : this.defenderUnits
    // Pick the first living unit of matching type. If multiple of the
    // same type contributed to the kill chain we cannot tell which
    // actually swung; firing on the first is good enough for a
    // flavour callout.
    for (const u of pool) {
      if (u.isDead) continue
      if (u.type === attackerType) {
        u.announce('on_kill')
        return
      }
    }
  }

  // Core_hit: defender side reports the breach; cyborg side gloats
  // about approaching the objective. Spawn one bubble per faction
  // nearest the core, so the moment reads as a paired call/response.
  // De-dup per reveal so chip damage from a single bomb does not
  // produce two bubbles back-to-back.
  private coreHitAnnouncedThisReveal = false
  private announceCoreHit() {
    if (this.coreHitAnnouncedThisReveal) return
    this.coreHitAnnouncedThisReveal = true
    const cc = this.core.cellCenters()
    const cx = cc[0].x + Config.GRID_CELL / 2
    const cy = cc[0].y + Config.GRID_CELL / 2
    // Nearest defender (any sprite, sphere, or structure) reports.
    const nearestDefender = this.findNearestRobot(cx, cy)
    if (nearestDefender) {
      spawnSpeechBubble(this.scene, nearestDefender.x, nearestDefender.y, 'robot', 'core_hit')
    }
    // Nearest cyborg gloats.
    const nearestCyborg = this.findNearestCyborg(cx, cy)
    if (nearestCyborg) {
      spawnSpeechBubble(this.scene, nearestCyborg.x, nearestCyborg.y, 'cyborg', 'core_hit')
    }
  }
  private findNearestRobot(x: number, y: number): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null
    let bestD = Infinity
    const consider = (px: number, py: number) => {
      const d = Math.hypot(px - x, py - y)
      if (d < bestD) { bestD = d; best = { x: px, y: py } }
    }
    for (const u of this.defenderUnits) if (!u.isDead) consider(u.worldX, u.worldY)
    for (const s of this.spheres)        if (!s.isDead) consider(s.worldX, s.worldY)
    for (const s of this.structures)     if (!s.isDead) consider(s.worldX, s.worldY)
    return best
  }
  private findNearestCyborg(x: number, y: number): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null
    let bestD = Infinity
    for (const u of this.units) {
      if (u.isDead) continue
      const d = Math.hypot(u.worldX - x, u.worldY - y)
      if (d < bestD) { bestD = d; best = { x: u.worldX, y: u.worldY } }
    }
    return best
  }

  constructor(
    private scene: THREE.Scene,
    private core: PixelPowerCore,
    private units: SpriteUnit[],
    private structures: Structure[],
    private spheres: SphereDefender[],
    private defenderUnits: SpriteUnit[] = [],
    private pendingGrenades: PendingGrenade[] = [],
    private medicPads: MedicPad[] = [],
    private tethers: Tether[] = [],
    private repairPads: RepairPad[] = [],
    private repairTethers: RepairTether[] = [],
    private ammoBoxes: AmmoBox[] = [],
    private healStreaks: Map<string, { count: number; lastHealTurn: number }> = new Map(),
    private currentTurn: number = 0,
  ) {
    this.steps = this.buildSteps()
  }

  // Start-of-reveal ticks. These used to run in the constructor, but they
  // log() and emit() - and Game wires onLogEntry / onPieceEvent / onWin /
  // onLose AFTER construction, so every constructor-time entry fired into a
  // null callback. Symptoms: "reboots" lines never rendered, turns whose
  // only events were tick-driven showed no header at all, and tick damage
  // (core defense, expired bombs) was missing from telemetry, tripping the
  // damage-reconciliation warning. Game.enterRevealPhase calls start()
  // right after the callbacks are bound; step playback begins on the next
  // update() so the relative order (buildSteps, then ticks, then steps)
  // is unchanged.
  start() {
    // Force-detonate bombs that have outlived their fuse. Done before any
    // step runs so the explosions read as "the bomb you left out finally
    // went off" - happens at the start of the new reveal.
    this.expireOldBombs()
    // Tick medic-pads next so healed cyborgs are at top HP before they act.
    this.tickMedicPads()
    // Tick active tethers so target/medic heal-bonds resolve before any
    // cyborg takes their action.
    this.tickTethers()
    // Defender-side counterparts - repair-pads + repair-tethers fire at the
    // start of the reveal so towers are at top HP before they auto-fire.
    this.tickRepairPads()
    this.tickRepairTethers()
    // Power-core electric defense - pulses every reveal if any cyborg is
    // standing in the 4x4 zone around the core. Visual overlay shows the
    // danger area persistently (see Game.makeCoreDefenseOverlay).
    this.tickCoreDefense()
    // Decrement hacked-piece timers so turncoat towers/units revert once
    // the Nerd's hold expires.
    this.tickHack()
  }

  // Cyborg Nerd hack: count down each turncoat piece's remaining reveals and
  // restore it to the robot side when it hits zero. Covers both mobile
  // defenders (defenderUnits) and towers (structures).
  private tickHack() {
    const revert = (p: SpriteUnit | Structure) => {
      if (p.hackedTurnsRemaining <= 0) return
      p.hackedTurnsRemaining--
      if (p.hackedTurnsRemaining === 0 && !p.isDead) {
        this.log('defender', `${this.actorLabel(p)} reboots — back under robot control`)
      }
    }
    for (const u of this.defenderUnits) revert(u)
    for (const s of this.structures) revert(s)
  }

  // Core electric defense — if any live cyborg is inside the 12-cell zone
  // around the core, damage all of them. Single pulse per reveal, AoE-style.
  // Cloak doesn't help (geometry-based, like other AoE).
  private tickCoreDefense() {
    if (this.core.isDead) return
    const zoneCells = this.core.defenseZoneCells()
    if (zoneCells.length === 0) return
    const CORE_DEFENSE_DAMAGE = 20
    const E = 1   // cell-center tolerance
    let hits = 0, kills = 0
    for (const u of this.units) {
      if (u.isDead) continue
      const inZone = zoneCells.some(c =>
        Math.abs(c.x - u.worldX) < E && Math.abs(c.y - u.worldY) < E)
      if (!inZone) continue
      u.takeDamage(CORE_DEFENSE_DAMAGE)
      hits++
      const killed = u.isDead
      if (killed) kills++
      // Blue lightning burst on each zapped cyborg + a wider halo ring
      // so the pulse reads clearly through chaos. Two layered explosions:
      // the inner one is the hit flash, the outer ring is the discharge.
      this.explosions.push(new Explosion(this.scene, u.worldX, u.worldY, 60, 0.55, 0x88ddff))
      this.explosions.push(new Explosion(this.scene, u.worldX, u.worldY, 30, 0.35, 0xffffff))
      this.attribute(u, 'core', 'defender', CORE_DEFENSE_DAMAGE, killed)
    }
    if (hits > 0) {
      this.combatThisReveal = true
      this.log('defender',
        `Power Core electric defense — ${hits} hit (−${hits * CORE_DEFENSE_DAMAGE}${kills > 0 ? `, ${kills} killed` : ''})`)
      this.emit({ kind: 'action', actorType: 'core', side: 'defender', action: 'core_pulse' })
      playEventSfx('core_zap')
    }
  }

  private expireOldBombs() {
    for (const g of [...this.pendingGrenades]) {
      // Each bomb carries its own timer based on trigger mode:
      //   proximity → timerTurns = 3 (safety fuse against ignored traps)
      //   timed     → timerTurns = 1 (grenadier's cooked grenade)
      if (g.armed && g.turnsArmed >= g.timerTurns) {
        this.detonatePendingGrenade(g, 'expired')
      }
    }
  }

  // Tick every active medic-pad. Each pad heals adjacent cyborg allies
  // (paid out of the pad's own charge budget), then we sweep dead /
  // expired pads out of the array + scene. Runs at the start of each
  // reveal so cyborgs are topped up before they take their actions.
  private tickMedicPads() {
    if (this.medicPads.length === 0) return
    // Pad lives on the attacker side; it heals cyborg units only.
    const allies = this.units.filter(u => !u.isDead)
    for (const pad of [...this.medicPads]) {
      if (pad.isDead) continue
      const result = pad.tick(allies, this.boundApplyHeal)
      if (result.healed > 0) {
        this.combatThisReveal = true
        this.log('attacker', `Medic-pad pulses across ${result.healed}`)
      }
      if (result.expired) {
        pad.kill()
        this.log('attacker', `Medic-pad spent — station offline`)
      }
    }
    // Sweep dead pads
    for (let i = this.medicPads.length - 1; i >= 0; i--) {
      if (this.medicPads[i].isDead) this.medicPads.splice(i, 1)
    }
  }

  // Tick every active tether. Heals the target by Tether.healPerTick and
  // burns one medic ammo. Auto-ends when the medic runs out of ammo, the
  // target hits full HP, or either dies — caller sweeps dead tethers
  // after the loop. Clears the tether references on both endpoints so
  // their default-action stops returning 'hold'.
  private tickTethers() {
    if (this.tethers.length === 0) return
    for (const t of this.tethers) {
      if (t.isDead) continue
      const { medic, target } = t
      const shouldEnd =
        medic.isDead || target.isDead ||
        medic.ammoRemaining <= 0 || target.hp >= target.maxHp ||
        t.ticksActive >= t.maxTicks
      if (shouldEnd) {
        medic.tether = null
        target.tether = null
        target.hideHpBar()    // hide the temp HP bar shown during the link
        t.end()
        this.log('attacker', `${this.actorLabel(medic)} releases the tether on ${this.actorLabel(target)}`)
        continue
      }
      // Heal + burn ammo + tick counter. applyHeal scales by streak.
      const { scaled } = this.applyHeal(target, t.healPerTick, 'plus')
      if (scaled <= 0) {
        // Streak exhausted — release the tether instead of pinning both
        // endpoints for zero benefit.
        medic.tether = null
        target.tether = null
        target.hideHpBar()
        t.end()
        this.log('attacker', `${this.actorLabel(medic)} releases the tether on ${this.actorLabel(target)} (saturated)`)
        continue
      }
      medic.ammoRemaining = Math.max(0, medic.ammoRemaining - 1)
      t.ticksActive++
      this.combatThisReveal = true
      this.log('attacker', `${this.actorLabel(medic)} channels heal to ${this.actorLabel(target)} (+${scaled})`)
    }
    for (let i = this.tethers.length - 1; i >= 0; i--) {
      if (this.tethers[i].isDead) this.tethers.splice(i, 1)
    }
  }

  // Tick every active repair-pad. Each pad ticks repairs on adjacent
  // defender-side pieces (structures, defender mobile units, sphere, core)
  // and burns one of its own charges. Sweep dead/expired pads afterward.
  private tickRepairPads() {
    if (this.repairPads.length === 0) return
    for (const pad of [...this.repairPads]) {
      if (pad.isDead) continue
      const result = pad.tick(this.structures, this.defenderUnits, this.spheres, this.core, this.boundApplyHeal)
      if (result.healed > 0) {
        this.combatThisReveal = true
        this.log('defender', `Repair-pad pulses across ${result.healed}`)
      }
      if (result.expired) {
        pad.kill()
        this.log('defender', `Repair-pad spent — station offline`)
      }
    }
    for (let i = this.repairPads.length - 1; i >= 0; i--) {
      if (this.repairPads[i].isDead) this.repairPads.splice(i, 1)
    }
  }

  // Tick every active repair-tether. Mirror of tickTethers, with the wider
  // target type. End conditions match: bot dead, bot out of ammo, target
  // full HP or dead. Per-tick: target.heal() + 1 bot ammo.
  private tickRepairTethers() {
    if (this.repairTethers.length === 0) return
    for (const t of this.repairTethers) {
      if (t.isDead) continue
      const { bot, target } = t
      const shouldEnd =
        bot.isDead || target.isDead ||
        bot.ammoRemaining <= 0 || t.targetIsFull() ||
        t.ticksActive >= t.maxTicks
      if (shouldEnd) {
        bot.tether = null
        if (target instanceof SpriteUnit) target.tether = null
        target.hideHpBar()    // hide temp HP bar shown during the weld
        t.end()
        this.log('defender', `${this.actorLabel(bot)} releases the weld on ${this.targetLabel(target)}`)
        continue
      }
      const { scaled } = this.applyHeal(target, t.healPerTick, 'plus')
      if (scaled <= 0) {
        // Streak exhausted — drop the weld so the bot can re-target
        // (or be ranged-down by the cyborg that the loop was protecting
        // against). Prevents repair + cannon stalemate.
        bot.tether = null
        if (target instanceof SpriteUnit) target.tether = null
        target.hideHpBar()
        t.end()
        this.log('defender', `${this.actorLabel(bot)} releases the weld on ${this.targetLabel(target)} (saturated)`)
        continue
      }
      bot.ammoRemaining = Math.max(0, bot.ammoRemaining - 1)
      t.ticksActive++
      // Replay the weld pose each tick so the bot keeps "working" while
      // tethered — the clip otherwise ends after the first turn and the
      // bot would just stand in idle for subsequent ticks.
      const tx = target instanceof PixelPowerCore
        ? target.mesh.position.x : target.worldX
      const ty = target instanceof PixelPowerCore
        ? target.mesh.position.y : target.worldY
      bot.faceTarget(tx, ty)
      bot.playRepairAnim()
      this.combatThisReveal = true
      this.log('defender', `${this.actorLabel(bot)} welds ${this.targetLabel(target)} (+${scaled})`)
    }
    for (let i = this.repairTethers.length - 1; i >= 0; i--) {
      if (this.repairTethers[i].isDead) this.repairTethers.splice(i, 1)
    }
  }

  // ── Step list ────────────────────────────────────────────────────────────

  private buildSteps(): PlannedStep[] {
    const list: PlannedStep[] = []

    // Cyborgs: use queued actions, OR auto-default to advance/fire if the
    // player didn't queue anything (otherwise BATTLE looks like a no-op).
    // Default actions are PLACEHOLDERS — the real action is computed at
    // execute time so each unit's pathing sees the up-to-date field state
    // (faster cyborgs that have already moved out of the way no longer
    // block slower cyborgs' west steps). Fixes the Hulk-lag bug where
    // lowest-initiative units always planned around blockers that
    // executed-and-moved-away before the Hulk's turn arrived.
    for (const u of this.units) {
      if (u.isDead) continue
      if (u.queuedActions.length > 0) {
        for (const a of u.queuedActions) list.push({ actor: u, action: a })
      } else {
        list.push({ actor: u, action: { kind: 'hold' }, isDefault: true })
      }
    }
    // Defender mobile units (combat dogs, repair bots): same default-action
    // logic but hunting cyborgs / repairing damaged pieces. Same isDefault
    // replan-at-execute pattern as cyborgs above.
    for (const u of this.defenderUnits) {
      if (u.isDead) continue
      if (u.queuedActions.length > 0) {
        for (const a of u.queuedActions) list.push({ actor: u, action: a })
      } else {
        list.push({ actor: u, action: { kind: 'hold' }, isDefault: true })
      }
    }
    // Spheres: queued shots first, otherwise auto-fire at nearest cyborg.
    for (const s of this.spheres) {
      if (s.isDead) continue
      if (s.queuedActions.length > 0) {
        for (const a of s.queuedActions) list.push({ actor: s, action: a })
      } else {
        const def = this.defaultSphereAction(s)
        if (def) list.push({ actor: s, action: def })
      }
    }
    // Structures auto-fire on their initiative tick. Walls/mines have
    // apBudget 0 → skipped. Pieces out of ammo (ammoRemaining 0) are inert
    // — they sit there and take damage without firing back. The defender
    // Bomber is special — it throws a proximity bomb at an empty cell, not
    // direct-fire at a unit, and only if it doesn't already have a bomb
    // on the field.
    for (const st of this.structures) {
      if (st.isDead || st.apBudget === 0) continue
      if (st.ammoRemaining <= 0) continue
      // Hacked turncoat tower: fire on the nearest LOYAL robot in its arc
      // instead of hunting cyborgs. Skips all the normal targeting below.
      if (st.isHacked) {
        const robot = this.pickHackedStructureTarget(st)
        if (robot) list.push({ actor: st, action: { kind: 'fire', target: robot } })
        continue
      }
      if (st.type === 'bomber') {
        // One bomb per defender Bomber at a time — skip if their previous
        // bomb is still armed on the field.
        if (this.hasActiveBomb(st.id)) continue
        const cell = this.pickBombThrowCell(st)
        if (cell) list.push({ actor: st, action: { kind: 'throw', cell } })
        continue
      }
      if (st.type === 'signal') {
        // Signal EMP — target the cyborg currently FURTHEST INSIDE the
        // middle map (x ∈ [DEFENDER_MAX_X, ATTACKER_MIN_X]). "Furthest"
        // here means farthest east — closest to spawn, hardest to reach
        // with normal DPS. Stunning a back-line sniper or hulk before
        // they engage is the EMP's signature strategic play.
        const target = this.pickEmpTarget(st)
        if (target) {
          list.push({ actor: st, action: { kind: 'emp', target: { kind: 'unit', id: target.id } } })
        }
        continue
      }
      const target = this.pickNearestEnemyOf(st)
      if (target) {
        list.push({ actor: st, action: { kind: 'fire', target: { kind: 'unit', id: target.id } } })
        continue
      }
      // No cyborg in range. Mobile structures (S17.16 sentry) advance
      // toward the nearest cyborg on the map so they reach the fight
      // instead of holding a back-line firing position with no targets.
      if (st.speed > 0) {
        const closest = this.nearestCyborgToStructure(st)
        if (closest) {
          const cell = this.pickStructureStep(st, closest.worldX, closest.worldY)
          if (cell) {
            list.push({ actor: st, action: { kind: 'move', cell } })
            continue
          }
        }
      }
      // No cyborg in range and no movement need. Stationary structures
      // can shoot ammo crates to deny enemy reloads. Costs the
      // structure 1 ammo to destroy a crate (1 HP), so it's a trade:
      // lose one shot to deny ~2 shots' worth of enemy ammo.
      const crate = this.pickNearestAmmoBoxInRange(st)
      if (crate) {
        list.push({ actor: st, action: { kind: 'fire', target: { kind: 'ammobox', id: crate.id } } })
      }
    }

    // Initiative DESC. Tiebreak: defender first (irrelevant in practice since
    // ties only exist among stationary defenders, but spec-correct), then
    // stable array order.
    list.sort((a, b) => {
      if (b.actor.initiative !== a.actor.initiative) return b.actor.initiative - a.actor.initiative
      const aDef = a.actor.side === 'defender' ? 0 : 1
      const bDef = b.actor.side === 'defender' ? 0 : 1
      return aDef - bDef
    })

    return list
  }

  // Default action for any mobile unit (attacker cyborg OR defender dog).
  // If an enemy is in attack range, fire at the nearest one. Otherwise step
  // one cell toward the nearest enemy in sight. If nothing's in sight,
  // cyborgs still advance toward the core (their objective) and defender
  // mobile units (dogs) wander to a random adjacent cell.
  private defaultMobileUnitAction(unit: SpriteUnit): QueuedAction | null {
    // EMP stun: while > 0, the cyborg's systems are offline — no action
    // this turn, decrement the counter. Trumps every other branch (including
    // tether-pinning) since EMP is a forced disable, not a behavior choice.
    if (unit.stunnedTurns > 0) {
      unit.stunnedTurns--
      return { kind: 'hold' }
    }
    // Tether-pinned: medic + target both hold while a tether is active.
    // tickTethers does the heal at start-of-reveal; the units themselves
    // don't take a normal action this turn.
    if (unit.tether) return { kind: 'hold' }

    // Hacked turncoat (Cyborg Nerd): a robot the Hacker flipped. Until the
    // hack expires it hunts its former allies — fire on the nearest LOYAL
    // robot in range, else close on the nearest one. Cyborgs ignore it
    // (nearestEnemy skips hacked pieces), so this overrides its normal AI.
    if (unit.isHacked) {
      const inRange = this.nearestLoyalRobot(unit.worldX, unit.worldY, unit.id, this.actorRange(unit))
      if (inRange) return { kind: 'fire', target: inRange.ref }
      const approach = this.nearestLoyalRobot(unit.worldX, unit.worldY, unit.id, Infinity)
      if (approach) {
        const cell = this.pickStepTowardPoint(unit, approach.x, approach.y)
        if (cell) return { kind: 'move', cell }
      }
      return { kind: 'hold' }
    }

    // Cyborg Nerd / HACKER — no gun. Spends a hack on the nearest hackable
    // robot piece in range, otherwise closes the distance to one. When out
    // of hacks he's defenceless, so he retreats to the cyborg spawn edge.
    if (unit.type === 'hacker') {
      if (unit.ammoRemaining > 0) {
        const victim = this.findHackVictim(unit, Config.UNITS.hacker.range)
        if (victim) return { kind: 'hack', target: victim.ref }
        const approach = this.findHackVictim(unit, Infinity)
        if (approach) {
          const cell = this.pickStepTowardPoint(unit, approach.x, approach.y)
          if (cell) return { kind: 'move', cell }
        }
        return { kind: 'hold' }
      }
      const retreat = this.pickStepTowardPoint(unit, Config.WORLD.RIGHT, unit.worldY)
      if (retreat) return { kind: 'move', cell: retreat }
      return { kind: 'hold' }
    }

    // Cyborg Medic — three heal modes (tether / throw / pad) prioritized
    // by ally value + ammo + cluster geometry. Falls through to
    // advance-on-core when nothing needs healing right now (medic
    // follows the front line so it's near wounded allies when they
    // take damage).
    if (unit.type === 'medic') {
      const heal = this.medicDefaultAction(unit)
      if (heal) return heal
    }
    // Robot Repair — same triage shape as the medic, but the wounded
    // pool is anything defender-side with HP (towers, walls, dog, sphere,
    // power core). Falls through to wander when nothing needs repair.
    if (unit.type === 'repair') {
      const fix = this.repairDefaultAction(unit)
      if (fix) return fix
    }

    // Hulk: single-minded core-march. He's melee-only and HUNGRY for the
    // Power Core. Decision order is local-only:
    //   1. Slam clustered enemies if 2+ in a cardinal wedge (special, ammo-gated)
    //   2. Punch anything in his short melee range (70 = adjacent cells)
    //   3. Otherwise march toward the core — DON'T get distracted by enemies
    //      in sight. The Hulk has fists, no ranged option; the only thing
    //      that wins the game is reaching the core. Bypasses the generic
    //      fire/sight/advance branches that follow.
    if (unit.type === 'hulk') {
      if (unit.slamAmmoRemaining > 0) {
        const slam = this.pickSlamWedge(unit)
        if (slam) return { kind: 'slam', cell: slam }
      }
      const meleeRange = Math.max(Config.UNITS.hulk.range, MELEE_REACH)
      const melee = this.nearestEnemy(unit, meleeRange)
      if (melee) {
        return { kind: 'fire', target: { kind: melee.kind, id: melee.id } }
      }
      if (!this.core.isDead) {
        const cc = this.core.cellCenters()[0]
        const cell = this.pickStepTowardPoint(unit, cc.x, cc.y)
        if (cell) return { kind: 'move', cell }
        const wander = this.pickWanderStep(unit)
        if (wander) return { kind: 'move', cell: wander }
      }
      return { kind: 'hold' }
    }
    // Stalker front-line rush. Like the Hulk, single-minded — bypasses
    // the generic sight-gated advance so he doesn't pause to scope out.
    // Decision order:
    //   1. Punch anything in melee range (his unlimited fists). The
    //      cloak drops automatically on this attack (executeAttack).
    //   2. Otherwise march straight at the NEAREST defender piece
    //      (any type — sphere / structure / dog / repair / core),
    //      ignoring sight range entirely. The whole point of the
    //      cloak is to close distance without being shot, so we
    //      don't want him hanging back.
    if (unit.type === 'stalker') {
      // Stalker intro + cloak. Spawns visible inside his own (red) deployment
      // zone and marches west. The instant he steps OFF that zone into the
      // open field he calls out and cloaks together. The zone edge sits well
      // outside every defender weapon range, so he's dark long before he can
      // be shot — and because defender structures fire BEFORE cyborgs each
      // turn, a range/sight trigger would always give them one free turn on
      // the still-visible Stalker the moment he crossed into range. Cloaking
      // at the zone boundary sidesteps that entirely, and it's a single
      // position check instead of scanning every defender piece.
      if (!unit.introSpoken && unit.worldX < Config.ATTACKER_MIN_X) {
        unit.introSpoken = true
        unit.announceOnce('intro')
        unit.engageCloak()
      }
      const meleeRange = Math.max(Config.UNITS.stalker.range, MELEE_REACH)
      const melee = this.nearestEnemy(unit, meleeRange)
      if (melee) {
        return { kind: 'fire', target: { kind: melee.kind, id: melee.id } }
      }
      // No range gate — find the closest defender piece on the entire map.
      // Falls back to core if every defender is dead and core somehow lives.
      const frontLine = this.nearestEnemy(unit, Infinity)
      if (frontLine) {
        const cell = this.pickStepTowardPoint(unit, frontLine.x, frontLine.y)
        if (cell) return { kind: 'move', cell }
        const wander = this.pickWanderStep(unit)
        if (wander) return { kind: 'move', cell: wander }
      }
      return { kind: 'hold' }
    }
    // Sniper find-a-spot-and-shoot. Loop:
    //   1. With ammo + target in range:
    //        a. Not yet crouched → spend this turn settling in (aim pose,
    //           no fire). Sniper rule: can NOT crouch and shoot the same
    //           turn — must use a turn to crouch first.
    //        b. Already crouched → FIRE. Stays crouched after the shot so
    //           consecutive shots (e.g. after an ammo-crate refill) don't
    //           re-pay the settle cost; only movement breaks the crouch.
    //   2. With ammo + no target in range → fall through to walk (walking
    //      will reset crouched=false via moveTo).
    //   3. NO ammo → retreat to base. The sniper has no melee option,
    //      so he runs back to the cyborg spawn edge (east) rather than
    //      blocking forward units' paths or getting picked off doing
    //      nothing. Stands up out of the crouched aim pose (handled by
    //      SpriteUnit.advanceFrame's idle fallback when ammo hits 0).
    if (unit.type === 'sniper') {
      if (unit.ammoRemaining > 0) {
        const target = this.nearestEnemy(unit, Config.UNITS.sniper.range)
        if (target) {
          // S20 shoot-and-move: after firing the sniper is flagged for
          // a forced relocation on its NEXT turn. Take one step toward
          // the target (closing distance) instead of firing/crouching.
          // moveTo clears mustRelocate, so the turn after this is a
          // normal settle/fire cycle from the new cell.
          if (unit.mustRelocate) {
            const cell = this.pickStepTowardPoint(unit, target.x, target.y)
            if (cell) return { kind: 'move', cell }
            // No legal move (boxed in) — fall through so the sniper can
            // at least re-fire instead of doing nothing.
          }
          if (unit.crouched) {
            return { kind: 'fire', target: { kind: target.kind, id: target.id } }
          }
          // Spend this turn crouching — fires next turn if still in range.
          // Face the target first so the E/W aim pose ships (other facings
          // fall back to static rotation; doesn't read as "settled in").
          unit.faceTarget(target.x, target.y)
          unit.crouch()
          return { kind: 'hold' }
        }
        // No target in current-cell range — fall through to repositioning
      } else {
        // Empty rifle. Prefer detouring to an ammo crate if one's in
        // sight — re-arming and re-engaging is more interesting than
        // retreating. If no crate, retreat east toward the spawn edge.
        const sight = Config.UNITS.sniper.sightRange ?? 450
        const box = this.nearestAmmoBoxFor(unit, sight)
        if (box) {
          const cell = this.pickStepTowardPoint(unit, box.worldX, box.worldY)
          if (cell) return { kind: 'move', cell }
        }
        const retreatX = Config.WORLD.RIGHT - Config.GRID_CELL * 0.5
        if (unit.worldX < retreatX - Config.GRID_CELL) {
          const cell = this.pickStepTowardPoint(unit, retreatX, unit.worldY)
          if (cell) return { kind: 'move', cell }
        }
        // At the retreat edge with no ammo and no crate in sight —
        // STAND UP out of the crouched aim pose. Visual "rifle empty"
        // cue that the user wanted.
        unit.standUpFromAim()
        return { kind: 'hold' }
      }
    }
    // Grenadier-specific: if an armed enemy bomb is adjacent (within 1.5
    // cells), prefer DIFFUSING it over anything else. Costs 1 AP, no
    // damage, bomb vanishes — strictly better than walking into the blast.
    if (unit.type === 'grenadier') {
      const adj = this.nearestArmedEnemyBombInRange(unit, Config.GRID_CELL * 1.5)
      if (adj) return { kind: 'diffuse', target: { kind: 'bomb', id: adj.id } }
    }
    // Lobbed AoE units (Bomber / Grenadier) throw proximity bombs onto empty
    // cells, one bomb per thrower at a time. Special-cased here because the
    // standard fire-at-nearest-enemy flow doesn't apply to area traps.
    // Ammo-gated: out-of-ammo throwers skip the throw branch and fall through
    // to move/advance like inert units.
    if (this.isLobbedThrower(unit) && unit.ammoRemaining > 0) {
      const lobbed = this.lobbedThrowerAction(unit)
      if (lobbed) return lobbed
      // Fall through to move / advance if no throw is available right now.
    }
    const range: number = Config.UNITS[unit.type].range
    // Hulk has his own block above (single-minded core-march) so we don't
    // need the melee-unlimited exception here anymore — by the time we
    // reach this branch, unit is guaranteed not to be a hulk.
    if (range > 0 && !this.isLobbedThrower(unit) && unit.type !== 'medic' && unit.type !== 'repair'
        && unit.ammoRemaining > 0) {
      // Bomb counterplay: if there's an armed enemy bomb in range AND we're
      // safely outside its AoE, shoot it instead of an enemy unit. Detonates
      // the bomb harmlessly (from our perspective) — clears the field.
      const bombShot = this.nearestSafeArmedBomb(unit, range)
      if (bombShot) {
        return { kind: 'fire', target: { kind: 'bomb', id: bombShot.id } }
      }
      const fireTarget = this.nearestEnemy(unit, range)
      if (fireTarget) {
        return { kind: 'fire', target: { kind: fireTarget.kind, id: fireTarget.id } }
      }
    }
    // Universal melee fallback — out-of-ammo non-support units swing for
    // MELEE_FALLBACK_DAMAGE (10) if an enemy is one cell away. Keeps the
    // battle moving when both sides have spent their ammo. Snipers retreat
    // (handled above), medic/repair retreat (handled in their default
    // actions), hulk has his own unlimited-fists path. Everyone else falls
    // back to short, weak punches here.
    // By this point hulk + sniper have already returned from their own
    // branches; medic + repair handle their own defaults via the helpers
    // above. So we just need to exclude medic/repair here defensively.
    if (unit.ammoRemaining <= 0 && unit.type !== 'medic' && unit.type !== 'repair') {
      const melee = this.nearestEnemy(unit, MELEE_FALLBACK_RANGE)
      if (melee) {
        return { kind: 'fire', target: { kind: melee.kind, id: melee.id } }
      }
      // Nothing adjacent to punch — try to grab a resupply crate so we
      // can shoot again next turn. Falls through to the normal sight/
      // march logic if no crate's visible.
      const sight = Config.UNITS[unit.type].sightRange ?? 280
      const box = this.nearestAmmoBoxFor(unit, sight)
      if (box) {
        const cell = this.pickStepTowardPoint(unit, box.worldX, box.worldY)
        if (cell) return { kind: 'move', cell }
      }
    }
    // Movement: cyborgs march the core (single-minded, like the Hulk).
    // No more "chase the sighted enemy" — that was making cyborgs deviate
    // north/south to close on out-of-range defenders, which the user read
    // as "no logic / not heading to core." If they can FIRE, the fire
    // branch above already returned. If they can't, just keep marching.
    // Defenders (dog) still chase sighted enemies since they don't have
    // a "core" objective.
    if (unit.side === 'attacker' && !this.core.isDead) {
      const cc = this.core.cellCenters()[0]
      const cell = this.pickStepTowardPoint(unit, cc.x, cc.y)
      if (cell) {
        // Mine-spotted callout. If there is a live armed enemy mine
        // within ~2 cells of the unit's path, broadcast a warning so
        // the lane reads "watch the ground." Once per unit per game.
        this.maybeAnnounceMineSpotted(unit)
        return { kind: 'move', cell }
      }
      // Blocked from stepping toward core — wander is now directional
      // (west-biased for attackers) so the cyborg still makes general
      // westward progress instead of spinning N/S randomly.
      const wander = this.pickWanderStep(unit)
      if (wander) return { kind: 'move', cell: wander }
    }
    if (unit.side === 'defender') {
      // Defender mobile units (dog). Aggressive pursuit: ALWAYS close
      // distance to the nearest cyborg, ignoring sight range. Same
      // pattern as the cyborg-side Stalker. Without this, dogs sat
      // idle at spawn until cyborgs walked into the 280-unit sight
      // window, which read as passive. The user wants dogs actively
      // engaging the moment cyborgs are on the map.
      const moveTarget = this.nearestEnemy(unit, Infinity)
      if (moveTarget) {
        const cell = this.pickStepTowardPoint(unit, moveTarget.x, moveTarget.y)
        if (cell) return { kind: 'move', cell }
      }
      const cell = this.pickWanderStep(unit)
      if (cell) return { kind: 'move', cell }
    }
    // Fully boxed in (no step + no wander). Return 'hold' instead of null
    // so the unit stays in the step list — null caused them to be OMITTED
    // entirely, which read as "taking breaks." Hold gets the 80ms skip
    // duration so it's still fast, just visible.
    return { kind: 'hold' }
  }

  // Cyborg Medic three-mode priority. Tethers a high-value damaged ally
  // first, then throws a med-pack at the most-wounded ally in range,
  // then drops a pad on a cluster of 2+ damaged cyborgs, then walks
  // toward the most-damaged ally. When there is NOTHING to heal the medic
  // hangs back with the squad instead of leading the charge — running
  // ahead of the front line just gets the medic killed before anyone
  // needs treatment.
  private medicDefaultAction(unit: SpriteUnit): QueuedAction | null {
    // Out of charges — medic has no offense. Prefer a medkit crate if
    // one's in sight; otherwise retreat east toward the spawn edge.
    if (unit.ammoRemaining <= 0) {
      const sight = Config.UNITS.medic.sightRange ?? 280
      const box = this.nearestAmmoBoxFor(unit, sight)
      if (box) {
        const cell = this.pickStepTowardPoint(unit, box.worldX, box.worldY)
        if (cell) return { kind: 'move', cell }
      }
      const retreatX = Config.WORLD.RIGHT - Config.GRID_CELL * 0.5
      if (unit.worldX < retreatX - Config.GRID_CELL) {
        const cell = this.pickStepTowardPoint(unit, retreatX, unit.worldY)
        if (cell) return { kind: 'move', cell }
      }
      return { kind: 'hold' }
    }
    const range = Config.UNITS.medic.range
    // Damaged cyborg allies that aren't already being tethered.
    const damaged: SpriteUnit[] = []
    for (const a of this.units) {
      if (a.isDead || a === unit) continue
      if (a.hp >= a.maxHp) continue
      if (a.tether) continue       // someone else is healing them
      damaged.push(a)
    }
    if (damaged.length === 0) return this.supportHangBackAction(unit)

    // Priority 1 — tether a high-value damaged ally if one is in range and
    // we have ammo to spare (need 1 for the start tick).
    if (unit.ammoRemaining > 0) {
      const HIGH_VALUE: Record<string, boolean> = { hulk: true, sniper: true, cannon: true, doublegun: true }
      for (const ally of damaged) {
        if (!HIGH_VALUE[ally.type]) continue
        const d = Math.hypot(ally.worldX - unit.worldX, ally.worldY - unit.worldY)
        if (d <= range) {
          return { kind: 'heal-tether', target: { kind: 'unit', id: ally.id } }
        }
      }
    }

    // Priority 2 — throw med-pack at the most-damaged ally in range.
    if (unit.ammoRemaining > 0) {
      let best: SpriteUnit | null = null
      let bestMissing = 0
      for (const ally of damaged) {
        const d = Math.hypot(ally.worldX - unit.worldX, ally.worldY - unit.worldY)
        if (d > range) continue
        const missing = ally.maxHp - ally.hp
        if (missing > bestMissing) { best = ally; bestMissing = missing }
      }
      if (best) return { kind: 'heal-throw', target: { kind: 'unit', id: best.id } }
    }

    // Priority 3 — pad-drop if 2 ammo and there's a cluster of 2+ damaged
    // cyborgs we can sit a pad next to.
    if (unit.ammoRemaining >= 2) {
      const padCell = this.pickPadDeployCell(unit, damaged)
      if (padCell) return { kind: 'heal-pad', cell: padCell }
    }

    // Priority 4 — move toward the most-damaged ally so future turns can
    // tether/throw. No range gating; the medic walks the field.
    let mostDamaged: SpriteUnit | null = null
    let mostMissing = 0
    for (const ally of damaged) {
      const missing = ally.maxHp - ally.hp
      if (missing > mostMissing) { mostDamaged = ally; mostMissing = missing }
    }
    if (mostDamaged) {
      const cell = this.pickStepTowardPoint(unit, mostDamaged.worldX, mostDamaged.worldY)
      if (cell) return { kind: 'move', cell }
    }
    return this.supportHangBackAction(unit)
  }

  // Hang-back behavior for support units (medic, future cyborg-repair).
  // The medic should ADVANCE WITH THE SQUAD but never lead. Targets a
  // position one cell behind the FRONT (west-most) ally — close enough
  // to heal anyone in the formation, but always trailing the front line.
  // Previous version anchored to the nearest ally, which meant the medic
  // got stuck at the BACK if rear cyborgs were the closest neighbors.
  private supportHangBackAction(unit: SpriteUnit): QueuedAction {
    // Find the front-most non-medic cyborg (lowest X — attackers march
    // west toward the core).
    let frontX: number | null = null
    let frontY: number | null = null
    for (const a of this.units) {
      if (a.isDead || a === unit || a.type === 'medic') continue
      if (frontX === null || a.worldX < frontX) {
        frontX = a.worldX
        frontY = a.worldY
      }
    }
    if (frontX === null || frontY === null) return { kind: 'hold' }

    // Target: 1 cell east of the front (i.e., one row behind). Medic
    // range is 150 (3 cells), so from this position the medic can still
    // throw med-packs at the front-line ally AND any ally 2 cells deeper.
    const TARGET_OFFSET = Config.GRID_CELL
    const targetX = frontX + TARGET_OFFSET
    const targetY = frontY

    const dist = Math.hypot(unit.worldX - targetX, unit.worldY - targetY)
    if (dist < Config.GRID_CELL * 0.8) return { kind: 'hold' }

    const cell = this.pickStepTowardPoint(unit, targetX, targetY)
    if (cell) return { kind: 'move', cell }
    return { kind: 'hold' }
  }

  // Find a cell within 2 tiles of the medic that, when a pad is dropped
  // there, would sit adjacent to at least 2 damaged cyborg allies. Returns
  // the candidate with the highest neighbor count, or null if no cluster
  // exists. Skips occupied cells.
  private pickPadDeployCell(medic: SpriteUnit, damagedAllies: SpriteUnit[]): CellRef | null {
    const cs = Config.GRID_CELL
    const medicCol = Math.floor((medic.worldX - Config.WORLD.LEFT) / cs)
    const medicRow = Math.floor((medic.worldY - Config.WORLD.BOTTOM) / cs)
    const candidates: { cell: CellRef; count: number }[] = []
    for (let dc = -2; dc <= 2; dc++) {
      for (let dr = -2; dr <= 2; dr++) {
        if (dc === 0 && dr === 0) continue
        const col = medicCol + dc
        const row = medicRow + dr
        const x = Config.WORLD.LEFT + col * cs + cs / 2
        const y = Config.WORLD.BOTTOM + row * cs + cs / 2
        if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) continue
        if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) continue
        if (this.isCellOccupiedAtBattle(x, y, medic)) continue
        let count = 0
        for (const ally of damagedAllies) {
          if (Math.hypot(ally.worldX - x, ally.worldY - y) <= cs * 1.6) count++
        }
        if (count >= 2) candidates.push({ cell: { col, row }, count })
      }
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.count - a.count)
    return candidates[0].cell
  }

  // Robot Repair triage. Picks the most valuable damaged defender-side
  // piece in range and applies tether → throw → pad → walk-toward, mirroring
  // the medic's priority shape. Returns null if there's nothing to fix
  // and no useful repositioning target — caller falls through to a wander
  // step so the repair bot drifts without freezing the round.
  private repairDefaultAction(unit: SpriteUnit): QueuedAction | null {
    // Out of charges. The repair bot has no offense, so it prioritises
    // resupply over standing still. Search order:
    //   1. Compatible repair-kit crate in sight (fastest top-up).
    //   2. The Power Core (defender-side advantage: a stationary
    //      energy source the repair bot can dock against to recharge).
    //   3. Retreat west toward the backline if neither is reachable.
    // Same support-pull-back rule as the medic. The recharge itself
    // happens in checkPowerCoreRecharge after the move resolves.
    if (unit.ammoRemaining <= 0) {
      const sight = Config.UNITS.repair.sightRange ?? 280
      const box = this.nearestAmmoBoxFor(unit, sight)
      if (box) {
        const cell = this.pickStepTowardPoint(unit, box.worldX, box.worldY)
        if (cell) return { kind: 'move', cell }
      }
      // Power Core recharge. Always reachable for defender repair bots
      // since the core is required. Walk toward the nearest core cell
      // (within sight to avoid AI cheating with full-map vision).
      if (!this.core.isDead) {
        const coreCells = this.core.cellCenters()
        let bestCell: { x: number; y: number } | null = null
        let bestDist = Infinity
        for (const cc of coreCells) {
          const cx = cc.x + Config.GRID_CELL / 2
          const cy = cc.y + Config.GRID_CELL / 2
          const dx = cx - unit.worldX
          const dy = cy - unit.worldY
          const d = Math.hypot(dx, dy)
          if (d <= sight && d < bestDist) { bestDist = d; bestCell = { x: cx, y: cy } }
        }
        if (bestCell) {
          const cell = this.pickStepTowardPoint(unit, bestCell.x, bestCell.y)
          if (cell) return { kind: 'move', cell }
        }
      }
      const retreatX = Config.WORLD.LEFT + Config.GRID_CELL * 0.5
      if (unit.worldX > retreatX + Config.GRID_CELL) {
        const cell = this.pickStepTowardPoint(unit, retreatX, unit.worldY)
        if (cell) return { kind: 'move', cell }
      }
      return { kind: 'hold' }
    }
    const range = Config.UNITS.repair.range

    // Build the "damaged defender pool" — anything defender-side at less
    // than max HP and not dead. Pad/tether/throw all draw from this list.
    // SpriteUnits and Structures expose .tether for the pin marker; the
    // sphere + core don't (they're stationary anyway, so we don't gate on
    // a pin field for them).
    type Target = {
      ref: TargetRef
      x: number
      y: number
      missing: number
      kind: 'structure' | 'sphere' | 'core' | 'unit'
      entity: RepairTetherTarget
      pinned: boolean       // true if already being weld-tethered by another bot
      priority: number      // higher = repair this first when health-tied
    }
    const damaged: Target[] = []
    for (const s of this.structures) {
      if (s.isDead || s.hp >= s.maxHp) continue
      damaged.push({
        ref: { kind: 'structure', id: s.id },
        x: s.worldX, y: s.worldY,
        missing: s.maxHp - s.hp,
        kind: 'structure', entity: s, pinned: false,
        priority: structureRepairPriority(s.type),
      })
    }
    for (const sp of this.spheres) {
      if (sp.isDead || sp.hp >= sp.maxHp) continue
      damaged.push({
        ref: { kind: 'sphere', id: sp.id },
        x: sp.worldX, y: sp.worldY,
        missing: sp.maxHp - sp.hp,
        kind: 'sphere', entity: sp, pinned: false,
        priority: 8,    // spheres are expensive — high but below the core
      })
    }
    for (const du of this.defenderUnits) {
      if (du === unit || du.isDead || du.hp >= du.maxHp) continue
      if (du.tether) continue   // already being tethered by another bot
      damaged.push({
        ref: { kind: 'unit', id: du.id },
        x: du.worldX, y: du.worldY,
        missing: du.maxHp - du.hp,
        kind: 'unit', entity: du, pinned: false,
        priority: 4,
      })
    }
    if (!this.core.isDead && this.core.hp < this.core.maxHp) {
      const cc = this.core.cellCenters()
      damaged.push({
        ref: { kind: 'core', id: '' },
        x: cc[0].x + Config.GRID_CELL / 2,  // centroid (between the 4 sub-cells)
        y: cc[0].y + Config.GRID_CELL / 2,
        missing: this.core.maxHp - this.core.hp,
        kind: 'core', entity: this.core, pinned: false,
        priority: 12,   // the core is the win condition — heal it first
      })
    }
    if (damaged.length === 0) {
      // Nothing to repair — let the player know the bot is idle by choice,
      // not bugged or stuck. announceOnce so the bubble doesn't repeat
      // every reveal (it'll fire once per match per bot).
      unit.announceOnce('no_repairs_needed')
      return { kind: 'hold' }
    }

    // Priority 1 — weld-tether the highest-priority damaged piece in range.
    // Tether is a sustained channel; the bot prefers to lock in for several
    // turns of repair on the most valuable target. The threshold here is
    // looser than the medic's (priority >= 4 vs >= 8) since the repair bot
    // has no throw fallback — without it the bot would just walk past a
    // damaged tower instead of welding it.
    if (unit.ammoRemaining > 0) {
      const inRange = damaged
        .filter(t => Math.hypot(t.x - unit.worldX, t.y - unit.worldY) <= range)
        .sort((a, b) => b.priority - a.priority || b.missing - a.missing)
      const top = inRange[0]
      if (top) {
        return { kind: 'repair-tether', target: top.ref }
      }
    }

    // Priority 2 — drop a pad if 2+ damaged pieces cluster near a deploy
    // cell. Same shape as pickPadDeployCell, but the damaged-set covers
    // structures, defender units, sphere, and core sub-cells.
    if (unit.ammoRemaining >= 2) {
      const padCell = this.pickRepairPadDeployCell(unit, damaged)
      if (padCell) return { kind: 'repair-pad', cell: padCell }
    }

    // Priority 3 — walk toward the highest-priority damaged piece. No
    // range gating; the bot grinds across the field to reach it.
    const target = [...damaged].sort((a, b) => b.priority - a.priority || b.missing - a.missing)[0]
    if (target) {
      const cell = this.pickStepTowardPoint(unit, target.x, target.y)
      if (cell) return { kind: 'move', cell }
    }
    return null
  }

  // Mirror of pickPadDeployCell — search a 2-cell box around the repair
  // bot for an empty cell sitting next to 2+ damaged defender targets.
  // Damaged-target XY comes from the precomputed list (which already
  // includes the power core's centroid).
  private pickRepairPadDeployCell(
    bot: SpriteUnit,
    damagedTargets: { x: number; y: number }[],
  ): CellRef | null {
    const cs = Config.GRID_CELL
    const botCol = Math.floor((bot.worldX - Config.WORLD.LEFT) / cs)
    const botRow = Math.floor((bot.worldY - Config.WORLD.BOTTOM) / cs)
    const candidates: { cell: CellRef; count: number }[] = []
    for (let dc = -2; dc <= 2; dc++) {
      for (let dr = -2; dr <= 2; dr++) {
        if (dc === 0 && dr === 0) continue
        const col = botCol + dc
        const row = botRow + dr
        const x = Config.WORLD.LEFT + col * cs + cs / 2
        const y = Config.WORLD.BOTTOM + row * cs + cs / 2
        if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) continue
        if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) continue
        if (this.isCellOccupiedAtBattle(x, y, bot)) continue
        let count = 0
        for (const t of damagedTargets) {
          if (Math.hypot(t.x - x, t.y - y) <= cs * 1.6) count++
        }
        if (count >= 2) candidates.push({ cell: { col, row }, count })
      }
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.count - a.count)
    return candidates[0].cell
  }

  // Pick the cardinal slam direction whose 3-cell wedge contains the most
  // enemies. Returns the wedge-center cell (one step forward of `unit`) iff
  // that wedge contains at least 2 enemies — anything less and the AI
  // prefers conserving slam ammo for a real cluster. Ties broken by which
  // wedge has higher TOTAL HP to chew through (kills aren't guaranteed at
  // 40 dmg vs typical 80–300 HP, so concentration matters).
  private pickSlamWedge(unit: SpriteUnit): CellRef | null {
    const cs = Config.GRID_CELL
    const col = Math.floor((unit.worldX - Config.WORLD.LEFT) / cs)
    const row = Math.floor((unit.worldY - Config.WORLD.BOTTOM) / cs)
    let best: { cell: CellRef; count: number; hp: number } | null = null
    for (const [dc, dr] of CARDINAL_STEPS) {
      const targetCol = col + dc
      const targetRow = row + dr
      const perpCol = dr === 0 ? 0 : 1
      const perpRow = dr === 0 ? 1 : 0
      let count = 0
      let hp = 0
      for (let k = -1; k <= 1; k++) {
        const wcol = targetCol + perpCol * k
        const wrow = targetRow + perpRow * k
        const wx = Config.WORLD.LEFT + wcol * cs + cs / 2
        const wy = Config.WORLD.BOTTOM + wrow * cs + cs / 2
        if (wx < Config.WORLD.LEFT || wx > Config.WORLD.RIGHT) continue
        if (wy < Config.WORLD.BOTTOM || wy > Config.WORLD.TOP) continue
        const hit = this.firstEnemyAt(unit, wx, wy)
        if (hit) { count++; hp += hit.hp }
      }
      if (count >= 2 && (!best || count > best.count || (count === best.count && hp > best.hp))) {
        best = { cell: { col: targetCol, row: targetRow }, count, hp }
      }
    }
    return best ? best.cell : null
  }

  // Returns the first live enemy of `unit` whose cell center sits on (x, y),
  // or null. Used by the Hulk slam scorer.
  private firstEnemyAt(unit: SpriteUnit, x: number, y: number): { hp: number } | null {
    const E = 1
    if (unit.side === 'attacker') {
      for (const s of this.spheres) {
        if (!s.isDead && Math.abs(s.worldX - x) < E && Math.abs(s.worldY - y) < E) return { hp: s.hp }
      }
      for (const st of this.structures) {
        if (!st.isDead && Math.abs(st.worldX - x) < E && Math.abs(st.worldY - y) < E) return { hp: st.hp }
      }
      for (const du of this.defenderUnits) {
        if (!du.isDead && Math.abs(du.worldX - x) < E && Math.abs(du.worldY - y) < E) return { hp: du.hp }
      }
      if (!this.core.isDead) {
        for (const cc of this.core.cellCenters()) {
          if (Math.abs(cc.x - x) < E && Math.abs(cc.y - y) < E) return { hp: this.core.hp }
        }
      }
    } else {
      for (const u of this.units) {
        if (!u.isDead && Math.abs(u.worldX - x) < E && Math.abs(u.worldY - y) < E) return { hp: u.hp }
      }
    }
    return null
  }

  private pickWanderStep(unit: SpriteUnit): CellRef | null {
    // Directional wander — bias toward the side's objective. Previously
    // pure random pick which read as "no logic." Generalized S17.3+ to
    // use actual entity positions rather than hardcoded world-X axes,
    // so this works on future maps where attackers approach from any
    // direction (not just east → west) and where the core might not
    // be at the world's left edge.
    const cs = Config.GRID_CELL
    // Attackers bias toward the core (true objective). Defenders bias
    // toward the nearest live attacker (true threat). Fallback: stay put.
    let tx: number, ty: number
    if (unit.side === 'attacker') {
      if (this.core.isDead) return null   // no objective left, just hold
      const cc = this.core.cellCenters()[0]
      tx = cc.x; ty = cc.y
    } else {
      const t = this.nearestEnemy(unit, Infinity)
      if (!t) return null
      tx = t.x; ty = t.y
    }
    const options: { cell: CellRef; dist: number }[] = []
    for (const [dx, dy] of CARDINAL_STEPS) {
      const x = unit.worldX + dx * cs
      const y = unit.worldY + dy * cs
      if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) continue
      if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) continue
      if (this.isCellOccupiedAtBattle(x, y, unit)) continue
      const col = Math.floor((x - Config.WORLD.LEFT) / cs)
      const row = Math.floor((y - Config.WORLD.BOTTOM) / cs)
      // Euclidean distance to the actual objective — works on any map
      // layout, not just east→west.
      const dist = Math.hypot(x - tx, y - ty)
      options.push({ cell: { col, row }, dist })
    }
    if (options.length === 0) return null
    options.sort((a, b) => a.dist - b.dist || Math.random() - 0.5)
    return options[0].cell
  }

  // Total planned steps — Game uses this after onComplete to detect a
  // zero-action reveal (no pieces capable of acting) so the continuous-battle
  // loop doesn't spin forever.
  get totalSteps(): number { return this.steps.length }

  // Returns the closest LIVE enemy entity within `maxDist` of unit. Enemy side
  // is inferred from the unit's own side (attacker → defender, defender → attacker).
  private nearestEnemy(
    unit: SpriteUnit,
    maxDist: number,
  ): { id: string; kind: 'sphere' | 'structure' | 'core' | 'unit'; x: number; y: number; d: number } | null {
    let bestId: string | null = null
    let bestKind: 'sphere' | 'structure' | 'core' | 'unit' = 'unit'
    let bestX = 0, bestY = 0
    let bestDist = maxDist
    const consider = (id: string, kind: typeof bestKind, x: number, y: number) => {
      const d = Math.hypot(x - unit.worldX, y - unit.worldY)
      if (d <= bestDist) { bestId = id; bestKind = kind; bestX = x; bestY = y; bestDist = d }
    }
    if (unit.side === 'attacker') {
      // Hacked robots are temporary cyborg allies — skip them so cyborgs
      // don't waste shots on their own turncoats.
      for (const s of this.spheres)        if (!s.isDead) consider(s.id, 'sphere',    s.worldX, s.worldY)
      for (const s of this.structures)     if (!s.isDead && !s.isHacked) consider(s.id, 'structure', s.worldX, s.worldY)
      for (const d of this.defenderUnits)  if (!d.isDead && !d.isHacked) consider(d.id, 'unit',      d.worldX, d.worldY)
      if (!this.core.isDead) {
        for (const cc of this.core.cellCenters()) consider('core', 'core', cc.x, cc.y)
      }
    } else {
      // Defender-side targeting: skip cloaked attackers (Stalker invisibility).
      for (const u of this.units) if (!u.isDead && !u.cloaked) consider(u.id, 'unit', u.worldX, u.worldY)
    }
    return bestId === null ? null : { id: bestId, kind: bestKind, x: bestX, y: bestY, d: bestDist }
  }

  // Step one cell toward (tx, ty). Picks the best move using a two-tier
  // search:
  //
  //  Tier 1 — DISTANCE-REDUCING — preferred. Any neighbor cell whose
  //   distance to the target is less than the current distance.
  //
  //  Tier 2 — SIDEWAYS — fallback when tier 1 is empty. Neighbors that
  //   don't reduce distance but stay within ~one cell of the current
  //   distance. Lets the unit flow PAST a blocking obstacle (wall, tower)
  //   instead of jamming and falling through to wander.
  //
  // Anti-backtrack: candidates matching the unit's lastTraversedCol/Row
  // are skipped unless they're the ONLY option. Keeps a unit committed to
  // a detour direction (kept going N past a wall instead of bouncing
  // N → S → N → S between adjacent sideways picks).
  //
  // Each tier sorts by (distance + dangerWeight). Bomb-AoE damage dominates
  // pure distance so a unit will sidestep one tile to dodge a primed grenade
  // — but if every legal step is dangerous, it still picks the least-bad one.
  //
  // Cardinal-only by default; per-unit allowDiagonalMove unlocks 8-way.
  private pickStepTowardPoint(unit: SpriteUnit, tx: number, ty: number): CellRef | null {
    const cs = Config.GRID_CELL
    const curDist = Math.hypot(tx - unit.worldX, ty - unit.worldY)
    type Cand = {
      col: number; row: number; x: number; y: number; d: number;
      danger: number; isBacktrack: boolean; spacing: number;
    }
    const reducing: Cand[] = []
    const sideways: Cand[] = []
    const allowDiagonal = (Config.UNITS[unit.type] as { allowDiagonalMove?: boolean }).allowDiagonalMove === true
    const steps = allowDiagonal ? DIAGONAL_STEPS : CARDINAL_STEPS
    const SIDEWAYS_THRESHOLD = cs   // up to one cell's worth worse — covers any cardinal sidestep on diagonal targets
    for (const [dx, dy] of steps) {
      const x = unit.worldX + dx * cs
      const y = unit.worldY + dy * cs
      if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) continue
      if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) continue
      if (this.isCellOccupiedAtBattle(x, y, unit)) continue
      const col = Math.floor((x - Config.WORLD.LEFT) / cs)
      const row = Math.floor((y - Config.WORLD.BOTTOM) / cs)
      const d = Math.hypot(tx - x, ty - y)
      const isBacktrack = col === unit.lastTraversedCol && row === unit.lastTraversedRow
      const cand: Cand = {
        col, row, x, y, d,
        danger: this.cellBombDanger(x, y, unit.side),
        isBacktrack,
        spacing: this.cellTypeClusterPenalty(unit, x, y),
      }
      if (d < curDist - 0.5) reducing.push(cand)
      else if (d <= curDist + SIDEWAYS_THRESHOLD) sideways.push(cand)
    }
    // S17.23 core-zone avoidance. Ranged cyborgs (anyone with ammo
    // who isn't a melee-only Hulk or Stalker) should NOT step into
    // the core electric-defense zone when they can fire from
    // outside. The fire branch in defaultMobileUnitAction already
    // wins when an enemy is in range, but the move path itself
    // didn't penalise stepping into the zone, so a cyborg walking
    // up to the core could land inside the zone for one turn of
    // free 20 damage before the fire branch kicked in. Hulk +
    // Stalker need to enter the zone for melee, so they bypass.
    const avoidsCoreZone = unit.side === 'attacker'
                          && unit.type !== 'hulk'
                          && unit.type !== 'stalker'
    const inCoreZone = (x: number, y: number): boolean => {
      if (this.core.isDead) return false
      const E = 1
      for (const c of this.core.defenseZoneCells()) {
        if (Math.abs(c.x - x) < E && Math.abs(c.y - y) < E) return true
      }
      return false
    }
    // Score helper. distance + danger weight + spacing penalty + a
    // hefty zone penalty for avoidant units. Backtrack candidates
    // get a big penalty so they only win when no non-backtrack
    // option exists.
    const score = (c: Cand) => {
      let s = c.d + c.danger * 2 + c.spacing + (c.isBacktrack ? 1000 : 0)
      // 30 added to score is roughly 0.6 cells worth of "extra
      // distance" so a cyborg will detour around the zone rather
      // than march straight through. If every option is in the
      // zone (no detour available), the lowest-score zone cell
      // still wins so the unit eventually progresses.
      if (avoidsCoreZone && inCoreZone(c.x, c.y)) s += 30
      return s
    }
    const pickFrom = (pool: Cand[]): Cand | null => {
      if (pool.length === 0) return null
      // Random tiebreaker — with stable sort, ties resolve in CARDINAL_STEPS
      // order (E, W, N, S) so cyborgs blocked west always sidestep NORTH.
      // User observation S17.3: "walk up but not down." Randomize tied
      // scores so N/S sideways are equally likely.
      pool.sort((a, b) => score(a) - score(b) || Math.random() - 0.5)
      return pool[0]
    }
    // Try tier 1 first; if empty, tier 2. If both empty (fully boxed in),
    // return null so the caller falls through to wander.
    const c = pickFrom(reducing) ?? pickFrom(sideways)
    return c ? { col: c.col, row: c.row } : null
  }

  // Nearest pickup-able ammo box for `unit`. Used to detour out-of-ammo
  // units to resupply before falling back to retreat / wander. Returns
  // null when no compatible box is within maxDist.
  private nearestAmmoBoxFor(unit: SpriteUnit, maxDist: number): AmmoBox | null {
    let best: AmmoBox | null = null
    let bestD = maxDist
    for (const box of this.ammoBoxes) {
      if (box.isDead) continue
      if (!box.canBePickedUpBy(unit.type)) continue
      const d = Math.hypot(box.worldX - unit.worldX, box.worldY - unit.worldY)
      if (d < bestD) { best = box; bestD = d }
    }
    return best
  }

  // Penalty for stepping near other allies of the same type. Right now
  // only applied to snipers — long-range units that cover overlapping
  // arcs when clustered. Score grows as the candidate cell gets closer
  // to an existing same-side sniper; the step picker will route the
  // moving sniper toward a less-crowded angle.
  private cellTypeClusterPenalty(unit: SpriteUnit, x: number, y: number): number {
    // Sniper 3-cell spacing rule (existing).
    if (unit.type === 'sniper') {
      const SPACING = Config.GRID_CELL * 3   // want >=3 cells between snipers
      const pool = unit.side === 'attacker' ? this.units : this.defenderUnits
      let penalty = 0
      for (const other of pool) {
        if (other === unit || other.isDead || other.type !== 'sniper') continue
        const od = Math.hypot(other.worldX - x, other.worldY - y)
        if (od < SPACING) penalty += (SPACING - od) * 0.6
      }
      return penalty
    }
    // S20 robot anti-cluster rule. Every robot piece detonates a death
    // AoE (Config.DEATH_EXPLOSION radius 75, damage 25) when killed, so
    // a mobile robot standing next to another robot can chain-wipe
    // half the team in one cyborg kill. Once a defender unit LEAVES
    // base (candidate cell at or past Config.DEFENDER_MAX_X), penalise
    // candidate cells that sit adjacent to any other live defender
    // piece. Inside base the clustering is unavoidable (pieces are
    // packed around the core) and not penalised here.
    if (unit.side === 'defender' && x >= Config.DEFENDER_MAX_X) {
      const ADJ = Config.GRID_CELL * 1.2   // a hair over one cell
      const CLUSTER_PENALTY = 40           // ~0.8 cells of detour per adjacency
      let penalty = 0
      for (const other of this.defenderUnits) {
        if (other === unit || other.isDead) continue
        if (Math.hypot(other.worldX - x, other.worldY - y) < ADJ) penalty += CLUSTER_PENALTY
      }
      for (const s of this.structures) {
        if (s.isDead) continue
        if (Math.hypot(s.worldX - x, s.worldY - y) < ADJ) penalty += CLUSTER_PENALTY
      }
      for (const sp of this.spheres) {
        if (sp.isDead) continue
        if (Math.hypot(sp.worldX - x, sp.worldY - y) < ADJ) penalty += CLUSTER_PENALTY
      }
      return penalty
    }
    return 0
  }

  // How much armed-bomb damage would a unit standing at (x, y) absorb if
  // every armed bomb in radius went off right now. Used by pickStepTowardPoint
  // to flee primed AoE. With the friendly-fire model, ALL armed bombs are
  // counted — a unit will flee its own side's bombs too (it can't shrug
  // off the explosion just because its team threw it). `side` parameter
  // kept for signature compatibility but no longer filters anything.
  private cellBombDanger(x: number, y: number, _side: 'attacker' | 'defender'): number {
    let total = 0
    for (const g of this.pendingGrenades) {
      if (!g.armed) continue
      if (Math.hypot(g.worldX - x, g.worldY - y) <= g.aoeRadius) total += g.damage
    }
    return total
  }

  // Default sphere action: fire at nearest cyborg in range. Skipped if the
  // sphere has burned through its ammo budget.
  // S17.12 sphere AI. Three branches:
  //   1. Has ammo + cyborg in range  -> fire (existing behavior).
  //   2. Has ammo + no cyborg in range -> roll toward nearest cyborg
  //      on the map (sphere is a "walking gun", closes the gap).
  //   3. Out of ammo                  -> SUICIDE RUSH. Roll toward
  //      the nearest cyborg. On adjacency, sphere takeDamage(maxHp)
  //      kills itself; the existing defender on-death self-destruct
  //      AoE detonates and damages everyone in radius 60.
  private defaultSphereAction(sphere: SphereDefender): QueuedAction | null {
    // Find the closest live cyborg anywhere on the map. Used by all
    // three branches.
    let nearest: SpriteUnit | null = null
    let nearestDist = Infinity
    for (const u of this.units) {
      if (u.isDead) continue
      const d = Math.hypot(u.worldX - sphere.worldX, u.worldY - sphere.worldY)
      if (d < nearestDist) { nearestDist = d; nearest = u }
    }
    if (!nearest) return null

    if (sphere.ammoRemaining > 0) {
      // Branch 1: cyborg in attack range. Fire.
      if (nearestDist <= sphere.range) {
        return { kind: 'fire', target: { kind: 'unit', id: nearest.id } }
      }
      // Branch 2: no one in range but ammo remains. Roll closer.
      const cell = this.pickSphereStep(sphere, nearest.worldX, nearest.worldY)
      if (cell) return { kind: 'move', cell }
      return null
    }

    // Branch 3: out of ammo. Suicide rush. If adjacent (within ~1.5
    // grid cells of the target), self-detonate by zeroing HP. The
    // on-death handler will spawn the self-destruct AoE that catches
    // the nearby cyborg cluster. Otherwise, roll toward the target.
    const CELL = Config.GRID_CELL
    if (nearestDist <= CELL * 1.5) {
      sphere.takeDamage(sphere.hp)   // immediate death triggers defender AoE
      this.log('defender', `${this.actorLabel(sphere)} detonates at point-blank range`)
      return { kind: 'hold' }
    }
    const cell = this.pickSphereStep(sphere, nearest.worldX, nearest.worldY)
    if (cell) return { kind: 'move', cell }
    return null
  }

  // Sphere-specific step picker. pickStepTowardPoint depends on
  // SpriteUnit fields (allowDiagonalMove via Config.UNITS, last-
  // traversed bookkeeping, etc.) that the sphere does not have.
  // This is a stripped down cardinal-only "closer is better" picker
  // that respects cell occupancy.
  // Nearest live cyborg to a structure (no sight gate). Used by mobile
  // sentry AI when no enemy is in fire range so it can advance.
  private nearestCyborgToStructure(st: Structure): SpriteUnit | null {
    let best: SpriteUnit | null = null
    let bestD = Infinity
    for (const u of this.units) {
      if (u.isDead) continue
      if (u.cloaked) continue   // Stalker invisibility — a walking structure can't chase what it can't see
      const d = Math.hypot(u.worldX - st.worldX, u.worldY - st.worldY)
      if (d < bestD) { bestD = d; best = u }
    }
    return best
  }

  // Structure cardinal step picker. Returns the col/row of the
  // adjacent cell that most reduces the structure's distance to
  // (tx, ty). Respects cell occupancy. Mirrors pickSphereStep but
  // typed for Structure (it has col/row instead of worldX/Y as
  // primary fields).
  private pickStructureStep(st: Structure, tx: number, ty: number): CellRef | null {
    const cs = Config.GRID_CELL
    const curDist = Math.hypot(tx - st.worldX, ty - st.worldY)
    let best: CellRef | null = null
    let bestD = curDist
    for (const [dx, dy] of CARDINAL_STEPS) {
      const x = st.worldX + dx * cs
      const y = st.worldY + dy * cs
      if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) continue
      if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) continue
      if (this.isCellOccupiedAtBattle(x, y, st)) continue
      const d = Math.hypot(tx - x, ty - y)
      if (d < bestD) {
        bestD = d
        best = { col: st.col + dx, row: st.row + dy }
      }
    }
    return best
  }

  private pickSphereStep(sphere: SphereDefender, tx: number, ty: number): CellRef | null {
    const cs = Config.GRID_CELL
    const curDist = Math.hypot(tx - sphere.worldX, ty - sphere.worldY)
    let best: CellRef | null = null
    let bestD = curDist
    for (const [dx, dy] of CARDINAL_STEPS) {
      const x = sphere.worldX + dx * cs
      const y = sphere.worldY + dy * cs
      if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) continue
      if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) continue
      // Don't crash into other defenders, cyborgs, structures, the core.
      if (this.isCellOccupiedAtBattle(x, y, sphere)) continue
      const d = Math.hypot(tx - x, ty - y)
      if (d < bestD) {
        bestD = d
        const col = Math.floor((x - Config.WORLD.LEFT) / cs)
        const row = Math.floor((y - Config.WORLD.BOTTOM) / cs)
        best = { col, row }
      }
    }
    return best
  }

  // ── Lobbed-thrower (Bomber / Grenadier) helpers ────────────────────────

  private isLobbedThrower(actor: Actor): boolean {
    return (actor instanceof Structure && actor.type === 'bomber')
      || (actor instanceof SpriteUnit && (actor.type === 'bomber' || actor.type === 'grenadier'))
  }

  private hasActiveBomb(ownerId: string): boolean {
    return this.pendingGrenades.some(g => g.ownerId === ownerId)
  }

  // Auto-action for cyborg Bomber / Grenadier. If their bomb is still on the
  // field, they hold (or shuffle closer to an enemy). Otherwise they pick the
  // best empty cell within throw range and lob.
  private lobbedThrowerAction(unit: SpriteUnit): QueuedAction | null {
    if (this.hasActiveBomb(unit.id)) return null   // caller continues to move/advance fallback
    const cell = this.pickBombThrowCell(unit)
    if (cell) return { kind: 'throw', cell }
    return null
  }

  // Pick the empty cell within thrower's range where the bomb's AoE
  // actually overlaps at least one enemy's current position. Without this
  // overlap check the thrower happily lobs at "the cell closest to the
  // nearest enemy" — which, with a 45–55 unit AoE and 50-unit cells,
  // misses the enemy entirely and fuse-expires on empty ground.
  //
  // Scoring: prefer cells that catch the MOST enemies in their AoE; tie-
  // break on minimum distance to the nearest hit enemy. Returns null if no
  // cell would catch any enemy — caller falls through to move, saving the
  // ammo for a productive throw later.
  private pickBombThrowCell(actor: Actor): CellRef | null {
    const range = this.actorRange(actor)
    const aoeRadius = this.actorAoeRadius(actor)
    if (aoeRadius <= 0) return null
    const ax = this.actorX(actor)
    const ay = this.actorY(actor)

    // Collect enemy AND ally positions. Power Core is represented by its
    // four sub-cell centers so a bomb landing adjacent to ANY of them
    // counts as a core hit. Bombs are friendly-fire now, so we also need
    // to know which cells would catch our own teammates — the AI should
    // refuse throws that hurt us more than them.
    const enemies: { x: number; y: number }[] = []
    const allies: { x: number; y: number }[] = []
    if (actor.side === 'attacker') {
      for (const s of this.spheres)       if (!s.isDead) enemies.push({ x: s.worldX, y: s.worldY })
      for (const s of this.structures)    if (!s.isDead) enemies.push({ x: s.worldX, y: s.worldY })
      for (const d of this.defenderUnits) if (!d.isDead) enemies.push({ x: d.worldX, y: d.worldY })
      if (!this.core.isDead) {
        for (const cc of this.core.cellCenters()) enemies.push({ x: cc.x, y: cc.y })
      }
      for (const u of this.units) {
        if (u.isDead) continue
        if (actor instanceof SpriteUnit && u === actor) continue  // don't count self
        allies.push({ x: u.worldX, y: u.worldY })
      }
    } else {
      // Skip cloaked attackers when AIMING (the defender can't see the Stalker
      // to target it). If a bomb still lands near a cloaked unit for other
      // reasons, the AoE damage step hits it anyway — geometry, not targeting.
      for (const u of this.units) if (!u.isDead && !u.cloaked) enemies.push({ x: u.worldX, y: u.worldY })
      for (const s of this.spheres)       if (!s.isDead) allies.push({ x: s.worldX, y: s.worldY })
      for (const s of this.structures) {
        if (s.isDead) continue
        if (actor === s) continue                             // don't count self (defender bomber)
        allies.push({ x: s.worldX, y: s.worldY })
      }
      for (const d of this.defenderUnits) if (!d.isDead) allies.push({ x: d.worldX, y: d.worldY })
      if (!this.core.isDead) {
        for (const cc of this.core.cellCenters()) allies.push({ x: cc.x, y: cc.y })
      }
    }
    if (enemies.length === 0) return null

    // Center the search on the nearest enemy. SEARCH=4 covers a 9×9 grid
    // — wide enough that even with diagonal AoE coverage we can find
    // valid cells around clusters.
    let nearest: { x: number; y: number; d: number } | null = null
    for (const e of enemies) {
      const d = Math.hypot(e.x - ax, e.y - ay)
      if (!nearest || d < nearest.d) nearest = { x: e.x, y: e.y, d }
    }
    if (!nearest || nearest.d > range + Config.GRID_CELL * 2) return null

    const cs = Config.GRID_CELL
    const ecol = Math.floor((nearest.x - Config.WORLD.LEFT) / cs)
    const erow = Math.floor((nearest.y - Config.WORLD.BOTTOM) / cs)
    const SEARCH = 4

    // Two scoring rules depending on the thrower:
    //
    //   Grenadier (timed cooked grenade): MUST throw to the SIDE or BEHIND
    //   the nearest enemy (NEVER in front, between us and them). Rationale:
    //   advancing cyborgs are usually clustered on the grenadier's side of
    //   the enemy, so any "front" throw catches them in the blast. Behind
    //   preferred over side. Also requires ZERO ally hits — explicit
    //   no-friendly-fire rule per S17 update.
    //
    //   Bomber (proximity mine): MUST NOT include the bomber itself in
    //   the AoE — a bomb at the bomber's feet is dumb and the user
    //   called it out. Other allies in AoE incur a softer penalty but
    //   net-positive throws are allowed.
    //
    // Both: prefer cells "beyond" the nearest enemy (further from thrower
    // than the target) so the AoE lands past the enemy line.
    const isGrenadier = actor instanceof SpriteUnit && actor.type === 'grenadier'
    const isBomber = (actor instanceof SpriteUnit && actor.type === 'bomber')
                     || (actor instanceof Structure && actor.type === 'bomber')
    // For the grenadier behind/side check, vector from thrower to nearest enemy.
    const geX = nearest.x - ax
    const geY = nearest.y - ay
    const geLen = Math.hypot(geX, geY) || 1
    let best: { col: number; row: number; net: number; hits: number; nearD: number; beyondEnemy: boolean; placement: number } | null = null
    const enemyD = Math.hypot(nearest.x - ax, nearest.y - ay)
    for (let dc = -SEARCH; dc <= SEARCH; dc++) {
      for (let dr = -SEARCH; dr <= SEARCH; dr++) {
        const col = ecol + dc
        const row = erow + dr
        const x = Config.WORLD.LEFT + col * cs + cs / 2
        const y = Config.WORLD.BOTTOM + row * cs + cs / 2
        if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) continue
        if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) continue
        if (Math.hypot(x - ax, y - ay) > range) continue
        if (actor instanceof Structure && !this.targetInFireArc(actor, x - ax, y - ay)) continue
        if (!this.isCellEmptyForBomb(x, y)) continue
        // Bomber MUST stay outside its own bomb's AoE. Skip cells that
        // would catch the thrower itself in the blast.
        if (isBomber && Math.hypot(ax - x, ay - y) <= aoeRadius) continue
        // Count enemies + allies caught in the AoE.
        let hits = 0
        let nearD = Infinity
        for (const e of enemies) {
          const d = Math.hypot(e.x - x, e.y - y)
          if (d <= aoeRadius) { hits++; if (d < nearD) nearD = d }
        }
        if (hits === 0) continue
        let allyHits = 0
        for (const a of allies) {
          if (Math.hypot(a.x - x, a.y - y) <= aoeRadius) allyHits++
        }
        const net = hits - allyHits
        // Grenadier S17 rule: zero ally-hits AND throw must land BEHIND
        // or to the SIDE of the nearest enemy (never in front, where
        // advancing cyborgs would be). Bomber keeps the older clean-throw
        // rule (zero ally hits).
        if (isGrenadier && allyHits > 0) continue
        if (!isGrenadier && allyHits > 0) continue
        // placement classification for grenadier: cosine of angle between
        // (thrower→enemy) and (enemy→cell). >+0.5 = behind (preferred),
        // between -0.5 and +0.5 = side (acceptable), <-0.5 = front (skip).
        let placement = 0   // non-grenadier ignores this
        if (isGrenadier) {
          const ecX = x - nearest.x
          const ecY = y - nearest.y
          const ecLen = Math.hypot(ecX, ecY) || 1
          const cos = (geX * ecX + geY * ecY) / (geLen * ecLen)
          if (cos > 0.5) placement = 2        // behind enemy — preferred
          else if (cos > -0.5) placement = 1  // side — acceptable
          else continue                        // in front of enemy — skip (catches our line)
        }
        const beyondEnemy = Math.hypot(x - ax, y - ay) > enemyD
        if (!best
            || placement > best.placement
            || (placement === best.placement && net > best.net)
            || (placement === best.placement && net === best.net && hits > best.hits)
            || (placement === best.placement && net === best.net && hits === best.hits && beyondEnemy && !best.beyondEnemy)
            || (placement === best.placement && net === best.net && hits === best.hits && beyondEnemy === best.beyondEnemy && nearD < best.nearD)) {
          best = { col, row, net, hits, nearD, beyondEnemy, placement }
        }
      }
    }
    return best ? { col: best.col, row: best.row } : null
  }

  // Read AoE radius from the per-type config. Returns 0 for non-AoE actors
  // (units without aoeRadius, structures that don't lob).
  private actorAoeRadius(actor: Actor): number {
    if (actor instanceof SpriteUnit) return Config.UNITS[actor.type].aoeRadius ?? 0
    if (actor instanceof Structure)  return Config.STRUCTURES[actor.type].aoeRadius ?? 0
    return 0
  }

  // Closest armed enemy bomb within `maxDist` of the unit — used by Grenadier
  // diffuse targeting. Returns the bomb regardless of AoE (diffuse is a melee
  // safe-remove, the grenadier doesn't care about the radius).
  private nearestArmedEnemyBombInRange(unit: SpriteUnit, maxDist: number): PendingGrenade | null {
    let best: PendingGrenade | null = null
    let bestD = maxDist
    for (const g of this.pendingGrenades) {
      if (!g.armed) continue
      if (g.side === unit.side) continue
      const d = Math.hypot(g.worldX - unit.worldX, g.worldY - unit.worldY)
      if (d < bestD) { best = g; bestD = d }
    }
    return best
  }

  // Find the closest armed enemy bomb that's far enough that we're outside
  // its AoE — shooting it would detonate it harmlessly. Returns null if no
  // bomb is in range or every in-range bomb would catch us in its blast.
  private nearestSafeArmedBomb(unit: SpriteUnit, attackRange: number): PendingGrenade | null {
    let best: PendingGrenade | null = null
    let bestD = attackRange
    for (const g of this.pendingGrenades) {
      if (!g.armed) continue
      if (g.side === unit.side) continue       // not enemy
      const d = Math.hypot(g.worldX - unit.worldX, g.worldY - unit.worldY)
      if (d > attackRange) continue
      if (d <= g.aoeRadius + 8) continue       // too close — we'd eat the blast
      if (d < bestD) { best = g; bestD = d }
    }
    return best
  }

  // Side-aware enemy position lookup (no ID needed — we just need a point).
  private nearestEnemyXY(actor: Actor, maxDist: number): { x: number; y: number } | null {
    let best: { x: number; y: number; d: number } | null = null
    const consider = (x: number, y: number) => {
      const d = Math.hypot(x - this.actorX(actor), y - this.actorY(actor))
      if (d <= maxDist && (!best || d < best.d)) best = { x, y, d }
    }
    if (actor.side === 'attacker') {
      for (const s of this.spheres)        if (!s.isDead) consider(s.worldX, s.worldY)
      for (const s of this.structures)     if (!s.isDead) consider(s.worldX, s.worldY)
      for (const d of this.defenderUnits)  if (!d.isDead) consider(d.worldX, d.worldY)
      if (!this.core.isDead) {
        for (const cc of this.core.cellCenters()) consider(cc.x, cc.y)
      }
    } else {
      // Defender-side: skip cloaked attackers.
      for (const u of this.units) if (!u.isDead && !u.cloaked) consider(u.worldX, u.worldY)
    }
    return best
  }

  // A cell is bomb-eligible if no piece sits on it (units, structures,
  // spheres, core sub-cells) AND no existing pending grenade is already
  // there. Walls/mines count as occupants — bombs go on truly open ground.
  private isCellEmptyForBomb(x: number, y: number): boolean {
    const E = 1
    const occupied = (px: number, py: number) =>
      Math.abs(px - x) < E && Math.abs(py - y) < E
    for (const u of this.units)        if (!u.isDead && occupied(u.worldX, u.worldY)) return false
    for (const u of this.defenderUnits) if (!u.isDead && occupied(u.worldX, u.worldY)) return false
    for (const s of this.spheres)       if (!s.isDead && occupied(s.worldX, s.worldY)) return false
    for (const s of this.structures)    if (!s.isDead && occupied(s.worldX, s.worldY)) return false
    for (const cc of this.core.cellCenters()) if (occupied(cc.x, cc.y)) return false
    for (const g of this.pendingGrenades) if (occupied(g.worldX, g.worldY)) return false
    return true
  }

  private pickNearestEnemyOf(struct: Structure): SpriteUnit | null {
    // Omnidirectional structures (Sentry) ignore the fire-arc check —
    // their sprite rotates to face whichever target they pick. Multi-arc
    // structures (Tower, Bomber, Cannon) still gate on the compass-rose
    // facings the player bought.
    const omni = STRUCTURE_OMNI_FIRE[struct.type] === true
    let nearest: SpriteUnit | null = null
    let nearestDist: number = struct.range
    for (const u of this.units) {
      if (u.isDead) continue
      if (u.cloaked) continue   // Stalker invisibility — defender targeting skips
      const dx = u.worldX - struct.worldX
      const dy = u.worldY - struct.worldY
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > nearestDist) continue
      if (!omni && !this.targetInFireArc(struct, dx, dy)) continue
      nearestDist = d; nearest = u
    }
    return nearest
  }

  // Signal EMP target picker. Looks at cyborgs currently inside the middle
  // map zone (between defender and attacker zones) and returns the FURTHEST
  // one — the cyborg with the biggest X (closest to the cyborg spawn edge).
  // This prioritizes stunning back-line units (snipers, hulks) before they
  // engage, where regular defender DPS can't reach. Skips cyborgs already
  // stunned (don't waste a charge re-stunning the same target).
  private pickEmpTarget(struct: Structure): SpriteUnit | null {
    let furthest: SpriteUnit | null = null
    let furthestX = -Infinity
    for (const u of this.units) {
      if (u.isDead) continue
      if (u.stunnedTurns > 0) continue
      if (u.cloaked) continue   // Stalker invisibility — EMP can't pick a cloaked target either
      // Must be inside the middle map (no-build zone). DEFENDER_MAX_X is
      // the right edge of defender zone; ATTACKER_MIN_X is the left edge
      // of attacker zone.
      if (u.worldX < Config.DEFENDER_MAX_X) continue
      if (u.worldX > Config.ATTACKER_MIN_X) continue
      // Must be in EMP range (Signal range = 500, covers full middle map).
      const dx = u.worldX - struct.worldX
      const dy = u.worldY - struct.worldY
      if (Math.hypot(dx, dy) > struct.range) continue
      if (u.worldX > furthestX) {
        furthest = u
        furthestX = u.worldX
      }
    }
    return furthest
  }

  // Closest in-range ammo crate the defender structure can fire at.
  // Honors the structure's fire-arc constraint (omni-fire pieces like
  // sentry ignore the arc). Returns null if no crate is in range.
  private pickNearestAmmoBoxInRange(struct: Structure): AmmoBox | null {
    const omni = STRUCTURE_OMNI_FIRE[struct.type] === true
    let nearest: AmmoBox | null = null
    let nearestDist: number = struct.range
    for (const box of this.ammoBoxes) {
      if (box.isDead) continue
      const dx = box.worldX - struct.worldX
      const dy = box.worldY - struct.worldY
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > nearestDist) continue
      if (!omni && !this.targetInFireArc(struct, dx, dy)) continue
      nearestDist = d; nearest = box
    }
    return nearest
  }

  // S17.19 Phaser beam attack. Defender 'cannon' fires a piercing
  // line of light along the facing direction nearest the targeted
  // enemy. Every enemy in the cardinal lane between Phaser and end
  // of range takes the full Config damage value (no falloff, no
  // damage split, just one beam = N damage per enemy along it).
  // Friendlies + walls are skipped: this is a tuned anti-cyborg
  // weapon, not a friendly-fire trap.
  private firePhaserBeam(struct: Structure, tx: number, ty: number) {
    const range = struct.range
    const damage = struct.damage
    const halfCell = Config.GRID_CELL / 2
    const ax = struct.worldX
    const ay = struct.worldY
    // Pick the facing whose cardinal lane covers the target. Among
    // qualifying lanes the one with the greatest forward projection
    // wins (target is most "in front" of that facing).
    let bestFacing: number | null = null
    let bestForward = -Infinity
    for (const facing of struct.fireFacings) {
      const fx = Math.cos(facing); const fy = Math.sin(facing)
      const fwd  = (tx - ax) * fx + (ty - ay) * fy
      const perp = Math.abs((tx - ax) * -fy + (ty - ay) * fx)
      if (fwd > 0 && perp <= halfCell && fwd > bestForward) {
        bestForward = fwd
        bestFacing = facing
      }
    }
    if (bestFacing === null) return   // no facing covers the target (defensive; AI should not queue this)
    const fx = Math.cos(bestFacing)
    const fy = Math.sin(bestFacing)
    // Scan cyborgs in the lane and damage every one in range.
    let hits = 0
    let totalDamage = 0
    for (const u of this.units) {
      if (u.isDead) continue
      const ux = u.worldX - ax
      const uy = u.worldY - ay
      const fwd  = ux * fx + uy * fy
      const perp = Math.abs(ux * -fy + uy * fx)
      if (fwd <= 0 || fwd > range || perp > halfCell) continue
      u.takeDamage(damage)
      hits++
      totalDamage += damage
      this.attribute(u, 'cannon', 'defender', damage, u.isDead)
    }
    // Beam visual along the full range.
    this.spawnPhaserBeamVisual(ax, ay, fx, fy, range)
    playWeaponSfx('phaser')
    this.log('defender', hits === 0
      ? `${this.actorLabel(struct)} fires phaser beam (no targets)`
      : `${this.actorLabel(struct)} phaser beam hits ${hits} (−${totalDamage})`)
    if (hits > 0) this.emit({ kind: 'hit',  actorType: 'cannon', side: 'defender' })
    else          this.emit({ kind: 'miss', actorType: 'cannon', side: 'defender' })
  }

  // Quick beam visual. A translucent cyan plane positioned + rotated
  // along the facing direction, fades out over 0.6s. No need for a
  // dedicated entity class; managed inline with requestAnimationFrame.
  //
  // S17.20: beam now starts at the cell-edge in the facing direction
  // (approximate barrel tip) instead of at the cell center. Before
  // the beam appeared to come from inside the Phaser sprite and read
  // as "a little low" relative to where the gun visually sits.
  // Z bumped 6 -> 12 so the beam renders above sprites instead of
  // beneath them, also addressing the "low" perception.
  private spawnPhaserBeamVisual(ax: number, ay: number, fx: number, fy: number, range: number) {
    const angle = Math.atan2(fy, fx)
    // Beam start derived from the gun sprite art, re-measured directly
    // from /sprites/gun/south.png in S20 (the previous calibration had
    // the cyan tip at image y=27.5 but the actual cyan glow east tip
    // sits at image (59, 20) on a 64x64 PNG — the prior values placed
    // the beam ~4.5 world units below the barrel).
    //
    // Offsets expressed as fractions of the cannon's actual sprite
    // size so future size changes don't need recalibration. Cannon
    // size = 40 today, so forward = 16.88, perp = 7.5.
    const cannonSize = (Config.STRUCTURES.cannon as { size?: number }).size
                       ?? Config.GRID_CELL   // safety fallback
    // Imported from Structure if needed; otherwise read the actual
    // sprite size from the STRUCTURE_SPRITE_SIZE table via a small
    // helper. For now, hardcode the percentages and multiply by 40
    // (current cannon STRUCTURE_SPRITE_SIZE).
    const SIZE = 40
    const BARREL_FORWARD_PCT = 59 / 64 - 0.5   // 0.422 — east tip of cyan glow
    const BARREL_PERP_PCT    = 0.5 - 20 / 64   // 0.188 — y of cyan tip above PNG center
    const BARREL_FORWARD = SIZE * BARREL_FORWARD_PCT      // ~16.88
    const BARREL_PERP_LEFT = SIZE * BARREL_PERP_PCT       // ~7.50
    void cannonSize  // (kept around for documentation; not used directly)
    const beamLen = range - BARREL_FORWARD
    const beamWidth = 10
    const geo = new THREE.PlaneGeometry(beamLen, beamWidth)
    const mat = new THREE.MeshBasicMaterial({
      color: 0x88e6ff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      depthTest: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    // Perpendicular-counter-clockwise vector for the lateral offset.
    // For east-facing (fx=1, fy=0) this is (0, +1), so the beam lifts
    // by +3 world Y to align with the cyan glow.
    const px = -fy
    const py = fx
    const cx = ax + fx * (BARREL_FORWARD + beamLen / 2) + px * BARREL_PERP_LEFT
    const cy = ay + fy * (BARREL_FORWARD + beamLen / 2) + py * BARREL_PERP_LEFT
    mesh.position.set(cx, cy, 12)
    mesh.rotation.z = angle
    mesh.renderOrder = 14
    this.scene.add(mesh)
    const startMs = performance.now()
    const tick = () => {
      const elapsed = (performance.now() - startMs) / 1000
      if (elapsed >= 0.6) {
        mesh.removeFromParent()
        mat.dispose()
        geo.dispose()
        return
      }
      mat.opacity = 0.85 * (1 - elapsed / 0.6)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  // S17.19 cardinal-lane fire arc. Replaces the old 120-degree wedge.
  // Tower facing east can only hit targets in the east row (forward
  // dot-product > 0 AND perpendicular distance <= cs/2). Diagonal
  // neighbours (NE, SE, etc.) are now OUTSIDE the arc. Each entry in
  // fireFacings is one cardinal lane; the player can buy extra
  // facings via the compass rose to widen coverage.
  private targetInFireArc(struct: Structure, dx: number, dy: number): boolean {
    if (dx === 0 && dy === 0) return true
    const halfCell = Config.GRID_CELL / 2
    for (const facing of struct.fireFacings) {
      const fx = Math.cos(facing)
      const fy = Math.sin(facing)
      const forward = dx * fx + dy * fy
      if (forward <= 0) continue                // target behind the tower
      const perp = Math.abs(dx * -fy + dy * fx)
      if (perp <= halfCell) return true
    }
    return false
  }

  // ── Main tick ────────────────────────────────────────────────────────────

  // Pause flag controlled by the Mini Control Center BATTLE / PAUSE pill.
  // When true, the engine still ticks visuals (so in-flight projectiles
  // and explosions resolve naturally) but does NOT advance the planned
  // step sequence or accumulate step time. Unpausing resumes from exactly
  // where the engine left off.
  paused = false

  update(delta: number) {
    // Always tick visuals (projectiles, explosions, unit anims): they
    // keep running between steps and after the engine ends.
    this.tickProjectiles(delta)
    this.tickExplosions(delta)
    this.tickPendingGrenades(delta)
    for (const u of this.units) u.update(delta)

    // Pause check happens AFTER visuals so any in-flight projectile or
    // explosion can finish drawing while the engine is frozen.
    if (this.paused) return

    if (this.done) return

    if (this.over) {
      // Game ended (win/lose) — wait for visuals to settle, then close.
      if (this.projectiles.length === 0 && this.explosions.length === 0) {
        this.done = true
      }
      return
    }

    // All planned actions consumed — wait for in-flight projectiles AND
    // explosions to finish, then signal completion. (Previously only waited
    // on projectiles, so a Grenadier AoE explosion that was still expanding
    // got orphaned in the scene with nothing to tick it.)
    if (this.idx >= this.steps.length) {
      if (this.projectiles.length === 0 && this.explosions.length === 0) {
        this.done = true
        this.onComplete?.()
      }
      return
    }

    if (this.firstTickOfStep) {
      this.executeStep(this.steps[this.idx])
      this.firstTickOfStep = false
    }

    // 'hold' actions (stunned, tether-pinned, no valid move) have nothing
    // visible to animate, so step past them quickly. Reduces dead-time in
    // reveals where many cyborgs are stunned / blocked and lets the
    // visible action breathe at the normal 0.6s cadence. Was: every step
    // waited 0.6s regardless, making a 15-cyborg turn drag for 9s even
    // when 10 of those steps were no-ops.
    // Player-controlled pacing — slow=2.4× / normal=1.5× / fast=1.0×.
    // Reads localStorage on first call per session via the cached getter,
    // so flipping speed mid-game (via console or HUD button) takes effect
    // on the very next step.
    const speedMul = revealSpeedMultiplier()
    const baseStep = this.steps[this.idx].action.kind === 'hold' ? 0.08 : STEP_DURATION
    const stepDuration = baseStep * speedMul
    this.stepTime += delta
    if (this.stepTime >= stepDuration) {
      this.stepTime = 0
      this.firstTickOfStep = true
      this.idx++
      this.checkWinLose()
    }
  }

  private tickProjectiles(delta: number) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const hit = this.projectiles[i].update(delta)
      if (!hit) continue
      const proj = this.projectiles[i]
      // Skip onHit (damage application) after game over so corpses don't
      // get re-damaged and trigger weird state.
      if (!this.over) proj.onHit?.()
      // Silent landing = lobbed grenade has arrived but won't blow until next
      // turn. No explosion VFX, no boom sound — onHit spawned the pending
      // grenade sprite that now sits on the cell.
      if (!proj.silentLanding) {
        this.explosions.push(new Explosion(
          this.scene, proj.targetX, proj.targetY,
          proj.isAoe ? proj.aoeRadius : 20, 0.4,
        ))
        if (proj.isAoe) playExplosion()
      }
      this.projectiles.splice(i, 1)
    }
  }

  private tickExplosions(delta: number) {
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      this.explosions[i].update(delta)
      if (this.explosions[i].isDone) this.explosions.splice(i, 1)
    }
  }

  // Proximity-trigger applies only to bombs in 'proximity' mode (Bomber's
  // mines). Timed grenades (Grenadier's cooked grenades) ignore proximity
  // and detonate purely on their armed-turn timer via expireOldBombs.
  // Detonation is friendly-fire on the AoE side: the bomb hits everyone
  // in radius, but the TRIGGER for proximity bombs is enemy-only (allies
  // don't set them off).
  private tickPendingGrenades(delta: number) {
    for (let i = this.pendingGrenades.length - 1; i >= 0; i--) {
      const g = this.pendingGrenades[i]
      g.update(delta)
      if (this.over) continue
      // Unarmed bombs ignore proximity — they're in the 1-turn fuse window
      // that gives enemies a chance to plan around them.
      if (!g.armed) continue
      // Timed bombs skip proximity entirely; their detonation is handled
      // exclusively by expireOldBombs (next reveal start).
      if (g.triggerMode === 'timed') continue
      if (this.shouldDetonateGrenade(g)) {
        this.detonatePendingGrenade(g)
      }
    }
  }

  // Apply a pending grenade's blast (explosion VFX + side-aware AoE + sound)
  // and remove it from the field. Shared by proximity trigger + shoot-the-bomb.
  // `trigger` is optional: 'proximity' (someone stepped on it), 'expired' (the
  // ARMED_LIFETIME fuse blew), or the Actor who shot it.
  private detonatePendingGrenade(g: PendingGrenade, trigger: Actor | 'proximity' | 'expired' = 'proximity') {
    this.explosions.push(new Explosion(this.scene, g.worldX, g.worldY, g.aoeRadius, 0.5))
    const summary = this.applyAoeForSide(g.worldX, g.worldY, g.aoeRadius, g.damage, g.side, g.ownerType)
    playExplosion()
    g.dispose()
    const idx = this.pendingGrenades.indexOf(g)
    if (idx >= 0) this.pendingGrenades.splice(idx, 1)
    this.combatThisReveal = true
    const cause =
      trigger === 'proximity' ? 'proximity-triggered'
      : trigger === 'expired' ? 'fuse expired'
      : `shot by ${this.actorLabel(trigger)}`
    this.log(g.side, summary.hits === 0
      ? `Bomb detonates (${cause}) — no targets in blast`
      : `Bomb detonates (${cause}) — ${summary.hits} hit (−${summary.damageDealt}${summary.kills > 0 ? `, ${summary.kills} killed` : ''})`)
  }

  private shouldDetonateGrenade(g: PendingGrenade): boolean {
    // ENEMY-ONLY trigger: only an enemy stepping into the AoE sets off
    // the bomb. Allies walking past an idle bomb won't trigger it (it
    // would feel terrible if your own grenadier's mistake blew up an
    // ally just for walking nearby). NOTE: friendly-fire still applies
    // on DETONATION — once the bomb goes off, the blast hits everyone
    // in radius regardless of side. cellBombDanger keeps fleeing all
    // armed bombs (own + enemy) since "blast you when an enemy walks
    // close" is still a real threat.
    const r = g.aoeRadius
    if (g.side === 'defender') {
      // Defender bomb — triggers on attackers only
      for (const u of this.units) {
        if (u.isDead) continue
        if (Math.hypot(u.worldX - g.worldX, u.worldY - g.worldY) <= r) return true
      }
      return false
    }
    // Attacker bomb — triggers on defender pieces + core only
    for (const s of this.spheres)       if (!s.isDead && Math.hypot(s.worldX - g.worldX, s.worldY - g.worldY) <= r) return true
    for (const s of this.structures)    if (!s.isDead && Math.hypot(s.worldX - g.worldX, s.worldY - g.worldY) <= r) return true
    for (const d of this.defenderUnits) if (!d.isDead && Math.hypot(d.worldX - g.worldX, d.worldY - g.worldY) <= r) return true
    if (!this.core.isDead) {
      for (const cc of this.core.cellCenters()) {
        if (Math.hypot(cc.x - g.worldX, cc.y - g.worldY) <= r) return true
      }
    }
    return false
  }

  // ── Per-action execution ─────────────────────────────────────────────────

  private executeStep(step: PlannedStep) {
    const { actor } = step
    if (actor.isDead) return   // strict skip — actor died earlier in the reveal
    // isDefault placeholder → compute the real action NOW so the unit's
    // pathing sees the current field state (e.g. faster cyborgs that
    // have already moved out of the way no longer block this unit's
    // west step). Falls back to 'hold' if no action is available.
    let action = step.action
    if (step.isDefault && actor instanceof SpriteUnit) {
      action = this.defaultMobileUnitAction(actor) ?? { kind: 'hold' }
    }

    if (action.kind === 'hold') return

    if (action.kind === 'move') {
      this.executeMove(actor, action.cell)
      return
    }

    if (action.kind === 'fire' || action.kind === 'throw') {
      this.executeAttack(actor, action)
      return
    }

    if (action.kind === 'diffuse') {
      this.executeDiffuse(actor, action.target)
      return
    }

    if (action.kind === 'slam') {
      this.executeSlam(actor, action.cell)
      return
    }

    if (action.kind === 'heal-throw') {
      this.executeHealThrow(actor, action.target)
      return
    }

    if (action.kind === 'heal-pad') {
      this.executeHealPad(actor, action.cell)
      return
    }

    if (action.kind === 'heal-tether') {
      this.executeHealTether(actor, action.target)
      return
    }

    if (action.kind === 'repair-pad') {
      this.executeRepairPad(actor, action.cell)
      return
    }

    if (action.kind === 'repair-tether') {
      this.executeRepairTether(actor, action.target)
      return
    }

    if (action.kind === 'emp') {
      this.executeEmp(actor, action.target)
      return
    }

    if (action.kind === 'hack') {
      this.executeHack(actor, action.target)
      return
    }
  }

  // Signal EMP: stun the target cyborg for 2 turns, spawn a blue burst on
  // the target's cell, consume 1 ammo from the firing Signal structure.
  // No damage. If the target died between targeting + execution, fizzle
  // silently (still costs ammo — the EMP charge was committed).
  private executeEmp(actor: Actor, ref: TargetRef) {
    if (!(actor instanceof Structure) || actor.type !== 'signal') return
    this.decrementActorAmmo(actor)
    const target = ref.kind === 'unit'
      ? this.units.find(u => u.id === ref.id && !u.isDead)
      : null
    if (!target) {
      this.log('defender', `${this.actorLabel(actor)} EMP fizzles — target gone`)
      return
    }
    const stunTurns: number = 2
    target.stunnedTurns = Math.max(target.stunnedTurns, stunTurns)
    // Visual: blue lightning ring on the target's cell. Reuses Explosion
    // with a blue tint; smaller radius (no AoE), shorter fade.
    this.explosions.push(new Explosion(this.scene, target.worldX, target.worldY, 40, 0.45, 0x66ccff))
    this.combatThisReveal = true
    this.log('defender',
      `${this.actorLabel(actor)} EMP strikes ${this.actorLabel(target)} — stunned ${stunTurns} turns`)
    this.emit({ kind: 'action', actorType: 'signal', side: 'defender', action: 'emp' })
  }

  // Cyborg Nerd HACK: flip one enemy robot piece (tower or mobile defender)
  // to the cyborg side for HACK_DURATION reveals. No damage; consumes 1 hack
  // from the Nerd's pool. The piece reverts via tickHack. Fizzles (still costs
  // the hack) if the target died or got hacked by someone else first.
  private executeHack(actor: Actor, ref: TargetRef) {
    if (!(actor instanceof SpriteUnit) || actor.type !== 'hacker') return
    if (actor.ammoRemaining <= 0) return
    const target = this.resolveHackTarget(ref)
    if (!target) {
      this.log('attacker', `${this.actorLabel(actor)}'s hack fizzles — target gone`)
      this.decrementActorAmmo(actor)
      return
    }
    const d = Math.hypot(target.worldX - actor.worldX, target.worldY - actor.worldY)
    if (d > Config.UNITS.hacker.range) return   // out of range at execute time — try again later
    this.decrementActorAmmo(actor)
    actor.faceTarget(target.worldX, target.worldY)
    actor.playHackAnim()
    target.hackedTurnsRemaining = HACK_DURATION
    // Visual: cyan data-burst on the hacked piece (reuses Explosion, no AoE).
    this.explosions.push(new Explosion(this.scene, target.worldX, target.worldY, 45, 0.5, 0x66ccff))
    this.combatThisReveal = true
    this.log('attacker',
      `${this.actorLabel(actor)} HACKS ${this.actorLabel(target)} — turned for ${HACK_DURATION} turns`)
    this.emit({ kind: 'action', actorType: 'hacker', side: 'attacker', action: 'hack' })
  }

  // Resolve a hack TargetRef to a live, not-already-hacked robot piece.
  private resolveHackTarget(ref: TargetRef): SpriteUnit | Structure | null {
    if (ref.kind === 'structure') {
      const s = this.structures.find(x => x.id === ref.id)
      return s && !s.isDead && !s.isHacked ? s : null
    }
    if (ref.kind === 'unit') {
      const u = this.defenderUnits.find(x => x.id === ref.id)
      return u && !u.isDead && !u.isHacked ? u : null
    }
    return null
  }

  // Nearest robot piece the Hacker can TURN — a firing tower (HACKABLE_
  // STRUCTURES) or a mobile defender — that isn't already hacked, within
  // maxDist. Used both to pick a victim and to path toward one.
  private findHackVictim(hacker: SpriteUnit, maxDist: number): { ref: TargetRef; x: number; y: number } | null {
    let best: { ref: TargetRef; x: number; y: number } | null = null
    let bestD = maxDist
    const consider = (ref: TargetRef, x: number, y: number) => {
      const d = Math.hypot(x - hacker.worldX, y - hacker.worldY)
      if (d <= bestD) { bestD = d; best = { ref, x, y } }
    }
    for (const s of this.structures) {
      if (s.isDead || s.isHacked || !HACKABLE_STRUCTURES[s.type]) continue
      consider({ kind: 'structure', id: s.id }, s.worldX, s.worldY)
    }
    for (const u of this.defenderUnits) {
      if (u.isDead || u.isHacked) continue
      consider({ kind: 'unit', id: u.id }, u.worldX, u.worldY)
    }
    return best
  }

  // Nearest LOYAL robot piece (live, not hacked) for a turncoat mobile unit
  // to attack — any structure, mobile defender, or sphere except itself.
  private nearestLoyalRobot(fromX: number, fromY: number, selfId: string, maxDist: number): { ref: TargetRef; x: number; y: number } | null {
    let best: { ref: TargetRef; x: number; y: number } | null = null
    let bestD = maxDist
    const consider = (ref: TargetRef, x: number, y: number) => {
      const d = Math.hypot(x - fromX, y - fromY)
      if (d <= bestD) { bestD = d; best = { ref, x, y } }
    }
    for (const s of this.structures)    if (!s.isDead && !s.isHacked && s.id !== selfId) consider({ kind: 'structure', id: s.id }, s.worldX, s.worldY)
    for (const u of this.defenderUnits) if (!u.isDead && !u.isHacked && u.id !== selfId) consider({ kind: 'unit', id: u.id }, u.worldX, u.worldY)
    for (const sp of this.spheres)      if (!sp.isDead && sp.id !== selfId) consider({ kind: 'sphere', id: sp.id }, sp.worldX, sp.worldY)
    return best
  }

  // Nearest LOYAL robot in a hacked tower's range + fire arc (omni structures
  // skip the arc check). Mirrors pickNearestEnemyOf but scans robots.
  private pickHackedStructureTarget(struct: Structure): TargetRef | null {
    const omni = STRUCTURE_OMNI_FIRE[struct.type] === true
    let bestRef: TargetRef | null = null
    let bestD: number = struct.range
    const consider = (ref: TargetRef, x: number, y: number) => {
      const dx = x - struct.worldX, dy = y - struct.worldY
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > bestD) return
      if (!omni && !this.targetInFireArc(struct, dx, dy)) return
      bestD = d; bestRef = ref
    }
    for (const s of this.structures)    if (!s.isDead && !s.isHacked && s.id !== struct.id) consider({ kind: 'structure', id: s.id }, s.worldX, s.worldY)
    for (const u of this.defenderUnits) if (!u.isDead && !u.isHacked) consider({ kind: 'unit', id: u.id }, u.worldX, u.worldY)
    for (const sp of this.spheres)      if (!sp.isDead) consider({ kind: 'sphere', id: sp.id }, sp.worldX, sp.worldY)
    return bestRef
  }

  // Resolve a TargetRef to a concrete repairable defender entity. Unlike
  // resolveTargetEntity (which returns a takeDamage-shaped thing), this
  // returns the concrete entity so the caller can call .heal() and react
  // to type-specific properties (e.g. SpriteUnit.tether for pinning).
  private resolveRepairTarget(ref: TargetRef): RepairTetherTarget | null {
    if (ref.kind === 'core') return this.core.isDead ? null : this.core
    if (ref.kind === 'sphere') {
      const s = this.spheres.find(x => x.id === ref.id)
      return s && !s.isDead ? s : null
    }
    if (ref.kind === 'structure') {
      const s = this.structures.find(x => x.id === ref.id)
      return s && !s.isDead ? s : null
    }
    if (ref.kind === 'unit') {
      const u = this.defenderUnits.find(x => x.id === ref.id)
      return u && !u.isDead ? u : null
    }
    return null
  }

  private repairTargetXY(t: RepairTetherTarget): { x: number; y: number } {
    if (t instanceof PixelPowerCore) {
      // Use centroid (the grid intersection where the 4 sub-cells meet).
      const cc = t.cellCenters()
      return { x: cc[0].x + Config.GRID_CELL / 2, y: cc[0].y + Config.GRID_CELL / 2 }
    }
    return { x: t.worldX, y: t.worldY }
  }

  // Robot Repair pad deployment. Burns 2 charges and drops a RepairPad on
  // the specified cell. Strict-skip on out-of-ammo / cell-occupied / out-
  // of-zone, just like the medic's pad. Pad lives in this.repairPads —
  // Game owns the array but RevealPhase mutates it in place.
  private executeRepairPad(actor: Actor, cell: CellRef) {
    if (!(actor instanceof SpriteUnit)) return
    if (actor.type !== 'repair') return
    if (actor.ammoRemaining < 2) return
    const cs = Config.GRID_CELL
    const x = Config.WORLD.LEFT + cell.col * cs + cs / 2
    const y = Config.WORLD.BOTTOM + cell.row * cs + cs / 2
    if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) return
    if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) return
    if (this.isCellOccupiedAtBattle(x, y, actor)) return
    for (const p of this.repairPads) {
      if (Math.hypot(p.worldX - x, p.worldY - y) < cs * 0.5) return
    }

    actor.ammoRemaining = Math.max(0, actor.ammoRemaining - 2)
    actor.faceTarget(x, y)
    actor.playRepairAnim()
    this.combatThisReveal = true
    this.repairPads.push(new RepairPad(this.scene, cell.col, cell.row))
    this.log('defender', `${this.actorLabel(actor)} deploys a repair-pad at (${cell.col}, ${cell.row})`)
  }

  // Robot Repair tether — sustained weld-beam on a damaged defender piece.
  // First tick fires now (immediate heal + 1 ammo); subsequent ticks happen
  // at the start of each reveal via tickRepairTethers. Strict-skip on
  // not-a-repair, already-tethered, no ammo, target dead/full/pinned, or
  // out of range.
  private executeRepairTether(actor: Actor, ref: TargetRef) {
    if (!(actor instanceof SpriteUnit) || actor.type !== 'repair') return
    if (actor.tether) return
    if (actor.ammoRemaining <= 0) return
    const target = this.resolveRepairTarget(ref)
    if (!target || target.isDead) return
    if (target.hp >= target.maxHp) return
    // Defender mobile target — refuse if someone else is already welding it.
    if (target instanceof SpriteUnit && target.tether) return
    const tp = this.repairTargetXY(target)
    const dist = Math.hypot(tp.x - actor.worldX, tp.y - actor.worldY)
    if (dist > Config.UNITS.repair.range) return

    const tether = new RepairTether(this.scene, actor, target)
    actor.tether = tether
    // Only mobile targets need the pin marker — structures/sphere/core
    // are already stationary.
    if (target instanceof SpriteUnit) target.tether = tether
    this.repairTethers.push(tether)
    // Show the target's HP bar for the duration of the weld so the player
    // sees the bar climb as repair ticks land. Hidden again on release.
    target.showHpBar()

    const { scaled: weldScaled } = this.applyHeal(target, tether.healPerTick, 'plus')
    actor.ammoRemaining = Math.max(0, actor.ammoRemaining - 1)
    tether.ticksActive++
    actor.faceTarget(tp.x, tp.y)
    actor.playRepairAnim()
    this.combatThisReveal = true
    this.log('defender', `${this.actorLabel(actor)} welds ${this.targetLabel(target)} (+${weldScaled})`)
  }

  // Medic tether — creates a sustained Tether between the medic and a
  // damaged cyborg ally. First-tick heals + spends 1 ammo immediately;
  // subsequent ticks happen at the start of each reveal via tickTethers.
  // Strict-skip if: not a medic, already tethered, no ammo, target dead
  // or already at full HP, target out of tether range (3 cells).
  private executeHealTether(actor: Actor, ref: TargetRef) {
    if (!(actor instanceof SpriteUnit) || actor.type !== 'medic') return
    if (actor.tether) return
    if (actor.ammoRemaining <= 0) return
    const target = this.resolveTargetEntity(ref)
    if (!target || target.isDead) return
    if (!(target instanceof SpriteUnit) || target.side !== actor.side) return
    if (target.hp >= target.maxHp) return
    if (target.tether) return   // someone else already tethering this ally
    const dist = Math.hypot(target.worldX - actor.worldX, target.worldY - actor.worldY)
    if (dist > Config.UNITS.medic.range) return

    const tether = new Tether(this.scene, actor, target)
    actor.tether = tether
    target.tether = tether
    this.tethers.push(tether)
    // Temp HP bar visible during the heal-link — hidden again on release.
    target.showHpBar()

    // First tick happens NOW so the player sees an immediate heal + spend.
    const { scaled: tetherScaled } = this.applyHeal(target, tether.healPerTick, 'plus')
    actor.ammoRemaining = Math.max(0, actor.ammoRemaining - 1)
    tether.ticksActive++
    actor.faceTarget(target.worldX, target.worldY)
    this.combatThisReveal = true
    this.log(actor.side, `${this.actorLabel(actor)} tethers ${this.targetLabel(target)} (+${tetherScaled})`)
  }

  // Medic-pad deployment. Burns 2 of the medic's heal charges and drops a
  // MedicPad on the specified cell. Strict-skip if out of ammo, the cell
  // is occupied (other unit / structure / pad already there), or the cell
  // is outside the attacker zone.
  private executeHealPad(actor: Actor, cell: CellRef) {
    if (!(actor instanceof SpriteUnit)) return
    if (actor.type !== 'medic') return
    if (actor.ammoRemaining < 2) return
    const cs = Config.GRID_CELL
    const x = Config.WORLD.LEFT + cell.col * cs + cs / 2
    const y = Config.WORLD.BOTTOM + cell.row * cs + cs / 2
    if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) return
    if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) return
    // Don't drop on an occupied cell (per the one-piece-per-cell rule).
    if (this.isCellOccupiedAtBattle(x, y, actor)) return
    // Don't drop on top of an existing pad.
    for (const p of this.medicPads) {
      if (Math.hypot(p.worldX - x, p.worldY - y) < cs * 0.5) return
    }

    actor.ammoRemaining = Math.max(0, actor.ammoRemaining - 2)
    actor.faceTarget(x, y)
    this.combatThisReveal = true
    this.medicPads.push(new MedicPad(this.scene, cell.col, cell.row))
    this.log(actor.side, `${this.actorLabel(actor)} deploys a medic-pad at (${cell.col}, ${cell.row})`)
  }

  // Medic med-pack throw. Lobs a green med-pack at a damaged cyborg ally,
  // on-land calls target.heal() and triggers the green pulse VFX. Uses the
  // same Projectile pipeline as the Bomber's grenade — sprite-textured,
  // arcing, silent landing — but with a different sprite + heal payload
  // instead of damage. Strict-skip on out-of-ammo, out-of-range, or
  // target-already-full-HP/dead.
  private executeHealThrow(actor: Actor, ref: TargetRef) {
    if (!(actor instanceof SpriteUnit)) return
    if (actor.type !== 'medic') return
    if (actor.ammoRemaining <= 0) return

    const target = this.resolveTargetEntity(ref)
    if (!target || target.isDead) return
    // Only heal cyborg allies (same side).
    if (!(target instanceof SpriteUnit) || target.side !== actor.side) return
    if (target.hp >= target.maxHp) return

    const ax = actor.worldX, ay = actor.worldY
    const dist = Math.hypot(target.worldX - ax, target.worldY - ay)
    const range = Config.UNITS.medic.range
    if (dist > range) return

    this.decrementActorAmmo(actor)
    this.combatThisReveal = true

    actor.faceTarget(target.worldX, target.worldY)
    // Medic has no throw anim — snap to static rotation via playState fallback.
    // playAttackAnim is a no-op for medics (manifest has no shoot/throw).

    const muzzle = this.actorMuzzle(actor, target.worldX, target.worldY)
    const healAmount = Config.UNITS.medic.damage   // repurposed as heal amount
    const proj = new Projectile(
      this.scene, muzzle.x, muzzle.y, target,
      target.worldX, target.worldY,
      0, false, 0, 0x66ff88, getMedPackTexture(),
    )
    proj.silentLanding = true   // no explosion on land — it's a heal, not a hit
    const targetLabel = this.targetLabel(target)
    const sourceLabel = this.actorLabel(actor)
    const side = actor.side
    proj.onHit = () => {
      if (target.isDead) {
        this.log(side, `${sourceLabel}'s med-pack arrives too late for ${targetLabel}`)
        return
      }
      // 'number' VFX — med-pack throw shows the exact amount restored
      // (the player wanted a clear number on the impact, distinct from
      // the sustained 'plus' tether ticks).
      const { healed, scaled } = this.applyHeal(target, healAmount, 'number')
      this.log(side, healed
        ? `${sourceLabel} heals ${targetLabel} (+${scaled})`
        : `${sourceLabel}'s med-pack lands but ${targetLabel} is already full`)
    }
    this.projectiles.push(proj)
  }

  // Hulk-only wedge attack. `cell` is the center of the wedge — one cardinal
  // step from the Hulk's current cell. The wedge is 3 cells wide perpendicular
  // to that direction; every enemy occupying any of the 3 cells takes the
  // slam's damage. Hits zero targets is still a legal action — the Hulk slams
  // the ground, ammo is spent.
  private executeSlam(actor: Actor, cell: CellRef) {
    if (!(actor instanceof SpriteUnit)) return
    if (actor.type !== 'hulk') return
    if (actor.slamAmmoRemaining <= 0) return

    const cs = Config.GRID_CELL
    const hulkCol = Math.floor((actor.worldX - Config.WORLD.LEFT) / cs)
    const hulkRow = Math.floor((actor.worldY - Config.WORLD.BOTTOM) / cs)
    const dirCol = cell.col - hulkCol
    const dirRow = cell.row - hulkRow
    // Must be a cardinal neighbor — guard against stale plans where the Hulk
    // moved before the slam tick. Diagonal or non-adjacent targets are a
    // strict skip per the planning model.
    const isCardinal = (Math.abs(dirCol) + Math.abs(dirRow)) === 1
    if (!isCardinal) return

    // Wedge perpendicular to the slam direction. East slam → wedge runs N/S,
    // covering rows -1/0/+1 of the target col.
    const perpCol = dirRow === 0 ? 0 : 1
    const perpRow = dirRow === 0 ? 1 : 0
    const wedgeCells: { x: number; y: number }[] = []
    for (let k = -1; k <= 1; k++) {
      const col = cell.col + perpCol * k
      const row = cell.row + perpRow * k
      const x = Config.WORLD.LEFT + col * cs + cs / 2
      const y = Config.WORLD.BOTTOM + row * cs + cs / 2
      if (x < Config.WORLD.LEFT || x > Config.WORLD.RIGHT) continue
      if (y < Config.WORLD.BOTTOM || y > Config.WORLD.TOP) continue
      wedgeCells.push({ x, y })
    }

    actor.faceTarget(cell.col * cs + Config.WORLD.LEFT + cs / 2,
                     cell.row * cs + Config.WORLD.BOTTOM + cs / 2)
    actor.playSlamAnim()
    actor.slamAmmoRemaining = Math.max(0, actor.slamAmmoRemaining - 1)
    this.combatThisReveal = true

    // Visual punch — a small impact burst on each wedge cell. Tied to the
    // slam animation cadence so the boom lands as the Hulk's fist connects.
    const damage = (Config.UNITS.hulk as { slamDamage: number }).slamDamage
    const E = 1
    let hits = 0, kills = 0
    this.emit({ kind: 'action', actorType: 'hulk', side: actor.side, action: 'slam' })
    this.emit({ kind: 'attack', actorType: 'hulk', side: actor.side })
    let totalSlamDamage = 0
    for (const wc of wedgeCells) {
      this.explosions.push(new Explosion(this.scene, wc.x, wc.y, 22, 0.35))
      const hit = (t: { id?: string; isDead: boolean; takeDamage(n: number): void } | PixelPowerCore) => {
        if (t.isDead) return
        // Shield aura applies. Defender targets in a friendly shield's
        // aura take reduced slam damage. Track per-hit reduced amount
        // for the log line since per-target totals vary now.
        const final = this.shieldedDamage(t, damage)
        t.takeDamage(final); hits++
        totalSlamDamage += final
        const killed = t.isDead
        if (killed) kills++
        this.attribute(t, 'hulk', actor.side, final, killed)
      }
      if (actor.side === 'attacker') {
        for (const s of this.spheres) {
          if (!s.isDead && Math.abs(s.worldX - wc.x) < E && Math.abs(s.worldY - wc.y) < E) hit(s)
        }
        for (const st of this.structures) {
          if (!st.isDead && Math.abs(st.worldX - wc.x) < E && Math.abs(st.worldY - wc.y) < E) hit(st)
        }
        for (const du of this.defenderUnits) {
          if (!du.isDead && Math.abs(du.worldX - wc.x) < E && Math.abs(du.worldY - wc.y) < E) hit(du)
        }
        if (!this.core.isDead) {
          for (const cc of this.core.cellCenters()) {
            if (Math.abs(cc.x - wc.x) < E && Math.abs(cc.y - wc.y) < E) { hit(this.core); break }
          }
        }
      } else {
        for (const u of this.units) {
          if (!u.isDead && Math.abs(u.worldX - wc.x) < E && Math.abs(u.worldY - wc.y) < E) hit(u)
        }
      }
    }
    // Dedicated slam SFX falls back to playExplosion if the sample is
    // missing so the impact never goes silent.
    if (!playEventSfx('hulk_slam')) playExplosion()
    // Hit/miss telemetry for the slam. Tracked as one outcome per slam,
    // not per target hit, so /stats.html accuracy reads as "% of slams
    // that landed on at least one target."
    if (hits > 0) this.emit({ kind: 'hit',  actorType: 'hulk', side: actor.side })
    else          this.emit({ kind: 'miss', actorType: 'hulk', side: actor.side })
    this.log(actor.side, hits === 0
      ? `${this.actorLabel(actor)} slams the ground (no targets)`
      : `${this.actorLabel(actor)} slams ${hits} target${hits === 1 ? '' : 's'} (−${totalSlamDamage}${kills > 0 ? `, ${kills} killed` : ''})`)
  }

  // Grenadier safe-remove of an armed enemy bomb. The bomb just vanishes —
  // no damage, no explosion VFX, small white blip where it sat. Strict-skip
  // if the bomb already detonated, the grenadier is no longer adjacent, or
  // somehow non-grenadier code routed through here.
  private executeDiffuse(actor: Actor, ref: TargetRef) {
    if (!(actor instanceof SpriteUnit) || actor.type !== 'grenadier') return
    if (ref.kind !== 'bomb') return
    const bomb = this.pendingGrenades.find(g => g.id === ref.id)
    if (!bomb || !bomb.armed) return
    if (bomb.side === actor.side) return       // own side — refuse to "diffuse" friendly
    const d = Math.hypot(bomb.worldX - actor.worldX, bomb.worldY - actor.worldY)
    if (d > Config.GRID_CELL * 1.6) return     // too far now
    // Quick non-explosive "puff" so the player sees the diffuse happen.
    this.explosions.push(new Explosion(this.scene, bomb.worldX, bomb.worldY, 14, 0.25))
    bomb.dispose()
    const idx = this.pendingGrenades.indexOf(bomb)
    if (idx >= 0) this.pendingGrenades.splice(idx, 1)
    actor.faceTarget(bomb.worldX, bomb.worldY)
    this.combatThisReveal = true
    this.log(actor.side, `${this.actorLabel(actor)} diffuses an armed bomb`)
  }

  private executeMove(actor: Actor, cell: CellRef) {
    // Mobile actors. Structures CAN move now (S17.16 made sentry
    // mobile via Structure.moveTo). SphereDefender and SpriteUnit
    // also have moveTo. Wall/turret/etc. have speed=0 and are still
    // queued only as 'hold' / fire actions, never 'move'.
    if (actor instanceof SphereDefender) {
      const dest = this.cellCenter(cell)
      if (this.isCellOccupiedAtBattle(dest.x, dest.y, actor)) return
      actor.moveTo(dest.x, dest.y)
      this.movementThisReveal = true
      this.emit({ kind: 'move', actorType: 'sphere', side: 'defender' })
      return
    }
    if (actor instanceof Structure && actor.speed > 0) {
      const dest = this.cellCenter(cell)
      if (this.isCellOccupiedAtBattle(dest.x, dest.y, actor)) return
      actor.moveTo(cell.col, cell.row)
      this.movementThisReveal = true
      this.emit({ kind: 'move', actorType: actor.type, side: 'defender' })
      return
    }
    if (!(actor instanceof SpriteUnit)) return
    const dest = this.cellCenter(cell)
    if (this.isCellOccupiedAtBattle(dest.x, dest.y, actor)) return   // strict skip
    actor.moveTo(dest.x, dest.y)
    this.movementThisReveal = true
    // Telemetry — one 'move' event per successful step. Game tallies into
    // cellsWalkedByPieceType so /stats.html can show engagement (low number
    // means the type held / was blocked / never advanced).
    this.emit({ kind: 'move', actorType: actor.type, side: actor.side })
    // Mine trigger: if this move lands the unit on/near a live mine, detonate.
    this.checkMineTriggers(actor, dest.x, dest.y)
    // Resupply pickup: if a compatible ammo crate sits at the destination,
    // the unit grabs it and tops up its ammo (capped at the unit's max).
    this.checkAmmoBoxPickup(actor, dest.x, dest.y)
    // Power Core docking: defender repair bots adjacent to any core cell
    // siphon a small charge boost. The cyborg analogue is the ammo crate;
    // the robot side gets a permanent in-world energy source instead.
    this.checkPowerCoreRecharge(actor, dest.x, dest.y)
    // Repair-bot field refill: if this is a repair bot ending its
    // move adjacent to a low-ammo friendly piece, transfer +1 ammo
    // from the bot's refill pool. The bot has to roll back to the
    // Power Core when the refill pool is spent.
    this.checkRepairBotRefill(actor, dest.x, dest.y)
  }

  // Pick up any compatible ammo crate at (x, y). Capped at the unit's
  // max ammo so over-cap stockpiling isn't a thing. Logs the grab so the
  // combat panel shows it; counts as a combat event so the auto-loop
  // doesn't stalemate while units are resupplying.
  private checkAmmoBoxPickup(unit: SpriteUnit, x: number, y: number) {
    // Robots do NOT pick up crates. They resupply by docking at the Power
    // Core (see checkPowerCoreRecharge). A defender mobile unit walking
    // over a crate just walks over it; the crate stays on the field for
    // the cyborg side to grab. Rule enforced here at the entry guard.
    if (unit.side !== 'attacker') return
    const E = 1
    for (const box of this.ammoBoxes) {
      if (box.isDead) continue
      if (Math.abs(box.worldX - x) > E || Math.abs(box.worldY - y) > E) continue
      if (!box.canBePickedUpBy(unit.type)) continue
      const max = Config.UNITS[unit.type].ammo
      const before = unit.ammoRemaining
      unit.ammoRemaining = Math.min(max, unit.ammoRemaining + KIT_AMOUNT)
      const gained = unit.ammoRemaining - before
      box.dispose()
      this.combatThisReveal = true
      const kitLabel = box.type === 'medkit' ? 'medkit'
        : box.type === 'repair_kit' ? 'repair kit'
        : box.type === 'grenade' ? 'grenade box'
        : 'ammo box'
      const article = kitLabel === 'ammo box' ? 'an' : 'a'
      this.log(unit.side, `${this.actorLabel(unit)} grabs ${article} ${kitLabel} (+${gained})`)
      unit.announce('rearmed')
      playEventSfx('ammo_pickup')
      // Parity telemetry. Cyborg-only counter since defender side has no crate path.
      this.emit({ kind: 'crate_pickup', side: 'attacker' })
      return  // only one pickup per move
    }
  }

  // Power Core recharge. When a defender repair bot ends its move
  // adjacent to any cell of the 2x2 core footprint, it siphons a small
  // charge boost (capped at the unit's max). The core is unharmed by
  // this; it's the defender-side equivalent of the cyborg ammo crate.
  // Only fires for repair bots and only while ammoRemaining is below
  // max (so a full bot can stand next to the core without farming).
  private checkPowerCoreRecharge(unit: SpriteUnit, x: number, y: number) {
    if (unit.side !== 'defender') return
    if (unit.type !== 'repair') return
    if (this.core.isDead) return
    const healMax = Config.UNITS.repair.ammo
    const refillMax = (Config.UNITS.repair as { refillCharges?: number }).refillCharges ?? 0
    // Skip the docking trip entirely if BOTH pools are already topped
    // up. Without this gate the bot would constantly trigger the docked
    // path next to the core for no effect.
    if (unit.ammoRemaining >= healMax && unit.refillRemaining >= refillMax) return
    const cells = this.core.cellCenters()
    // "Adjacent" means within 1.5 grid cells of any of the 4 core sub-
    // cell centers. Each core sub-cell is GRID_CELL wide, so the test
    // is generous enough to count standing immediately N/E/S/W of the
    // 2x2 core footprint as docked.
    const CELL = Config.GRID_CELL
    let docked = false
    for (const c of cells) {
      const cx = c.x + CELL / 2
      const cy = c.y + CELL / 2
      if (Math.abs(cx - x) <= CELL * 1.5 && Math.abs(cy - y) <= CELL * 1.5) {
        docked = true
        break
      }
    }
    if (!docked) return
    // Both pools refill on a single dock. Heal charges replenish faster
    // (+2 per turn) since the bot's primary job is healing. Refill
    // charges replenish slower (+1 per turn) because each refill unlocks
    // many extra structure shots downstream.
    const HEAL_RECHARGE = 2
    const REFILL_RECHARGE = 1
    const beforeHeal = unit.ammoRemaining
    unit.ammoRemaining = Math.min(healMax, unit.ammoRemaining + HEAL_RECHARGE)
    const healGained = unit.ammoRemaining - beforeHeal
    const beforeRefill = unit.refillRemaining
    unit.refillRemaining = Math.min(refillMax, unit.refillRemaining + REFILL_RECHARGE)
    const refillGained = unit.refillRemaining - beforeRefill
    if (healGained <= 0 && refillGained <= 0) return
    this.combatThisReveal = true
    const parts: string[] = []
    if (healGained > 0) parts.push(`+${healGained} heal`)
    if (refillGained > 0) parts.push(`+${refillGained} refill`)
    this.log('defender', `${this.actorLabel(unit)} docks at the Power Core (${parts.join(', ')})`)
    unit.announce('rearmed')
    playEventSfx('core_recharge')
    this.emit({ kind: 'core_recharge', side: 'defender' })
  }

  // Repair-bot field refill. When a repair bot's move (or hold) leaves
  // it adjacent to a friendly defender piece that has burned through
  // its ammo, transfer +1 ammo from the bot's refillRemaining pool to
  // that piece. One refill per turn, one target. Once the bot's pool
  // is empty it must roll back to the Power Core to top up. By the
  // time that round-trip completes the cyborg push is usually already
  // at the gate, which is the intended balance lever (per user spec).
  private checkRepairBotRefill(unit: SpriteUnit, x: number, y: number) {
    if (unit.side !== 'defender') return
    if (unit.type !== 'repair') return
    if (unit.refillRemaining <= 0) return
    const CELL = Config.GRID_CELL
    const ADJ = CELL * 1.5   // covers cardinal + diagonal cells
    // Search adjacent friendly defender pieces that have ammoRemaining
    // < their config max. Picks the FIRST such piece (deterministic;
    // priority can be tuned later if cluster behavior matters).
    type Refillable =
      | { kind: 'struct'; ref: Structure; max: number }
      | { kind: 'sphere'; ref: SphereDefender; max: number }
      | { kind: 'unit'; ref: SpriteUnit; max: number }
    let target: Refillable | null = null
    for (const s of this.structures) {
      if (s.isDead) continue
      const max = (Config.STRUCTURES as Record<string, { ammo: number }>)[s.type]?.ammo ?? 0
      if (max <= 0) continue                 // walls / mines / shield don't fire
      if (s.ammoRemaining >= max) continue
      if (Math.abs(s.worldX - x) > ADJ || Math.abs(s.worldY - y) > ADJ) continue
      target = { kind: 'struct', ref: s, max }
      break
    }
    if (!target) {
      for (const sp of this.spheres) {
        if (sp.isDead) continue
        const max = Config.SPHERE.ammo
        if (sp.ammoRemaining >= max) continue
        if (Math.abs(sp.worldX - x) > ADJ || Math.abs(sp.worldY - y) > ADJ) continue
        target = { kind: 'sphere', ref: sp, max }
        break
      }
    }
    if (!target) {
      for (const du of this.defenderUnits) {
        if (du === unit || du.isDead) continue
        const max = Config.UNITS[du.type].ammo
        if (du.ammoRemaining >= max) continue
        if (Math.abs(du.worldX - x) > ADJ || Math.abs(du.worldY - y) > ADJ) continue
        target = { kind: 'unit', ref: du, max }
        break
      }
    }
    if (!target) return
    const REFILL = 1
    const before = target.ref.ammoRemaining
    target.ref.ammoRemaining = Math.min(target.max, target.ref.ammoRemaining + REFILL)
    const gained = target.ref.ammoRemaining - before
    if (gained <= 0) return
    unit.refillRemaining -= 1
    this.combatThisReveal = true
    this.log('defender', `${this.actorLabel(unit)} refills ${this.actorLabel(target.ref)} (+${gained} ammo)`)
    unit.announce('rearmed')
    playEventSfx('repair_recharged')
  }

  private executeAttack(actor: Actor, action: QueuedAction) {
    // Three attack flavors:
    //   1. Hulk fists      unlimited ammo, full damage (55), full range (70).
    //   2. Stalker melee   unlimited ammo (S17.17), full damage (40),
    //                      full range (70). Melee-only unit per user spec.
    //   3. Universal melee when a SpriteUnit (not hulk/stalker/sniper/medic
    //                      /repair) is at ammo=0 AND target is adjacent,
    //                      swing for MELEE_FALLBACK_DAMAGE (10) at
    //                      MELEE_FALLBACK_RANGE (70). No ammo cost.
    //   4. Standard fire   needs ammo; uses Config damage + range.
    // Towers / Spheres / Structures don't get melee fallback (immobile).
    // S17.17: Stalker joins Hulk as a melee-only unit. Hits deal full
    // damage (40) at full range (70) with no ammo cost. Per user spec:
    // "Stalker does not have ammo. They are melee only."
    const meleeUnlimited = actor instanceof SpriteUnit
                          && (actor.type === 'hulk' || actor.type === 'stalker')
    const ammoZero = this.actorAmmo(actor) <= 0
    const isMeleeFallback = actor instanceof SpriteUnit
                           && ammoZero
                           && !meleeUnlimited
                           && actor.type !== 'medic'
                           && actor.type !== 'repair'
                           && actor.type !== 'sniper'
    if (ammoZero && !meleeUnlimited && !isMeleeFallback) return

    const ax = this.actorX(actor)
    const ay = this.actorY(actor)
    // Resolve target XY (specific entity for 'fire', cell center for 'throw').
    // For the 2x2 core, aim at the cell nearest the attacker (passing ax/ay),
    // NOT the geometric centroid. nearestEnemy picks the target by nearest core
    // cell (~1 cell away when adjacent); resolving to the centroid here would
    // measure ~1.5 cells and make a melee unit's confirmed punch whiff — the
    // core "stand next to it and never hit it" bug.
    const aim = action.kind === 'fire'
      ? this.resolveTargetXY((action as { target: TargetRef }).target, ax, ay)
      : this.cellCenter((action as { cell: CellRef }).cell)
    if (!aim) return

    const dx = aim.x - ax
    const dy = aim.y - ay
    const dist = Math.sqrt(dx * dx + dy * dy)
    // Melee fallback uses the adjacency reach — out-of-ammo cyborgs can only
    // punch what's adjacent. Dedicated melee units (hulk / stalker) also get
    // floored to MELEE_REACH: their Config range (70) is under one cell (75),
    // so without the floor a confirmed punch on an adjacent target (incl. the
    // 2x2 core) would fail this dist check and whiff. See MELEE_REACH note.
    const meleeFloor = actor instanceof SpriteUnit && (actor.type === 'hulk' || actor.type === 'stalker')
      ? MELEE_REACH : 0
    const effRange = isMeleeFallback ? MELEE_FALLBACK_RANGE : Math.max(this.actorRange(actor), meleeFloor)
    if (dist > effRange) return

    // Burn one round of ammo unless this is a free attack (hulk fists or
    // already-zero ammo melee fallback).
    if (!meleeUnlimited && !isMeleeFallback) this.decrementActorAmmo(actor)
    this.combatThisReveal = true

    // S17.19 Phaser beam. Defender 'cannon' (player-facing "Phaser")
    // is now a piercing beam instead of a single-target AoE blast.
    // Fires a continuous line in the facing direction nearest the
    // target; every enemy in the cardinal lane up to its range takes
    // damage. Spawn beam visual and bail before the standard
    // projectile path.
    if (actor instanceof Structure && actor.type === 'cannon') {
      this.firePhaserBeam(actor, aim.x, aim.y)
      return
    }

    // Cyborg attack animation; spheres/structures don't have shoot anims yet.
    if (actor instanceof SpriteUnit) {
      actor.faceTarget(aim.x, aim.y)
      actor.playAttackAnim()
      // Sniper one-liner — fires once per battle, on the actual shot.
      if (actor.type === 'sniper') {
        actor.announceOnce('sniper_shot')
        // S20 shoot-and-move rule. Sniper must relocate on the next
        // turn instead of firing again from the same cell. Combined
        // with the existing "crouch breaks on movement" rule this
        // forces a settle/fire/move/settle/fire... rhythm (~1 shot
        // per 3 turns), removing the static-turret pattern that made
        // snipers the runaway top damage piece.
        actor.mustRelocate = true
      }
      // Stalker cloak drops on first damage-dealing action — committing
      // to combat reveals position to defender targeting AI.
      if (actor.cloaked) {
        actor.dropCloak()
        this.log('attacker', `${this.actorLabel(actor)} drops cloak — visible to defenders`)
      }
    }
    // Omnidirectional structures (Sentry) rotate to face the target each
    // shot. setSingleFacing both updates fireFacings AND swaps the sprite
    // to the matching 8-way rotation PNG — the gun visibly tracks enemies.
    if (actor instanceof Structure && STRUCTURE_OMNI_FIRE[actor.type] === true) {
      const aimAngle = Math.atan2(aim.y - actor.worldY, aim.x - actor.worldX)
      actor.setSingleFacing(aimAngle)
    }

    // Telemetry: one 'attack' event per executeAttack call (i.e. per
    // shot/throw), regardless of how many hits the AoE generates.
    this.emit({ kind: 'attack', actorType: this.actorTypeKey(actor), side: actor.side })

    // Melee fallback is always a single-target punch — never AoE, even
    // for actor types that normally have aoeRadius > 0 (grenadier, cyborg
    // bomber). Without this gate, an out-of-ammo grenadier punching an
    // adjacent enemy would fall into the lobbed branch and crash trying
    // to read action.cell (their melee action is kind:'fire', not 'throw').
    const isAoe = !isMeleeFallback && (
      action.kind === 'throw'
      || (actor instanceof SpriteUnit && Config.UNITS[actor.type].aoeRadius > 0)
      || (actor instanceof Structure && (Config.STRUCTURES[actor.type].aoeRadius ?? 0) > 0)
    )
    const aoeRadius = !isAoe ? 0
      : actor instanceof SpriteUnit ? Config.UNITS[actor.type].aoeRadius
      : actor instanceof Structure  ? (Config.STRUCTURES[actor.type].aoeRadius ?? 0)
      : 0

    const muzzle = this.actorMuzzle(actor, aim.x, aim.y)
    const damage = isMeleeFallback ? MELEE_FALLBACK_DAMAGE : this.actorDamage(actor)
    // Per-weapon projectile colour overrides. Laser tower fires a bolt
    // that matches its sprite's cyan emitter glow so the shot reads as
    // "energy weapon" instead of the generic yellow defender bullet.
    // Defaults stay: yellow for defender, red for cyborg.
    let color = actor.side === 'defender' ? 0xffee00 : 0xff3333
    if (actor instanceof Structure && actor.type === 'laser') color = 0x00e5ff
    // Lobbed AoE = Bomber (defender structure) + Bomber/Grenadier (cyborg
    // units). These throw a grenade with a 1-turn fuse: projectile lands as
    // a PendingGrenade sprite, detonates at the start of the next reveal.
    // Direct-fire AoE (e.g. cannon turret) keeps the original instant-blast
    // behaviour.
    // Melee strike — Hulk / Stalker fists, or an out-of-ammo melee-fallback
    // punch. Melee-only: the hit lands INSTANTLY on the adjacent target with
    // NO flying projectile. A bullet visual on a melee unit reads as "shooting"
    // (the Stalker must never appear to shoot). Single-target only — hulk and
    // stalker have aoeRadius 0 and melee-fallback is forced non-AoE upstream.
    if ((meleeUnlimited || isMeleeFallback) && action.kind === 'fire') {
      const ref = (action as { target: TargetRef }).target
      // Hulk/Stalker use their own melee recipe (melee_hit / stalker_swing);
      // an out-of-ammo fallback punch uses the generic body-impact, NOT the
      // unit's ranged weapon sound (a punching cannon shouldn't go "bang").
      playWeaponSfx(isMeleeFallback ? 'melee_hit' : this.weaponSfxFor(actor))
      const targetEntity = this.resolveTargetEntity(ref)
      const atkType = this.actorTypeKey(actor)
      if (targetEntity && !targetEntity.isDead) {
        const targetLabel = this.targetLabel(targetEntity)
        const final = this.shieldedDamage(targetEntity, damage)
        targetEntity.takeDamage(final)
        const killed = targetEntity.isDead
        const shieldedTag = final < damage ? ' (shielded)' : ''
        this.log(actor.side, `${this.actorLabel(actor)} strikes ${targetLabel} (−${final}${shieldedTag}${killed ? `, killed` : ''})`)
        this.attribute(targetEntity, atkType, actor.side, final, killed)
        this.emit({ kind: 'hit', actorType: atkType, side: actor.side })
        // Brief impact spark at the target — melee feedback, not a projectile.
        this.explosions.push(new Explosion(this.scene, aim.x, aim.y, 22, 0.3, actor.side === 'attacker' ? 0xff5533 : 0xffcc33))
      } else {
        this.emit({ kind: 'miss', actorType: atkType, side: actor.side })
      }
      return
    }

    const isLobbed = (actor instanceof Structure && actor.type === 'bomber')
      || (actor instanceof SpriteUnit && (actor.type === 'bomber' || actor.type === 'grenadier'))
    const spriteTex = isLobbed ? getGrenadeTexture() : null

    const proj = new Projectile(
      this.scene, muzzle.x, muzzle.y, null, aim.x, aim.y,
      damage, isAoe, aoeRadius, color, spriteTex,
    )

    if (action.kind === 'fire' && !isAoe) {
      const ref = (action as { target: TargetRef }).target
      if (ref.kind === 'bomb') {
        // Shoot-the-bomb counterplay — the projectile is a hit-marker, the
        // bomb supplies its own damage/AoE/side on detonation. Removes the
        // pending grenade from the field cleanly.
        const bomb = this.pendingGrenades.find(g => g.id === ref.id)
        if (bomb && bomb.armed) {
          proj.onHit = () => this.detonatePendingGrenade(bomb, actor)
        }
        this.log(actor.side, `${this.actorLabel(actor)} shoots at an armed bomb`)
      } else {
        // Direct fire. Resolve target entity NOW (at fire time) and
        // damage on hit. If the target died before the projectile
        // lands, no damage.
        const targetEntity = this.resolveTargetEntity(ref)
        const targetLabel = targetEntity ? this.targetLabel(targetEntity) : 'target'
        if (targetEntity) {
          const attackerType = this.actorTypeKey(actor)
          const attackerSide = actor.side
          proj.onHit = () => {
            if (targetEntity.isDead) {
              this.log(attackerSide, `${this.actorLabel(actor)}'s shot at ${targetLabel} finds the target already down`)
              // Accuracy telemetry. Target died before our projectile
              // arrived: count as a miss so the shot is not lost from
              // the attack tally.
              this.emit({ kind: 'miss', actorType: attackerType, side: attackerSide })
              return
            }
            // Shield aura applies before damage is dealt. Reduced amount
            // also drives the log line and attribute counters so dmg/cr
            // accurately reflects what landed.
            const final = this.shieldedDamage(targetEntity, damage)
            targetEntity.takeDamage(final)
            const killed = targetEntity.isDead
            const shieldedTag = final < damage ? ' (shielded)' : ''
            this.log(attackerSide, `${this.actorLabel(actor)} hits ${targetLabel} (−${final}${shieldedTag}${killed ? `, killed` : ''})`)
            this.attribute(targetEntity, attackerType, attackerSide, final, killed)
            this.emit({ kind: 'hit', actorType: attackerType, side: attackerSide })
          }
        } else {
          this.log(actor.side, `${this.actorLabel(actor)} fires (target lost)`)
          // No resolvable target entity at fire-resolution time. Still
          // counts as a miss against this attack's accuracy.
          this.emit({ kind: 'miss', actorType: this.actorTypeKey(actor), side: actor.side })
        }
      }
    } else if (isLobbed && action.kind === 'throw') {
      // Lobbed AoE — two mechanics on the same projectile pipeline:
      //   Bomber → 'proximity' (lands as a trap, waits for enemies)
      //   Grenadier → 'timed' (cooked grenade, explodes on its own timer)
      // Both arm at end-of-reveal; the difference is what triggers
      // detonation. Grenadiers throw TIMED GRENADES, not mines.
      // GUARD: only run this branch on actual 'throw' actions. Grenadier
      // melee fallback uses kind:'fire' which has no .cell field.
      proj.silentLanding = true
      // Soft launch thunk so the throw is audible (the detonation later
      // uses playExplosion, but the lob itself was silent before).
      playWeaponSfx('bomb_throw')
      const side = actor.side
      const ownerId = actor.id
      const ownerType = this.actorTypeKey(actor)
      const ownerLabel = this.actorLabel(actor)
      const isGrenadier = actor instanceof SpriteUnit && actor.type === 'grenadier'
      const triggerMode = isGrenadier ? 'timed' : 'proximity'
      proj.onHit = () => {
        // S17.18 no-stack rule: a bomb can NEVER land on the same cell
        // as an existing bomb. The pick-time check in pickBombThrowCell
        // catches single-turn intent, but two bombers throwing in the
        // SAME reveal can both target the same empty cell before
        // either bomb is on the field. This is the safety net at
        // arrival time. If a duplicate would happen, the projectile
        // fizzles with a small puff so the player sees what failed.
        const E = 1
        const dup = this.pendingGrenades.some(
          g => Math.abs(g.worldX - aim.x) < E && Math.abs(g.worldY - aim.y) < E,
        )
        if (dup) {
          this.explosions.push(new Explosion(this.scene, aim.x, aim.y, 14, 0.25))
          this.log(side, `${ownerLabel}'s ${what} hits an existing bomb cell, fizzles`)
          return
        }
        this.pendingGrenades.push(new PendingGrenade(
          this.scene, aim.x, aim.y, damage, aoeRadius, side, ownerId, triggerMode, 16, ownerType,
        ))
      }
      const cell = (action as { cell: CellRef }).cell
      const what = isGrenadier ? 'a grenade' : 'a bomb'
      this.log(actor.side, `${ownerLabel} throws ${what} to (${cell.col}, ${cell.row})`)
      this.emit({ kind: 'action', actorType: ownerType, side, action: 'throw' })
      // Landing-location telemetry. Records throw target + nearest
      // enemy so /stats.html can visualise whether throws cluster on
      // enemies or fly off into dead air. Enemy pool depends on the
      // throwing side.
      const enemyPool = actor.side === 'attacker'
        ? [...this.defenderUnits, ...this.spheres, ...this.structures]
        : [...this.units]
      let nearestEnemyX: number | null = null
      let nearestEnemyY: number | null = null
      let distFromEnemy: number | null = null
      for (const e of enemyPool) {
        if (e.isDead) continue
        const d = Math.hypot(e.worldX - aim.x, e.worldY - aim.y)
        if (distFromEnemy === null || d < distFromEnemy) {
          distFromEnemy = d
          nearestEnemyX = e.worldX
          nearestEnemyY = e.worldY
        }
      }
      this.emit({
        kind: 'grenade_throw',
        throwerType: ownerType,
        side: actor.side,
        throwerX: actor.worldX,
        throwerY: actor.worldY,
        landX: aim.x,
        landY: aim.y,
        nearestEnemyX, nearestEnemyY, distFromEnemy,
      })
    } else {
      // Direct-fire AoE. Splashes everything in range of the impact
      // point immediately. Defender AoE hits cyborgs and friendly
      // defender pieces (friendly-fire). Attacker AoE hits defender
      // pieces plus core plus friendly cyborgs.
      const sourceLabel = this.actorLabel(actor)
      const sourceSide = actor.side
      const sourceType = this.actorTypeKey(actor)
      proj.onHit = () => {
        const summary = this.applyAoe(aim.x, aim.y, aoeRadius, damage, actor)
        this.log(sourceSide, summary.hits === 0
          ? `${sourceLabel} AoE bursts harmlessly`
          : `${sourceLabel} AoE — ${summary.hits} hit (−${summary.damageDealt}${summary.kills > 0 ? `, ${summary.kills} killed` : ''})`)
        // Accuracy. Hit if ANY target took damage from the burst.
        if (summary.hits > 0) this.emit({ kind: 'hit',  actorType: sourceType, side: sourceSide })
        else                  this.emit({ kind: 'miss', actorType: sourceType, side: sourceSide })
      }
    }

    this.projectiles.push(proj)
    // Direct-fire projectile launch sound. AoE projectiles stay silent at
    // launch (the impact playExplosion is plenty); throws got their own
    // bomb_throw above. The dispatcher picks the right per-weapon recipe
    // so phaser, sniper, doublegun, sphere etc. each sound distinct.
    if (!isAoe) playWeaponSfx(this.weaponSfxFor(actor))

    // Doublegun burst. Cyborg Doublegun fires a 2-shot burst per turn:
    // schedule a second identical projectile ~80ms after the first so it
    // visually + audibly reads as a paired pop. Per-shot damage in Config
    // is halved (23) so the 2-shot total matches the prior single-shot
    // throughput. Same target, same onHit handler. If the first shot kills
    // the target the second is wasted (onHit early-returns on isDead).
    if (!isAoe && actor instanceof SpriteUnit && actor.type === 'doublegun') {
      const onHitClone = proj.onHit
      setTimeout(() => {
        const proj2 = new Projectile(
          this.scene, muzzle.x, muzzle.y, null, aim.x, aim.y,
          damage, isAoe, aoeRadius, color, spriteTex,
        )
        proj2.onHit = onHitClone
        this.projectiles.push(proj2)
        playWeaponSfx('doublegun')
      }, 80)
    }
    // Sentry N/S double-shot (S20). The Robot_Sentry south animation
    // shows the top-mounted gun swiveling right -> fire -> left -> fire.
    // Replicate the mechanic when the sentry's target is roughly NORTH
    // or SOUTH (so the swivel motion makes spatial sense). East/West
    // facing keeps the single-shot since the art can't show the swivel
    // from that angle. Full damage each shot — small defender buff
    // gated on positioning. ~180ms gap is slower than doublegun's 80ms
    // so the paired shots read as a swivel sweep, not a burst.
    if (!isAoe && actor instanceof Structure && actor.type === 'sentry') {
      const dx = aim.x - actor.worldX
      const dy = aim.y - actor.worldY
      const targetIsNS = Math.abs(dy) > Math.abs(dx)
      if (targetIsNS) {
        const onHitClone = proj.onHit
        setTimeout(() => {
          if (actor.isDead) return
          const proj2 = new Projectile(
            this.scene, muzzle.x, muzzle.y, null, aim.x, aim.y,
            damage, isAoe, aoeRadius, color, spriteTex,
          )
          proj2.onHit = onHitClone
          this.projectiles.push(proj2)
          playWeaponSfx(this.weaponSfxFor(actor))
        }, 180)
      }
    }
  }

  private applyAoe(cx: number, cy: number, radius: number, damage: number, source: Actor): AoeSummary {
    return this.applyAoeForSide(cx, cy, radius, damage, source.side, this.actorTypeKey(source))
  }

  // Splash damage application. AoE explosions are FRIENDLY-FIRE — every
  // non-dead piece in radius takes damage regardless of which side it
  // belongs to. The `side` parameter is kept on the signature for the
  // log label (which side fired the bomb) but no longer filters who gets
  // hit. Returns the number of pieces hit, total damage dealt, and kill
  // count for the post-action summary.
  private applyAoeForSide(cx: number, cy: number, radius: number, damage: number, side: 'attacker' | 'defender', attackerType?: string): AoeSummary {
    let hits = 0, kills = 0
    // Friendly-fire telemetry. Counts ally targets damaged by this AoE.
    // Helps surface AoE-targeting bugs where a grenadier consistently
    // hits its own cluster, or a defender bomb chains through allied
    // structures. Emitted once at the end of the detonation.
    let allyHits = 0
    const hit = (target: { id?: string; isDead: boolean; takeDamage(n: number): void } | PixelPowerCore, dmg: number, isAlly: boolean) => {
      if (target.isDead) return
      // Shield aura applies before damage is dealt. The reduced amount
      // is what gets attributed for stats too, so dmg/cr math reflects
      // the actual damage absorbed.
      const final = this.shieldedDamage(target, dmg)
      target.takeDamage(final)
      hits++
      if (isAlly) allyHits++
      const killed = target.isDead
      if (killed) kills++
      if (attackerType) this.attribute(target, attackerType, side, final, killed)
    }
    // Cyborgs are ALLIES if the AoE source side was attacker.
    const cyborgsAreAllies = side === 'attacker'
    // Cyborgs (attacker units). Grenadiers wear extra explosive shielding:
    // AoE damage halved. Models heavier blast plating around the bomb-vest
    // role so they survive nearby detonations (own grenades + bomber AoE).
    for (const u of this.units) {
      if (u.isDead) continue
      if (!this.inRadius(u.worldX, u.worldY, cx, cy, radius)) continue
      if (u.type === 'grenadier') {
        const shielded = Math.max(1, Math.round(damage * 0.5))
        u.takeDamage(shielded)
        hits++
        if (cyborgsAreAllies) allyHits++
        const killed = u.isDead
        if (killed) kills++
        if (attackerType) this.attribute(u, attackerType, side, shielded, killed)
      } else {
        hit(u, damage, cyborgsAreAllies)
      }
    }
    // Defender pieces. Allies if the AoE source side was defender.
    const defendersAreAllies = side === 'defender'
    for (const s of this.spheres) {
      if (s.isDead) continue
      if (this.inRadius(s.worldX, s.worldY, cx, cy, radius)) hit(s, damage, defendersAreAllies)
    }
    for (const s of this.structures) {
      if (s.isDead) continue
      if (this.inRadius(s.worldX, s.worldY, cx, cy, radius)) hit(s, damage, defendersAreAllies)
    }
    for (const u of this.defenderUnits) {
      if (u.isDead) continue
      if (this.inRadius(u.worldX, u.worldY, cx, cy, radius)) hit(u, damage, defendersAreAllies)
    }
    if (!this.core.isDead) {
      const cc = this.core.cellCenters()
      const inside = cc.some(p => this.inRadius(p.x, p.y, cx, cy, radius))
      if (inside) hit(this.core, damage, defendersAreAllies)
    }
    // Ammo crates caught in the blast vaporize. User observed a grenade
    // landing on a crate, expects the crate to be destroyed. Boxes count
    // as kills in the summary (objects destroyed) but their damage is
    // tracked separately since they have 1 HP.
    for (const box of this.ammoBoxes) {
      if (box.isDead) continue
      if (this.inRadius(box.worldX, box.worldY, cx, cy, radius)) {
        box.takeDamage(damage)
        hits++
        if (box.isDead) kills++
      }
    }
    // Single friendly-fire event per detonation, carrying the ally hit
    // count. Skipped for the death-explosion sources ('self_destruct'
    // for robots, 'hulk_blast' for hulks) so we don't pollute the
    // bug-hunting counter with mandatory by-design ally hits.
    const isDeathBlast = attackerType === 'self_destruct' || attackerType === 'hulk_blast'
    if (attackerType && !isDeathBlast && allyHits > 0) {
      this.emit({ kind: 'friendly_fire', actorType: attackerType, side, count: allyHits })
    }
    return { hits, damageDealt: hits * damage, kills }
  }

  private checkMineTriggers(unit: SpriteUnit, x: number, y: number) {
    for (const s of this.structures) {
      if (s.type !== 'mine' || s.isDead) continue
      const dx = s.worldX - x
      const dy = s.worldY - y
      if (Math.sqrt(dx * dx + dy * dy) >= MINE_DETECT_RADIUS) continue
      const radius = Config.STRUCTURES.mine.range + 10
      this.explosions.push(new Explosion(this.scene, s.worldX, s.worldY, radius, 0.7))
      playExplosion()
      const dmg = Config.STRUCTURES.mine.damage
      let hits = 0, kills = 0
      this.emit({ kind: 'action', actorType: 'mine', side: 'defender', action: 'mine_trigger' })
      for (const u of this.units) {
        if (u.isDead) continue
        if (this.inRadius(u.worldX, u.worldY, s.worldX, s.worldY, radius)) {
          u.takeDamage(dmg); hits++
          const killed = u.isDead
          if (killed) kills++
          this.attribute(u, 'mine', 'defender', dmg, killed)
        }
      }
      s.takeDamage(9999)   // mine self-destructs on trigger
      this.combatThisReveal = true
      this.log('defender', `Mine triggers — ${this.actorLabel(unit)} step set it off${hits > 0 ? ` (−${hits * dmg}, ${hits} hit${kills > 0 ? `, ${kills} killed` : ''})` : ' (no other targets)'}`)
    }
  }

  // ── Win/lose ─────────────────────────────────────────────────────────────

  private checkWinLose() {
    if (this.over) return
    if (this.core.isDead) {
      this.over = true
      this.log('neutral', 'POWER CORE DESTROYED')
      this.applyCoreBlast()
      this.onLose?.()
      return
    }
    if (this.units.every(u => u.isDead)) {
      this.over = true
      // Faction-neutral: the attacker can be Cyborgs, Humans, or Robots.
      this.log('neutral', 'All attackers eliminated')
      this.onWin?.()
    }
  }

  private applyCoreBlast() {
    const cx = this.core.mesh.position.x
    const cy = this.core.mesh.position.y
    const BLAST_RADIUS = 180
    // S17.14: attribute the blast kills properly. Previously each
    // takeDamage(99999) call killed the cyborg silently. Those kills
    // were missing from stats (no kind:'damage' / 'kill' events, no
    // on_death speech, no telemetry buckets). Now each hit goes
    // through attribute() with actorType 'core_blast' so the dying
    // cyborgs are credited and on_death speech fires as a final
    // dramatic chorus.
    let hits = 0, kills = 0, totalDmg = 0
    for (const u of this.units) {
      if (u.isDead) continue
      if (!this.inRadius(u.worldX, u.worldY, cx, cy, BLAST_RADIUS)) continue
      const dmg = u.hp   // record actual damage applied so attribute amounts make sense
      u.takeDamage(99999)
      const killed = u.isDead
      hits++
      if (killed) kills++
      totalDmg += dmg
      this.attribute(u, 'core_blast', 'defender', dmg, killed)
    }
    this.explosions.push(new Explosion(this.scene, cx, cy, BLAST_RADIUS, 1.2))
    playExplosion()
    if (hits > 0) {
      this.log('defender', `Power Core blast hits ${hits} (−${totalDmg}${kills > 0 ? `, ${kills} killed` : ''})`)
    }
  }

  // ── Resolvers ────────────────────────────────────────────────────────────

  private resolveTargetEntity(ref: TargetRef): { takeDamage(n: number): void; isDead: boolean } | null {
    if (ref.kind === 'core') return this.core.isDead ? null : this.core
    if (ref.kind === 'ammobox') {
      const box = this.ammoBoxes.find(b => b.id === ref.id)
      return box && !box.isDead ? box : null
    }
    const all: Actor[] = [...this.units, ...this.defenderUnits, ...this.spheres, ...this.structures]
    const hit = all.find(p => p.id === ref.id)
    return hit && !hit.isDead ? hit : null
  }

  private resolveTargetXY(ref: TargetRef, fromX?: number, fromY?: number): { x: number; y: number } | null {
    if (ref.kind === 'core') {
      if (this.core.isDead) return null
      // Aim at the core cell nearest the attacker (when a from-point is given)
      // so a melee unit adjacent to one of the 2x2 cells is actually in range.
      // Falls back to the mesh center for callers that pass no from-point.
      if (fromX !== undefined && fromY !== undefined) {
        let best = { x: this.core.mesh.position.x, y: this.core.mesh.position.y }
        let bestD = Infinity
        for (const c of this.core.cellCenters()) {
          const d = Math.hypot(c.x - fromX, c.y - fromY)
          if (d < bestD) { bestD = d; best = { x: c.x, y: c.y } }
        }
        return best
      }
      return { x: this.core.mesh.position.x, y: this.core.mesh.position.y }
    }
    if (ref.kind === 'bomb') {
      const b = this.pendingGrenades.find(g => g.id === ref.id)
      return b && b.armed ? { x: b.worldX, y: b.worldY } : null
    }
    if (ref.kind === 'ammobox') {
      const box = this.ammoBoxes.find(b => b.id === ref.id)
      return box && !box.isDead ? { x: box.worldX, y: box.worldY } : null
    }
    const all: Actor[] = [...this.units, ...this.defenderUnits, ...this.spheres, ...this.structures]
    const hit = all.find(p => p.id === ref.id)
    return hit && !hit.isDead ? { x: hit.worldX, y: hit.worldY } : null
  }

  // ── Geometry helpers ─────────────────────────────────────────────────────

  private cellCenter(cell: CellRef): { x: number; y: number } {
    const c = Config.GRID_CELL
    return {
      x: Config.WORLD.LEFT   + cell.col * c + c / 2,
      y: Config.WORLD.BOTTOM + cell.row * c + c / 2,
    }
  }

  private isCellOccupiedAtBattle(x: number, y: number, exclude: Actor): boolean {
    const E = 1
    for (const u of this.units) {
      if (u === exclude || u.isDead) continue
      if (Math.abs(u.worldX - x) < E && Math.abs(u.worldY - y) < E) return true
      if (u.isWalking && Math.abs(u.prevWorldX - x) < E && Math.abs(u.prevWorldY - y) < E) return true
    }
    for (const u of this.defenderUnits) {
      if (u === exclude || u.isDead) continue
      if (Math.abs(u.worldX - x) < E && Math.abs(u.worldY - y) < E) return true
      if (u.isWalking && Math.abs(u.prevWorldX - x) < E && Math.abs(u.prevWorldY - y) < E) return true
    }
    for (const s of this.spheres) {
      if (s.isDead) continue
      if (Math.abs(s.worldX - x) < E && Math.abs(s.worldY - y) < E) return true
    }
    for (const s of this.structures) {
      if (s.isDead) continue
      if (Math.abs(s.worldX - x) < E && Math.abs(s.worldY - y) < E) return true
    }
    for (const cc of this.core.cellCenters()) {
      if (Math.abs(cc.x - x) < E && Math.abs(cc.y - y) < E) return true
    }
    return false
  }

  private inRadius(x: number, y: number, cx: number, cy: number, r: number): boolean {
    const dx = x - cx, dy = y - cy
    return Math.sqrt(dx * dx + dy * dy) < r
  }

  private actorX(a: AnyTarget): number { return a instanceof PixelPowerCore ? a.mesh.position.x : a.worldX }
  private actorY(a: AnyTarget): number { return a instanceof PixelPowerCore ? a.mesh.position.y : a.worldY }

  private actorAmmo(actor: Actor): number {
    if (actor instanceof SpriteUnit)     return actor.ammoRemaining
    if (actor instanceof SphereDefender) return actor.ammoRemaining
    return actor.ammoRemaining
  }

  private decrementActorAmmo(actor: Actor) {
    if (actor instanceof SpriteUnit) {
      actor.ammoRemaining = Math.max(0, actor.ammoRemaining - 1)
      actor.notifyAmmoChanged()   // may pop a "low_ammo" / "out_of_ammo" bubble
      return
    }
    if (actor instanceof SphereDefender) {
      actor.ammoRemaining = Math.max(0, actor.ammoRemaining - 1)
      actor.notifyAmmoChanged()
      return
    }
    actor.ammoRemaining = Math.max(0, actor.ammoRemaining - 1)
    actor.notifyAmmoChanged()
  }

  private actorRange(actor: Actor): number {
    if (actor instanceof SpriteUnit)     return Config.UNITS[actor.type].range
    if (actor instanceof SphereDefender) return Config.SPHERE.range
    return Config.STRUCTURES[actor.type].range
  }
  private actorDamage(actor: Actor): number {
    if (actor instanceof SpriteUnit)     return Config.UNITS[actor.type].damage
    if (actor instanceof SphereDefender) return Config.SPHERE.damage
    return Config.STRUCTURES[actor.type].damage
  }
  private actorMuzzle(actor: Actor, aimX: number, aimY: number): { x: number; y: number } {
    if (actor instanceof SpriteUnit) return actor.getMuzzlePoint()
    // Spheres and structures don't have a directional muzzle — fire from a
    // small forward offset toward the target so the projectile doesn't start
    // inside the piece.
    const dx = aimX - actor.worldX
    const dy = aimY - actor.worldY
    const d = Math.sqrt(dx * dx + dy * dy) || 1
    const FORWARD = 14
    return {
      x: actor.worldX + (dx / d) * FORWARD,
      y: actor.worldY + (dy / d) * FORWARD,
    }
  }

  faceCamera(camera: THREE.Camera) {
    for (const u of this.units) u.faceCamera(camera)
    for (const u of this.defenderUnits) u.faceCamera(camera)
    for (const s of this.spheres) if (!s.isDead) s.faceCamera(camera)
    for (const s of this.structures) if (!s.isDead) s.faceCamera(camera)
  }

  // ── Combat log helpers ──────────────────────────────────────────────────

  private log(side: 'defender' | 'attacker' | 'neutral', text: string) {
    const entry: CombatLogEntry = { side, text }
    this.combatLog.push(entry)
    this.onLogEntry?.(entry)
  }

  private actorLabel(a: AnyTarget): string {
    if (a instanceof PixelPowerCore) return 'Power Core'
    if (a instanceof SphereDefender) return 'Sphere'
    if (a instanceof SpriteUnit) return Config.UNITS[a.type].label
    // STRUCTURES[type].label is "Bomber 70cr" — strip the cost suffix.
    return Config.STRUCTURES[a.type].label.replace(/\s*\d+cr.*$/, '').trim()
  }

  // Lookup for fire-target entities. Resolves to the same label as actorLabel
  // for now but kept separate so a future change (e.g. include cell coords
  // for the core's hit cell) only touches the target path.
  private targetLabel(t: { isDead: boolean }): string {
    if (t instanceof PixelPowerCore) return 'Power Core'
    if (t instanceof SphereDefender) return 'Sphere'
    if (t instanceof SpriteUnit) return Config.UNITS[t.type].label
    if (t instanceof Structure)  return Config.STRUCTURES[t.type].label.replace(/\s*\d+cr.*$/, '').trim()
    if (t instanceof AmmoBox) {
      return t.type === 'medkit' ? 'medkit crate'
        : t.type === 'repair_kit' ? 'repair-kit crate'
        : t.type === 'grenade' ? 'grenade crate'
        : 'ammo crate'
    }
    return 'target'
  }
}
