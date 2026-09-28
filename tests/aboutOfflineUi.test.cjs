/**
 * aboutOfflineUi — UI/layout contract pins for two user-facing fixes:
 *
 *   1. About Us (src/app/(app)/info/about.tsx):
 *      The "Build Verification Marker" panel (Build ID / Version Code /
 *      build date, orange bordered card) must be fully removed from the
 *      user-facing rendering path — not hidden via opacity/visibility.
 *      Internal build metadata stays untouched: src/lib/buildMarker.ts
 *      must still exist and export its values for diagnostics/updates,
 *      and the native update/security systems' inputs are not UI files.
 *
 *   2. Offline Videos (src/app/(app)/offline-library.tsx):
 *      Zero downloads → the empty state is vertically centered in the
 *      available content area via FLEX (flexGrow + centering), never a
 *      hardcoded screen height. Any content present (courses/downloading/
 *      failed) → normal top-aligned scrollable list (no grow/centering).
 *
 * Assertion style: real source with comments stripped, so pins match code,
 * not prose.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function check(name, cond, msg) {
  if (cond) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name} — ${msg}`); }
}

/** Read source with comments and strings stripped — assertions see real code only. */
function readCode(p) {
  let src = fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
  src = src.replace(/\/\*[\s\S]*?\*\//g, '');          // block comments
  src = src.replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');      // line comments
  return src;
}

console.log('\n── About Us — build marker removed from user-facing UI ──');
{
  const about = readCode('src/app/(app)/info/about.tsx');

  check('no Build Verification Marker rendering',
    !/Build Verification Marker/i.test(about),
    'the marker text still appears in about.tsx code');

  check('no build-metadata imports in About Us',
    !/from '@\/lib\/buildMarker'/.test(about) && !/BUILD_ID|BUILD_VERSION_CODE|BUILD_TIMESTAMP/.test(about),
    'About Us still imports/consumes build marker values');

  check('no build-marker debug icon import',
    !/FlaskConical/.test(about),
    'the marker panel icon (FlaskConical) is still imported/rendered');

  check('About Us page still renders its sections',
    /PageHeader title="About Us"/.test(about) &&
    /Our Mission/.test(about) &&
    /What We Stand For/.test(about) &&
    /useCmsSections\('about_us'/.test(about),
    'About Us content was broken by the removal');

  // The library module itself must remain for internal consumers.
  const marker = fs.readFileSync(path.join(ROOT, 'src/lib/buildMarker.ts'), 'utf8');
  check('src/lib/buildMarker.ts retained for internal use',
    /BUILD_VERSION_NAME/.test(marker) && /BUILD_VERSION_CODE/.test(marker),
    'buildMarker.ts was deleted — internal diagnostics/updates may need it');

  // Hidden-not-removed patterns are forbidden (opacity/visibility/display:none).
  check('marker removed, not merely hidden',
    !/display:\s*['"]none['"]/.test(about) && !/visibility:\s*['"]hidden['"]/.test(about),
    'About Us uses hide-style suppression instead of a clean removal');
}

console.log('\n── Offline Videos — centered true-empty, top-aligned list ──');
{
  const lib = readCode('src/app/(app)/offline-library.tsx');

  // The centering must key off the ZERO-downloads condition exactly.
  check('centering is gated on the zero-downloads condition',
    /!\s*hasDownloads\s*&&\s*\{\s*flexGrow:\s*1,\s*justifyContent:\s*'center'/,
    'ScrollView contentContainer lacks the !hasDownloads flex-centering branch');

  check('centering is flex-based (no hardcoded screen height)',
    !/height:\s*(Math\.round\(.*Window|Dimensions\.get\('window'\)\.height)/.test(lib),
    'a fixed screen-height layout was introduced');

  check('empty state element exists with centered horizontal alignment',
    /emptySpace.*alignItems/.test(lib) || /styles\.emptySpace/.test(lib),
    'emptySpace style/usage missing');

  check('true-empty variant neutralizes top padding (centering owns spacing)',
    /emptySpaceCentered:\s*\{\s*paddingTop:\s*0,\s*paddingBottom:\s*0\s*\}/.test(lib),
    'emptySpaceCentered variant missing');

  check('list sections remain normal flow (top-aligned cards)',
    /styles\.courseCard/.test(lib) && /styles\.dlCard/.test(lib),
    'course/download card rendering missing');

  // The contextual (has downloads, more room below) copy still renders the
  // same emptySpace block — the !hasDownloads gate must be additive, not a
  // replacement that changes which branches render.
  check('contextual empty-space branch preserved',
    /!\s*hasDownloads\s*\|\|\s*courses\.length\s*>\s*0/.test(lib),
    'the (!hasDownloads || courses.length > 0) empty-space branch was altered');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
