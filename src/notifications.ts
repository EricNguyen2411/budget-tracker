/**
 * Being upfront about a real platform limitation: iOS Safari has no
 * reliable way to deliver a notification at a specific future time while
 * the app isn't open — that needs a real backend push server, which this
 * app deliberately doesn't have (no server at all, by design). What
 * follows is the honest alternative: check how long it's been since you
 * last logged something, and if it's been a while, nudge you the moment
 * you next open the app. Not a scheduled reminder — an on-open one.
 */

const LAST_TX_CHECK_KEY = 'budget-tracker-last-nudge-check'

export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false
  const result = await Notification.requestPermission()
  return result === 'granted'
}

export function notificationPermissionStatus(): NotificationPermission | 'unsupported' {
  if (!('Notification' in window)) return 'unsupported'
  return Notification.permission
}

/** Call once per app open. If enabled, permitted, and it's been long enough
 * since the most recent transaction, shows an immediate notification. */
export function checkInAppNudge(mostRecentTransactionDate: Date | null, enabled: boolean, thresholdDays: number) {
  if (!enabled || Notification.permission !== 'granted') return
  if (!mostRecentTransactionDate) return

  const today = new Date().toDateString()
  const lastCheck = localStorage.getItem(LAST_TX_CHECK_KEY)
  if (lastCheck === today) return // only once per day, not every reopen

  const daysSince = (Date.now() - mostRecentTransactionDate.getTime()) / (1000 * 60 * 60 * 24)
  if (daysSince >= thresholdDays) {
    new Notification('Budget Tracker', {
      body: `It's been ${Math.floor(daysSince)} days since your last logged transaction — anything to add?`,
      icon: '/budget-tracker/icon-192.png'
    })
  }
  localStorage.setItem(LAST_TX_CHECK_KEY, today)
}
