<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Config;

/**
 * PdfWatermarkService — personalized student watermarking for lesson PDFs.
 *
 * Produces ONE per-student copy of a teacher-uploaded source PDF. Two engines
 * are available; the deployment picks one with PDF_WATERMARK_MODE:
 *
 * ── ENGINE A: "raster" (flattened, image-based) — the DEFAULT ───────────────
 * Every page is rendered to a bitmap, the student's watermark is composited
 * BELOW the lecture content, the two layers are flattened into a single opaque
 * page image, and each page image is placed into a new PDF. The result has NO
 * selectable text layer and no removable annotation — the mark is part of the
 * pixel data.
 *
 * ── ENGINE B: "vector" (FPDI/FPDF) — the previous implementation, preserved ─
 * Re-emits the original page content as vectors and draws the watermark into
 * the SAME page content stream *before* the imported page, so it sits behind
 * the lecture content. Text stays selectable and output size stays small, but
 * the text layer survives. Kept for hosts that cannot run a renderer; it is
 * NOT removed.
 *
 * ── WHY THE WATERMARK IS TRULY "BEHIND" IN ENGINE A ────────────────────────
 * The page is rendered with Ghostscript's `pngalpha` device, which leaves the
 * unpainted page background TRANSPARENT (a normal viewer shows white paper, but
 * there is no white fill in the raster). Compositing order is then:
 *
 *     (1) opaque background canvas: white fill + the student watermark
 *     (2) the transparent-content page bitmap composited ON TOP (alpha = how
 *         much ink is at that pixel)
 *     (3) flatten → one opaque page image
 *
 * Where the lecture has text/diagrams the page bitmap is opaque and covers the
 * watermark; in the empty margins the page bitmap is transparent and the
 * watermark shows through. The watermark is never painted over the content,
 * which is the exact failure mode of "rasterise first, then stamp" pipelines.
 *
 * ── FAIL CLOSED ────────────────────────────────────────────────────────────
 * If the selected engine is not fully available the delivery is REFUSED
 * (HTTP 503). The unwatermarked original is never served as a fallback, and a
 * partially processed document is never returned (the output is written to a
 * sibling temp file and only published after every page succeeded).
 *
 * ── LIMITS STATED PLAINLY ──────────────────────────────────────────────────
 * Flattening raises the effort needed for casual text extraction — it does NOT
 * make content impossible to copy, and it does not stop screenshots, OCR, image
 * editing or photography. The watermark likewise deters ordinary removal; it is
 * not cryptographically irrevocable. The goal is attribution + friction.
 */
final class PdfWatermarkService
{
    /** Dedicated private bucket for generated copies. NO /storage/signed route. */
    public const BUCKET = 'lesson-material-pdfs';

    /** Engine selectors (PDF_WATERMARK_MODE). */
    public const MODE_RASTER = 'raster';
    public const MODE_VECTOR = 'vector';
    public const MODE_AUTO   = 'auto';

    /** Vendored pure-PHP PDF libraries are looked for here first. */
    private const VENDOR_DIRS = ['backend/lib/pdf', 'backend/vendor', 'vendor'];

