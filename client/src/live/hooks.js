import { useContext, useEffect, useRef, useSyncExternalStore } from 'react'
import { LiveSocketContext } from './context.js'

function useLiveSocketContext() {
  const socket = useContext(LiveSocketContext)
  if (!socket) throw new Error('Live socket hooks must be used inside <LiveSocketProvider>')
  return socket
}

// The socket itself, for actions like retryNow()
export function useLiveSocket() {
  return useLiveSocketContext()
}

// { status: 'connecting' | 'open' | 'reconnecting' | 'offline', retryAt }
export function useConnectionStatus() {
  const socket = useLiveSocketContext()
  return useSyncExternalStore(socket.subscribeStatus, socket.getState)
}

// Calls handler for every message from the server. The latest handler is
// always used, so callers don't need to memoise it.
export function useSocketMessages(handler) {
  const socket = useLiveSocketContext()
  const handlerRef = useRef(handler)

  useEffect(() => {
    handlerRef.current = handler
  })

  useEffect(() => socket.onMessage((message) => handlerRef.current(message)), [socket])
}

// Subscribes to score_update and commentary messages for every match in
// matchIds, adding and dropping subscriptions as the list changes. The app
// subscribes to all live matches, not just the cards on screen: the server
// doesn't resend the current score on subscribe, so a match left unsubscribed
// while another tab is open would show an old score when you come back.
export function useMatchSubscriptions(matchIds) {
  const socket = useLiveSocketContext()
  const subscribed = useRef(new Set())
  const key = [...new Set(matchIds)].sort((a, b) => a - b).join(',')

  useEffect(() => {
    const next = new Set(key ? key.split(',').map(Number) : [])
    for (const id of next) if (!subscribed.current.has(id)) socket.subscribe(id)
    for (const id of subscribed.current) if (!next.has(id)) socket.unsubscribe(id)
    subscribed.current = next
  }, [socket, key])

  useEffect(
    () => () => {
      for (const id of subscribed.current) socket.unsubscribe(id)
      subscribed.current = new Set()
    },
    [socket],
  )
}
