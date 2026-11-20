import { useQueryClient } from '@tanstack/react-query'
import { commentaryQueryKey, matchQueryKey, matchesQueryKey } from '../lib/api.js'
import { applyScoreUpdate, clearScored, upsertMatch } from '../lib/matches.js'
import { useSocketMessages } from './hooks.js'

// How long a card shows its "Goal!" celebration
const SCORED_MS = 4000

// Keeps the cached match list, and the open match page's match and feed, in
// step with WebSocket broadcasts, so the UI re-renders from one source of
// truth whether data came over REST or WS
export function useLiveMatchUpdates() {
  const queryClient = useQueryClient()

  useSocketMessages((message) => {
    const data = message.data
    if (!data?.id) return

    // Each new feed line goes on top of that match's feed, if it's loaded
    if (message.type === 'commentary') {
      queryClient.setQueryData(commentaryQueryKey(data.matchId), (feed) =>
        feed ? [data, ...feed.filter((c) => c.id !== data.id)] : feed,
      )
      return
    }

    const match = data
    // The list and the single match get the same change; the single match is
    // a one-item list for the helpers
    const update = (fn) => {
      queryClient.setQueryData(matchesQueryKey, (list) => (list ? fn(list) : list))
      queryClient.setQueryData(matchQueryKey(match.id), (one) => (one ? fn([one])[0] : one))
    }

    switch (message.type) {
      case 'match_created':
      case 'status_change':
        update((list) => upsertMatch(list, match))
        break

      case 'score_update': {
        const at = Date.now()
        update((list) => applyScoreUpdate(list, match, at))
        setTimeout(() => update((list) => clearScored(list, match.id, at)), SCORED_MS)
        break
      }
    }
  })
}
