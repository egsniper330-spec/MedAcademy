'use strict';
/**
 * Regression guard — uploaded lesson materials must actually reach the student.
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 * A doctor uploaded a PDF to a lesson, the upload succeeded and a correctly
 * associated `lesson_materials` row existed, but the student's lesson/video
 * screen never showed it.
 *
 * Root cause: the PHP Data API resolves embedded one-to-many relations with a
 * BATCHED fan-out. It kept ONE rolling `$parentIds` across the relation loop and
 * replaced it with each relation's CHILD ids, so the second and later SIBLINGS
 * at the same depth queried their foreign key against the wrong ids. For the
 * lesson select (`…, lesson_pdfs(*), lesson_materials(*)`) the materials query
 * ran as `lesson_id IN (<lesson_pdfs.id>)` and always came back empty. A linear
 * chain (sections → lessons → lesson_materials) was unaffected, which is why
 * only the lesson/video screens lost the materials.
 *
 * Also pinned here:
 *   • the per-material download policy (`allow` / `preview_only` / `hidden` /
 *     `disabled`) is enforced on the SERVER when a signed URL is minted, and
 *     respected by the student screen;
 *   • a suspended enrollment is not access;
 *   • unpublished lessons/courses are not delivered;
 *   • the upload content policy (size + blocked types) exists on the server with
 *     an identical client mirror, so the doctor gets a real reason.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ' + msg); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const DATA = 'backend/src/Controllers/DataController.php';
const STORE = 'backend/src/Controllers/StorageController.php';
const STORAGE = 'backend/src/Storage/StorageService.php';
const STUDENT = 'src/app/(app)/lesson/[id].tsx';
const EDITOR = 'src/app/(app)/lesson-editor/[id].tsx';
const HELPER = 'src/lib/lessonMaterials.ts';

/* ─────────────────── 1. the fan-out root cause (behavioural) ─────────────── */

console.log('── One-to-many fan-out: sibling relations keep their own parent set ──');

/**
 * Faithful model of the DataController read loop. `fetchChildren(rel, ids)` is
 * the (parent-ids → child rows) query the controller performs. Two variants:
 *   'old' = the single rolling $parentIds (the bug),
 *   'new' = per-relation parent set derived from depth / parentRelIndex.
 */
function fanOut(variant, mainIds, rels, childrenOf) {
  const levelData = {};
  let parentIds = mainIds;
  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i];
    if (variant === 'new') {
      if ((rel.depth ?? 1) === 1) parentIds = mainIds;
      else {
        const groups = levelData[rel.parentRelIndex] ?? {};
        parentIds = [];
        for (const g of Object.values(groups)) for (const k of Object.keys(g)) parentIds.push(k);
      }
    }
    if (!parentIds.length) { levelData[i] = {}; continue; }
    const keyed = {};
    for (const row of childrenOf(rel, parentIds)) {
      (keyed[row[rel.fkCol]] ||= {})[row.id] = row;
    }
    levelData[i] = keyed;
    if (variant === 'old') {
      const next = [];
      for (const g of Object.values(keyed)) next.push(...Object.keys(g));
      parentIds = next;
    }
  }
  return levelData;
}

