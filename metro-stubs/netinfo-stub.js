/**
 * netinfo-stub.js — web no-op for @react-native-community/netinfo
 *
 * WHY THIS EXISTS:
 *   @react-native-community/netinfo's nativeInterface.js checks for
 *   NativeModules.RNCNetInfo at module-evaluation time and throws a hard
 *   Error when it is null (which it always is on web/preview).  That throw
 *   propagates up through SecurityContext.tsx → _layout.tsx and kills the
 *   entire JS startup before React renders a single component, producing a
 *   completely white screen in the preview and a completely black screen on
 *   iOS (New Architecture swallows the uncaught render-time error silently).
 *
 * API surface required by the app:
 *   • NetInfo.addEventListener(listener) — used in SecurityContext for
 *     network-reconnect security re-checks (returns an unsubscribe fn)
 *   • NetInfo.fetch() — used in nativeSecurity.ts to check connectivity
 *     before running Stage-2 security checks
 *
 * Web behaviour:
 *   • addEventListener — returns a no-op unsubscribe; never fires on web
 *     (security re-checks are still triggered by AppState / timers).
 *   • fetch() — resolves with isConnected:true so security checks proceed
 *     normally on web (they are already safe/no-op via Platform guards).
 */

'use strict';

const noopUnsubscribe = () => {};

const NetInfoStub = {
  addEventListener: (_listener) => noopUnsubscribe,
  fetch: async () => ({
    type: 'wifi',
    isConnected: true,
    isInternetReachable: true,
    details: null,
  }),
  configure: (_config) => {},
  refresh: async () => ({
    type: 'wifi',
    isConnected: true,
    isInternetReachable: true,
    details: null,
  }),
  useNetInfo: () => ({
    type: 'wifi',
    isConnected: true,
    isInternetReachable: true,
    details: null,
  }),
};

module.exports = NetInfoStub;
module.exports.default = NetInfoStub;
