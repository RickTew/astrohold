// Self-contained online lobby overlay.
//
// Deliberately independent of HUD.ts and the game flow: it injects its own
// DOM + scoped styles (.ah-lobby-*), so it can NEVER disturb the frozen HUD
// or the side picker. Mounted only when the page is opened with `?online`
// (see main.ts), so normal players never see a half-built feature.
//
// Flow: Create (pick a side -> get a shareable 6-char code, wait for the
// opponent) OR Join (paste a code). When both seats are filled the match
// goes 'active' and onReady(match, mySide) fires on BOTH clients.

import {
  createMatch, joinMatch, subscribeToMatch, getMatch, mySideIn,
  type OnlineMatch, type MatchSide,
} from './onlineMatch'

const STYLE = `
.ah-lobby-backdrop{position:fixed;inset:0;z-index:99999;display:flex;
  align-items:center;justify-content:center;background:rgba(4,6,12,.82);
  font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8eefc}
.ah-lobby{width:min(440px,92vw);background:#0e1422;border:1px solid #243049;
  border-radius:14px;padding:26px 26px 22px;box-shadow:0 18px 60px rgba(0,0,0,.6)}
.ah-lobby h2{margin:0 0 4px;font-size:22px;letter-spacing:.5px}
.ah-lobby p.sub{margin:0 0 18px;color:#8da0c0;font-size:13px}
.ah-lobby .row{display:flex;gap:10px}
.ah-lobby button{flex:1;cursor:pointer;border:0;border-radius:9px;padding:12px;
  font-size:14px;font-weight:600;color:#fff;background:#2b3a59;transition:filter .12s}
.ah-lobby button:hover{filter:brightness(1.18)}
.ah-lobby button.def{background:#2b62c9}
.ah-lobby button.att{background:#c93b3b}
.ah-lobby button.ghost{background:#1a2336}
.ah-lobby input{width:100%;box-sizing:border-box;margin:6px 0 14px;padding:12px;
  border-radius:9px;border:1px solid #2b3a59;background:#0a0f1a;color:#fff;
  font-size:18px;letter-spacing:3px;text-transform:uppercase;text-align:center}
.ah-lobby .code{font-size:34px;font-weight:800;letter-spacing:8px;text-align:center;
  background:#0a0f1a;border:1px dashed #2b62c9;border-radius:10px;padding:14px;margin:6px 0 4px}
.ah-lobby .hint{font-size:12px;color:#8da0c0;text-align:center;margin:0 0 16px}
.ah-lobby .err{color:#ff8a8a;font-size:13px;min-height:18px;margin-top:6px;text-align:center}
.ah-lobby .ok{color:#7ee0a0}
.ah-lobby a.link{color:#6fa8ff;cursor:pointer;text-decoration:underline}
.ah-lobby .center{text-align:center}
.ah-lobby .spin{display:inline-block;width:14px;height:14px;border:2px solid #3a4straggler;
  border-top-color:#6fa8ff;border-radius:50%;animation:ah-spin 1s linear infinite;vertical-align:-2px}
@keyframes ah-spin{to{transform:rotate(360deg)}}
`.replace('#3a4straggler', '#33405c')

export type OnMatchReady = (match: OnlineMatch, mySide: MatchSide) => void

export function mountLobby(onReady: OnMatchReady): void {
  if (document.getElementById('ah-lobby-style')) return // already mounted

  const style = document.createElement('style')
  style.id = 'ah-lobby-style'
  style.textContent = STYLE
  document.head.appendChild(style)

  const backdrop = document.createElement('div')
  backdrop.className = 'ah-lobby-backdrop'
  const box = document.createElement('div')
  box.className = 'ah-lobby'
  backdrop.appendChild(box)
  document.body.appendChild(backdrop)

  let unsub: (() => void) | null = null

  const close = () => {
    unsub?.()
    backdrop.remove()
    style.remove()
  }

  // Fire onReady once, then tear the lobby down.
  const ready = async (match: OnlineMatch) => {
    const side = await mySideIn(match)
    if (!side) { showError('Could not resolve your side in this match.'); return }
    close()
    onReady(match, side)
  }

  const render = (html: string) => { box.innerHTML = html }
  const showError = (msg: string) => {
    const el = box.querySelector<HTMLElement>('.err')
    if (el) el.textContent = msg
  }

  // ---- Screen: home (Create / Join) ----------------------------------
  const home = () => {
    render(`
      <h2>Play Online</h2>
      <p class="sub">Two devices, one per side. Share a code to play a friend.</p>
      <div class="row" style="margin-bottom:12px">
        <button class="def" data-create="defender">Create as Defender</button>
        <button class="att" data-create="attacker">Create as Attacker</button>
      </div>
      <div class="center sub" style="margin:14px 0 6px">or join a friend's game</div>
      <input id="ah-join-code" maxlength="6" placeholder="CODE" autocomplete="off" />
      <div class="row"><button class="ghost" data-join>Join Game</button></div>
      <div class="err"></div>
    `)
    box.querySelectorAll<HTMLElement>('[data-create]').forEach(b =>
      b.onclick = () => create(b.dataset.create as MatchSide))
    box.querySelector<HTMLElement>('[data-join]')!.onclick = () => {
      const code = box.querySelector<HTMLInputElement>('#ah-join-code')!.value.trim().toUpperCase()
      if (code.length < 4) { showError('Enter the code your friend shared.'); return }
      join(code)
    }
  }

  // ---- Action: create -------------------------------------------------
  const create = async (side: MatchSide) => {
    render(`<h2>Creating game…</h2><p class="sub center"><span class="spin"></span></p>`)
    try {
      const match = await createMatch(side)
      waiting(match)
    } catch (e) {
      home(); showError(errText(e))
    }
  }

  // ---- Screen: waiting for opponent ----------------------------------
  const waiting = (match: OnlineMatch) => {
    render(`
      <h2>Waiting for opponent…</h2>
      <p class="sub">You are <strong>${match.attacker_id ? 'Attacker' : 'Defender'}</strong>. Share this code:</p>
      <div class="code">${match.invite_token ?? '------'}</div>
      <p class="hint">They open the game with <strong>?online</strong> and enter this code. <span class="spin"></span></p>
      <div class="row"><button class="ghost" data-cancel>Cancel</button></div>
      <div class="err"></div>
    `)
    box.querySelector<HTMLElement>('[data-cancel]')!.onclick = close

    // Live: opponent joins -> status flips to 'active'.
    unsub = subscribeToMatch(match.id, m => { if (m.status === 'active') ready(m) })
    // Safety net in case the join lands before the subscription is live.
    getMatch(match.id).then(m => { if (m && m.status === 'active') ready(m) }).catch(() => {})
  }

  // ---- Action: join ---------------------------------------------------
  const join = async (code: string) => {
    render(`<h2>Joining…</h2><p class="sub center"><span class="spin"></span></p>`)
    try {
      const match = await joinMatch(code)
      ready(match)
    } catch (e) {
      home(); showError(errText(e))
    }
  }

  home()
}

function errText(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e)
  if (/not found/i.test(m)) return 'No open game with that code.'
  if (/not joinable|full|already/i.test(m)) return 'That game is no longer open.'
  return m
}
