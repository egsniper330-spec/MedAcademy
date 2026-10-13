/**
 * FAIL-CLOSED FIXTURE — a screen that reads no route params at all. Scanning a
 * tree made only of files like this must FAIL rather than pass: a guard that
 * analysed nothing has proved nothing, and reporting success there is the
 * "control that never ran presented as satisfied" failure mode.
 *
 * EXPECTED: the guard exits non-zero with "cannot have been exercised".
 */
export default function PlainScreen() {
  return null;
}
