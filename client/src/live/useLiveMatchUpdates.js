import { useQueryClient } from '@tanstack/react-query'
import { matchesQueryKey } from '../lib/api.js'
import { applyScoreUpdate, clearScored, upsertMatch } from '../lib/matches.js'
import { useSocketMessages } from './hooks.js'

// How long a card shows its "Goal!" celebration
const SCORED_MS = 4000

// Keeps the cached match list in step with WebSocket broadcasts, so the
// grid re-renders from one source of truth whether data came over REST or WS
export function useLiveMatchUpdates() {
  const queryClient = useQueryClient()

  useSocketMessages((message) => {
    const match = message.data
    if (!match?.id) return

    const update = (fn) => queryClient.setQueryData(matchesQueryKey, (list) => (list ? fn(list) : list))

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
