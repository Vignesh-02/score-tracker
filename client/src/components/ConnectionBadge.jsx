import { useEffect, useState } from 'react'
import { RotateCw, WifiOff } from 'lucide-react'
import { useConnectionStatus, useLiveSocket } from '../live/hooks.js'

// Only problems are shown: while connected there's nothing to say
const STYLES = {
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

// Every page load starts out "connecting" for a moment; only say so if it drags on
const SHOW_CONNECTING_AFTER_MS = 3000

function useSlowConnect(status) {
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    if (status !== 'connecting') return
    const timer = setTimeout(() => setSlow(true), SHOW_CONNECTING_AFTER_MS)
    return () => {
      clearTimeout(timer)
      setSlow(false)
    }
  }, [status])

  return slow
}

export function ConnectionBadge() {
  const { status, retryAt } = useConnectionStatus()
  const socket = useLiveSocket()
  const slowConnect = useSlowConnect(status)

  if (status === 'open' || (status === 'connecting' && !slowConnect)) return null

  const { dot, label } = STYLES[status]
  const waitingToRetry = retryAt != null

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
