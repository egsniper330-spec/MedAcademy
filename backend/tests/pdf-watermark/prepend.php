<?php

declare(strict_types=1);

/**
 * prepend.php — test-only autoload bridge for the PDF watermark test workflow.
 *
 * Loaded with `php -d auto_prepend_file=.../prepend.php` exactly the way
 * PdfWatermarkService::loadLibraries() would load FPDF/FPDI from a real
 * deployment (backend/vendor), except that the Composer dependencies live in
 * the git-ignored test workspace instead of the repository tree.
 *
 * It never modifies production code, configuration or data.
 */

$root = dirname(__DIR__, 3);
$work = (string) getenv('PDFTEST_WORKDIR');
$work = ($work !== '' ? $work : $root . '/.freebuff/pdf-watermark-tests');

$autoload = $work . '/lib/vendor/autoload.php';
if (!is_file($autoload)) {
    fwrite(STDERR, "FPDF/FPDI are not installed (missing: {$autoload})\n");
    fwrite(STDERR, "Run the bootstrap first:\n");
    fwrite(STDERR, "  powershell -NoProfile -ExecutionPolicy Bypass -File backend\\tests\\pdf-watermark\\run.ps1\n");
    fwrite(STDERR, "  (or: bash backend/tests/pdf-watermark/run.sh on Linux/macOS)\n");
    exit(1);
}

require_once $autoload;
