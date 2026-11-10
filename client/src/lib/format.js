const DAY_MS = 24 * 60 * 60 * 1000

const timeOnly = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const dayAndTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

const startOfDay = (time) => new Date(time).setHours(0, 0, 0, 0)

// "15:30", "Tomorrow 15:30", "Yesterday 20:00" or "Sat 8 Nov, 15:30"
export function formatKickoff(iso, now) {
  if (!iso) return 'Time to be confirmed'

  const date = new Date(iso)
  const days = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS)

  if (days === 0) return timeOnly.format(date)
  if (days === 1) return `Tomorrow ${timeOnly.format(date)}`
  if (days === -1) return `Yesterday ${timeOnly.format(date)}`
  return dayAndTime.format(date)
}

// "in 45m", "in 2h 15m", "in 3d"
export function formatCountdown(iso, now) {
  const ms = new Date(iso).getTime() - now
  if (ms <= 0) return 'starting'

  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`

  return `in ${Math.round(hours / 24)}d`
}
