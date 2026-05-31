import { Game } from './game/Game'
import { installBattleStatsConsoleApi } from './game/BattleStats'
import { enableAudioDebug } from './audio/audioDebug'
import { mountAudioLogOverlay } from './devtools/audioLogOverlay'

// Audio vocal hunt: visit astrohold3.vercel.app/?audiolog to turn on an
// on-screen log that names the exact file every sound plays (SFX + music),
// newest first. Read the line that appears the instant Live Caption shows a
// vocal. Off (and free) for normal players.
if (new URLSearchParams(location.search).has('audiolog')) {
  enableAudioDebug()
  mountAudioLogOverlay()
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const game = new Game(canvas)

// Expose battle-stats dump helpers on window.astrohold before the game
// starts — the user can call them from the dev console at any time:
//   astrohold.statsSummary() · astrohold.dumpStats() · astrohold.statsJSON()
installBattleStatsConsoleApi()

game.init().then(() => game.start())

if (import.meta.hot) {
  import.meta.hot.dispose(() => game.dispose())
}
