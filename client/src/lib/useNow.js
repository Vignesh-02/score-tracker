import { useSyncExternalStore } from 'react'

// One shared clock for countdowns like "in 2h 15m". Ticks every 30s while
// any component is using it, instead of one timer per card.
const TICK_MS = 30_000

const listeners = new Set()
let now = Date.now()
let timer = null

function subscribe(listener) {
  listeners.add(listener)

  if (!timer) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      listeners.forEach((l) => l())
    }, TICK_MS)
  }

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearInterval(timer)
      timer = null
    }
  }
}

const getSnapshot = () => now

export function useNow() {
  return useSyncExternalStore(subscribe, getSnapshot)
}
