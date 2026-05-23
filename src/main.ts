import { Game } from './game/Game'
import { installBattleStatsConsoleApi } from './game/BattleStats'

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
