import { useEffect, useState } from 'react'
import { RotateCw, WifiOff } from 'lucide-react'
import { useConnectionStatus, useLiveSocket } from '../live/hooks.js'

const STYLES = {
  open: { dot: 'bg-ok', label: 'Live' },
  connecting: { dot: 'bg-warn animate-pulse', label: 'Connecting…' },
  reconnecting: { dot: 'bg-warn animate-pulse', label: 'Reconnecting…' },
  offline: { dot: 'bg-live', label: 'Offline' },
}

// Rendered with key={retryAt}, so each retry starts a fresh countdown
function RetryCountdown({ retryAt }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000))
  if (seconds === 0) return null

  return <span className="font-mono text-xs font-medium normal-case text-muted">retry in {seconds}s</span>
}

export function ConnectionBadge() {
  const { status, retryAt } = useConnectionStatus()
  const socket = useLiveSocket()
  const { dot, label } = STYLES[status]

  const waitingToRetry = status !== 'open' && retryAt != null

  return (
    <div className="flex items-center gap-2">
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 rounded-full border-2 border-ink bg-card px-3 py-1.5 text-sm font-bold uppercase tracking-wide shadow-brutal-sm sm:px-4 sm:py-2"
      >
        {status === 'offline' ? (
          <WifiOff className="size-4 text-live" aria-hidden />
        ) : (
          <span className={`size-2.5 rounded-full ${dot}`} aria-hidden />
        )}
        <span>{label}</span>
        {waitingToRetry && <RetryCountdown key={retryAt} retryAt={retryAt} />}
      </div>

      {waitingToRetry && (
        <button
          type="button"
          onClick={() => socket.retryNow()}
          aria-label="Retry connection now"
          className="grid size-9 place-items-center rounded-full border-2 border-ink bg-card shadow-brutal-sm transition hover:-translate-y-0.5 active:translate-x-0.5 active:translate-y-0.5 active:shadow-none"
        >
          <RotateCw className="size-4" aria-hidden />
        </button>
      )}
    </div>
  )
}
