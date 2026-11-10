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

// Subscribes to a match's score_update and commentary messages while the
// calling component is mounted. Pass null to subscribe to nothing.
export function useMatchSubscription(matchId) {
  const socket = useLiveSocketContext()

  useEffect(() => {
    if (matchId == null) return
    socket.subscribe(matchId)
    return () => socket.unsubscribe(matchId)
  }, [socket, matchId])
}
