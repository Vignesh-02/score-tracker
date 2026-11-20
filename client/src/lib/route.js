import { useEffect, useState } from 'react'

// A tiny router for the app's two kinds of page: the match list (/, with its
// tab and filters in the query string) and one match (/match/123). Nginx and
// Vite serve index.html for both, so links and refreshes work.

const MATCH_PATH = /^\/match\/(\d+)\/?$/

export const matchPath = (id) => `/match/${id}`

function readRoute() {
  const found = window.location.pathname.match(MATCH_PATH)
  return { matchId: found ? Number(found[1]) : null }
}

// Pages opened inside the app carry this, so "back" knows it can go back
const IN_APP = { inApp: true }

export function navigate(url) {
  window.history.pushState(IN_APP, '', url)
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo(0, 0)
}

// Back to where the visitor came from in the app, or to the list if they
// arrived straight on this page (e.g. from a shared link)
export function goBack() {
  if (window.history.state?.inApp) window.history.back()
  else navigate('/')
}

// For <a href> links handled by the app: plain clicks stay in the app;
// ctrl/cmd/shift/middle-click still open a new tab as usual
export function onAppLinkClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  navigate(e.currentTarget.getAttribute('href'))
}

export function useRoute() {
  const [route, setRoute] = useState(readRoute)

  useEffect(() => {
    const onPopState = () => setRoute(readRoute())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  return route
}
