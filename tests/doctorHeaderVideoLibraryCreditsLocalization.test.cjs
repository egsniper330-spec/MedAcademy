#!/usr/bin/env node
/**
 * Doctor dashboard header, Video Library header, My Credits localization and the
 * four informational pages (About / Terms / Contact / Privacy).
 *
 * Run: node tests/doctorHeaderVideoLibraryCreditsLocalization.test.cjs
 *
 * WHAT THIS PINS
 *   1. The Doctor header greets with a localized "Welcome" and the authenticated
 *      doctor's OWN name (never a hardcoded name / the literal word "Doctor"),
 *      and its bell matches the student dashboard exactly (box, icon ratio,
 *      unread dot, label). Navigation + notification intent stay wired.
 *   2. The Video Library header is a title/subtitle block with a separate,
 *      balanced action row and a compact sync-status line — while upload, sync,
 *      search, sort, filters, rename, delete and their double-submit guards stay
 *      intact and translated.
 *   3. My Credits has no hardcoded English left, formats dates through the i18n
 *      date helper, and every visible state has an Arabic + English string.
 *   4. The four info pages resolve their app-owned content through the existing
 *      dictionaries, keep the CMS override first, and keep the fallback reactive
 *      to a locale change.
 *   5. The new dictionary keys exist in BOTH languages (i18nLocalization.test.cjs
 *      separately enforces exact key parity, Arabic script and no duplicates).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures.push(label + (detail ? ` (${detail})` : '')); console.log('  ✗ ' + label); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

const drOverview = read('src/app/(app)/(doctor)/dr-overview.tsx');
const studentDash = read('src/app/(app)/(student)/dashboard.tsx');
const dashHeader = read('src/components/DashboardHeader.tsx');
const videoLibrary = read('src/app/(app)/(doctor)/video-library.tsx');
const credits = read('src/app/(app)/(hubs)/credits.tsx');
const about = read('src/app/(app)/info/about.tsx');
const contact = read('src/app/(app)/info/contact.tsx');
const terms = read('src/app/(app)/info/terms.tsx');
const privacy = read('src/app/(app)/info/privacy.tsx');
const resources = read('src/lib/i18n/resources.ts');

/* ══ 1. Doctor dashboard header ═══════════════════════════════════════════ */

section('1. Doctor header — greeting, real name, and the bell');

ok('the greeting line is localized (doctor: role label, student: greeting line)',
  /roleLabel=\{t\('home\.welcome'\)\}/.test(drOverview) &&
  /greeting=\{t\('home\.hello'\)\}/.test(studentDash));
ok('the headline is the authenticated profile name, not a hardcoded string',
  /const doctorName = String\(profile\?\.full_name \?\? ''\)\.trim\(\) \|\| firstName \|\| t\('role\.doctor'\)/.test(drOverview) &&
  /greeting=\{doctorName\}/.test(drOverview));
ok('the profile name is the FIRST choice (the role word is only a fallback)',
  drOverview.indexOf("String(profile?.full_name ?? '').trim()") < drOverview.indexOf("|| t('role.doctor')"));
ok('the literal word "Doctor" is no longer the greeting',
  !/greeting=\{firstName \? `\$\{firstName\} 👋` : '👋'\}/.test(drOverview));
ok('the waving-hand emoji no longer stands in for the name',
  !/👋/.test(drOverview));
ok('the role label is no longer passed as the greeting overline',
  !/roleLabel=\{t\('drOverview\.roleLabel'\)\}/.test(drOverview));

// Bell parity with the student dashboard.
ok('the bell reads the doctor\'s unread count from the API',
  /getUnreadNotificationCount\(profile\.id\)/.test(drOverview) &&
  /setUnreadCount\(unread\)/.test(drOverview));
ok('the bell uses the student header\'s icon ratio (0.43 of the control box)',
  /\(layout\.touchTarget \+ 2\) \* 0\.43/.test(drOverview) &&
  /\(layout\.touchTarget \+ 2\) \* 0\.43/.test(studentDash));
ok('the bell box is touchTarget + 2 with the shared card radius',
  /width: layout\.touchTarget \+ 2, height: layout\.touchTarget \+ 2, borderRadius: layout\.cardRadius/.test(drOverview));
