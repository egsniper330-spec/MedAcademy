/**
 * labels.ts — enum value → translation key helpers.
 *
 * Stored values (course status, difficulty, …) are machine-readable and must
 * never change. Only the *printed* label is localized, so every screen can show
 * a translated chip while the API payload keeps the original token.
 *
 * Unknown values fall back to the raw token rather than a `ns.key` string, so a
 * new backend status degrades to something readable.
 */

const COURSE_STATUS_KEYS: Record<string, string> = {
  published: 'courseStatus.published',
  hidden: 'courseStatus.hidden',
  draft: 'courseStatus.draft',
  archived: 'courseStatus.archived',
};

const DIFFICULTY_KEYS: Record<string, string> = {
  beginner: 'difficulty.beginner',
  intermediate: 'difficulty.intermediate',
  advanced: 'difficulty.advanced',
  all_levels: 'difficulty.allLevels',
};

const STATUS_KEYS: Record<string, string> = {
  active: 'status.active',
  suspended: 'status.suspended',
  pending: 'status.pending',
  expired: 'status.expired',
  blocked: 'status.blocked',
  deleted: 'status.deleted',
  trashed: 'status.trashed',
};

/** Account / enrollment / subscription status chip label. */
export function statusLabel(status: string, t: (key: string) => string): string {
  const key = STATUS_KEYS[status];
  return key ? t(key) : status;
}

export function courseStatusKey(status: string): string | null {
  return COURSE_STATUS_KEYS[status] ?? null;
}

export function courseStatusLabel(
  status: string,
  t: (key: string) => string,
): string {
  const key = courseStatusKey(status);
  return key ? t(key) : status;
}

export function difficultyLabel(
  difficulty: string,
  t: (key: string) => string,
): string {
  const key = DIFFICULTY_KEYS[difficulty];
  return key ? t(key) : difficulty.replace(/_/g, ' ');
}
