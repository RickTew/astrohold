import { Game } from './game/Game'
import { installBattleStatsConsoleApi } from './game/BattleStats'
import { enableAudioDebug } from './audio/audioDebug'
import { mountAudioLogOverlay } from './devtools/audioLogOverlay'
import { passGate } from './gate'

// Pre-launch access gate (TEMPORARY). Blocks the WHOLE app (game, ?online,
// ?audiolog) behind a shared code while AstroHold is in private build, so the
// live domain is not open to the public. boot() does not run until the visitor
// passes the gate (or has already passed it on this browser).
//
// Remove the passGate() wrapper below and delete src/gate.ts at public launch.
// The real entry is the guest-first screen on the roadmap, NOT this throwaway
// gate. See the src/gate.ts header for how to change the code / remove it.
passGate().then(boot)

function boot() {
  // AstroCraft mini-RTS prototype. Gated behind ?astrocraft so the main game
  // is untouched; dynamic import keeps it out of the main bundle. When active
  // it replaces the normal boot entirely (its own canvas + loop).
  if (new URLSearchParams(location.search).has('astrocraft')) {
    import('./astrocraft/AstroCraft').then(({ mountAstroCraft }) => mountAstroCraft())
    return
  }

  // Audio vocal hunt: visit astro-hold.vercel.app/?audiolog to turn on an
  // on-screen log that names the exact file every sound plays (SFX + music),
  // newest first. Read the line that appears the instant Live Caption shows a
  // vocal. Off (and free) for normal players.
  if (new URLSearchParams(location.search).has('audiolog')) {
    enableAudioDebug()
    mountAudioLogOverlay()
  }

  // Online 2-player lobby. Gated behind ?online while the netcode is built,
  // so normal players never load it and the live game is unchanged. Dynamic
  // import keeps it out of the main bundle. Milestone: connect two players;
  // in-game build/reveal sync is the next step.
  if (new URLSearchParams(location.search).has('online')) {
    import('./net/lobbyUI').then(({ mountLobby }) => {
      mountLobby((match, mySide) => {
        console.log('[online] match ready', match.id, '- you are', mySide)
        const toast = document.createElement('div')
        toast.textContent = `Online match ready - you are ${mySide.toUpperCase()} (game sync coming next)`
        toast.style.cssText =
          'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:99999;' +
          'background:#15351f;color:#7ee0a0;border:1px solid #2a5a3a;padding:10px 16px;' +
          'border-radius:8px;font:600 14px system-ui,sans-serif'
        document.body.appendChild(toast)
      })
    })
  }

  const canvas = document.getElementById('canvas') as HTMLCanvasElement
  const game = new Game(canvas)

  // Expose battle-stats dump helpers on window.astrohold before the game
  // starts. The user can call them from the dev console at any time:
  //   astrohold.statsSummary() · astrohold.dumpStats() · astrohold.statsJSON()
  installBattleStatsConsoleApi()

  game.init().then(() => game.start())

  if (import.meta.hot) {
    import.meta.hot.dispose(() => game.dispose())
  }
}
