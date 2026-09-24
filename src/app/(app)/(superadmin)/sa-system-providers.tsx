/**
 * Super Admin shell wrapper for the shared System Diagnostics screen ("System
 * Diagnostics" in the Platform hub). `backTo` supplies the explicit ← Platform
 * header action — the SA shell is a tab navigator, so there is no stack to pop.
 */
import SystemDiagnosticsScreen from '@/app/(app)/(admin)/system-providers';

export default function SuperAdminSystemDiagnostics() {
  return <SystemDiagnosticsScreen backTo="/sa-platform" />;
}
