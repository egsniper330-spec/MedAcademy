/**
 * Device presence heartbeat — keeps `devices.last_active_at` truthful while the
 * app is actually in use, so "online" stops meaning "logged in at some point".
 *
 * DESIGN CONSTRAINTS (all deliberate)
 * -----------------------------------
 * • FOREGROUND ONLY. iOS/Android suspend or kill a backgrounded app; a timer that
 *   pretends otherwise would just be silenced by the OS. The interval runs while
 *   `AppState === 'active'` and is cleared the moment the app leaves it. A
 *   backgrounded device therefore ages out of the online window naturally and is
 *   shown as "offline (inferred)" with its last CONFIRMED time — which is the
 *   honest answer, not a guess at when it actually went offline.
 * • CHEAP. One POST per interval (default 60 s, matching the backend policy),
 *   ±10% jitter so a fleet of devices does not beat in lockstep. No polling, no
 *   payload, no audit rows.
 * • FIRST BEAT ON RESUME. Coming back to the foreground beats immediately
 *   instead of waiting up to a minute.
 * • FAILURES ARE NOT OFFLINE. A failed beat only widens the retry interval
 *   (exponential, capped at 5 minutes). Presence is never derived from a request
 *   outcome, so a flaky network cannot make the Super Admin view claim a device
 *   went offline.
 * • NO DOUBLE BEATS. While a request is in flight the timer does not start
 *   another one; the backend write is monotonic anyway, so retries/duplicates can
 *   never move the timestamp backwards.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { sendDeviceHeartbeat } from '@/lib/api';
import { PRESENCE_HEARTBEAT_INTERVAL_MS, setServerClock } from '@/lib/devicePresence';

const MAX_BACKOFF_MS = 5 * 60_000;

/** ±10% jitter keeps many devices from posting on the same second. */
function withJitter(ms: number): number {
  const spread = ms * 0.1;
  return Math.round(ms - spread + Math.random() * spread * 2);
}

/**
 * Start the presence heartbeat for the signed-in session.
 *
 * `userId` is the dependency: mounting this under the authenticated shell means
 * the timer starts after login and stops on sign-out/unmount.
 */
export function useDeviceHeartbeat(userId?: string | null): void {
  useEffect(() => {
    if (!userId) return;

    let stopped = false;
    let inFlight = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unbound = false;

    const clear = () => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
    };

    const schedule = (delay: number) => {
      if (stopped || unbound) return;
      clear();
      timer = setTimeout(() => { void beat(); }, withJitter(delay));
    };

    const beat = async () => {
      if (stopped || unbound || inFlight) return;
      inFlight = true;
      try {
        const res = await sendDeviceHeartbeat();
        // Anchor the shared clock so every screen measures elapsed time against
        // the server, not against this device's (possibly wrong) clock.
        setServerClock(res?.server_epoch_ms);
        failures = 0;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e ?? '');
        // A session that is not device-bound (older build, web) will never
        // succeed — stop instead of retrying forever.
        if (/not bound to a device|device_unbound/i.test(message)) unbound = true;
        else failures = Math.min(failures + 1, 5);
      } finally {
        inFlight = false;
        if (!unbound) {
          const backoff = failures === 0
            ? PRESENCE_HEARTBEAT_INTERVAL_MS
            : Math.min(PRESENCE_HEARTBEAT_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
          schedule(backoff);
        }
      }
    };

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        // Immediate beat on resume; do not wait out the interval.
        clear();
        void beat();
      } else {
        // Backgrounded/inactive: no timer at all. The OS may suspend the app.
        clear();
      }
    });

    if (AppState.currentState === 'active') void beat();

    return () => {
      stopped = true;
      clear();
      subscription.remove();
    };
  }, [userId]);
}
