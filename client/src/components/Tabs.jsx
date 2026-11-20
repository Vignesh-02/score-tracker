import { TAB, TABS } from '../lib/matches.js'
import { tabId, tabPanelId } from '../lib/tabs.js'

const LABELS = { [TAB.LIVE]: 'Live', [TAB.FIXTURES]: 'Fixtures', [TAB.RESULTS]: 'Results', [TAB.TABLES]: 'Tables' }

// Live, Fixtures, Results (each with its match count) and Tables. Arrow keys
// move between tabs.
export function Tabs({ tab, counts, onChange }) {
  function onKeyDown(e) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]
    onChange(next)
    document.getElementById(tabId(next))?.focus()
  }

  return (
    <div role="tablist" aria-label="Matches" className="flex border-b border-line" onKeyDown={onKeyDown}>
      {TABS.map((value) => {
        const active = value === tab
        const liveNow = value === TAB.LIVE && counts[value] > 0

        return (
          <button
            key={value}
            id={tabId(value)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={tabPanelId(value)}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(value)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2.5 text-sm font-bold tracking-[0.12em] uppercase transition sm:gap-2 sm:px-5 sm:text-base sm:tracking-[0.18em] ${
              active ? 'border-amber text-amber' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {liveNow && (
              <span className="relative flex size-2" aria-hidden>
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-live opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-live" />
              </span>
            )}
            {LABELS[value]}
            {counts[value] != null && (
              <span className="font-mono text-xs font-medium tracking-normal opacity-70">{counts[value]}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