ok('the unread dot is rendered only when there is something unread',
  /unreadCount > 0 && \(/.test(drOverview) && /backgroundColor: '#EF4444'/.test(drOverview));
ok('the bell announces the unread count to screen readers',
  /unreadCount > 0 \? `\$\{t\('nav\.notifications'\)\}, \$\{tCount\('common\.unreadCount', unreadCount\)\}` : t\('nav\.notifications'\)/.test(drOverview));
ok('tapping the bell still marks dashboard intent and opens notifications',
  /markEntryIntent\('\/\(app\)\/notifications', 'nested'\)/.test(drOverview) &&
  /router\.push\('\/\(app\)\/notifications'/.test(drOverview));
ok('the hamburger/drawer header component is unchanged in use',
  /<DashboardHeader/.test(drOverview) && /<HamburgerButton plain color=\{c\.text\} \/>/.test(dashHeader));

// Shared header hardening.
// The title stack still takes the remaining width and may shrink to zero, so a
// long display name truncates instead of pushing the actions off the row. The
// gap is now expressed with PHYSICAL margins (the row is pinned to ltr so the
// mirror is the single `flexDirection` in the model, not a second reversal).
ok('a long name truncates instead of pushing the controls (flex 1 + minWidth 0)',
  /flex: 1,\s*minWidth: 0,/.test(dashHeader));
ok('the header gap follows the app direction with physical margins',
  /marginLeft: isRTL \? 0 : spacing\.sm \+ spacing\.xs/.test(dashHeader) &&
  /marginRight: isRTL \? spacing\.sm \+ spacing\.xs : 0/.test(dashHeader));
ok('the greeting block is anchored to the locale start edge (right in Arabic)',
  /alignItems: isRTL \? 'flex-end' : 'flex-start'/.test(dashHeader));
ok('the header row mirrors physically, never via Yoga direction',
  /flexDirection: isRTL \? 'row-reverse' : 'row',/.test(dashHeader) &&
  /direction: 'ltr',/.test(dashHeader));
ok('the greeting is single-line so it can never overlap the actions',
  /greeting\}?\s*<\/Text>/s.test(dashHeader) && (dashHeader.match(/numberOfLines=\{1\}/g) || []).length >= 2);
ok('the Arabic overline drops Latin tracking (cursive joins stay intact)',
  /isRTL \? \{ letterSpacing: 0, textTransform: 'none' as const \} : null/.test(dashHeader));

/* ══ 2. Video Library header ══════════════════════════════════════════════ */

section('2. Video Library — header structure and preserved behaviour');

ok('the title block is title + subtitle only (no cramped right-hand actions)',
  /<PageHeader\s*\n\s*title=\{t\('videoLibrary\.title'\)\}\s*\n\s*subtitle=\{t\('videoLibrary\.subtitle'\)\}\s*\n\s*\/>/.test(videoLibrary));
ok('no controls are stuffed back into the PageHeader',
  !/<PageHeader[\s\S]{0,240}rightAction/.test(videoLibrary));
ok('Upload and Sync sit in their own balanced, equal-width row',
  /paddingHorizontal: 16, flexDirection: 'row', gap: 10, marginBottom: 8/.test(videoLibrary) &&
  (videoLibrary.match(/flex: 1, height: 44, borderRadius: 14, flexDirection: 'row', alignItems: 'center'/g) || []).length === 2);
ok('Sync is the secondary control and Upload the primary one',
  /neuFlatStyle\(isDark\),\s*\n\s*\{ flex: 1, height: 44/.test(videoLibrary) &&
  /justifyContent: 'center', gap: 8, backgroundColor: c\.primary/.test(videoLibrary));
ok('both actions keep their accessibility labels',
  /accessibilityLabel=\{t\('videoLibrary\.syncAria'\)\}/.test(videoLibrary) &&
  /accessibilityLabel=\{t\('videoLibrary\.upload'\)\}/.test(videoLibrary));
ok('the sync status is one compact secondary line (state · time · counts)',
  /\(syncing \|\| syncFailed \|\| !!syncSummary\)/.test(videoLibrary) &&
  /t\('videoLibrary\.lastSync', \{/.test(videoLibrary) &&
  /t\('videoLibrary\.syncUnavailable'\)/.test(videoLibrary));
ok('a failed sync still offers Retry',
  /syncFailed && \(\s*\n\s*<Pressable onPress=\{handleSync\} disabled=\{syncing\}/.test(videoLibrary));
ok('duplicate sync requests stay blocked',
  /if \(syncing\) return;/.test(videoLibrary) && /disabled=\{syncing\}/.test(videoLibrary));
ok('duplicate upload requests stay blocked',
  /if \(uploadingVideo\) return;/.test(videoLibrary) && /disabled=\{uploadingVideo\}/.test(videoLibrary));
ok('the API contract is untouched (search / status / sort / dir)',
  /getMyVideoLibrary\(\{ search, status: statusFilter, sortBy, sortDir \}\)/.test(videoLibrary));
ok('sync still scopes doctors to their own library',
  /syncVideoLibraryWithVdoCipher\(true, isStaff \? 'all' : 'mine'\)/.test(videoLibrary));
ok('the auto-sync focus throttle survives the redesign',
  /AUTO_SYNC_INTERVAL_MS = 5 \* 60 \* 1000/.test(videoLibrary) &&
  /now - lastAutoSyncRef\.current > AUTO_SYNC_INTERVAL_MS/.test(videoLibrary));
ok('sort options and status filters are translation keys, not literals',
  /labelKey: 'videoLibrary\.sortDate'/.test(videoLibrary) &&
  /labelKey: 'videoLibrary\.filterProcessing'/.test(videoLibrary) &&
  /t\(SORT_OPTIONS\.find\(o => o\.value === sortBy\)\?\.labelKey \?\? 'videoLibrary\.sort'\)/.test(videoLibrary));
ok('row actions (rename / delete / usage) survive and are translated',
  /t\('videoLibrary\.rename'\)/.test(videoLibrary) &&
  /t\('videoLibrary\.deleteVideo'\)/.test(videoLibrary) &&
  /t\('videoLibrary\.usedIn'\)/.test(videoLibrary) &&
  /toggleUsage\(item\)/.test(videoLibrary) && /handleDelete\(item\)/.test(videoLibrary));
ok('dates follow the app locale instead of a pinned en-US tag',
  /formatLocalizedDate\(item\.created_at, locale, \{ style: 'medium' \}\)/.test(videoLibrary) &&
  !/en-US/.test(videoLibrary));
ok('the content column is capped on tablets/desktop',
  /maxWidth: 960, alignSelf: 'center'/.test(videoLibrary));
ok('the upload strip no longer shadows the translation function',
  !/const t: UploadTask/.test(videoLibrary) && /const task: UploadTask/.test(videoLibrary));

/* ══ 3. My Credits ════════════════════════════════════════════════════════ */

section('3. My Credits — complete localization');

ok('the page title and subtitle come from the dictionary',
  /title=\{t\('credits\.title'\)\} subtitle=\{t\('credits\.subtitle'\)\}/.test(credits));
ok('Redeem Code heading, hint, button and modal are translated',
  ['credits.redeemTitle', 'credits.redeemHint', 'credits.enterCode', 'credits.modalTitle', 'credits.modalSubtitle', 'credits.modalNote', 'credits.redeem']
    .every((k) => credits.includes(`t('${k}')`)));
ok('balance labels are translated',
  ['credits.available', 'credits.totalAllocated', 'credits.used', 'credits.history', 'credits.noTransactions']
    .every((k) => credits.includes(`t('${k}')`)));
// Keys with interpolation are called as t('key', { … }) — match the key literal.
ok('transaction rows localize the type, course, student and balance flow',
  ['credits.creditsUsed', 'credits.creditsAdded', 'credits.coursePrefix', 'credits.studentPrefix', 'credits.balanceFlow']
    .every((k) => credits.includes(`'${k}'`)));
ok('validation / success / failure toasts are translated',
  ['credits.enterCodeError', 'credits.addedSuccess', 'credits.redeemFailed']
    .every((k) => credits.includes(`'${k}'`)));
ok('dates use the shared localized formatter (not a pinned en-US tag)',
  /formatLocalizedDate\(tx\.created_at, locale, \{ style: 'medium' \}\)/.test(credits) &&
  !/toLocaleDateString\('en-US'/.test(credits));
ok('the RTL gutter uses gap instead of a physical marginLeft',
  /marginTop: 3, gap: 3/.test(credits) && !/marginLeft: 3/.test(credits));
ok('credit amounts, redemption and refresh behaviour are untouched',
  /redeemCreditCode\(code\)/.test(credits) &&
  /invalidateCreditCache\(\)/.test(credits) &&
  /Promise\.all\(\[refreshBalance\(\), loadHistory\(\)\]\)/.test(credits));

/* ══ 4. Informational pages ═══════════════════════════════════════════════ */

section('4. About / Contact / Terms / Privacy');

ok('About Us localizes its title, tagline, mission, pillars and footer',
  ['about.title', 'about.tagline', 'about.missionTitle', 'about.standFor', 'about.footer']
    .every((k) => about.includes(`'${k}'`)) &&
  /titleKey: 'about\.pillar1Title'/.test(about) &&
  /t\(p\.titleKey\)/.test(about));
ok('About injects the server brand name as a parameter instead of concatenating copy',
  /t\('about\.missionBody', \{ app: branding\.app_name \}\)/.test(about) &&
  /t\('about\.footer', \{ app: branding\.app_name \}\)/.test(about));
ok('Contact Us localizes its title, intro, states and channel identity',
  ['contact.title', 'contact.introFallback', 'contact.errorTitle', 'contact.emptyTitle', 'contact.open']
    .every((k) => contact.includes(`t('${k}')`)) &&
  /CONTACT_TEXT_KEYS/.test(contact));
ok('an admin-customised channel label is preserved verbatim',
  /link\.label === platformDef\(link\.platform\)\.label \? text\.label : link\.label/.test(contact));
ok('the contact URL safety check survives localization',
  /if \(!isSafeContactHref\(href\)\) continue;/.test(contact) &&
  /isSafeContactHref\(href\)\) return;/.test(contact));
ok('the Contact error state still offers Retry (never a login redirect)',
  /runRetry/.test(contact) && /refresh\(\)/.test(contact) && !/router\.(replace|push)/.test(contact));
ok('Terms resolves its numbered sections through the dictionaries',
  /t\(`terms\.s\$\{n\}h`\)/.test(terms) && /t\(`terms\.s\$\{n\}b`\)/.test(terms));
ok('Privacy does the same for its own section set',
  /t\(`privacy\.s\$\{n\}h`\)/.test(privacy) && /t\(`privacy\.s\$\{n\}b`\)/.test(privacy));
ok('both legal pages keep the CMS body as the first source',
  /useCmsSections\('terms_conditions', \[\]\)/.test(terms) &&
  /useCmsSections\('privacy_policy', \[\]\)/.test(privacy) &&
  /cmsSections\.length > 0\s*\n?\s*\? cmsSections/.test(terms) &&
  /cmsSections\.length > 0\s*\n?\s*\? cmsSections/.test(privacy));
ok('the built-in legal copy is the fallback (not a useState seed), so it follows the locale',
  /: SECTION_NUMBERS\.map\(\(n\) => \(\{/.test(terms) &&
  /: SECTION_NUMBERS\.map\(\(n\) => \(\{/.test(privacy));
ok('the legal "last updated" line is localized',
  /t\('legal\.lastUpdated'\)/.test(terms) && /t\('legal\.lastUpdated'\)/.test(privacy));
ok('no legal clause was dropped: 9 sections each, English and Arabic',
  ['1','2','3','4','5','6','7','8','9'].every((n) =>
    (resources.match(new RegExp(`'terms\\.s${n}h'`, 'g')) || []).length === 2 &&
    (resources.match(new RegExp(`'terms\\.s${n}b'`, 'g')) || []).length === 2 &&
    (resources.match(new RegExp(`'privacy\\.s${n}h'`, 'g')) || []).length === 2 &&
    (resources.match(new RegExp(`'privacy\\.s${n}b'`, 'g')) || []).length === 2));

/* ══ 5. Dictionary coverage for every new key ═════════════════════════════ */

section('5. New keys exist in both languages');

const NEW_KEYS = [
  'videoLibrary.title', 'videoLibrary.subtitle', 'videoLibrary.upload', 'videoLibrary.sync',
  'videoLibrary.syncAria', 'videoLibrary.lastSync', 'videoLibrary.autoSynced',
  'videoLibrary.syncRunning', 'videoLibrary.syncUnavailable', 'videoLibrary.syncOk',
  'videoLibrary.syncFailed', 'videoLibrary.searchPlaceholder', 'videoLibrary.sort',
  'videoLibrary.sortDate', 'videoLibrary.sortTitle', 'videoLibrary.sortDuration',
  'videoLibrary.sortSize', 'videoLibrary.filterAll', 'videoLibrary.filterReady',
  'videoLibrary.filterProcessing', 'videoLibrary.filterFailed', 'videoLibrary.loading',
  'videoLibrary.emptyTitle', 'videoLibrary.emptyBody', 'videoLibrary.noResultsTitle',
  'videoLibrary.noResultsBody', 'videoLibrary.loadFailed', 'videoLibrary.untitled',
  'videoLibrary.statusReady', 'videoLibrary.statusProcessing', 'videoLibrary.statusFailed',
  'videoLibrary.statusMissing', 'videoLibrary.statusRemotelyDeleted',
  'videoLibrary.statusDuplicateRemoved', 'videoLibrary.lessonsLabel', 'videoLibrary.videoId',
  'videoLibrary.usedIn', 'videoLibrary.notUsedYet', 'videoLibrary.rename',
  'videoLibrary.renameTitle', 'videoLibrary.titlePlaceholder', 'videoLibrary.renamed',
  'videoLibrary.renameFailed', 'videoLibrary.usageFailed', 'videoLibrary.deleteVideo',
  'videoLibrary.deleteTitle', 'videoLibrary.deleteBody', 'videoLibrary.usedInLessons',
  'videoLibrary.notUsedInAnyLesson', 'videoLibrary.keepVideo', 'videoLibrary.deletePermanently',
  'videoLibrary.deleted', 'videoLibrary.deletedWithLessons', 'videoLibrary.deleteFailed',
  'videoLibrary.notDeleted', 'videoLibrary.queued', 'videoLibrary.invalidFile',
  'videoLibrary.queueFailed', 'videoLibrary.stagePreparing', 'videoLibrary.stageUploading',
  'videoLibrary.stagePaused', 'videoLibrary.stageProcessing', 'videoLibrary.stageVerifying',
  'videoLibrary.stageRestoring', 'videoLibrary.stageTimedOut', 'videoLibrary.stageFailed',
  'videoLibrary.retryUpload',
  'credits.title', 'credits.subtitle', 'credits.redeemTitle', 'credits.redeemHint',
  'credits.enterCode', 'credits.available', 'credits.totalAllocated', 'credits.used',
  'credits.history', 'credits.noTransactions', 'credits.creditsUsed', 'credits.creditsAdded',
  'credits.coursePrefix', 'credits.studentPrefix', 'credits.balanceFlow', 'credits.addedSuccess',
  'credits.enterCodeError', 'credits.redeemFailed', 'credits.modalTitle',
  'credits.modalSubtitle', 'credits.modalNote', 'credits.redeem',
  'legal.lastUpdated',
  'about.title', 'about.tagline', 'about.missionTitle', 'about.missionBody',
  'about.standFor', 'about.pillar1Title', 'about.pillar1Body', 'about.pillar2Title',
  'about.pillar2Body', 'about.pillar3Title', 'about.pillar3Body', 'about.pillar4Title',
  'about.pillar4Body', 'about.footer',
  'contact.title', 'contact.introFallback', 'contact.open', 'contact.errorTitle',
  'contact.errorBody', 'contact.retryA11y', 'contact.emptyTitle', 'contact.emptyBody',
  'contact.email', 'contact.emailDesc', 'contact.phone', 'contact.phoneDesc',
  'contact.whatsapp', 'contact.whatsappDesc', 'contact.telegram', 'contact.telegramDesc',
  'contact.website', 'contact.websiteDesc', 'contact.facebook', 'contact.facebookDesc',
  'contact.instagram', 'contact.instagramDesc', 'contact.twitter', 'contact.twitterDesc',
  'contact.unknownDesc',
];

const missing = NEW_KEYS.filter((k) => (resources.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length !== 2);
ok(`all ${NEW_KEYS.length} new keys are defined exactly once per language` +
  (missing.length ? `: ${missing.slice(0, 6).join(', ')}` : ''), missing.length === 0);

// A couple of spot checks that the Arabic half is really Arabic, not a copy of
// the English value (the full Arabic-script rule lives in i18nLocalization).
ok('Arabic sample values are translated',
  /'credits\.title': 'رصيدي'/.test(resources) &&
  /'videoLibrary\.title': 'مكتبة الفيديو'/.test(resources) &&
  /'about\.title': 'من نحن'/.test(resources) &&
  /'contact\.title': 'اتصل بنا'/.test(resources) &&
  /'legal\.lastUpdated': 'آخر تحديث: يوليو 2025'/.test(resources));
ok('the Arabic legal copy states the same clauses (spot checks)',
  /'terms\.s9b':\s*\n?\s*'تخضع هذه الشروط للقوانين المعمول بها/.test(resources) &&
  /'privacy\.s5b':\s*\n?\s*'لا نبيع بياناتك الشخصية/.test(resources));
ok('no Arabic string was hardcoded into a component instead of the dictionary',
  !/[\u0600-\u06FF]/.test(videoLibrary.replace(/\/\*[\s\S]*?\*\//g, '')) &&
  !/[\u0600-\u06FF]/.test(credits.replace(/\/\*[\s\S]*?\*\//g, '')));

/* ── Result ─────────────────────────────────────────────────────────────── */

console.log('');
if (failures.length) {
  console.log(`❌ ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('   - ' + f);
  process.exit(1);
}
console.log(`✅ ${passed} passed, 0 failed`);