{
  // Fixture: ONE lesson, no pdfs, one material — exactly the reported case.
  const lessonId = 'L1';
  const materials = [{ id: 'M1', lesson_id: lessonId, file_name: 'lecture.pdf' }];
  const pdfs = [];
  const rels = [
    { alias: 'lesson_pdfs', fkCol: 'lesson_id', depth: 1 },
    { alias: 'lesson_materials', fkCol: 'lesson_id', depth: 1 },
  ];
  const childrenOf = (rel, ids) =>
    (rel.alias === 'lesson_pdfs' ? pdfs : materials).filter((r) => ids.includes(r[rel.fkCol]));

  const oldResult = fanOut('old', [lessonId], rels, childrenOf);
  const newResult = fanOut('new', [lessonId], rels, childrenOf);

  ok(Object.keys(oldResult[1] ?? {}).length === 0,
    'model: the pre-fix loop loses a sibling relation (reproduces the reported symptom)');
  ok((newResult[1] ?? {})[lessonId]?.M1 !== undefined,
    'model: the fixed loop delivers lesson_materials for the same fixture');

  // A material must survive when the sibling DOES have rows too (the ids then
  // differ, which is what made the old query return the wrong set silently).
  const pdfRows = [{ id: 'P1', lesson_id: lessonId }];
  const childrenWithPdfs = (rel, ids) =>
    (rel.alias === 'lesson_pdfs' ? pdfRows : materials).filter((r) => ids.includes(r[rel.fkCol]));
  const old2 = fanOut('old', [lessonId], rels, childrenWithPdfs);
  const new2 = fanOut('new', [lessonId], rels, childrenWithPdfs);
  ok(Object.keys(old2[1] ?? {}).length === 0, 'model: pre-fix loop also loses materials when the sibling has rows');
  ok((new2[1] ?? {})[lessonId]?.M1 !== undefined, 'model: fixed loop is unaffected by the sibling having rows');

  // The nested (linear) chain must keep working.
  const sections = [{ id: 'S1', course_id: 'C1' }];
  const lessons = [{ id: 'L1', section_id: 'S1' }];
  const nestedRels = [
    { alias: 'sections', fkCol: 'course_id', depth: 1 },
    { alias: 'lessons', fkCol: 'section_id', depth: 2, parentRelIndex: 0 },
    { alias: 'lesson_materials', fkCol: 'lesson_id', depth: 3, parentRelIndex: 1 },
  ];
  const nestedChildren = (rel, ids) =>
    ({ sections, lessons, lesson_materials: materials }[rel.alias] || []).filter((r) => ids.includes(r[rel.fkCol]));
  const nested = fanOut('new', ['C1'], nestedRels, nestedChildren);
  ok(Object.keys(nested[2] ?? {}).length === 1,
    'model: nested course → sections → lessons → lesson_materials still resolves');
}

{
  const php = read(DATA);
  const loop = php.slice(php.indexOf('$levelData = []; // relIndex'), php.indexOf('// Attach bottom-up'));
  ok(!/array_merge\(\.\.\.\$parentIds\)/.test(loop),
    'DataController: the rolling $parentIds (sibling-losing) pattern is gone');
  ok(/\$rel\['parentRelIndex'\]/.test(loop),
    'DataController: nested relations resolve parents via parentRelIndex');
  ok(/depth.*=== 1[\s\S]{0,120}\$mainIds/.test(loop),
    'DataController: depth-1 relations are queried with the MAIN row ids');
  ok(/\$levelData\[\$i\] = \[\];\s*\n\s*continue;/.test(loop),
    'DataController: a relation without parents yields [] and does not abort its siblings');
}

/* ─────────────── 2. per-material access policy (signed URL mint) ─────────── */

console.log('── Signed-URL authorisation: suspension, publication, per-material policy ──');
{
  const svc = read(STORAGE);
  const fn = svc.slice(svc.indexOf('public function canAccess'), svc.indexOf('return false;', svc.indexOf('return false;') + 1));
  ok(/function canAccess\([\s\S]{0,240}bool \$forDownload = false\)/.test(svc),
    'StorageService: canAccess takes the download intent');
  ok(/in_array\(\$permission, \['hidden', 'disabled'\], true\)/.test(svc),
    'StorageService: hidden/disabled materials are never delivered');
  ok(/'course_status'[\s\S]{0,200}!== 'published'/.test(svc),
    'StorageService: materials of an unpublished course are refused');
  ok(/'lesson_status'[\s\S]{0,200}!== 'published'/.test(svc),
    'StorageService: materials of an unpublished lesson are refused');
  ok(/`status` IS NULL OR `status` <> 'suspended'/.test(svc),
    'StorageService: a SUSPENDED enrollment is not access (matches the course-suspension rule)');
  ok(/\$forDownload && \(\$permission === 'preview_only' \|\| !\$row\['download_enabled'\]\)/.test(svc),
    'StorageService: preview_only / downloads-off refuse a DOWNLOAD while still allowing viewing');

  const ctl = read(STORE);
  ok(/filter_var\(\$request->json\(\)\['download'\] \?\? false, FILTER_VALIDATE_BOOLEAN\)/.test(ctl),
    'StorageController: the mint endpoint reads the download intent from the body');
  ok(/canAccess\([^)]*\$forDownload\)/.test(ctl),
    'StorageController: the mint endpoint passes it to the authorisation check');
}

/* ─────────────── 3. upload content policy (size + types) ─────────────────── */

