import { useEffect, useState } from 'react'
import { RotateCw, WifiOff } from 'lucide-react'
import { useConnectionStatus, useLiveSocket } from '../live/hooks.js'

const STYLES = {
  open: { dot: 'bg-ok shadow-[0_0_8px_var(--color-ok)]', label: 'Live feed' },
  connecting: { dot: 'bg-warn animate-pulse', label: 'Connecting' },
  reconnecting: { dot: 'bg-warn animate-pulse', label: 'Reconnecting' },
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

  return <span className="font-mono text-xs font-medium normal-case tracking-normal text-muted">retry {seconds}s</span>
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
        className="flex items-center gap-2.5 rounded-md border border-line bg-board px-3 py-2 text-sm font-bold tracking-[0.15em] uppercase"
      >
        {status === 'offline' ? (
          <WifiOff className="size-4 text-live" aria-hidden />
        ) : (
          <span className={`size-2 rounded-full ${dot}`} aria-hidden />
        )}
        <span>{label}</span>
        {waitingToRetry && <RetryCountdown key={retryAt} retryAt={retryAt} />}
      </div>

      {waitingToRetry && (
        <button
          type="button"
          onClick={() => socket.retryNow()}
          aria-label="Retry connection now"
          className="grid size-9 place-items-center rounded-md border border-line bg-board text-amber transition hover:border-amber"
        >
          <RotateCw className="size-4" aria-hidden />
        </button>
      )}
    </div>
  )
}
