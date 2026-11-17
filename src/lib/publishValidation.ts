/**
 * Publish validation for a lesson's video — the ONE rule the course builder
 * uses both for its local pre-check and for the fresh-data re-check.
 *
 * ROOT CAUSE of "the lesson has no video" on a lesson that clearly has one:
 * the builder tested `l.youtube_video_id`, a field that does not exist. A
 * YouTube lesson is stored by the lesson editor and returned by the API in
 * `video_id` (the same column every provider uses), so a saved YouTube lesson
 * always looked empty and publishing was refused. `youtube_video_id` is still
 * honoured for older cached payloads.
 */

/** A YouTube id is 11 URL-safe characters; a full URL is also accepted. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_URL = /(?:youtube\.com|youtu\.be)\//i;

export type LessonVideoShape = {
  video_type?: string | null;
  video_id?: string | null;
  youtube_video_id?: string | null;
  video_status?: string | null;
  video_upload_id?: string | null;
  video_asset_id?: string | null;
};

function nonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** True when `value` is a usable YouTube reference (id or supported URL). */
export function isYoutubeReference(value: unknown): boolean {
  const v = nonEmpty(value);
  if (v === '') return false;
  return YOUTUBE_ID.test(v) || YOUTUBE_URL.test(v);
}

/**
 * The provider a lesson actually plays from. `video_type` wins; a legacy row
 * with no type but a YouTube-shaped reference is treated as YouTube rather than
 * falling through to the retired provider branch.
 */
export function lessonVideoType(lesson: LessonVideoShape | null | undefined): string {
  const declared = nonEmpty(lesson?.video_type).toLowerCase();
  if (declared !== '') return declared;
  if (isYoutubeReference(lesson?.video_id) || isYoutubeReference(lesson?.youtube_video_id)) {
    return 'youtube';
  }
  return 'coming_soon';
}

/**
 * Does this lesson carry playable video? Deliberately strict: an empty lesson
 * still fails (publishing must not be weakened), but every accepted YouTube
 * reference counts, whether it arrived as `video_id` or `youtube_video_id`.
 */
export function lessonHasVideo(lesson: LessonVideoShape | null | undefined): boolean {
  if (!lesson) return false;
  const type = lessonVideoType(lesson);

  if (type === 'coming_soon') return true;
  if (type === 'youtube') {
    return isYoutubeReference(lesson.video_id) || isYoutubeReference(lesson.youtube_video_id);
  }
  // Retired provider / uploaded asset rows: an id, a ready upload, or a linked
  // upload/asset record.
  return Boolean(
    nonEmpty(lesson.video_id)
    || nonEmpty(lesson.video_upload_id)
    || nonEmpty(lesson.video_asset_id)
    || lesson.video_status === 'ready',
  );
}