console.log('── Upload policy: size cap and blocked types, server + client in sync ──');
{
  const ctl = read(STORE);
  ok(/private const BLOCKED_UPLOAD_EXTENSIONS/.test(ctl), 'StorageController: blocked-extension denylist exists');
  ok(/LESSON_MATERIAL_MAX_BYTES', 100 \* 1024 \* 1024\)/.test(ctl),
    'StorageController: 100 MB cap matches the advertised limit');
  ok(/413/.test(ctl) && /415/.test(ctl),
    'StorageController: oversized (413) and blocked-type (415) uploads are rejected');
  ok(/in_array\(\$bucket, \['lesson-materials', 'lesson-pdfs'\], true\)/.test(ctl),
    'StorageController: the policy applies to attachment buckets (video chunks stay exempt)');
  ok(/assertUploadAllowed\(\$bucket, \$file, \$dest\)/.test(ctl),
    'StorageController: the policy runs on the upload path');

  const extract = (src) => {
    const i = src.indexOf('BLOCKED_UPLOAD_EXTENSIONS');
    const body = src.slice(src.indexOf('[', i), src.indexOf(']', i));
    return (body.match(/'([a-z0-9]+)'/g) || []).map((s) => s.replace(/'/g, '')).sort();
  };
  const server = extract(ctl);
  const client = extract(read(HELPER));
  ok(server.length > 20, `server denylist parsed (${server.length} entries)`);
  ok(JSON.stringify(server) === JSON.stringify(client),
    'client mirror of the blocked-extension list is identical to the server denylist');
  ok(/LESSON_MATERIAL_MAX_BYTES = 100 \* 1024 \* 1024/.test(read(HELPER)),
    'client mirror advertises the same 100 MB cap');

  // Attachments are served as downloads, never rendered inline from the API origin.
  ok(/X-Content-Type-Options'\s*=>\s*'nosniff'/.test(ctl) && /Content-Disposition'\s*\]\s*=\s*'attachment/.test(ctl),
    'StorageController: documents are served nosniff + as an attachment (no stored XSS on the API origin)');
}

/* ─────────────── 4. student screen honours the material policy ──────────── */

console.log('── Student lesson screen: materials section + per-material policy ──');
{
  const helper = read(HELPER);
  ok(/'hidden' \|\| permission === 'disabled'/.test(helper),
    'lessonMaterials: hidden/disabled map to no access');
  ok(/'preview_only'/.test(helper) && /'download' : 'view'/.test(helper),
    'lessonMaterials: preview_only maps to view-only');
  ok(/Number\(mat\.download_enabled\) !== 0/.test(helper),
    'lessonMaterials: download_enabled normalises 1/0/true/false (MySQL TINYINT safe)');

  const s = read(STUDENT);
  ok((s.match(/<MaterialsSection/g) || []).length === 2,
    'student screen: BOTH lesson layouts render the one shared materials section');
  ok(/Lecture Materials/.test(s), 'student screen: section is titled "Lecture Materials"');
  ok(/import \{[^}]*materialAccess[^}]*\} from '@\/lib\/lessonMaterials'/.test(s),
    'student screen: imports the shared access helper');
  ok(!/onPress=\{\(\) => mat\.download_enabled && openMaterial/.test(s),
    'student screen: the old download_enabled-only gate is gone');
  ok(/onOpenMaterial=\{openMaterial\}/.test(s), 'student screen: material open is wired to openMaterial');
  ok(/accessibilityLabel=\{downloadable \? `Download \$\{name\}` : `View \$\{name\}`\}/.test(s),
    'student screen: rows expose Download vs View to accessibility');
  ok(/const items = visibleMaterials\(materials\);[\s\S]{0,120}if \(items\.length === 0 && pdfs\.length === 0\) return null;/.test(s),
    'student screen: an empty materials section renders nothing (no dangling heading)');
  ok(/formatBytes\(mat\.file_size\)/.test(s) && /mat\.file_type\?\.split\('\/'\)\[1\]/.test(s),
    'student screen: each row shows the real size and file type');

  const api = read('src/lib/api.ts');
  ok(/getMaterialSignedUrl\([\s\S]{0,400}forDownload = false/.test(api),
    'api: getMaterialSignedUrl takes the download intent');
  ok(/download: forDownload/.test(api), 'api: the signed-URL request carries the download intent');
  ok(/getMaterialSignedUrl\(storagePathOrUrl, forDownload\)/.test(s),
    'student screen: the item action forwards its own access level');

  const ed = read(EDITOR);
  ok((ed.match(/validateMaterialFile\(/g) || []).length === 2,
    'lesson editor: both upload and replace pre-validate against the server policy');
  ok(/uploadLessonMaterial\(/.test(ed) && /createLessonMaterial\(/.test(ed),
    'lesson editor: upload still stores the file and creates the DB association');
  ok(/lesson_id: lesson\.id/.test(ed) && /course_id: courseId/.test(ed),
    'lesson editor: the association carries lesson_id + course_id (reopening keeps it)');
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
