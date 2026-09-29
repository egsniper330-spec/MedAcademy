/**
 * vdoPlayerSession.ts
 *
 * DEV-ONLY VdoPlayer session observability (release builds: all no-ops).
 *
 * Why: VdoCipher documents that renderer/DRM errors (6120-class) correlate
 * with more than one active VdoPlayer. React-level guarantees (unmount on
 * blur, in-place fullscreen, no Modal) are enforced in code, but this counter
 * makes the actual invariant observable on a device: every native player
 * mount registers here, every unmount deregisters, and >1 concurrent
 * instance prints an explicit warning naming every live session.
 *
 * Scope note (honesty): this counts MOUNTED native player VIEWS — it does not
 * fabricate a release signal (the SDK releases decoder resources on unmount;
 * it exposes no public release event to hook). It proves the "at most one
 * mounted player" invariant at the layer we control.
 */

const mounted = new Set<string>();

export function playerSessionMount(tag: string): void {
  if (!__DEV__) return;
  mounted.add(tag);
  if (mounted.size > 1) {
    console.warn(
      `[vdo-sessions] ${mounted.size} native players mounted concurrently: ` +
        `${[...mounted].join(', ')} — VdoCipher documents renderer errors ` +
        `(e.g. 6120) with more than one active player.`,
    );
  } else {
    console.info(`[vdo-sessions] mount ${tag} (1 active)`);
  }
}

export function playerSessionUnmount(tag: string): void {
  if (!__DEV__) return;
  mounted.delete(tag);
  console.info(`[vdo-sessions] unmount ${tag} (${mounted.size} active)`);
}

/** Test hook. */
export function _resetPlayerSessionsForTests(): void {
  mounted.clear();
}
