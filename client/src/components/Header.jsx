import { ConnectionBadge } from './ConnectionBadge.jsx'

export function Header() {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border-[3px] border-ink bg-sun px-5 py-5 text-on-accent shadow-brutal sm:px-8 sm:py-7">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Score Tracker</h1>
        <p className="mt-1 font-medium">Live football scores, as they happen</p>
      </div>
      <ConnectionBadge />
    </header>
  )
}
