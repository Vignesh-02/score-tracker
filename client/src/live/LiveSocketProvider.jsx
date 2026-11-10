import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LiveSocketContext } from './context.js'
import { createLiveSocket } from './socket.js'

export function LiveSocketProvider({ children }) {
  const [socket] = useState(() => createLiveSocket())
  const queryClient = useQueryClient()

  useEffect(() => {
    socket.start()

    // Anything broadcast while we were disconnected was missed, so refetch
    const offReconnect = socket.onReconnect(() => queryClient.invalidateQueries())

    return () => {
      offReconnect()
      socket.stop()
    }
  }, [socket, queryClient])

  return <LiveSocketContext.Provider value={socket}>{children}</LiveSocketContext.Provider>
}
