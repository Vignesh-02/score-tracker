import { ChevronDown } from 'lucide-react'
import { ALL } from '../lib/matches.js'

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-2 rounded-md border px-3.5 py-1.5 text-sm font-bold tracking-wider uppercase transition ${
        active
          ? 'border-amber bg-amber/10 text-amber'
          : 'border-line bg-panel text-muted hover:border-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

const Count = ({ children }) => <span className="font-mono text-xs opacity-70">{children}</span>

export function Filters({ options, filters, total, onChange }) {
  const { sports, competitions } = options

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by sport">
        <Chip active={filters.sport === ALL} onClick={() => onChange({ sport: ALL })}>
          All <Count>{total}</Count>
        </Chip>
        {sports.map(({ value, count }) => (
          <Chip key={value} active={filters.sport === value} onClick={() => onChange({ sport: value })}>
            {value} <Count>{count}</Count>
          </Chip>
        ))}
      </div>

      {competitions.length > 0 && (
        <label className="relative w-full sm:ml-auto sm:w-auto">
          <span className="sr-only">Competition</span>
          <select
            value={filters.competition}
            onChange={(e) => onChange({ competition: e.target.value })}
            className="w-full appearance-none rounded-md border border-line bg-panel py-1.5 pr-9 pl-3.5 text-sm font-bold tracking-wider uppercase transition hover:border-muted focus:border-amber focus:outline-none sm:w-auto"
          >
            <option value={ALL}>All competitions</option>
            {competitions.map(({ value, count }) => (
              <option key={value} value={value}>
                {value} ({count})
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
        </label>
      )}
    </div>
  )
}
