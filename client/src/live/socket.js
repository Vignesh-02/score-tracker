// One WebSocket connection for the whole app. It reconnects with backoff,
// re-sends match subscriptions after every reconnect, and reports its status
// so the UI can show Live / Reconnecting / Offline.
//
// It lives outside React on purpose: components come and go, the connection
// should not.

const WS_PATH = '/ws'

// The server allows 5 connection attempts per IP every 2s, so retries start at
// 1s and double up to 30s. Jitter spreads out many tabs reconnecting at once.
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30_000

function wsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${WS_PATH}`
}

function backoffDelay(attempt) {
  const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
  return delay / 2 + Math.random() * (delay / 2)
}

export function createLiveSocket({ url = wsUrl } = {}) {
  let socket = null
  let attempt = 0
  let retryTimer = null
  let stopTimer = null
  let started = false
  let hasConnectedBefore = false

  // matchId -> number of components currently interested in it
  const subscriptions = new Map()
  const messageListeners = new Set()
  const reconnectListeners = new Set()
  const statusListeners = new Set()

  // 'connecting' (first attempt), 'open', 'reconnecting', 'offline'
  let state = { status: 'connecting', retryAt: null }

  function setState(next) {
    state = { ...state, ...next }
    statusListeners.forEach((listener) => listener())
  }

  function send(payload) {
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(payload))
    return true
  }

  function connect() {
    clearTimeout(retryTimer)
    retryTimer = null

    if (!navigator.onLine) {
      setState({ status: 'offline', retryAt: null })
      return
    }

    setState({ status: hasConnectedBefore ? 'reconnecting' : 'connecting', retryAt: null })

    const ws = new WebSocket(url())
    socket = ws

    ws.onopen = () => {
      attempt = 0
      setState({ status: 'open', retryAt: null })

      // The server forgets subscriptions when a socket closes, so send them again
      for (const matchId of subscriptions.keys()) {
        send({ type: 'subscribe', matchId })
      }

      // Updates sent while we were disconnected are lost; let the app refetch
      if (hasConnectedBefore) reconnectListeners.forEach((listener) => listener())
      hasConnectedBefore = true
    }

    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      messageListeners.forEach((listener) => listener(message))
    }

    // onerror is always followed by onclose, so retrying is handled there
    ws.onclose = () => {
      if (socket !== ws) return // an old socket we replaced or stopped
      socket = null
      if (started) scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (!navigator.onLine) {
      setState({ status: 'offline', retryAt: null })
      return
    }

    const delay = backoffDelay(attempt++)
    setState({ status: hasConnectedBefore ? 'reconnecting' : 'connecting', retryAt: Date.now() + delay })
    retryTimer = setTimeout(connect, delay)
  }

  // Coming back online should reconnect right away, not wait out the backoff
  function handleOnline() {
    if (!started || socket) return
    attempt = 0
    connect()
  }

  function handleOffline() {
    if (!started) return
    clearTimeout(retryTimer)
    retryTimer = null
    setState({ status: 'offline', retryAt: null })
  }

  return {
    start() {
      // React's StrictMode mounts, unmounts and remounts in development.
      // Cancelling a pending stop keeps that from opening a second socket.
      clearTimeout(stopTimer)
      stopTimer = null
      if (started) return

      started = true
      window.addEventListener('online', handleOnline)
      window.addEventListener('offline', handleOffline)
      connect()
    },

    stop() {
      clearTimeout(stopTimer)
      stopTimer = setTimeout(() => {
        started = false
        clearTimeout(retryTimer)
        window.removeEventListener('online', handleOnline)
        window.removeEventListener('offline', handleOffline)

        const ws = socket
        socket = null
        ws?.close()
      }, 0)
    },

    // Reconnect now instead of waiting for the next retry (the badge's "Retry")
    retryNow() {
      if (!started || socket) return
      attempt = 0
      connect()
    },

    subscribe(matchId) {
      const count = subscriptions.get(matchId) ?? 0
      subscriptions.set(matchId, count + 1)
      if (count === 0) send({ type: 'subscribe', matchId })
    },

    unsubscribe(matchId) {
      const count = subscriptions.get(matchId) ?? 0
      if (count <= 1) {
        subscriptions.delete(matchId)
        send({ type: 'unsubscribe', matchId })
      } else {
        subscriptions.set(matchId, count - 1)
      }
    },

    onMessage(listener) {
      messageListeners.add(listener)
      return () => messageListeners.delete(listener)
    },

    onReconnect(listener) {
      reconnectListeners.add(listener)
      return () => reconnectListeners.delete(listener)
    },

    // For useSyncExternalStore
    subscribeStatus(listener) {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },

    getState() {
      return state
    },
  }
}
