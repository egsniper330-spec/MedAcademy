<?php

declare(strict_types=1);

/**
 * watermark-diagnostics.php — report the personalized-PDF watermark engine.
 *
 * Run AFTER uploading backend/ and creating backend/.env:
 *
 *   php backend/scripts/watermark-diagnostics.php
 *
 * OPERATOR-ONLY: this is a CLI script (it refuses a web SAPI) and lives outside
 * the document root, so it may print the full capability detail — including the
 * resolved font path and configured PDFium render binary — which the admin-only
 * HTTP surface (RendererStatus::status()) deliberately omits. It still contains
 * no secrets, no database credentials, and no file bytes.
 *
 * Exit code 0 = an engine is available; 1 = watermarked delivery would 503.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Services\PdfWatermarkService;

$service = new PdfWatermarkService();
$detail = $service->rendererStatus();

$report = [
    'available' => $service->isAvailable(),
    'driver' => $service->driver(),
    'configured_mode' => $detail['configured_mode'],
    'effective_mode' => $detail['effective_mode'],
    'raster' => $detail['raster'],
    'vector' => $detail['vector'],
];

echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";

if (($report['available'] ?? false) !== true) {
    fwrite(STDERR, "\nWatermark engine is NOT available: every watermarked delivery will be refused (HTTP 503).\n");
    fwrite(STDERR, "Fix one of the engines and re-run this script.\n");
    exit(1);
}

if (($report['effective_mode'] ?? null) === PdfWatermarkService::MODE_VECTOR) {
    fwrite(STDERR, "\nNote: running the VECTOR engine — output keeps a selectable text layer.\n");
    fwrite(STDERR, "For flattened image-only pages enable raster: install the PDFium helper, GD (FreeType)\n");
    fwrite(STDERR, "or Imagick, and a TTF font, and allow proc_open.\n");
}

exit(0);
