// Pre-launch access gate (TEMPORARY - remove at public launch).
//
// AstroHold is in private build. This thin shim blocks the whole app behind a
// single shared access code so the live domain (www.astrohold.com) is not open
// to the public while the game is unfinished. It is intentionally SEPARATE from
// the planned guest-first entry/login screen: this is throwaway scaffolding,
// the entry screen is the real product. Do NOT let this harden into a login
// wall - guest play must always work at launch.
//
// HOW IT WORKS: a client-side code check plus a localStorage "pass" flag, so a
// tester enters the code once per browser. This is a DETERRENT, not real
// security: the code ships inside the JS bundle, so anyone who reads the bundle
// can bypass it. That is fine for "keep crawlers and the curious out of a
// half-built game". If we ever need true enforcement, swap the check for a
// Supabase RPC (server-side validation).
//
// CHANGE THE CODE: edit GATE_CODE below, or set VITE_GATE_CODE in the Vercel
// project (Production) and redeploy. The env var wins when present.
// REVOKE EVERYONE (force re-entry for all testers): bump GATE_VERSION.
// REMOVE AT LAUNCH: delete this file and the passGate() wrapper in main.ts.

const GATE_CODE =
  (import.meta.env.VITE_GATE_CODE as string | undefined)?.trim() || 'holdtheline'

// Bump to invalidate every tester's saved pass and force re-entry.
const GATE_VERSION = '1'
const STORAGE_KEY = 'ah_gate'

/**
 * Resolves once the visitor is allowed in: immediately if this browser has
 * already passed, otherwise after they enter the correct code in the splash.
 * Call this BEFORE booting the game in main.ts.
 */
export function passGate(): Promise<void> {
  // Already let in on this browser? Skip straight to the game.
  try {
    if (localStorage.getItem(STORAGE_KEY) === GATE_VERSION) {
      return Promise.resolve()
    }
  } catch {
    // localStorage blocked (private mode / disabled). Fall through to the
    // splash; the pass just will not persist across reloads.
  }

  return new Promise<void>((resolve) => {
    injectStyles()

    const overlay = document.createElement('div')
    overlay.id = 'ah-gate'

    overlay.innerHTML = `
      <div id="ah-gate-card">
        <div id="ah-gate-title">ASTROHOLD</div>
        <div id="ah-gate-sub">Private build &middot; enter access code</div>
        <input id="ah-gate-input" type="text" inputmode="text"
               autocomplete="off" autocapitalize="off" spellcheck="false"
               placeholder="access code" aria-label="access code" />
        <button id="ah-gate-btn" type="button">ENTER</button>
        <div id="ah-gate-err">&nbsp;</div>
      </div>
    `

    document.body.appendChild(overlay)

    const input = overlay.querySelector<HTMLInputElement>('#ah-gate-input')!
    const btn = overlay.querySelector<HTMLButtonElement>('#ah-gate-btn')!
    const err = overlay.querySelector<HTMLDivElement>('#ah-gate-err')!

    const attempt = () => {
      const guess = input.value.trim().toLowerCase()
      if (guess === GATE_CODE.toLowerCase()) {
        try {
          localStorage.setItem(STORAGE_KEY, GATE_VERSION)
        } catch {
          // ignore: cannot persist, but still let them in for this session.
        }
        overlay.style.opacity = '0'
        // Let the fade play, then tear down and boot the game.
        window.setTimeout(() => {
          overlay.remove()
          document.getElementById('ah-gate-style')?.remove()
          resolve()
        }, 280)
      } else {
        err.textContent = 'Incorrect code'
        input.value = ''
        const card = overlay.querySelector<HTMLDivElement>('#ah-gate-card')!
        card.classList.remove('ah-gate-shake')
        // Reflow so the animation can restart on a repeat wrong guess.
        void card.offsetWidth
        card.classList.add('ah-gate-shake')
        input.focus()
      }
    }

    btn.addEventListener('click', attempt)
    // Enter-to-submit is a convenience while typing the code; the ENTER
    // button is the primary, cursor-reachable path (mouse-only UI rule).
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attempt()
    })

    // Focus so the tester can type straight away.
    window.setTimeout(() => input.focus(), 0)
  })
}

function injectStyles(): void {
  if (document.getElementById('ah-gate-style')) return
  const style = document.createElement('style')
  style.id = 'ah-gate-style'
  // Scoped entirely to #ah-gate* - never touches .hud-* or index.html styles.
  style.textContent = `
    #ah-gate {
      position: fixed; inset: 0; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      background:
        radial-gradient(120% 120% at 50% 30%, #0b1830 0%, #05070d 70%, #000 100%);
      transition: opacity .28s ease;
      font-family: 'Orbitron', system-ui, sans-serif;
      -webkit-user-select: none; user-select: none;
    }
    #ah-gate-card {
      width: min(86vw, 360px);
      padding: 34px 30px 26px;
      border: 1px solid #244268;
      border-radius: 14px;
      background: rgba(10, 20, 38, 0.92);
      box-shadow: 0 0 0 1px rgba(120, 180, 255, .06), 0 18px 60px rgba(0,0,0,.6);
      text-align: center;
    }
    #ah-gate-title {
      font-weight: 900; font-size: 30px; letter-spacing: 6px;
      color: #cce8ff; text-shadow: 0 0 18px rgba(90,160,255,.5);
    }
    #ah-gate-sub {
      margin-top: 8px; font-size: 12px; letter-spacing: 1px;
      color: #6f86a8; font-family: system-ui, sans-serif;
    }
    #ah-gate-input {
      margin-top: 22px; width: 100%;
      padding: 12px 14px;
      font: 600 16px system-ui, sans-serif; letter-spacing: 1px;
      color: #eaf3ff; text-align: center;
      background: #0a1322; border: 1px solid #2c4a6e; border-radius: 9px;
      outline: none;
    }
    #ah-gate-input:focus { border-color: #4f86d6; box-shadow: 0 0 0 3px rgba(79,134,214,.18); }
    #ah-gate-input::placeholder { color: #46597a; letter-spacing: 1px; }
    #ah-gate-btn {
      margin-top: 14px; width: 100%;
      padding: 12px 14px;
      font: 700 14px 'Orbitron', system-ui, sans-serif; letter-spacing: 2px;
      color: #06101f; cursor: pointer;
      background: linear-gradient(180deg, #7ec0ff, #4f86d6);
      border: none; border-radius: 9px;
      transition: filter .12s ease, transform .06s ease;
    }
    #ah-gate-btn:hover { filter: brightness(1.08); }
    #ah-gate-btn:active { transform: translateY(1px); }
    #ah-gate-err {
      margin-top: 12px; min-height: 16px;
      font: 600 12px system-ui, sans-serif; letter-spacing: .5px;
      color: #ff7b7b;
    }
    .ah-gate-shake { animation: ah-gate-shake .32s ease both; }
    @keyframes ah-gate-shake {
      0%,100% { transform: translateX(0); }
      20% { transform: translateX(-8px); }
      40% { transform: translateX(7px); }
      60% { transform: translateX(-5px); }
      80% { transform: translateX(3px); }
    }
  `
  document.head.appendChild(style)
}
