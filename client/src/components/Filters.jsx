import { ChevronDown } from 'lucide-react'
import { ALL } from '../lib/matches.js'

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-full border-2 border-ink px-3.5 py-1.5 text-sm font-bold transition ${
        active
          ? 'bg-ink text-page'
          : 'bg-card shadow-brutal-sm hover:-translate-y-0.5 active:translate-x-0.5 active:translate-y-0.5 active:shadow-none'
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
        <label className="relative sm:ml-auto">
          <span className="sr-only">Competition</span>
          <select
            value={filters.competition}
            onChange={(e) => onChange({ competition: e.target.value })}
            className="w-full appearance-none rounded-full border-2 border-ink bg-card py-1.5 pl-4 pr-9 text-sm font-bold shadow-brutal-sm sm:w-auto"
          >
            <option value={ALL}>All competitions</option>
            {competitions.map(({ value, count }) => (
              <option key={value} value={value}>
                {value} ({count})
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2" aria-hidden />
        </label>
      )}
    </div>
  )
}
