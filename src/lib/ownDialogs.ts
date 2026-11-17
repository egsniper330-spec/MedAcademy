/**
 * Own-dialog bookkeeping for the floating-window guard.
 *
 * WHY: Android reports the ACTIVITY's window focus, and a native dialog takes
 * that focus exactly like another app's floating window does. The app's own
 * dialogs (React Native's `<Modal>` and everything built on it) are therefore
 * indistinguishable from the outside, so the guard must know when one of OURS
 * is open — otherwise a simple confirm dialog would trip the security gate.
 *
 * A counter rather than a boolean: two stacked dialogs must not clear the flag
 * between them.
 */

let openCount = 0;

/** Mark one of our own dialog windows as open; returns the release function. */
export function registerOwnDialog(): () => void {
  openCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount = Math.max(0, openCount - 1);
  };
}

/** True while at least one of the app's own dialogs is showing. */
export function hasOwnDialogOpen(): boolean {
  return openCount > 0;
}

/** Test seam — restores the empty state (never called by app code). */
export function resetOwnDialogsForTests(): void {
  openCount = 0;
}
