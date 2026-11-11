import { ConnectionBadge } from './ConnectionBadge.jsx'

export function Header() {
  return (
    <header className="relative overflow-hidden rounded-lg border border-line bg-panel">
      {/* Amber strip along the top, like the edge of a stadium board */}
      <div className="h-1 bg-amber" aria-hidden />
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8 sm:py-6">
        <div>
          <h1 className="font-score text-5xl leading-none font-bold tracking-wide uppercase sm:text-6xl">
            <span className="glow-amber text-amber">Khel</span>
            <span>Scores</span>
          </h1>
          <p className="mt-2 text-sm font-semibold tracking-[0.25em] text-muted uppercase">
            Live football &amp; cricket scores, as they happen
          </p>
        </div>
        <ConnectionBadge />
      </div>
    </header>
  )
}