    /**
     * Common Linux FreeType font locations, tried in order when
     * PDF_WATERMARK_FONT is not set. A TTF is REQUIRED by the raster engine so
     * the identity text renders correctly (non-Latin names, rotation).
     */
    private const FONT_CANDIDATES = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
    ];

    private ?bool $available = null;
    private ?string $driver = null;
    private ?array $rendererStatus = null;

    // ── Availability / capability detection ───────────────────────────────────

    /**
     * Try to load a vendored FPDF/FPDI. Returns true when at least one engine
     * can run. Never throws — an absent driver is a normal, reported state.
     */
    public function isAvailable(): bool
    {
        if ($this->available !== null) {
            return $this->available;
        }
        $this->loadLibraries();
        $status = $this->rendererStatus();
        $this->available = $status['effective_mode'] !== null;
        $this->driver = $status['effective_driver'];
        return $this->available;
    }

    /** Human-readable driver description, or null when none is installed. */
    public function driver(): ?string
    {
        $this->isAvailable();
        return $this->driver;
    }

    /** The operator-configured engine (never resolves "auto"). */
    public function configuredMode(): string
    {
        $mode = strtolower(trim(Config::string('PDF_WATERMARK_MODE', self::MODE_RASTER)));
        return in_array($mode, [self::MODE_RASTER, self::MODE_VECTOR, self::MODE_AUTO], true)
            ? $mode
            : self::MODE_RASTER;
    }

    /** The engine that will actually be used, or null when none can run. */
    public function effectiveMode(): ?string
    {
        return $this->rendererStatus()['effective_mode'];
    }

    /**
     * Diagnostics for the super-admin health surface. Reports WHAT is missing
     * so the requirement is actionable; contains no secrets and no file bytes.
     */
    public function status(): array
    {
        $s = $this->rendererStatus();
        // This shape is what GET /admin/material-watermark-status returns. It is
        // admin-gated, and it deliberately OMITS absolute filesystem paths and
        // the configured binary path — only presence booleans, the compositor
        // name and the Ghostscript version — so it cannot disclose server
        // layout even if the role gate is ever widened. The CLI diagnostics
        // script uses rendererStatus() for the full operator detail.
        return [
            'available' => $this->isAvailable(),
            'driver' => $this->driver(),
            'configured_mode' => $this->configuredMode(),
            'effective_mode' => $s['effective_mode'],
            'raster_ready' => $s['raster']['ready'],
            'vector_ready' => $s['vector']['ready'],
            'shell_execution' => $s['raster']['shell_execution'],
            'ghostscript_version' => $s['raster']['ghostscript_version'],
            'compositor' => $s['raster']['compositor'],
            'font_present' => $s['raster']['font'] !== null,
            'pdf_writer_present' => $s['raster']['pdf_writer'] === 'FPDF',
            'settings' => [
                'dpi' => $this->dpi(),
                'image_format' => $this->imageFormat(),
                'opacity' => $this->opacity(),
                'max_pages' => $this->maxPages(),
                'max_pixels_per_page' => $this->maxPixelsPerPage(),
                'jpeg_quality' => $this->jpegQuality(),
            ],
            'requirement' => 'raster engine: Ghostscript CLI + (GD w/ FreeType or Imagick) + a TTF font; vector engine: FPDF 1.8.x + FPDI 3 under backend/lib/pdf or backend/vendor.',
            'behaviour_when_missing' => 'A material with watermarking enabled is refused with HTTP 503 — the unwatermarked original is never served.',
        ];
    }

    /** Detailed, secret-free capability report for both engines. */
    public function rendererStatus(): array
    {
        if ($this->rendererStatus !== null) {
            return $this->rendererStatus;
        }

        // ── Raster engine prerequisites ──
        $canExec = $this->canExecute();
        $gsBin = Config::string('GHOSTSCRIPT_BIN', 'gs');
        $gsVersion = $canExec ? $this->probeGhostscript($gsBin) : null;
        $compositor = $this->detectCompositor();
        $font = $this->fontPath();
        // The flattened output is assembled with FPDF (image-only pages).
        $pdfWriter = class_exists(\FPDF::class);
        $rasterReady = $canExec && $gsVersion !== null && $compositor !== null && $font !== null && $pdfWriter;

        $raster = [
            'ready' => $rasterReady,
            'shell_execution' => $canExec ? 'enabled' : 'disabled (proc_open unavailable/disabled)',
            'ghostscript_bin' => $gsBin,
            'ghostscript_version' => $gsVersion,
            'compositor' => $compositor,
            'font' => $font,
            'pdf_writer' => $pdfWriter ? 'FPDF' : 'missing',
        ];

        // ── Vector engine prerequisites ──
        $vectorReady = class_exists(\setasign\Fpdi\Fpdi::class)
            || (class_exists('FPDI') && class_exists('FPDF'));
        $vector = [
            'ready' => $vectorReady,
            'fpdi_fpdf' => $vectorReady ? 'present' : 'missing',
        ];

        // ── Resolve the effective engine ──
        $mode = $this->configuredMode();
        $effective = null;
        if ($mode === self::MODE_RASTER) {
            $effective = $rasterReady ? self::MODE_RASTER : null;
        } elseif ($mode === self::MODE_VECTOR) {
            $effective = $vectorReady ? self::MODE_VECTOR : null;
        } else { // auto: prefer the stronger flattened engine, then fall back
            $effective = $rasterReady ? self::MODE_RASTER : ($vectorReady ? self::MODE_VECTOR : null);
        }

        $driver = null;
        if ($effective === self::MODE_RASTER) {
            $driver = 'raster: Ghostscript ' . ($gsVersion ?? '?') . ' + ' . $compositor . ' (flattened, no text layer)';
        } elseif ($effective === self::MODE_VECTOR) {
            $driver = class_exists(\setasign\Fpdi\Fpdi::class)
                ? 'vector: setasign/FPDI 3 + FPDF (Composer)'
                : 'vector: FPDI + FPDF (vendored)';
        }

        return $this->rendererStatus = [
            'configured_mode' => $mode,
            'effective_mode' => $effective,
            'effective_driver' => $driver,
            'raster' => $raster,
            'vector' => $vector,
        ];
    }

    /** Load vendored / Composer FPDF + FPDI when present. Idempotent. */
    private function loadLibraries(): void
    {
        foreach (self::VENDOR_DIRS as $rel) {
            $dir = MEDACADEMY_BASE . '/' . $rel;
            if (!is_dir($dir)) {
                continue;
            }
            foreach ([$dir . '/autoload.php', MEDACADEMY_BASE . '/vendor/autoload.php'] as $autoload) {
                if (is_file($autoload)) {
                    require_once $autoload;
                }
            }
            foreach ([$dir . '/fpdf.php', $dir . '/fpdi/src/autoload.php', $dir . '/fpdi/autoload.php'] as $entry) {
                if (is_file($entry)) {
                    require_once $entry;
                }
            }
        }
    }

    /**
     * True when PHP may start a subprocess. A restricted shared host often lists
     * proc_open in disable_functions; that makes the raster engine impossible
     * and must be reported, never worked around.
     */
    private function canExecute(): bool
    {
        if (!function_exists('proc_open')) {
            return false;
        }
        $disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));
        return !in_array('proc_open', $disabled, true);
    }

    /** Ghostscript version string, or null when the binary is absent. */
    private function probeGhostscript(string $bin): ?string
    {
        try {
            [$code, $out] = $this->runProcess([$bin, '--version'], 10);
        } catch (\Throwable $e) {
            return null;
        }
        if ($code !== 0) {
            return null;
        }
        return preg_match('/(\d+\.\d+(?:\.\d+)?)/', $out, $m) ? $m[1] : 'unknown';
    }

    /**
     * The image compositor used to put the watermark behind the page bitmap.
     * Imagick is preferred (reliable per-pixel alpha), GD (with FreeType) is the
     * common shared-hosting fallback. Null when neither can draw alpha text.
     */
    private function detectCompositor(): ?string
    {
        if (class_exists(\Imagick::class)) {
            return 'imagick';
        }
        if (extension_loaded('gd') && function_exists('imagettftext')) {
            $info = function_exists('gd_info') ? gd_info() : [];
            if (!isset($info['FreeType Support']) || $info['FreeType Support']) {
                return 'gd';
            }
        }
        return null;
    }

    /** The TTF used to stamp the identity; required by the raster engine. */
    private function fontPath(): ?string
    {
        $configured = trim(Config::string('PDF_WATERMARK_FONT', ''));
        if ($configured !== '') {
            return is_file($configured) ? $configured : null;
        }
        foreach (self::FONT_CANDIDATES as $candidate) {
            if (is_file($candidate)) {
                return $candidate;
            }
        }
        // Bundled font, if the operator drops one next to the PDF libraries.
        foreach (self::VENDOR_DIRS as $rel) {
            $glob = glob(MEDACADEMY_BASE . '/' . $rel . '/fonts/*.ttf') ?: [];
            if ($glob !== []) {
                return $glob[0];
            }
        }
        return null;
    }

    // ── Settings (all configurable; sensible, bounded defaults) ───────────────

    /** Render resolution for the raster engine. Sharp enough for lecture text. */
    public function dpi(): int
    {
        $dpi = Config::int('PDF_WATERMARK_DPI', 200);
        return max(96, min(400, $dpi));
    }

    /** Lossless PNG is the default; JPEG is opt-in for size experiments. */
    public function imageFormat(): string
    {
        $f = strtolower(trim(Config::string('PDF_WATERMARK_IMAGE_FORMAT', 'png')));
        return $f === 'jpeg' || $f === 'jpg' ? 'jpeg' : 'png';
    }

    public function jpegQuality(): int
    {
        return max(60, min(95, Config::int('PDF_WATERMARK_JPEG_QUALITY', 85)));
    }

    /** Watermark strength (0..1) used to pick the grey level on white. */
    public function opacity(): float
    {
        $raw = Config::string('PDF_WATERMARK_OPACITY', '0.15');
        $o = is_numeric($raw) ? (float) $raw : 0.15;
        return max(0.05, min(0.5, $o));
    }

    public function maxPages(): int
    {
        return max(1, Config::int('PDF_WATERMARK_MAX_PAGES', 150));
    }

    public function maxPixelsPerPage(): int
    {
        // 20M px ≈ A3 at 300 DPI. Two truecolor layers at 4 bytes/px ≈ 160 MB,
        // which fits comfortably under the 512 MB the deployment guide sets.
        return max(1_000_000, Config::int('PDF_WATERMARK_MAX_PIXELS_PER_PAGE', 20_000_000));
    }

    /**
     * PHP's memory_limit in bytes, or null when it is -1 (unlimited) or not
     * parseable. Used to refuse a page that would OOM the worker rather than let
     * it die with a fatal error mid-generation.
     */
    private function memoryLimitBytes(): ?int
    {
        $raw = trim((string) ini_get('memory_limit'));
        if ($raw === '' || $raw === '-1') {
            return null;
        }
        $unit = strtolower(substr($raw, -1));
        $num = (int) $raw;
        $factor = match ($unit) {
            'g' => 1024 * 1024 * 1024,
            'm' => 1024 * 1024,
            'k' => 1024,
            default => 1,
        };
        $bytes = $num * $factor;
        return $bytes > 0 ? $bytes : null;
    }

    // ── Identity helpers (unchanged contract) ─────────────────────────────────

    /**
     * Strip anything that could break the PDF text operators or spoof another
     * student. Identity values come from the server's own profile row, but they
     * are user-editable strings, so they are still normalised here.
     */
    public function sanitizeIdentityLine(string $value): string
    {
        // Drop control characters (incl. newlines/tabs) and the Unicode bidi
        // overrides that could visually reorder the id.
        $value = (string) preg_replace('/[\x00-\x1F\x7F]/u', ' ', $value);
        $value = (string) preg_replace('/[\x{202A}-\x{202E}\x{2066}-\x{2069}]/u', '', $value);
        // Collapse runs of whitespace and trim.
        $value = trim((string) preg_replace('/\s+/u', ' ', $value));
        // PDF literal strings are delimited by ( ) and escape \ ; cap the length
        // so an absurd name cannot blow up the page.
        return mb_substr($value, 0, 80);
    }

    /**
     * The repeated watermark text for one student. Two lines: the identity and
     * the platform brand, matching the video watermark's "Name • MED-####" form.
     *
     * @return array{0:string,1:string}
     */
    public function watermarkLines(string $fullName, string $publicUserId, bool $includeBrand = true): array
    {
        $name = $this->sanitizeIdentityLine($fullName);
        $id = $this->sanitizeIdentityLine($publicUserId);
        $identity = trim($name . ($id !== '' ? ' • ' . $id : ''));
        if ($identity === '') {
            $identity = 'MedAcademy';
        }
        return [$identity, $includeBrand ? 'MedAcademy — do not share' : ''];
    }

    /**
     * Cache identity of ONE personalized copy. Changes whenever the source bytes,
     * the student identity, or the watermark settings change — so a replaced
     * source PDF (or a settings change) can never reuse a stale copy.
     */
    public function variantKey(string $sourceHash, string $identityHash, array $settings): string
    {
        ksort($settings);
        return hash('sha256', implode('|', [$sourceHash, $identityHash, json_encode($settings, JSON_UNESCAPED_SLASHES)]));
    }

    /**
     * The engine/settings fingerprint that is folded into variantKey. Bumping
     * `engine` (or changing DPI / format / opacity) regenerates cached copies
     * instead of serving bytes produced by a different pipeline.
     *
     * @param array{0:string,1:string} $lines
     */
    public function variantSettings(array $lines): array
    {
        return [
            'engine' => 'flatten-v2',
            'mode' => $this->effectiveMode() ?? $this->configuredMode(),
            'dpi' => $this->dpi(),
            'format' => $this->imageFormat(),
            'opacity' => $this->opacity(),
            'lines' => $lines,
        ];
    }

    /** sha256 of the source bytes; also used to detect a replaced source. */
    public function sourceHash(string $sourceAbsPath): string
    {
        $hash = @hash_file('sha256', $sourceAbsPath);
        if ($hash === false) {
            throw new ApiException(500, 'Could not read the source PDF');
        }
        return $hash;
    }

    // ── Entry point ───────────────────────────────────────────────────────────

    /**
     * Produce the personalized PDF at $outAbsPath.
     *
     * Returns the page count. Throws — never silently returns the original or a
     * partial file:
     *   • 503 when the selected engine is not fully available (fail closed),
     *   • 415/422 when the source is not a usable PDF,
     *   • 500 when processing fails.
     */
    public function personalize(string $sourceAbsPath, array $lines, string $outAbsPath): int
    {
        if (!$this->isAvailable()) {
            throw new ApiException(503, 'PDF watermarking is not available on this server: no compatible engine is installed. The unwatermarked original will not be served.');
        }
        if (!is_file($sourceAbsPath) || filesize($sourceAbsPath) === 0) {
            throw new ApiException(422, 'The source PDF could not be read.');
        }

        // ── Structural validation before handing anything to the engine ──
        $head = (string) @file_get_contents($sourceAbsPath, false, null, 0, 1024);
        if (!str_starts_with($head, '%PDF-')) {
            throw new ApiException(422, 'This file is not a valid PDF and cannot be watermarked.');
        }
        $tail = (string) @file_get_contents($sourceAbsPath, false, null, max(0, (int) filesize($sourceAbsPath) - 4096));
        if (str_contains($tail, '/Encrypt')) {
            throw new ApiException(422, 'This PDF is encrypted and cannot be watermarked. Upload an unencrypted PDF.');
        }

        $dir = dirname($outAbsPath);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new ApiException(500, 'Could not create the output directory for the personalized PDF.');
        }

        try {
            $pages = $this->effectiveMode() === self::MODE_RASTER
                ? $this->renderRaster($sourceAbsPath, $lines, $outAbsPath)
                : $this->renderWithFpdfFpdi($sourceAbsPath, $lines, $outAbsPath);
        } catch (ApiException $e) {
            throw $e;
        } catch (\Throwable $e) {
            // Never leak a library stack trace to the client, and never fall back
            // to the original: the request fails closed.
            error_log('[pdf-watermark] generation failed: ' . $e->getMessage());
            throw new ApiException(500, 'The personalized PDF could not be generated.');
        }

        if (!is_file($outAbsPath) || filesize($outAbsPath) === 0) {
            throw new ApiException(500, 'The personalized PDF was not produced.');
        }
        return $pages;
    }

    // ── ENGINE A: rasterise → composite (watermark behind) → flatten ──────────

    /**
     * Flattened pipeline. Page order of operations per page:
     *   1. Ghostscript renders the ORIGINAL page to a transparent-background
     *      PNG (`pngalpha`) — the lecture ink, no white paper fill.
     *   2. A white canvas is prepared and the student watermark is drawn on it.
     *   3. The transparent page bitmap is composited ON TOP of the watermark.
     *   4. The composite is flattened to one opaque image and placed full-page
     *      into the output PDF (an image XObject — no text, no annotation).
     *
     * Pages are handled one at a time (bitmap freed after each), and the whole
     * document is bounded by a page-count and per-page pixel limit.
     */
    private function renderRaster(string $source, array $lines, string $out): int
    {
        $dpi = $this->dpi();
        $maxPages = $this->maxPages();
        $maxPixels = $this->maxPixelsPerPage();
        $format = $this->imageFormat();
        $quality = $this->jpegQuality();
        $opacity = $this->opacity();
        $timeout = max(15, Config::int('PDF_WATERMARK_TIMEOUT_SECONDS', 180));
        $gsBin = Config::string('GHOSTSCRIPT_BIN', 'gs');
        $font = $this->fontPath();
        $compositor = $this->detectCompositor();
        $memBytes = $this->memoryLimitBytes();
        if ($font === null || $compositor === null) {
            throw new ApiException(503, 'The flattened watermark engine is not fully available (missing font or compositor). The unwatermarked original will not be served.');
        }

        $work = $this->makeTempDir($out);
        try {
            // 1. Render up to maxPages+1 pages in ONE Ghostscript pass writing one
            //    PNG per page; rendering stops early so an oversized PDF cannot
            //    exhaust time. pngalpha = transparent unpainted background.
            $pattern = $work . '/page-%04d.png';
            $argv = [
                $gsBin, '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-dQUIET',
                '-sDEVICE=pngalpha', '-r' . $dpi,
                '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
                '-dFirstPage=1', '-dLastPage=' . ($maxPages + 1),
                '-dUseCropBox',
                '-sOutputFile=' . $pattern,
                $source,
                '-c', 'quit',
            ];
            [$code, , $stderr] = $this->runProcess($argv, $timeout);
            $pages = glob($work . '/page-*.png') ?: [];
            sort($pages, SORT_STRING);
            if ($code !== 0 && $pages === []) {
                error_log('[pdf-watermark] ghostscript failed: ' . substr($stderr, 0, 500));
                throw new ApiException(422, 'This PDF could not be rendered. It may be corrupt, encrypted or use an unsupported feature.');
            }
            if ($pages === []) {
                throw new ApiException(422, 'This PDF contained no renderable pages.');
            }
            if (count($pages) > $maxPages) {
                throw new ApiException(422, 'This PDF has more pages than the watermarking limit (' . $maxPages . ').');
            }

            // 2. Flatten each page and assemble the output PDF incrementally.
            $pdf = new \FPDF('P', 'pt');
            $pdf->SetAutoPageBreak(false);
            $pdf->SetMargins(0, 0, 0);

            $written = 0;
            foreach ($pages as $i => $pagePng) {
                $size = @getimagesize($pagePng);
                if ($size === false || (int) $size[0] < 1 || (int) $size[1] < 1) {
                    throw new ApiException(500, 'A rendered page could not be read back.');
                }
                $w = (int) $size[0];
                $h = (int) $size[1];
                if ($w * $h > $maxPixels) {
                    throw new ApiException(422, 'A page is too large to watermark at this resolution. Lower PDF_WATERMARK_DPI or raise PDF_WATERMARK_MAX_PIXELS_PER_PAGE.');
                }
                // Refuse before allocating rather than letting the worker die with
                // an uncatchable OOM fatal: two truecolor layers at 4 bytes/px
                // must fit within ~60% of the process memory limit.
                if ($memBytes !== null && $w * $h * 8 > (int) ($memBytes * 0.6)) {
                    throw new ApiException(422, 'A page needs more memory than this server allows (PHP memory_limit). Raise memory_limit or lower PDF_WATERMARK_DPI.');
                }

                $flat = $work . '/flat-' . $i . ($format === 'jpeg' ? '.jpg' : '.png');
                $this->compositePage($pagePng, $flat, $w, $h, $lines, $dpi, $opacity, $format, $quality, $compositor, $font);

                // Preserve the ORIGINAL page size + orientation: the PNG pixel
                // size at $dpi converts back to points 1:1.
                $wPt = $w * 72 / $dpi;
                $hPt = $h * 72 / $dpi;
                $orientation = $wPt > $hPt ? 'L' : 'P';

                $pdf->AddPage($orientation, [$wPt, $hPt]);
                $pdf->Image($flat, 0, 0, $wPt, $hPt, $format === 'jpeg' ? 'JPG' : 'PNG');

                // The page bitmap has already been composited into $flat, so it
                // can be freed now. $flat must NOT be deleted yet: FPDF reads a
                // PNG lazily at Output() time, so the flat images are removed by
                // cleanupDir() only AFTER the document has been written.
                @unlink($pagePng);
                $written++;
            }

            if ($written === 0) {
                throw new ApiException(500, 'No pages were watermarked.');
            }

            $pdf->Output($out, 'F');
            if (!is_file($out) || filesize($out) === 0) {
                throw new ApiException(500, 'The personalized PDF was not produced.');
            }
            return $written;
        } finally {
            $this->cleanupDir($work);
        }
    }

    /**
     * Composite ONE page: watermark (bottom) ← transparent page content (top).
     * Dispatches to the detected compositor. $outImage is a PNG or JPEG.
     *
     * @param array{0:string,1:string} $lines
     */
    private function compositePage(
        string $pagePng,
        string $outImage,
        int $w,
        int $h,
        array $lines,
        int $dpi,
        float $opacity,
        string $format,
        int $quality,
        string $compositor,
        string $font
    ): void {
        if ($compositor === 'imagick') {
            $this->compositeImagick($pagePng, $outImage, $w, $h, $lines, $dpi, $opacity, $format, $quality, $font);
            return;
        }
        $this->compositeGd($pagePng, $outImage, $w, $h, $lines, $dpi, $opacity, $format, $quality, $font);
    }

    /** Imagick compositor (preferred where the extension exists). */
    private function compositeImagick(
        string $pagePng,
        string $outImage,
        int $w,
        int $h,
        array $lines,
        int $dpi,
        float $opacity,
        string $format,
        int $quality,
        string $font
    ): void {
        $base = (int) round(255 - $opacity * (255 - 90)); // 255 = white, lower = darker
        $canvas = new \Imagick();
        $canvas->newImage($w, $h, new \ImagickPixel('white'));
        $canvas->setImageFormat('png');

        $draw = new \ImagickDraw();
        $draw->setFillColor(new \ImagickPixel('rgb(' . $base . ',' . $base . ',' . $base . ')'));
        $draw->setFont($font);
        $draw->setFontSize(max(9, (int) round($dpi * 0.08)));

        foreach ($this->watermarkPlacements($lines, $w, $h, $dpi, $font) as $p) {
            $draw->push();
            $draw->rotate($p['angle']);
            $draw->annotation($p['x'], $p['y'], $p['text']);
            $draw->pop();
        }
        $canvas->drawImage($draw);

        $fg = new \Imagick($pagePng);
        $canvas->compositeImage($fg, \Imagick::COMPOSITE_OVER, 0, 0);

        if ($format === 'jpeg') {
            $canvas->setImageFormat('jpeg');
            $canvas->setImageCompressionQuality($quality);
        } else {
            $canvas->setImageFormat('png');
            // The composite is opaque (white paper); strip the alpha channel so
            // FPDF can parse the PNG with or without the GD extension.
            $canvas->setImageAlphaChannel(\Imagick::ALPHACHANNEL_REMOVE);
            $canvas->setImageType(\Imagick::IMGTYPE_TRUECOLOR);
        }
        $canvas->writeImage($outImage);

        $fg->clear();
        $canvas->clear();
    }

    /** GD compositor (shared-hosting fallback; needs FreeType). */
    private function compositeGd(
        string $pagePng,
        string $outImage,
        int $w,
        int $h,
        array $lines,
        int $dpi,
        float $opacity,
        string $format,
        int $quality,
        string $font
    ): void {
        $canvas = imagecreatetruecolor($w, $h);
        if ($canvas === false) {
            throw new ApiException(500, 'Could not allocate the watermark canvas.');
        }
        $white = imagecolorallocate($canvas, 255, 255, 255);
        imagefilledrectangle($canvas, 0, 0, $w, $h, $white);

        // Opacity is realised as a grey level on the white canvas: opacity 0 →
        // pure white (invisible), higher → darker grey.
        $base = (int) round(255 - $opacity * (255 - 90));
        $ink = imagecolorallocate($canvas, $base, $base, $base);

        $fontSize = max(9, (int) round($dpi * 0.08));
        foreach ($this->watermarkPlacements($lines, $w, $h, $dpi, $font) as $p) {
            imagettftext($canvas, $fontSize, $p['angle'], (int) $p['x'], (int) $p['y'], $ink, $font, $p['text']);
        }

        // Composite the transparent-content page bitmap ON TOP of the watermark.
        $fg = @imagecreatefrompng($pagePng);
        if ($fg === false) {
            imagedestroy($canvas);
            throw new ApiException(500, 'A rendered page could not be loaded for compositing.');
        }
        imagealphablending($canvas, true);
        imagecopy($canvas, $fg, 0, 0, 0, 0, $w, $h);
        imagedestroy($fg);

        if ($format === 'jpeg') {
            imagejpeg($canvas, $outImage, $quality);
        } else {
            imagepng($canvas, $outImage, 6);
        }
        imagedestroy($canvas);
    }

    /**
     * Repeated diagonal grid of identity text. Spacing adapts to the page so a
     * small page is not over-stamped and a large one is not left bare. The two
     * lines alternate. Returns absolute coordinates in image pixels.
     *
     * This is the SINGLE source of placement for both compositors, so the
     * "behind the content" arrangement is identical whichever one runs.
     *
     * @param array{0:string,1:string} $lines
     * @return array<int,array{x:float,y:float,angle:int,text:string}>
     */
    private function watermarkPlacements(array $lines, int $w, int $h, int $dpi, string $font): array
    {
        $texts = array_values(array_filter($lines, static fn ($t) => $t !== ''));
        if ($texts === []) {
            $texts = ['MedAcademy'];
        }
        $fontSize = max(9, (int) round($dpi * 0.08));

        // Measure a representative line to space the grid honestly. imagettfbbox
        // only exists with GD, but the Imagick compositor does NOT require GD —
        // so guard the call and fall back to a width estimate rather than
        // fatally calling an undefined function.
        $sample = $texts[0];
        $box = function_exists('imagettfbbox') ? @imagettfbbox($fontSize, 0, $font, $sample) : false;
        $textW = ($box !== false && is_array($box)) ? abs($box[4] - $box[0]) : (int) ($fontSize * strlen($sample) * 0.6);
        $textH = ($box !== false && is_array($box)) ? abs($box[5] - $box[1]) : $fontSize;

        $stepX = max(200.0, $textW * 1.8);
        $stepY = max(140.0, $textH * 6.0);

        $out = [];
        $i = 0;
        for ($y = $stepY; $y < $h + $stepY; $y += $stepY) {
            for ($x = $stepX * 0.5; $x < $w + $stepX; $x += $stepX) {
                $out[] = [
                    'x' => $x,
                    'y' => $y,
                    'angle' => 45,
                    'text' => $texts[$i % count($texts)],
                ];
                $i++;
            }
        }
        return $out;
    }

    // ── ENGINE B: vector re-emission (FPDI/FPDF) — preserved ──────────────────

    /**
     * The drawing routine. Only reached when the vector engine is selected.
     *
     * ORDER MATTERS: the watermark is painted into each page's content stream
     * BEFORE the imported page is placed, so the lecture content — text,
     * diagrams, images — is composited ON TOP and stays fully legible. That is
     * the "background watermark" requirement.
     */
    private function renderWithFpdfFpdi(string $source, array $lines, string $out): int
    {
        $pdf = class_exists(\setasign\Fpdi\Fpdi::class)
            ? new \setasign\Fpdi\Fpdi()
            : new \FPDI();

        $pageCount = $pdf->setSourceFile($source);
        if ($pageCount < 1) {
            throw new ApiException(422, 'This PDF has no pages.');
        }

        $hasAlpha = method_exists($pdf, 'SetAlpha');
        $hasRotate = method_exists($pdf, 'Rotate');

        for ($pageNo = 1; $pageNo <= $pageCount; $pageNo++) {
            $tpl = $pdf->importPage($pageNo);
            // Preserve the ORIGINAL page size and orientation for every page,
            // including mixed sizes in one document.
            $size = $pdf->getTemplateSize($tpl);
            $w = (float) $size['width'];
            $h = (float) $size['height'];
            $orientation = ($size['orientation'] ?? ($w > $h ? 'L' : 'P'));

            $pdf->AddPage($orientation, [$w, $h]);

            // ── 1. Watermark layer, painted FIRST so it sits behind ──
            if ($hasAlpha) {
                $pdf->SetAlpha(0.10);
            }
            $pdf->SetTextColor(150, 150, 150);
            $pdf->SetFont('Helvetica', 'B', 14);

            // Repeated diagonal grid. The spacing adapts to the page so a small
            // page is not over-stamped and a large one is not left bare.
            $stepX = max(150.0, $w / 2.2);
            $stepY = max(110.0, $h / 4.0);
            $lineIndex = 0;
            for ($y = -$h * 0.15; $y < $h * 1.15; $y += $stepY) {
                for ($x = -$w * 0.15; $x < $w * 1.15; $x += $stepX) {
                    $text = $lines[$lineIndex % max(1, count($lines))] ?? '';
                    $lineIndex++;
                    if ($text === '') {
                        continue;
                    }
                    if ($hasRotate) {
                        $pdf->Rotate(45, $x, $y);
                        $pdf->Text($x, $y, $text);
                        $pdf->Rotate(0);
                    } else {
                        $pdf->Text($x, $y, $text);
                    }
                }
            }
            if ($hasAlpha) {
                $pdf->SetAlpha(1);
            }

            // ── 2. The ORIGINAL page, drawn ON TOP of the watermark ──
            $pdf->useTemplate($tpl, 0, 0, $w, $h);
        }

        $pdf->Output($out, 'F');
        return $pageCount;
    }

    // ── Process + temp-file helpers ───────────────────────────────────────────

    /**
     * Run an argv array without a shell (no string interpolation, so no command
     * injection surface) and with a wall-clock timeout.
     *
     * @param array<int,string> $argv
     * @return array{0:int,1:string,2:string} [exitCode, stdout, stderr]
     */
    private function runProcess(array $argv, int $timeout): array
    {
        $descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $proc = @proc_open($argv, $descriptors, $pipes);
        if (!is_resource($proc)) {
            throw new ApiException(503, 'The PDF renderer process could not be started.');
        }
        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $stdout = '';
        $stderr = '';
        $start = microtime(true);
        $timedOut = false;
        while (true) {
            $read = [$pipes[1], $pipes[2]];
            $write = null;
            $except = null;
            @stream_select($read, $write, $except, 0, 200000);
            foreach ($read as $stream) {
                $chunk = fread($stream, 8192);
                if ($chunk !== false && $chunk !== '') {
                    if ($stream === $pipes[1]) {
                        $stdout .= $chunk;
                    } else {
                        $stderr .= $chunk;
                    }
                }
            }
            $status = proc_get_status($proc);
            if (!$status['running']) {
                break;
            }
            if (microtime(true) - $start > $timeout) {
                $timedOut = true;
                proc_terminate($proc, 9);
                break;
            }
        }
        $stdout .= (string) stream_get_contents($pipes[1]);
        $stderr .= (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($proc);

        if ($timedOut) {
            throw new ApiException(504, 'The PDF renderer timed out.');
        }
        return [$code, $stdout, $stderr];
    }

    /** Private sibling scratch directory for one generation. */
    private function makeTempDir(string $out): string
    {
        $dir = dirname($out) . '/wm-' . bin2hex(random_bytes(6));
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new ApiException(500, 'Could not create a temporary working directory.');
        }
        return $dir;
    }

    /** Remove every file in a scratch directory, then the directory itself. */
    private function cleanupDir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (glob($dir . '/*') ?: [] as $file) {
            @unlink($file);
        }
        @rmdir($dir);
    }
}
