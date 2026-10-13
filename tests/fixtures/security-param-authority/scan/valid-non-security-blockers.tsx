/**
 * VALID FIXTURE — regression pin for the pattern bug this guard shipped with on
 * its first run: `/^blocks?[A-Z]/i` matched the *course-publish* concept
 * "blockers", because under /i the `[A-Z]` matched a lowercase letter. A
 * publish-workflow list is not a device-security decision, and flagging it is the
 * kind of false positive that destroys trust in the guard.
 *
 * EXPECTED: no violations.
 */
import { useLocalSearchParams } from 'expo-router';

export default function CourseBuilder() {
  const params = useLocalSearchParams<{ blockers: string; id: string }>();

  const blockers = JSON.parse(params.blockers ?? '[]');

  return { id: params.id, blockers };
}
