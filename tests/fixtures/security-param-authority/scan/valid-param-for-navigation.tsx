/**
 * VALID FIXTURE — route params used for what they are for: identity, navigation
 * and display-only data. Params are not banned; only security decisions are.
 *
 * EXPECTED: no violations.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';

export default function CourseScreen() {
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const router      = useRouter();

  const openLesson = () => router.push({ pathname: '/lesson/[id]', params: { id } });

  // A param-derived alias used only to build a link must not be flagged either.
  const courseRef = id;

  return { id, tab, courseRef, openLesson };
}
