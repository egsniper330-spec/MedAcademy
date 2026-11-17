#!/usr/bin/env node
/**
 * Regression: a Doctor deleting a PUBLISHED course got "Internal Server Error".
 *
 * Root cause: credit_transactions.course_id is a NULLABLE RESTRICT foreign key.
 * A published course always has at least one credit transaction (the enrollment
 * that paid for it), so `DELETE FROM courses` raised an FK violation and the
 * request died as a 500. Draft courses have no such rows, which is why only
 * published courses failed.
 *
 * The fix must (a) detach the ledger rows WITHOUT deleting them, (b) keep the
 * whole cascade transactional, and (c) answer with a real error instead of a 500.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const controller = fs.readFileSync(
  path.join(__dirname, '..', 'backend', 'src', 'Controllers', 'CourseController.php'),
  'utf8',
);
const deleteFn = controller.slice(controller.indexOf('public function deleteCourse'));

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    console.error(`  \u2717 ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
};

console.log('The published-course delete path');

check('credit transactions are detached before the course row is deleted', () => {
  const detach = deleteFn.indexOf('UPDATE credit_transactions SET course_id = NULL WHERE course_id = ?');
  const dropCourse = deleteFn.indexOf('DELETE FROM courses WHERE id = ?');
  assert.ok(detach > -1, 'the ledger rows must be detached from the course');
  assert.ok(dropCourse > -1, 'the course row is still deleted');
  assert.ok(detach < dropCourse, 'the detach must run BEFORE the DELETE (FK order)');
});

check('financial history is preserved, not deleted', () => {
  assert.ok(!/DELETE FROM credit_transactions/.test(deleteFn), 'credit transactions are accounting records');
});

check('the cascade stays in one transaction', () => {
  assert.match(deleteFn, /\$db->transaction\(function \(Database \$db\)/);
  assert.match(deleteFn, /DELETE FROM lessons WHERE course_id = \?/);
  assert.match(deleteFn, /DELETE FROM sections WHERE course_id = \?/);
  assert.match(deleteFn, /DELETE FROM enrollments WHERE course_id = \?/);
  assert.match(deleteFn, /DELETE FROM video_uploads WHERE course_id = \?/);
});

check('a remaining constraint answers 409 with a message, never a bare 500', () => {
  assert.match(deleteFn, /catch \(\\Throwable \$e\)/);
  assert.match(deleteFn, /throw new ApiException\(409,/);
});

check('ownership is still enforced before anything is deleted', () => {
  assert.match(deleteFn, /\$this->assertCourseOwner\(\$request, \$id\);/);
});

console.log('\nDuplicating a course keeps its videos');

check('the duplicate insert copies video_id instead of nulling it', () => {
  const dup = controller.slice(controller.indexOf('public function duplicate'));
  assert.match(dup, /\$lesson\['video_id'\] \?\? null/);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
