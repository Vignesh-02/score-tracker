// "just now", "12 min ago", "3 h ago"
export function updatedAgo(iso, now = Date.now()) {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.round(minutes / 60)} h ago`
}
