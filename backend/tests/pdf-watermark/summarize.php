<?php

declare(strict_types=1);

/**
 * summarize.php — turns the per-suite result JSON into:
 *
 *   out/summary.json   machine-readable summary (counts, versions, exit codes)
 *   out/REPORT.md      human-readable report
 *
 * Exit code 0 only when EVERY required suite produced ok=true with exit 0.
 * Called by run.ps1 / run.sh after the suites; can also be run standalone.
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
$WORK = (string) (getenv('PDFTEST_WORKDIR') ?: $root . '/.freebuff/pdf-watermark-tests');
$OUT = $WORK . '/out';

/** id => [label, required, listKey (null = suite has no check list)] */
$suites = [
    'real_pipeline'  => ['Real PHP raster pipeline (personalization, geometry, pixels)', true, 'checks'],
    'repo_verify'    => ['Repository integration test (backend/scripts/verify-watermark.php)', true, 'checks'],
    'error_handling' => ['Fail-closed error handling (malformed/encrypted/limits/missing deps)', true, 'cases'],
    'authorization'  => ['Authorization + token lifecycle incl. revocation', true, 'checks'],
    'gallery'        => ['Visual gallery artifact (manual inspection)', false, null],
];

$exitCodes = [];
if (is_file($OUT . '/exitcodes.json')) {
    $exitCodes = (array) json_decode((string) file_get_contents($OUT . '/exitcodes.json'), true) ?: [];
}

