/**
 * Publish validation for a lesson's video — the ONE rule the course builder
 * uses both for its local pre-check and for the fresh-data re-check.
 *
 * ROOT CAUSE #1 (first report): the builder tested `l.youtube_video_id`, a field
 * that does not exist on the rows it read. A YouTube lesson is stored by the
 * lesson editor in `video_id` (the same column every provider uses), so a saved
 * YouTube lesson always looked empty and publishing was refused.
 *
 * ROOT CAUSE #2 (still reproducible after the first fix): the check trusted the
 * DECLARED `video_type` first. A lesson created before the editor forced the
 * type — or created with the retired default and given a YouTube URL — keeps
 * `video_type` = the retired provider while the reference the doctor actually
 * entered sits in `youtube_video_id` (and/or a URL in `video_id`). Declared type
 * won, the branch fell through to the "uploaded asset" test, every id field was
 * empty, and publishing was refused for a lesson that plainly has a video.
 *
 * THE RULE (order matters):
 *   1. `coming_soon` is an intentional placeholder — always publishable.
 *   2. A usable YouTube reference in EITHER field is publishable, whatever the
 *      declared type says. The editor normalises both fields on save, so this
 *      also covers every record written before the normalisation existed.
 *   3. Otherwise the declared type decides, and an empty field still fails:
 *      publishing is not weakened.
 */

/** A YouTube id is 11 URL-safe characters; a full URL is also accepted. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_URL = /(?:youtube(?:-nocookie)?\.com|youtu\.be)\//i;

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
 * The provider a lesson actually plays from.
 *
 * `coming_soon` wins (it is a deliberate placeholder), then an actual YouTube
 * reference in either field — the reference the doctor entered is stronger
 * evidence than a stale `video_type` — and only then the declared type.
 */
export function lessonVideoType(lesson: LessonVideoShape | null | undefined): string {
  const declared = nonEmpty(lesson?.video_type).toLowerCase();
  if (declared === 'coming_soon') return 'coming_soon';
  if (isYoutubeReference(lesson?.youtube_video_id) || isYoutubeReference(lesson?.video_id)) {
    return 'youtube';
  }
  if (declared !== '') return declared;
  return 'coming_soon';
}

/**
 * Does this lesson carry playable video? Deliberately strict: an empty lesson
 * still fails (publishing must not be weakened), but every accepted YouTube
 * reference counts, whether it arrived as `video_id` or `youtube_video_id` and
 * whatever `video_type` claims.
 */
export function lessonHasVideo(lesson: LessonVideoShape | null | undefined): boolean {
  if (!lesson) return false;
  const type = lessonVideoType(lesson);

  if (type === 'coming_soon') return true;
  if (type === 'youtube') {
    return isYoutubeReference(lesson.video_id) || isYoutubeReference(lesson.youtube_video_id);
  }
  // Uploaded asset / legacy provider rows: an id, a ready upload, or a linked
  // upload/asset record.
  return Boolean(
    nonEmpty(lesson.video_id)
    || nonEmpty(lesson.video_upload_id)
    || nonEmpty(lesson.video_asset_id)
    || lesson.video_status === 'ready',
  );
}
