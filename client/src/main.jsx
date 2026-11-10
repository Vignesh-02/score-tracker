import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'motion/react'
import './index.css'
import App from './App.jsx'
import { LiveSocketProvider } from './live/LiveSocketProvider.jsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Live changes arrive over the WebSocket, so there's no need to refetch
      // on every window focus; a reconnect triggers a refetch instead
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      retry: 2,
    },
  },
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LiveSocketProvider>
        {/* Respects the OS "reduce motion" setting for every animation */}
        <MotionConfig reducedMotion="user">
          <App />
        </MotionConfig>
      </LiveSocketProvider>
    </QueryClientProvider>
  </StrictMode>,
)