function probe(string $argv0, array $args): ?string
{
    $d = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $p = @proc_open(array_merge([$argv0], $args), $d, $pipes);
    if (!is_resource($p)) {
        return null;
    }
    fclose($pipes[0]);
    $out = (string) stream_get_contents($pipes[1]) . (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($p);
    return trim($out);
}

// ── Versions actually used for this run ─────────────────────────────────────
$gd = function_exists('gd_info') ? gd_info() : [];
$versions = [
    'php' => PHP_VERSION . ' (' . PHP_OS . ', ' . (PHP_ZTS ? 'ZTS' : 'NTS') . ')',
    'memory_limit' => (string) ini_get('memory_limit'),
    'proc_open' => function_exists('proc_open') && !in_array('proc_open', array_map('trim', explode(',', (string) ini_get('disable_functions'))), true) ? 'available' : 'DISABLED',
    'gd' => !empty($gd) ? ('bundled ' . ($gd['GD Version'] ?? '?')) : 'missing',
    'freetype' => isset($gd['FreeType Support']) && $gd['FreeType Support'] ? 'YES' : 'NO',
    'imagick' => class_exists('Imagick') ? 'present' : 'not installed (GD used as compositor)',
    'ghostscript' => null,
    'fpdf' => null,
    'fpdi' => null,
    'composer' => null,
    'pdftotext' => null,
    'font' => getenv('PDF_WATERMARK_FONT') ?: '(service default)',
];

$gsBin = (string) (getenv('GHOSTSCRIPT_BIN') ?: 'gs');
$gsV = probe($gsBin, ['--version']);
if ($gsV !== null && preg_match('/\d+\.\d+(\.\d+)?/', $gsV, $m)) {
    $versions['ghostscript'] = $m[0] . ' (' . basename($gsBin) . ')';
}

$installed = $WORK . '/lib/vendor/composer/installed.json';
if (is_file($installed)) {
    $data = (array) json_decode((string) file_get_contents($installed), true);
    $pkgs = $data['packages'] ?? $data;
    foreach ((array) $pkgs as $pkg) {
        if (($pkg['name'] ?? '') === 'setasign/fpdf') {
            $versions['fpdf'] = (string) ($pkg['version'] ?? '?');
        }
        if (($pkg['name'] ?? '') === 'setasign/fpdi') {
            $versions['fpdi'] = (string) ($pkg['version'] ?? '?');
        }
    }
}

$composerPhar = $WORK . '/downloads/composer.phar';
if (is_file($composerPhar)) {
    $cv = probe(PHP_BINARY, [$composerPhar, '--version', '--no-ansi']);
    if ($cv !== null && preg_match('/Composer(?: version)? (\S+)/', $cv, $m)) {
        $versions['composer'] = $m[1];
    }
}

$pt = trim((string) (getenv('PDFTOTEXT') ?: 'pdftotext'));
$ptv = probe($pt, ['-v']);
if ($ptv !== null && preg_match('/version\s+(\S+)/', $ptv, $m)) {
    $versions['pdftotext'] = $m[1];
}

// ── Per-suite results ───────────────────────────────────────────────────────
$results = [];
$totals = ['passed' => 0, 'failed' => 0, 'skipped' => 0, 'total' => 0];
$allOk = true;

foreach ($suites as $id => [$label, $required, $listKey]) {
    $file = $OUT . '/' . $id . '.json';
    $entry = [
        'id' => $id, 'label' => $label, 'required' => $required,
        'ok' => false, 'passed' => 0, 'failed' => 0, 'skipped' => 0, 'total' => 0,
        'exit_code' => $exitCodes[$id] ?? null, 'failures' => [],
    ];
    if (!is_file($file)) {
        $entry['failures'][] = 'no result JSON (suite crashed or did not run) — see out/' . $id . '.log';
    } else {
        $data = (array) json_decode((string) file_get_contents($file), true);
        $list = $listKey !== null ? (array) ($data[$listKey] ?? []) : [];
        foreach ($list as $item) {
            $entry['total']++;
            $ok = (bool) ($item['ok'] ?? false);
            $detail = (string) ($item['detail'] ?? $item['why'] ?? '');
            if (!$ok) {
                $entry['failed']++;
                $entry['failures'][] = ($item['check'] ?? $item['case'] ?? '?') . ($detail !== '' ? " ($detail)" : '');
            } elseif (str_starts_with($detail, 'SKIPPED')) {
                $entry['skipped']++;
            } else {
                $entry['passed']++;
            }
        }
        $entry['ok'] = (bool) ($data['ok'] ?? false);
        if ($listKey === null) {
            $entry['ok'] = (bool) ($data['ok'] ?? false);
            $entry['total'] = 1;
            $entry['passed'] = $entry['ok'] ? 1 : 0;
            $entry['failed'] = $entry['ok'] ? 0 : 1;
        }
    }
    if ($entry['exit_code'] !== null && (int) $entry['exit_code'] !== 0 && $entry['ok']) {
        $entry['ok'] = false;
        $entry['failures'][] = 'suite exited with code ' . $entry['exit_code'];
    }
    if ($required && !$entry['ok']) {
        $allOk = false;
    }
    $totals['passed'] += $entry['passed'];
    $totals['failed'] += $entry['failed'];
    $totals['skipped'] += $entry['skipped'];
    $totals['total'] += $entry['total'];
    $results[] = $entry;
}

$summary = [
    'generated_at' => gmdate('c'),
    'workdir' => $WORK,
    'host' => ['os' => PHP_OS_FAMILY, 'uname' => php_uname()],
    'versions' => $versions,
    'suites' => $results,
    'totals' => $totals,
    'ok' => $allOk,
    'artifacts' => [
        'out_dir' => $OUT,
        'summary_json' => $OUT . '/summary.json',
        'report_md' => $OUT . '/REPORT.md',
        'gallery' => is_file($OUT . '/gallery.html') ? $OUT . '/gallery.html' : null,
        'student_pdfs' => [
            'student-a.pdf' => is_file($OUT . '/student-a.pdf') ? filesize($OUT . '/student-a.pdf') : null,
            'student-b.pdf' => is_file($OUT . '/student-b.pdf') ? filesize($OUT . '/student-b.pdf') : null,
        ],
    ],
];

@mkdir($OUT, 0775, true);
file_put_contents($OUT . '/summary.json', json_encode($summary, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");

// ── Human-readable report ───────────────────────────────────────────────────
$md = "# MedAcademy PDF watermark — test report\n\n";
$md .= 'Generated: ' . $summary['generated_at'] . " · Host: {$summary['host']['uname']}\n\n";
$md .= "**Result: " . ($allOk ? 'ALL REQUIRED SUITES PASSED' : 'FAILURE') . "** ";
$md .= "({$totals['passed']} passed, {$totals['failed']} failed, {$totals['skipped']} skipped of {$totals['total']} checks)\n\n";
$md .= "## Suites\n\n| Suite | Required | Result | Checks |\n|---|---|---|---|\n";
foreach ($results as $r) {
    $state = $r['ok'] ? 'PASS' : 'FAIL';
    $md .= "| {$r['label']} | " . ($r['required'] ? 'yes' : 'no') . " | $state | {$r['passed']}/{$r['total']}"
        . ($r['skipped'] ? " ({$r['skipped']} skipped)" : '') . " |\n";
}
foreach ($results as $r) {
    if ($r['failures'] !== []) {
        $md .= "\n### Failures — {$r['id']}\n\n";
        foreach ($r['failures'] as $f) {
            $md .= "- $f\n";
        }
    }
}
$md .= "\n## Versions used\n\n| Component | Version |\n|---|---|\n";
foreach ($versions as $k => $v) {
    $md .= '| ' . str_replace('_', ' ', $k) . ' | ' . ($v ?? 'not found') . " |\n";
}
$md .= "\n## Artifacts (all inside the git-ignored test workspace)\n\n";
$md .= "- Output directory: `{$summary['artifacts']['out_dir']}`\n";
$md .= "- Machine-readable summary: `{$summary['artifacts']['summary_json']}`\n";
foreach (['real_pipeline', 'repo_verify', 'error_handling', 'authorization', 'gallery'] as $id) {
    $md .= "- Suite log: `{$OUT}/$id.log`\n";
}
if ($summary['artifacts']['gallery'] !== null) {
    $md .= "- Visual gallery: `{$summary['artifacts']['gallery']}`\n\n";
    $md .= "  Inspect it manually (it is never opened or uploaded automatically):\n";
    $md .= "  `start \"\" \"{$summary['artifacts']['gallery']}\"` (Windows) or open the file in a browser.\n";
}
$md .= "\n## Reproduce\n\n";
$md .= "```\npowershell -NoProfile -ExecutionPolicy Bypass -File backend\\tests\\pdf-watermark\\run.ps1\n";
$md .= "bash backend/tests/pdf-watermark/run.sh        # Linux/macOS\n```\n\n";
$md .= "Licensing notes (Ghostscript AGPL/commercial): `backend/docs/PDF_WATERMARK_LICENSING.md`. ";
$md .= "This run does NOT resolve licensing obligations and does NOT prove cPanel/shared-hosting compatibility. See `backend/docs/PDF_WATERMARK_TESTING.md`.\n";
file_put_contents($OUT . '/REPORT.md', $md);

echo json_encode([
    'ok' => $allOk,
    'totals' => $totals,
    'summary_json' => $OUT . '/summary.json',
    'report_md' => $OUT . '/REPORT.md',
], JSON_UNESCAPED_SLASHES), "\n";

exit($allOk ? 0 : 1);
