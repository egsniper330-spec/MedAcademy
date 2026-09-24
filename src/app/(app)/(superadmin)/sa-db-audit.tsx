/**
 * Super Admin shell wrapper for the shared Database Audit screen.
 *
 * `backTo` is the terminal fallback for the header back arrow when there is no
 * history to pop; hub entry pops back to the pushing hub.
 */
import DbAuditPanel from '@/app/(app)/(admin)/db-audit';

export default function SuperAdminDbAudit() {
  return <DbAuditPanel backTo="/sa-platform" />;
}
