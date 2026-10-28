<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Config;

/**
 * PdfWatermarkService — personalized student watermarking for lesson PDFs.
 *
 * Produces ONE per-student copy of a teacher-uploaded source PDF. Three
 * renderers exist; the deployment picks one with PDF_WATERMARK_MODE, and `auto`
 * (the default) prefers them in the order below — pure PHP first, because the
 * production host is ordinary shared cPanel hosting with no shell tools.
 *
 * ── ENGINE A: "vector" via FPDI 2.x + TCPDF 6 — THE DEFAULT ────────────────
 * FPDI re-emits each original page as a Form XObject. Per page the service now
 * draws FOUR redundant representations (see "LAYERS") and keeps the original
 * page geometry (mixed sizes, /Rotate) without rasterising anything.
 *
 * ── LAYERS (why the mark is no longer one deletable block) ─────────────────
 *  A. BACK  — a sparse diagonal grid painted BEFORE the imported page, so the
 *             lecture ink covers it and the margins still read the identity.
 *  B. FRONT — identity marks at varied angles ACROSS the page, painted AFTER
 *             the lecture page, so they cross body text, tables and figures
 *             instead of only living in whitespace. A white box or a crop no
 *             longer removes them everywhere.
 *  C. TRACE — a lattice of ~2pt dots plus an 8x4 dot matrix that encodes a
 *             32-bit code derived from the recipient identity. It is not text,
 *             so "delete the text objects" leaves it behind, and its absence
 *             is itself evidence of tampering (see traceCode()).
 *  D. RAILS — the full identity on all four edges (two horizontal, two
 *             vertical), each placed with measured width so the id is never
 *             clipped at the page boundary.
 *  E. ANCHOR — one small, darker stamp INSIDE the content area at a seeded
 *             position and angle. The tinted layers can be thresholded away and
 *             the rails can be cropped, but neither removes a mark in the
 *             interior without also destroying the lecture around it.
 *
 * Then the marks are BAKED: PdfWatermarkBaker appends a second, differently
 * seeded set of marks INSIDE the imported page's own content stream. The page
 * content and the watermark then share one stream, so "keep the page XObject,
 * drop the rest of the page operators" — the one-line way to strip the previous
 * implementation — no longer yields a clean page.
 *
 * ── ENGINE B: "raster" (image per page) — DOUBLE-GATED, SEE LICENCE BELOW ──
 * Every page is rendered to a bitmap and ONE centred, diagonal watermark is
 * painted INTO that bitmap, and the flattened opaque page image is placed into
 * a new PDF. Each output page is then a single full-page image: no selectable
 * text layer, no separate watermark object, no annotation.
 *
 * The ONLY working renderer for this is Ghostscript, which is AGPL-3.0 or a
 * paid Artifex licence; Artifex's published position is that an AGPL
 * Ghostscript may not be used in a closed-source server-based service without
 * disclosing that service's source. It is therefore gated TWICE: the mode must
 * be asked for AND the operator must set PDF_WATERMARK_ACCEPT_AGPL_RENDERER=1.
 * Without that flag the engine reports itself unavailable and delivery is
 * refused (503) — it never silently runs AGPL code on a commercial install.
 *
 * ── ENGINE F: "flatten" — ONE centred mark INSIDE the page stream, no binary ─
 * Same single centred diagonal mark as ENGINE B, but baked straight into each
 * imported page's own content stream with operators (PdfWatermarkBaker) instead
 * of into a bitmap. Nothing outside the vendored MIT/LGPL PHP libraries is
 * executed: no Ghostscript, no shell, no network, no extra font file. The mark
 * is page content, not an annotation, optional-content group or separate text
 * object, so a reader's "remove watermark" command has nothing to target — but
 * the lecture text layer survives, which is the documented trade-off versus
 * ENGINE B.
 *
 * ── LICENSING (see backend/docs/PDF_WATERMARK_LICENSING.md) ────────────────
 * ENGINES A/C/F: setasign/fpdf (MIT) + setasign/fpdi (MIT) + tecnickcom/tcpdf
 * (LGPL-3.0-or-later, dynamically loaded PHP library) — no fee, no external
 * process, no network. ENGINE B additionally needs Ghostscript (AGPL or
 * commercial) and is gated as described above.
 *
 * ── ENGINE C: "vector" via FPDI + plain FPDF — fallback ────────────────────
 * Same ordering guarantee as ENGINE A using FPDF's core Helvetica instead of
 * TCPDF. Used only when TCPDF is absent; kept because it is the smallest
 * possible dependency set (FPDF 1.9 + FPDI 2.x).
 *
 * ── HOW ENGINE B FLATTENS ONE CENTRED MARK INTO THE PAGE ───────────────────
 * The page is rendered with Ghostscript's `pngalpha` device, which leaves the
 * unpainted page background TRANSPARENT (a normal viewer shows white paper, but
 * there is no white fill in the raster). Compositing order is then:
 *
 *     (1) opaque background canvas: white paper + the transparent-content page
 *         bitmap composited ON TOP (alpha = how much ink is at that pixel)
 *     (2) ONE centred diagonal identity mark painted OVER that composite, in
 *         ONE pass at exactly PDF_WATERMARK_OPACITY over a 107-grey face
 *     (3) flatten → one opaque page image
 *
 * A 0.12 alpha face over white paper lands at ~237/255: identifiable when you
 * look for it, without competing with the lecture underneath. It is composited
 * ONCE because any second pass (the old code drew a dilated white halo eight
 * times) compounds the alpha and delivers a mark several times heavier than the
 * setting. Because the mark is drawn into the SAME bitmap the lecture was
 * rasterised into, the delivered page holds a single image: the watermark
 * cannot be selected, deleted or "removed" as an object, and the lecture text
 * is no longer a text layer that can be stripped.
 *
 * ── FAIL CLOSED ────────────────────────────────────────────────────────────
 * If the selected engine is not fully available the delivery is REFUSED
 * (HTTP 503). The unwatermarked original is never served as a fallback, and a
 * partially processed document is never returned (the output is written to a
 * sibling temp file and only published after every page succeeded).
 *
 * ── LIMITS STATED PLAINLY ──────────────────────────────────────────────────
 * No PDF watermark survives a determined attacker, and this one does not claim
 * to. What the tests in backend/tests/pdf-watermark (removal_attacks.py) measure
 * is the actual cost of each attack, not a promise:
 *   • deleting page operators / keeping only the page XObject no longer removes
 *     the mark (it is inside that XObject too);
 *   • deleting the text leaves the dot lattice; deleting the images leaves the
 *     text; covering a region leaves the rest of the page covered;
 *   • a flatten-and-threshold attack on a black-on-white text page can still
 *     erase the visible grey marks (documented under "residual risk") — that is
 *     inherent to an overlay on bimodal content, and the lattice plus the four
 *     rails are what remain to attribute the copy.
 * Flattening (ENGINE B) is still the strongest mode where Ghostscript exists.
 */
final class PdfWatermarkService
{
    /** Dedicated private bucket for generated copies. NO /storage/signed route. */
    public const BUCKET = 'lesson-material-pdfs';

    /** Engine selectors (PDF_WATERMARK_MODE). */
    public const MODE_RASTER = 'raster';
    public const MODE_VECTOR = 'vector';
    public const MODE_FLATTEN = 'flatten';
    public const MODE_AUTO   = 'auto';

    /** Vendored pure-PHP PDF libraries are looked for here first. */
    private const VENDOR_DIRS = ['backend/lib/pdf', 'backend/vendor', 'vendor'];

    /**
     * TCPDF's own bundled, embedded Unicode TrueType face (DejaVu Sans). It ships
     * inside tecnickcom/tcpdf, so the watermark needs NO extra font upload and
     * NO system font: the glyphs are embedded in the generated PDF, which is
     * what keeps the mark identical in every viewer.
     *
     * The FAMILY is 'dejavusans' and the style selects the file
     * (dejavusans.php / dejavusansb.php) — passing the bold file name as the
     * family would make TCPDF look for a non-existent 'dejavusansbb'.
     */
    private const VECTOR_FONT = 'dejavusans';

    /** Background grid identity text, in points. */
    private const VECTOR_TEXT_PT = 14.0;

    /** Front marks (drawn OVER the lecture) are smaller than the back grid. */
    private const VECTOR_FRONT_PT = 10.0;

    /** The always-readable identity line on the page edges. */
    private const VECTOR_EDGE_PT = 7.0;

    /** Interior anchor text, in points. See drawTcpdfAnchor(). */
    private const VECTOR_ANCHOR_PT = 8.0;

    /** Version token of the layer layout; folded into the cache key. */
    private const LAYERS_VERSION = 'layers-v4';

    /** Raster engine — angle of the single centred watermark, in degrees. */
    private const RASTER_ANGLE_DEG = 35.0;

    /**
     * Raster-engine layout token, folded into the cache key: when the centred
     * layout changes, every cached raster copy must be regenerated instead of
     * serving bytes produced by the old tiled grid.
     */
    private const RASTER_LAYOUT = 'center-v1';

    /**
     * Flatten-engine layout token, folded into the cache key: it changes when the
     * single centred baked mark changes shape, so cached copies drawn by an older
     * layout are regenerated instead of served.
     */
    private const FLATTEN_LAYOUT = 'center-bake-v1';

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
    private bool $librariesLoaded = false;

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
        // Default is `auto`: pure-PHP vector first, raster only when the host
        // actually provides a renderer. A shared cPanel host never does, so the
        // default must not depend on Ghostscript.
        $mode = strtolower(trim(Config::string('PDF_WATERMARK_MODE', self::MODE_AUTO)));
        return in_array($mode, [self::MODE_RASTER, self::MODE_VECTOR, self::MODE_FLATTEN, self::MODE_AUTO], true)
            ? $mode
            : self::MODE_AUTO;
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
            'flatten_ready' => $s['flatten']['ready'],
            'agpl_renderer_accepted' => $s['raster']['licence_gate'] === 'accepted',
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
            'vector_engine' => $s['vector']['engine'],
            'requirement' => 'vector/flatten engine (default): setasign/fpdi 2.x + tecnickcom/tcpdf 6.x under backend/vendor; fallback: fpdi + fpdf; raster engine: additionally Ghostscript CLI + (GD w/ FreeType or Imagick) + a TTF font, AND an accepted AGPL-or-commercial Ghostscript licence (PDF_WATERMARK_ACCEPT_AGPL_RENDERER=1).',
            'behaviour_when_missing' => 'A student PDF is refused with HTTP 503 — the unwatermarked original is never served as a fallback.',
        ];
    }

    /** Detailed, secret-free capability report for both engines. */
    public function rendererStatus(): array
    {
        if ($this->rendererStatus !== null) {
            return $this->rendererStatus;
        }

        // The vendored FPDF/FPDI/TCPDF classes MUST be loaded before probing.
        // Only isAvailable() used to call loadLibraries(), so any caller that
        // asked for the STATUS first (the admin status endpoint, the CLI
        // diagnostics script) cached a "missing engine" verdict taken before
        // the autoloader had run — and because that verdict is memoised,
        // every later isAvailable() in the same request then refused
        // personalized delivery on a host where the engine IS installed.
        // Loading here makes "engine missing" mean what it says.
        $this->loadLibraries();

        // ── Raster engine prerequisites ──
        $canExec = $this->canExecute();
        $gsBin = Config::string('GHOSTSCRIPT_BIN', 'gs');
        $gsVersion = $canExec ? $this->probeGhostscript($gsBin) : null;
        $compositor = $this->detectCompositor();
        $font = $this->fontPath();
        // The flattened output is assembled with FPDF (image-only pages).
        $pdfWriter = class_exists(\FPDF::class);
        // ── LICENCE GATE ──
        // Ghostscript is AGPL-3.0 or a paid Artifex licence, and Artifex's
        // published position is that AGPL Ghostscript may not be shipped inside
        // a closed-source server-based service without disclosing that service's
        // source. So the binary being present is NOT enough: an operator has to
        // declare the licence position explicitly. Without the flag the engine
        // reports unavailable and delivery fails closed (503) — it never runs
        // AGPL code on a commercial install by accident.
        $agplAccepted = Config::bool('PDF_WATERMARK_ACCEPT_AGPL_RENDERER', false);
        $rasterPrereq = $canExec && $gsVersion !== null && $compositor !== null && $font !== null && $pdfWriter;
        $rasterReady = $rasterPrereq && $agplAccepted;

        $raster = [
            'ready' => $rasterReady,
            'prerequisites_ready' => $rasterPrereq,
            'licence_gate' => $agplAccepted
                ? 'accepted'
                : 'blocked (set PDF_WATERMARK_ACCEPT_AGPL_RENDERER=1 only with an Artifex licence or a documented AGPL position)',
            'shell_execution' => $canExec ? 'enabled' : 'disabled (proc_open unavailable/disabled)',
            'ghostscript_bin' => $gsBin,
            'ghostscript_version' => $gsVersion,
            'compositor' => $compositor,
            'font' => $font,
            'pdf_writer' => $pdfWriter ? 'FPDF' : 'missing',
        ];

        // ── Vector engine prerequisites ──
        // The TCPDF bridge class is only usable when BOTH halves are present:
        // setasign/fpdi ships src/Tcpdf/Fpdi.php, but instantiating it without
        // tecnickcom/tcpdf fatals, so both are required.
        $hasFpdi = class_exists(\setasign\Fpdi\Fpdi::class) || (class_exists('FPDI') && class_exists('FPDF'));
        $hasTcpdfBridge = $hasFpdi && class_exists(\setasign\Fpdi\Tcpdf\Fpdi::class) && class_exists(\TCPDF::class);
        $vectorEngine = $hasTcpdfBridge ? 'tcpdf' : ($hasFpdi ? 'fpdf' : null);
        $vector = [
            'ready' => $vectorEngine !== null,
            'engine' => $vectorEngine,
            'fpdi' => $hasFpdi ? 'present' : 'missing',
            'tcpdf' => class_exists(\TCPDF::class) ? 'present' : 'missing',
        ];

        // ── Renderer-free flattened engine (MODE_FLATTEN) ──
        // It bakes ONE centred mark into the page stream, reusing the DejaVu
        // face TCPDF embeds, so it needs the TCPDF bridge and nothing else: no
        // binary, no shell, no external font file, no network.
        $flattenReady = $vectorEngine === 'tcpdf';
        $flatten = [
            'ready' => $flattenReady,
            'engine' => $flattenReady ? 'tcpdf-bake' : null,
            'requires' => 'setasign/fpdi + tecnickcom/tcpdf (no renderer binary)',
        ];

        // ── Resolve the effective engine ──
        // `auto` prefers PURE PHP (no binaries, no shell, fits shared hosting);
        // the raster engine is only chosen when the operator explicitly asks
        // for it or when no vector engine can run.
        $mode = $this->configuredMode();
        $effective = null;
        if ($mode === self::MODE_RASTER) {
            $effective = $rasterReady ? self::MODE_RASTER : null;
        } elseif ($mode === self::MODE_FLATTEN) {
            $effective = $flattenReady ? self::MODE_FLATTEN : null;
        } elseif ($mode === self::MODE_VECTOR) {
            $effective = $vectorEngine !== null ? self::MODE_VECTOR : null;
        } else { // auto
            $effective = $vectorEngine !== null
                ? self::MODE_VECTOR
                : ($rasterReady ? self::MODE_RASTER : null);
        }

        $driver = null;
        if ($effective === self::MODE_RASTER) {
            $driver = 'raster: Ghostscript ' . ($gsVersion ?? '?') . ' + ' . $compositor . ' (one image per page, no text layer) — AGPL/commercial Ghostscript licence accepted by the operator';
        } elseif ($effective === self::MODE_FLATTEN) {
            $driver = 'flatten: setasign/FPDI 2.x + TCPDF 6.x (one centred mark baked into each page stream; no renderer binary, no shell, no network)';
        } elseif ($effective === self::MODE_VECTOR) {
            $driver = $vectorEngine === 'tcpdf'
                ? 'vector: setasign/FPDI 2.x + TCPDF 6.x (embedded DejaVu Sans)'
                : 'vector: setasign/FPDI + FPDF core font';
        }

        return $this->rendererStatus = [
            'configured_mode' => $mode,
            'effective_mode' => $effective,
            'effective_driver' => $driver,
            'raster' => $raster,
            'flatten' => $flatten,
            'vector' => $vector,
        ];
    }

    /**
     * One-line, path-free-enough diagnosis appended to the 503 message, so an
     * operator reading the API response (or the browser console) sees WHICH
     * piece is missing instead of a generic "no engine". Reports presence
     * booleans and the fixed relative locations only — no absolute paths, no
     * configuration values, nothing that helps an attacker.
     */
    private function missingEngineDetail(): string
    {
        $found = [];
        foreach (self::VENDOR_DIRS as $rel) {
            if (is_file(MEDACADEMY_BASE . '/' . $rel . '/autoload.php')) {
                $found[] = $rel . '/autoload.php';
            }
        }
        $autoload = $found === [] ? 'NOT FOUND in backend/vendor' : implode(' + ', $found);
        if ($found === []) {
            // The classic cPanel mistake: the zip is extracted one level too deep,
            // producing backend/<folder>/vendor/autoload.php. Naming it turns a
            // blind failure into a one-step fix.
            $nested = array_merge(
                glob(MEDACADEMY_BASE . '/*/vendor/autoload.php') ?: [],
                glob(MEDACADEMY_BASE . '/vendor/*/autoload.php') ?: []
            );
            if ($nested !== []) {
                $rel = ltrim(str_replace(MEDACADEMY_BASE, '', (string) $nested[0]), '/');
                $autoload .= ' (found at ' . $rel . ' — extract one level up)';
            }
        }
        $parts = [
            'autoload' => $autoload,
            'FPDI' => class_exists('setasign\\Fpdi\\Fpdi') ? 'loaded' : 'missing',
            'TCPDF' => class_exists('TCPDF') ? 'loaded' : 'missing',
            'zlib' => extension_loaded('zlib') ? 'yes' : 'NO',
            'mbstring' => extension_loaded('mbstring') ? 'yes' : 'NO',
        ];
        $out = [];
        foreach ($parts as $k => $v) {
            $out[] = $k . '=' . $v;
        }
        return implode(', ', $out);
    }

    /** Load vendored / Composer FPDF + FPDI when present. Idempotent. */
    private function loadLibraries(): void
    {
        if ($this->librariesLoaded) {
            return;
        }
        $this->librariesLoaded = true;
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

    /**
     * EFFECTIVE opacity of the flattened mark — the alpha the identity text is
     * composited at, applied exactly once.
     *
     * Before 2026-10-24 this value was fed through `0.55 + 1.5x`, so the default
     * 0.15 produced a 77.5 %-opaque face: a heavy grey banner that competed
     * with the lecture. It is now used verbatim, which makes the setting mean
     * what it says and keeps the mark a watermark rather than a headline.
     *
     * 0.10–0.14 is the designed band: on white paper a 0.12 mark over a
     * 107-grey face lands at ~237/255 luminance — clearly identifiable when you
     * look at it, no measurable effect on reading the text underneath.
     */
    public function opacity(): float
    {
        $raw = Config::string('PDF_WATERMARK_OPACITY', '0.12');
        $o = is_numeric($raw) ? (float) $raw : 0.12;
        return max(0.04, min(0.5, $o));
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
     * The two strings the watermark repeats.
     *
     *   [0] the COMPLETE identity: "Name • MED-####" — this is the line the
     *       rails, the baked marks and every page carry, and it is what makes a
     *       leaked copy attributable;
     *   [1] a SHORT label (the name alone, or the id when the name cannot be
     *       drawn). It is used to fill the remaining marks: the long
     *       "MedAcademy — do not share" brand line used to consume the space a
     *       second identity could have used, which is why the id often came out
     *       clipped or fragmented.
     *
     * Neither value is hard-coded: both come from the caller's profile row.
     *
     * @return array{0:string,1:string}
     */
    public function watermarkLines(string $fullName, string $publicUserId): array
    {
        $name = $this->renderableName($this->sanitizeIdentityLine($fullName));
        $id = $this->sanitizeIdentityLine($publicUserId);
        $identity = trim($name . ($name !== '' && $id !== '' ? ' • ' : '') . $id);
        if ($identity === '') {
            $identity = 'MedAcademy';
        }
        // The short label must never duplicate the identity, or the grid would
        // be twelve copies of one line and lose the readability of the name.
        $label = $name !== '' ? $name : $id;
        if ($label === $identity) {
            $label = '';
        }
        return [$identity, $label];
    }

    /**
     * Whether a name can actually be DRAWN legibly by this pipeline.
     *
     * The watermark renderer draws straight through the PDF text operators and
     * does no contextual shaping or bidi reordering. Latin (with diacritics),
     * Greek and Cyrillic are covered by the embedded face; Arabic, Hebrew,
     * Indic and CJK are NOT — drawing them would emit disconnected letterforms
     * or blank glyphs and make the mark look corrupted.
     *
     * For those names the identity line keeps the account id, which is unique,
     * stable and the part that actually proves who a leaked copy belonged to.
     * A name is never rendered as mojibake.
     */
    private function renderableName(string $name): string
    {
        if ($name === '') {
            return '';
        }
        $needsShaping = '/[\x{0590}-\x{08FF}\x{0900}-\x{0DFF}\x{0E00}-\x{0E7F}\x{0F00}-\x{0FFF}'
            . '\x{1000}-\x{109F}\x{1100}-\x{11FF}\x{1780}-\x{17FF}\x{2E80}-\x{9FFF}'
            . '\x{A960}-\x{A97F}\x{AC00}-\x{D7AF}\x{F900}-\x{FAFF}\x{FE30}-\x{FEFF}'
            . '\x{FF00}-\x{FFEF}]/u';
        if (preg_match($needsShaping, $name) === 1) {
            return '';
        }
        return $name;
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
        $mode = $this->effectiveMode() ?? $this->configuredMode();
        // The engine token changes when the RENDERER changes, so switching
        // engines (or upgrading TCPDF's drawing) regenerates every cached copy
        // instead of serving bytes produced by a different pipeline.
        $settings = [
            'engine' => $mode === self::MODE_RASTER
                ? 'flatten-v4-single'
                : ($mode === self::MODE_FLATTEN
                    ? self::FLATTEN_LAYOUT
                    : 'vector-v4:' . ($this->rendererStatus()['vector']['engine'] ?? 'none')),
            'mode' => $mode,
            'lines' => $lines,
        ];
        if ($mode === self::MODE_RASTER) {
            // Raster-only knobs: they do not affect the vector output, so they
            // must not invalidate its cache when an operator tunes them.
            $settings['raster_layout'] = self::RASTER_LAYOUT;
            $settings['raster_angle'] = self::RASTER_ANGLE_DEG;
            $settings['opacity'] = $this->opacity();
            $settings['dpi'] = $this->dpi();
            $settings['format'] = $this->imageFormat();
        } elseif ($mode === self::MODE_FLATTEN) {
            // The flattened engine is pure PHP but is NOT cache-compatible with
            // the vector one: it draws a different mark, so its own knobs go in.
            $settings['flatten_layout'] = self::FLATTEN_LAYOUT;
            $settings['flatten_angle'] = self::RASTER_ANGLE_DEG;
            $settings['flatten_tone'] = $this->centerInk()['tone'];
            $settings['opacity'] = $this->opacity();
            $settings['flatten_font'] = self::VECTOR_FONT;
        } else {
            // The VECTOR opacity is a different knob (PDF_WATERMARK_VECTOR_OPACITY)
            // and it must be part of the cache identity: without it, tuning the
            // setting kept serving copies drawn with the previous value.
            $settings['vector_opacity'] = $this->vectorOpacity();
            $settings['vector_front_opacity'] = $this->vectorForegroundOpacity();
            $settings['vector_font'] = self::VECTOR_FONT;
            $settings['vector_text_pt'] = self::VECTOR_TEXT_PT;
            // A copy generated by an older layer layout must be regenerated: the
            // extra layers are what make the mark hard to strip, so serving a
            // cached "one diagonal block" copy would silently undo the fix.
            $settings['layers'] = self::LAYERS_VERSION;
        }
        return $settings;
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
    /**
     * Validate a PDF that is about to be STORED (an upload) or delivered, using
     * the SAME rules the renderer applies — one definition of "a usable PDF".
     *
     * WHY THIS IS PUBLIC: the upload path must never accept a file that delivery
     * would later refuse, and it must never accept a file that is not really a
     * PDF at all. Before this the only gate was the filename extension, so a
     * 0-byte (or truncated, or encrypted, or HTML-named-.pdf) attachment was
     * stored as a "successful" material and only failed later, at a student's
     * download.
     *
     * Returns the page count when the parser could determine it (null for a
     * structurally valid document the bundled parser cannot read — the render
     * failure for those is reported with its own code at delivery time).
     *
     * Throws ApiException with a stable code:
     *   pdf_empty, source_too_large, pdf_invalid, pdf_encrypted, pdf_truncated.
     */
    public function inspect(string $absPath): array
    {
        $size = is_file($absPath) ? (int) @filesize($absPath) : 0;
        if ($size <= 0) {
            throw new ApiException(422, 'The file is empty.', 'pdf_empty');
        }
        if ($size > $this->maxSourceBytes()) {
            throw new ApiException(
                422,
                'This PDF is larger than the watermarking limit ('
                . (int) round($this->maxSourceBytes() / 1048576) . ' MB).',
                'source_too_large'
            );
        }

        $head = (string) @file_get_contents($absPath, false, null, 0, 1024);
        if (!str_starts_with($head, '%PDF-')) {
            throw new ApiException(422, 'This file is not a valid PDF.', 'pdf_invalid');
        }

        // A missing trailer means the transfer stopped early: the bytes on disk
        // are a PREFIX of a real document. Catch it now, not at delivery.
        $tail = (string) @file_get_contents($absPath, false, null, max(0, $size - 4096));
        if (!str_contains($tail, '%%EOF')) {
            throw new ApiException(
                422,
                'This PDF is incomplete (the file was cut short while uploading). Please upload it again.',
                'pdf_truncated'
            );
        }
        if (str_contains($tail, '/Encrypt')) {
            throw new ApiException(422, 'This PDF is encrypted and cannot be watermarked. Upload an unencrypted PDF.', 'pdf_encrypted');
        }

        // Parser-grade check with the library that will actually render it. A
        // document the engine cannot open is rejected HERE, where the doctor can
        // still act on the message, instead of failing every student's download.
        //
        // WHICH engine will render decides whether this check is even relevant:
        // the free FPDI parser cannot read COMPRESSED cross-reference streams
        // (the layout Acrobat, Word and most "optimised" PDFs emit), while the
        // RASTER engine hands the file to Ghostscript, which reads them fine. The
        // check used to run unconditionally whenever FPDI merely existed, so a
        // raster host refused perfectly deliverable documents at upload — and a
        // vector host refused them with a message that said "damaged", which is
        // both wrong and unactionable. Now the parse runs only when FPDI is the
        // renderer, and its "cannot read this container" case is reported as its
        // own, explained code.
        $mode = $this->effectiveMode();
        $fpdiRenders = $mode === self::MODE_VECTOR || $mode === self::MODE_FLATTEN;
        $pages = null;
        if ($fpdiRenders && class_exists('setasign\\Fpdi\\Fpdi')) {
            try {
                $reader = new \setasign\Fpdi\Fpdi();
                $pages = (int) $reader->setSourceFile($absPath);
                if ($pages < 1) {
                    throw new \RuntimeException('no pages');
                }
            } catch (\Throwable $e) {
                $unsupported = $this->isUnsupportedContainer($e);
                $encrypted = !$unsupported && $this->isEncryptedDocument($e);
                error_log('[pdf-inspect] parser rejected the document (' . get_class($e) . ')'
                    . ($unsupported ? ' [unsupported container]' : ($encrypted ? ' [encrypted]' : ' [damaged]'))
                    . ': ' . $e->getMessage());
                if ($unsupported) {
                    throw new ApiException(
                        422,
                        'This PDF is saved in a compressed format the watermarking engine cannot read. Re-export it as a standard PDF '
                        . '(in Acrobat/Word choose "Print to PDF", or save with PDF 1.4 compatibility) and upload that copy.',
                        'pdf_unsupported_format',
                        $e
                    );
                }
                if ($encrypted) {
                    throw new ApiException(422, 'This PDF is encrypted and cannot be watermarked. Upload an unencrypted PDF.', 'pdf_encrypted', $e);
                }
                throw new ApiException(
                    422,
                    'This PDF could not be read (it may be damaged or use an unsupported format). Please upload a different copy.',
                    'pdf_invalid',
                    $e
                );
            } finally {
                // FPDI keeps the source stream open for the reader's lifetime; on
                // Windows an open handle blocks the rename that stores the file,
                // so it must be released before the caller moves it.
                unset($reader);
                gc_collect_cycles();
            }
        }

        return ['size' => $size, 'page_count' => $pages];
    }

    /**
     * Did the parser fail because of the FILE's container format (compressed
     * cross-reference / object streams) rather than because the document is
     * damaged?
     *
     * The distinction is what makes the error actionable: "re-export as a
     * standard PDF" fixes the first case, while a damaged file needs a new copy
     * from wherever it came from. FPDI reports it as CrossReferenceException with
     * a "compression technique ... not supported" message and the COMPRESSED_XREF
     * code — but the SAME class is thrown for truly broken xref tables, which must
     * stay pdf_invalid. So the message and that specific code are what is matched,
     * never the class name alone.
     */
    private function isUnsupportedContainer(\Throwable $e): bool
    {
        for ($c = $e; $c !== null; $c = $c->getPrevious()) {
            // The MESSAGE is checked first: it is what distinguishes "this parser
            // cannot decompress the container" from the same exception class being
            // thrown for genuine damage.
            if (stripos($c->getMessage(), 'compression technique') !== false
                || stripos($c->getMessage(), 'not supported by the free parser') !== false
            ) {
                return true;
            }
            // CrossReferenceException is ALSO thrown for real corruption — an xref
            // position pointing at the wrong object type, a missing startxref, an
            // object that is not where the table says. Classifying those as
            // "compressed format, please re-export" told the doctor to redo work on
            // a file that is actually broken, so only the one code that means
            // "compressed xref/object streams" is treated as a container issue here.
            if (class_exists('setasign\\Fpdi\\PdfParser\\CrossReference\\CrossReferenceException')
                && $c instanceof \setasign\Fpdi\PdfParser\CrossReference\CrossReferenceException
                && $c->getCode() === \setasign\Fpdi\PdfParser\CrossReference\CrossReferenceException::COMPRESSED_XREF
            ) {
                return true;
            }
        }
        return false;
    }

    /**
     * Did the parser refuse because the document is encrypted?
     *
     * Necessary on top of the tail `/Encrypt` scan: the trailer that carries
     * `/Encrypt` can sit further than 4 KB from EOF in a large document, and then
     * the scan misses it while the parser still refuses the file.
     */
    private function isEncryptedDocument(\Throwable $e): bool
    {
        for ($c = $e; $c !== null; $c = $c->getPrevious()) {
            if (stripos($c->getMessage(), 'encrypt') !== false) {
                return true;
            }
            if (class_exists('setasign\\Fpdi\\PdfParser\\CrossReference\\CrossReferenceException')
                && $c instanceof \setasign\Fpdi\PdfParser\CrossReference\CrossReferenceException
                && $c->getCode() === \setasign\Fpdi\PdfParser\CrossReference\CrossReferenceException::ENCRYPTED
            ) {
                return true;
            }
        }
        return false;
    }

    public function personalize(string $sourceAbsPath, array $lines, string $outAbsPath): int
    {
        // ── RENDER BUDGET (delivery-stage fix) ────────────────────────────────
        // The layered vector engine is much heavier than the previous "one
        // diagonal block" version (BASE grid + imported page + FRONT marks +
        // trace lattice + rails + interior anchor + the content bake, per page).
        // On shared cPanel hosting the default max_execution_time is 30 s, and
        // because the layer token changed, EVERY cached copy had to be
        // regenerated after the upgrade — so a large or complex source PDF could
        // exhaust the worker mid-render for every student at once. A PHP fatal on
        // timeout produces no JSON error at all (the client only sees the generic
        // "personalized copy could not be prepared"), which is exactly the
        // reported symptom.
        //
        // Raising the limit is bounded and explicit: the operator sets
        // PDF_WATERMARK_TIME_LIMIT_SECONDS (default 90) and nothing else in the
        // request may use it — the value is restored immediately after the
        // render below. A timeout that still happens now fails with a NAMED
        // exception instead of a bare fatal.
        $previousTimeLimit = null;
        try {
            $previousTimeLimit = (int) ini_get('max_execution_time');
        } catch (\Throwable) {
            $previousTimeLimit = null;
        }
        $budget = max(30, Config::int('PDF_WATERMARK_TIME_LIMIT_SECONDS', 90));
        if ($previousTimeLimit !== null && ($previousTimeLimit === 0 || $previousTimeLimit < $budget)) {
            @set_time_limit($budget);
        }
        try {
            return $this->personalizeWithinBudget($sourceAbsPath, $lines, $outAbsPath);
        } finally {
            // Restore the worker's own limit so the longer budget cannot leak
            // into unrelated work on a reused FPM worker.
            if ($previousTimeLimit !== null && $previousTimeLimit > 0) {
                @set_time_limit($previousTimeLimit);
            }
        }
    }

    /** Body of personalize(), run under the bounded render budget above. */
    private function personalizeWithinBudget(string $sourceAbsPath, array $lines, string $outAbsPath): int
    {
        if (!$this->isAvailable()) {
            throw new ApiException(503, 'PDF watermarking is not available on this server: no compatible engine is installed (' . $this->missingEngineDetail() . '). Install it in backend/vendor (composer install --no-dev, or upload vendor-pdf-engine.zip and extract it into backend/). The unwatermarked original will not be served.', 'engine_unavailable');
        }
        if (!is_file($sourceAbsPath) || filesize($sourceAbsPath) === 0) {
            throw new ApiException(422, 'The source PDF could not be read.', 'source_unreadable');
        }
        // Bound the parse itself: FPDI loads the cross-reference data of the
        // WHOLE document, so an absurd upload can exhaust the worker before a
        // single page is drawn. Refuse early with an actionable message.
        $sourceBytes = (int) @filesize($sourceAbsPath);
        if ($sourceBytes > $this->maxSourceBytes()) {
            throw new ApiException(
                422,
                'This PDF is larger than the watermarking limit ('
                . (int) round($this->maxSourceBytes() / 1048576) . ' MB).',
                'source_too_large'
            );
        }

        // ── Structural validation before handing anything to the engine ──
        $head = (string) @file_get_contents($sourceAbsPath, false, null, 0, 1024);
        if (!str_starts_with($head, '%PDF-')) {
            throw new ApiException(422, 'This file is not a valid PDF and cannot be watermarked.', 'source_not_pdf');
        }
        $tail = (string) @file_get_contents($sourceAbsPath, false, null, max(0, (int) filesize($sourceAbsPath) - 4096));
        if (str_contains($tail, '/Encrypt')) {
            throw new ApiException(422, 'This PDF is encrypted and cannot be watermarked. Upload an unencrypted PDF.', 'source_encrypted');
        }

        $dir = dirname($outAbsPath);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new ApiException(500, 'Could not create the output directory for the personalized PDF.', 'storage_unwritable');
        }

        try {
            $mode = $this->effectiveMode();
            if ($mode === self::MODE_RASTER) {
                $pages = $this->renderRaster($sourceAbsPath, $lines, $outAbsPath);
            } elseif ($mode === self::MODE_FLATTEN) {
                $pages = $this->renderFlatten($sourceAbsPath, $lines, $outAbsPath);
            } else {
                $pages = $this->renderVector($sourceAbsPath, $lines, $outAbsPath);
            }
        } catch (ApiException $e) {
            throw $e;
        } catch (\Throwable $e) {
            // Never leak a library stack trace to the client, and never fall back
            // to the original: the request fails closed.
            //
            // STAGE DIAGNOSTICS: the class + message of the real cause are logged
            // server-side (never in the response) and attached as `previous`, so
            // ErrorHandler's log carries them too and the audit row can name the
            // stage. Without this a failing engine only ever produced the generic
            // "could not be generated", which is why the cause of a live delivery
            // failure could not be identified from the API response alone.
            error_log('[pdf-watermark] render failed (' . get_class($e) . '): ' . $e->getMessage());
            throw new ApiException(
                500,
                'The personalized PDF could not be generated.',
                'render_failed',
                $e
            );
        }

        if (!is_file($outAbsPath) || filesize($outAbsPath) === 0) {
            throw new ApiException(500, 'The personalized PDF was not produced.', 'output_missing');
        }
        return $pages;
    }

    // ── ENGINE F: renderer-free flattening (pure PHP, one centred mark) ──────

    /**
     * Flattened pipeline that needs NO renderer binary.
     *
     * Why this exists: the image-per-page engine (ENGINE B) can only be driven by
     * Ghostscript, which is AGPL-3.0 or a paid Artifex licence — unusable in a
     * closed-source commercial service without buying that licence. Every other
     * renderer is either copyleft (Poppler: GPL-2.0-or-later, MuPDF: AGPL) or has
     * no installable CLI (PDFium: BSD, but a library needing FFI and a VPS), and
     * ImageMagick's PDF delegate simply calls Ghostscript again. So this engine
     * removes the need for a renderer instead of substituting one: the same single
     * centred diagonal mark is written as PDF operators INTO each imported page's
     * own content stream, by PdfWatermarkBaker.
     *
     * What that buys, versus the layered vector engine (ENGINE A):
     *   • ONE mark per page, not a grid of twelve;
     *   • the mark is page CONTENT — no annotation, no optional-content group, no
     *     separate text or image object with its own dictionary. A reader's
     *     "remove watermark" command has nothing to select;
     *   • deleting "the watermark block" is impossible: the operators live in the
     *     stream that carries the lecture text, so any edit that removes them
     *     edits the lecture too.
     *
     * What it does NOT buy, stated plainly: the lecture text stays a real text
     * layer, so copy/paste and text extraction still work and the page is not one
     * flat image. ENGINE B remains stronger where a licensed renderer exists.
     *
     * EVERY PAGE MUST CARRY EXACTLY ONE MARK. The bake covers the pages whose
     * structure it can rewrite; the remaining pages get the IDENTICAL mark drawn
     * at page level (still page content — no annotation, no OCG, no object of its
     * own), so no page can be delivered blank and no page can get the mark twice.
     * The page-level fallback is weaker (that block can be deleted from the page
     * stream) and it is logged with the exact page numbers; it also removes the
     * need to refuse a document the product already delivers today.
     */
    private function renderFlatten(string $source, array $lines, string $out): int
    {
        $engine = $this->rendererStatus()['vector']['engine'] ?? null;
        if ($engine !== 'tcpdf') {
            throw new ApiException(503, 'The flattened engine needs the TCPDF bridge (setasign/fpdi + tecnickcom/tcpdf) in backend/vendor. The unwatermarked original will not be served.', 'engine_unavailable');
        }

        $identity = trim((string) ($lines[0] ?? ''));
        if ($identity === '') {
            $identity = 'MedAcademy';
        }

        // ── Build with NO page-level marks; the bake supplies every page ──
        $pageCount = $this->buildFlattenPass($source, $out, $identity);
        $report = (new PdfWatermarkBaker())->bake($out, $this->lastFlattenBlocks, $this->opacity());
        if ($report['baked'] === $pageCount) {
            return $pageCount;
        }

        $skipped = array_values(array_unique(array_map('intval', $report['skipped_pages'] ?? [])));
        if ($skipped === []) {
            // The baker could not even start (unsupported xref shape, no font, …).
            // Nothing page-specific to fall back to, so fail closed.
            error_log('[pdf-watermark] flatten bake failed: ' . (string) ($report['reason'] ?? 'unknown'));
            throw new ApiException(422, 'This PDF uses a structure the flattener cannot modify safely, so no copy was produced. Re-export the document and upload it again.');
        }

        // ── Pages whose imported Form cannot be rewritten ──
        // Same mark, same operators, appended to the PAGE's own content stream by
        // the baker instead (drawn on top of the imported page). Nothing is redrawn
        // through TCPDF, so the fallback mark is identical in size, angle, position
        // and alpha — it is only — marginally — easier to strip, because it is a
        // separable block inside the page stream rather than part of the lecture
        // Form. That is logged per page.
        $fallback = [];
        foreach ($skipped as $pageNo) {
            $block = $this->lastFlattenBlocks[$pageNo - 1] ?? '';
            if (is_string($block) && $block !== '') {
                $fallback[$pageNo] = $block;
            }
        }
        error_log(
            '[pdf-watermark] flatten: form bake covered ' . $report['baked'] . '/' . $pageCount
            . '; page-stream bake for ' . $this->pageList($pageCount, $skipped, true)
            . ' (' . (string) ($report['reason'] ?? 'unknown') . ')'
        );
        $second = (new PdfWatermarkBaker())->bakeOnPages($out, $fallback, $this->opacity());
        if ($second['baked'] !== count($fallback)) {
            error_log(
                '[pdf-watermark] flatten page bake incomplete: ' . $second['baked'] . ' of '
                . count($fallback) . ' (' . (string) ($second['reason'] ?? 'unknown') . ')'
            );
            throw new ApiException(422, 'This PDF uses a structure the flattener cannot modify safely, so no copy was produced. Re-export the document and upload it again.');
        }

        return $pageCount;
    }

    /** @var array<int,?string> blocks produced by the last buildFlattenPass() */
    private array $lastFlattenBlocks = [];

    /**
     * Build one flatten-mode PDF: every source page imported at its visible size,
     * the DejaVu face seeded once, and either a baked-operator block (returned to
     * the caller for PdfWatermarkBaker) or a page-level copy of the same mark for
     * the pages in $pageLevelMarks (1-based).
     *
     * Returns the page count. The per-page blocks land in $lastFlattenBlocks, keyed
     * positionally so the baker's page index lines up: a page-level mark contributes
     * a null entry, which the baker treats as "skip this page".
     *
     */
    private function buildFlattenPass(string $source, string $out, string $identity): int
    {
        $pdf = new \setasign\Fpdi\Tcpdf\Fpdi('P', 'pt', 'A4', true, 'UTF-8', false);
        $pdf->setPrintHeader(false);
        $pdf->setPrintFooter(false);
        $pdf->SetAutoPageBreak(false, 0);
        $pdf->SetMargins(0, 0, 0);
        $pdf->SetCellPaddings(0, 0, 0, 0);
        $pdf->setFontSubsetting(true);

        try {
            $pageCount = (int) $pdf->setSourceFile($source);
        } catch (\Throwable $e) {
            if ($this->isPdfParseFailure($e)) {
                error_log('[pdf-watermark] unsupported pdf structure: ' . $e->getMessage());
                throw new ApiException(422, 'This PDF uses a structure the watermarker cannot read (for example compressed cross-reference streams or encryption). It cannot be delivered to students.');
            }
            throw $e;
        }
        if ($pageCount < 1) {
            throw new ApiException(422, 'This PDF has no pages.');
        }
        if ($pageCount > $this->maxPages()) {
            throw new ApiException(422, 'This PDF has more pages than the watermarking limit (' . $this->maxPages() . ').');
        }

        $blocks = [];
        for ($pageNo = 1; $pageNo <= $pageCount; $pageNo++) {
            $tpl = $pdf->importPage($pageNo);
            $size = $pdf->getTemplateSize($tpl);
            $w = (float) ($size['width'] ?? 0);
            $h = (float) ($size['height'] ?? 0);
            if ($w <= 0.0 || $h <= 0.0) {
                throw new ApiException(422, 'Page ' . $pageNo . ' has no usable dimensions.');
            }
            // FPDI reports the VISIBLE size, so a /Rotate 90 page arrives already
            // swapped; adding the page that way keeps the mark aligned with what
            // the reader sees, exactly like the layered engine.
            $pdf->AddPage($w > $h ? 'L' : 'P', [$w, $h], false, false);
            $pdf->useTemplate($tpl, 0, 0, $w, $h);

            // The baked operators reuse /MACWMF0 — the DejaVu subset TCPDF embeds
            // on first use — so the glyphs must be written once. At alpha 0 they
            // are invisible; the visible mark is the baked (or page-level) one.
            $this->seedBakedFont($pdf, $identity);
            $blocks[] = $this->centeredBakedOps($pdf, $w, $h, $identity);
        }

        $pdf->Output($out, 'F');
        $this->lastFlattenBlocks = $blocks;
        return $pageCount;
    }

    /** 1,3,5 from a page count and a skipped set — for one log line. */
    private function pageList(int $pageCount, array $skipped, bool $invert): string
    {
        $out = [];
        for ($p = 1; $p <= $pageCount; $p++) {
            if (in_array($p, $skipped, true) === $invert) {
                $out[] = (string) $p;
            }
        }
        return $out === [] ? 'none' : implode(',', $out);
    }


    /**
     * Write the identity once at alpha 0 so TCPDF embeds the DejaVu subset the
     * baked operators reference. Invisible on the page: nothing else is drawn at
     * page level in this engine, so the delivered page carries exactly ONE visible
     * mark, the baked one.
     */
    private function seedBakedFont(\TCPDF $pdf, string $identity): void
    {
        $pdf->SetAlpha(0);
        $pdf->SetFont(self::VECTOR_FONT, 'B', 12);
        $pdf->Text(2, 2, $identity);
        $pdf->SetAlpha(1);
    }

    /**
     * Raw operators for the ONE centred mark, in page coordinates (origin
     * bottom-left). The run is rotated about its own visual centre, which is
     * placed on the page centre, so mixed page sizes and orientations all get the
     * same composition.
     */
    private function centeredBakedOps(\TCPDF $pdf, float $w, float $h, string $text): string
    {
        $mark = $this->centeredMarkGeometry($pdf, $w, $h, $text);
        if ($mark === null) {
            return '';
        }
        $size = $mark['size'];
        $cos = $mark['cos'];
        $sin = $mark['sin'];
        $px = $mark['x'];
        $py = $mark['y'];

        $tone = $this->centerInk()['tone'] / 255;
        // TCPDF writes the embedded Unicode face as UTF-16BE code units (the
        // subset maps CID == code point), so a hex string is a valid operand.
        $hex = strtoupper(bin2hex((string) mb_convert_encoding($text, 'UTF-16BE', 'UTF-8')));

        return "q\n"
            . '/' . PdfWatermarkBaker::GS_RES . " gs\n"
            . $this->pdfNum($tone) . " g\n"
            . "BT\n/" . PdfWatermarkBaker::FONT_RES . ' ' . $this->pdfNum($size) . " Tf\n"
            . $this->pdfNum($cos) . ' ' . $this->pdfNum($sin) . ' '
            . $this->pdfNum(-$sin) . ' ' . $this->pdfNum($cos) . ' '
            . $this->pdfNum($px) . ' ' . $this->pdfNum($py) . " cm\n"
            . '<' . $hex . "> Tj\nET\nQ\n";
    }

    /**
     * Geometry of the ONE centred mark, in PDF user space (origin bottom-left,
     * y UP): font size, rotation terms, and the baseline origin that puts the run's
     * visual centre on the page centre.
     *
     * Shared by the baked operators and the page-level fallback, so both draw the
     * SAME mark — a page that falls back is indistinguishable in appearance from a
     * baked one.
     *
     * @return array{size:float,angle:float,cos:float,sin:float,x:float,y:float}|null
     */
    private function centeredMarkGeometry(\TCPDF $pdf, float $w, float $h, string $text): ?array
    {
        $size = $this->centeredBakeFontSize($pdf, $w, $h, $text);
        if ($size === null) {
            return null;
        }
        $pdf->SetFont(self::VECTOR_FONT, 'B', $size);
        $runWidth = (float) $pdf->GetStringWidth($text);
        if ($runWidth <= 0.1) {
            return null;
        }

        $angle = self::RASTER_ANGLE_DEG;
        $cos = cos(deg2rad($angle));
        $sin = sin(deg2rad($angle));

        // Visual centre of a horizontal run RELATIVE TO ITS BASELINE ORIGIN.
        // +0.30em is roughly halfway between the ascender and the descender for
        // the embedded face, so the mark looks centred rather than sitting low.
        $uc = $runWidth / 2;
        $vc = $size * 0.30;
        // Rotate that offset, then place the origin so the offset lands on the
        // page centre (PDF user space: y up, positive angle counter-clockwise).
        return [
            'size' => $size,
            'angle' => $angle,
            'cos' => $cos,
            'sin' => $sin,
            'x' => ($w / 2) - (($uc * $cos) - ($vc * $sin)),
            'y' => ($h / 2) - (($uc * $sin) + ($vc * $cos)),
        ];
    }

    /**
     * Font size for the single centred mark: start DPI-independent, scale so the
     * rotated run spans ~86 % of the usable box, then shrink until it fits both
     * dimensions. A cap keeps a three-letter id from swallowing the page; the
     * loop keeps a 60-character name from running off it. Null when even 4pt does
     * not fit (degenerate page geometry).
     */
    private function centeredBakeFontSize(\TCPDF $pdf, float $w, float $h, string $text): ?float
    {
        $maxW = $w * 0.86;
        $maxH = $h * 0.86;
        if ($maxW <= 1.0 || $maxH <= 1.0) {
            return null;
        }
        $cos = cos(deg2rad(self::RASTER_ANGLE_DEG));
        $sin = sin(deg2rad(self::RASTER_ANGLE_DEG));
        $size = min(0.10 * min($w, $h), 140.0);

        for ($try = 0; $try < 10; $try++) {
            $pdf->SetFont(self::VECTOR_FONT, 'B', $size);
            $runWidth = (float) $pdf->GetStringWidth($text);
            if ($runWidth <= 0.1) {
                return null;
            }
            // Conservative height (ascender + descender) so the fit never clips.
            $runHeight = $size * 0.95;
            $rotW = $runWidth * $cos + $runHeight * $sin;
            $rotH = $runWidth * $sin + $runHeight * $cos;
            if ($rotW <= $maxW && $rotH <= $maxH) {
                break;
            }
            $shrink = min($maxW / max(1.0, $rotW), $maxH / max(1.0, $rotH)) * 0.97;
            $size *= max(0.5, $shrink);
            if ($size <= 4.0) {
                $size = 4.0;
                break;
            }
        }

        // Cap for very short identities, floor for float noise.
        $size = min($size, 0.14 * min($w, $h));
        return $size >= 4.0 ? $size : null;
    }

    // ── ENGINE B: rasterise → composite one centred mark → flatten ─────────

    /**
     * Flattened pipeline. Page order of operations per page:
     *   1. Ghostscript renders the ORIGINAL page to a transparent-background
     *      PNG (`pngalpha`) — the lecture ink, no white paper fill.
     *   2. A white canvas is prepared and the transparent page bitmap is
     *      composited ON TOP of it, producing opaque "paper + lecture".
     *   3. ONE centred diagonal identity mark is painted OVER that composite,
     *      in a single pass at exactly PDF_WATERMARK_OPACITY (no halo: a
     *      second pass would compound the alpha).
     *   4. The flattened opaque page image is placed full-page into the output
     *      PDF (an image XObject — no text, no annotation, no watermark object).
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

            // ── Never deliver a PARTIAL document ──────────────────────────
            // Ghostscript can exit non-zero AFTER writing some pages (one
            // damaged page in an otherwise valid file). Those pages would
            // otherwise be assembled and delivered with content silently
            // missing, so a non-zero exit refuses the whole document; so does a
            // rendered page count below the source's.
            if ($code !== 0) {
                error_log(
                    '[pdf-watermark] ghostscript exited ' . $code . ' after ' . count($pages) . ' page(s): '
                    . substr($stderr, 0, 300)
                );
                throw new ApiException(422, 'A page of this PDF could not be rendered, so no copy was produced. Re-export the document and upload it again.');
            }
            $expectedPages = $this->sourcePageCount($source);
            if ($expectedPages !== null && count($pages) !== $expectedPages) {
                error_log('[pdf-watermark] rendered ' . count($pages) . ' of ' . $expectedPages . ' page(s)');
                throw new ApiException(422, 'A page of this PDF could not be rendered, so no copy was produced. Re-export the document and upload it again.');
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
     * Page count read straight from the SOURCE bytes, or null when it cannot be
     * determined (page objects hidden in an object stream, unreadable file).
     * Used only to detect a TRUNCATED render: an unknown count skips this extra
     * check, while the non-zero-exit check above still applies.
     */
    private function sourcePageCount(string $source): ?int
    {
        $raw = @file_get_contents($source);
        if (!is_string($raw) || $raw === '') {
            return null;
        }
        $n = (int) preg_match_all('#/Type\s*/Page[^s]#', $raw);
        return $n > 0 ? $n : null;
    }

    /**
     * Composite ONE page: opaque paper + transparent lecture on top, then the
     * single centred watermark into the same bitmap. Dispatches to the detected
     * compositor. $outImage is a PNG or JPEG.
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
        $ink = $this->centerInk();

        // 1. White paper + the lecture page (transparent background) on top.
        $canvas = new \Imagick();
        $canvas->newImage($w, $h, new \ImagickPixel('white'));
        $canvas->setImageFormat('png');
        $fg = new \Imagick($pagePng);
        $canvas->compositeImage($fg, \Imagick::COMPOSITE_OVER, 0, 0);
        $fg->clear();

        // 2. The ONE centred mark, drawn on its own transparent layer so the
        //    whole run can be rotated about the page centre.
        $place = $this->centeredPlacement($lines, $w, $h, $dpi, $font);
        if ($place !== null) {
            $layer = new \Imagick();
            $layer->newImage($w, $h, new \ImagickPixel('transparent'));
            $layer->setImageFormat('png');

            // Baseline point that leaves the UNROTATED run centred on the page:
            // ImageMagick draws text from the baseline, so the vertical offset
            // is the midpoint of (ascender, descender).
            $probe = new \ImagickDraw();
            $probe->setFont($font);
            $probe->setFontSize($place['size']);
            $metrics = $layer->queryFontMetrics($probe, $place['text']);
            $probe->clear();
            $textW = (float) ($metrics['textWidth'] ?? 0);
            $asc = (float) ($metrics['ascender'] ?? $metrics['typoAscender'] ?? $place['size']);
            $desc = (float) ($metrics['descender'] ?? $metrics['typoDescender'] ?? 0.0);
            $tx = ($w - $textW) / 2;
            $ty = ($h + $asc + $desc) / 2;

            // ONE pass, ONE alpha: no halo, no stroke. Anything drawn twice
            // would compound the alpha and make the delivered mark heavier
            // than PDF_WATERMARK_OPACITY.
            $face = new \ImagickDraw();
            $face->setFont($font);
            $face->setFontSize($place['size']);
            $face->setFillColor(new \ImagickPixel(sprintf(
                'rgba(%d,%d,%d,%.3f)',
                $ink['tone'], $ink['tone'], $ink['tone'], $ink['cover']
            )));
            $layer->annotateImage($face, $tx, $ty, 0, $place['text']);
            $face->clear();

            // Rotate about the layer's own centre, so the mark keeps its page
            // position. ImageMagick rotates clockwise for a positive angle, so
            // −angle matches the GD path's counter-clockwise convention. The
            // fit above guarantees the rotated box already lies inside the
            // page, so nothing is clipped.
            $layer->rotateImage(new \ImagickPixel('transparent'), -$place['angle'], false);
            $canvas->compositeImage($layer, \Imagick::COMPOSITE_OVER, 0, 0);
            $layer->clear();
        }

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

        // 1. White paper + the transparent-content page bitmap on top.
        $fg = @imagecreatefrompng($pagePng);
        if ($fg === false) {
            imagedestroy($canvas);
            throw new ApiException(500, 'A rendered page could not be loaded for compositing.');
        }
        imagealphablending($canvas, true);
        imagecopy($canvas, $fg, 0, 0, 0, 0, $w, $h);
        imagedestroy($fg);

        // 2. The ONE centred mark, painted OVER the lecture — ONE pass.
        //
        // GD blends a source colour's own alpha into the destination, so a
        // second pass over the same pixels would compound (1-(1-a)^2, i.e. a
        // 0.12 mark rendered at 0.22). The previous implementation drew a
        // dilated white halo EIGHT times around the face, which is why the
        // delivered mark was far heavier than the configured opacity.
        $place = $this->centeredPlacement($lines, $w, $h, $dpi, $font);
        if ($place !== null) {
            $ink = $this->centerInk();
            $faceA = (int) max(0, min(127, round(127 * (1.0 - $ink['cover']))));
            $faceC = imagecolorallocatealpha($canvas, $ink['tone'], $ink['tone'], $ink['tone'], $faceA);
            imagealphablending($canvas, true);
            imagettftext(
                $canvas,
                $place['size'],
                $place['angle'],
                (int) round($place['x']),
                (int) round($place['y']),
                $faceC,
                $font,
                $place['text']
            );
        }

        if ($format === 'jpeg') {
            imagejpeg($canvas, $outImage, $quality);
        } else {
            imagepng($canvas, $outImage, 6);
        }
        imagedestroy($canvas);
    }

    /**
     * The SINGLE centred watermark of the raster engine.
     *
     * The identity line is laid out horizontally, then SCALED so the rotated
     * (35°) box spans ~86 % of the usable page width — a large, clearly visible
     * centred mark — and finally shrunk if that still exceeds the usable
     * height. That one fit covers every page shape — portrait, landscape,
     * /Rotate'd or unusually sized — and guarantees the mark never runs off
     * the sheet, however long the student's name is. A cap on the glyph size
     * keeps a very short identity (a 3-letter code) from swallowing the page.
     *
     * Returns the text, font size, angle, and the point for GD's imagettftext
     * (the LEFT-BASELINE origin, pre-compensated so the rotated glyph run
     * lands centred on the page). Null when the geometry cannot hold a mark.
     *
     * @param array{0:string,1:string} $lines
     * @return array{text:string,size:float,angle:float,x:float,y:float}|null
     */
    private function centeredPlacement(array $lines, int $w, int $h, int $dpi, string $font): ?array
    {
        $text = (string) ($lines[0] ?? '');
        if ($text === '') {
            $text = (string) ($lines[1] ?? '');
        }
        if ($text === '') {
            $text = 'MedAcademy';
        }

        $angle = self::RASTER_ANGLE_DEG;
        $rad = deg2rad($angle);
        $cos = cos($rad);
        $sin = sin($rad);
        $margin = max(8.0, 0.02 * (float) min($w, $h));
        $maxW = (float) $w - 2 * $margin;
        $maxH = (float) $h - 2 * $margin;
        if ($maxW <= 0.0 || $maxH <= 0.0) {
            return null;
        }

        // Start from a DPI-relative size, then SCALE so the rotated mark spans
        // ~86 % of the usable width ("fit the watermark to the page width"),
        // capped so a very short identity cannot grow into a page-swallowing
        // glyph. The shrink loop below then guarantees the fit on every page.
        $size = max(9.0, (float) round($dpi * 0.08));
        $startBox = $this->textBox($size, $font, $text);
        if ($startBox === null) {
            return null;
        }
        $startRotW = $startBox['w'] * $cos + $startBox['h'] * $sin;
        if ($startRotW > 1.0) {
            $size *= (0.86 * $maxW) / $startRotW;
        }
        $size = min($size, 0.14 * (float) min($w, $h));
        $size = max(6.0, $size);

        $box = null;
        $rotW = $rotH = 0.0;
        for ($try = 0; $try < 8; $try++) {
            $box = $this->textBox($size, $font, $text);
            if ($box === null) {
                return null;
            }
            $rotW = $box['w'] * $cos + $box['h'] * $sin;
            $rotH = $box['w'] * $sin + $box['h'] * $cos;
            if ($rotW <= $maxW && $rotH <= $maxH) {
                break;
            }
            $shrink = min($maxW / max(1.0, $rotW), $maxH / max(1.0, $rotH)) * 0.98;
            $size *= max(0.5, $shrink);
            $box = null;
        }
        if ($box === null || $rotW > $maxW || $rotH > $maxH || $size < 4.0) {
            return null;
        }

        // GD rotates the run about the returned origin, with positive angle =
        // counter-clockwise on screen (y down), so the centre offset
        // (bbox middle relative to the origin) is mapped by
        //   x' =  cx·cos + cy·sin ,  y' = −cx·sin + cy·cos
        // and the origin is chosen as page centre − that mapped offset.
        $cx = $box['cx'];
        $cy = $box['cy'];
        $rx = $cx * $cos + $cy * $sin;
        $ry = -$cx * $sin + $cy * $cos;

        return [
            'text' => $text,
            'size' => $size,
            'angle' => $angle,
            'x' => ($w / 2) - $rx,
            'y' => ($h / 2) - $ry,
        ];
    }

    /**
     * Measured box of one horizontal text run: width, height and the centre
     * offset RELATIVE TO THE LEFT-BASELINE ORIGIN (what imagettftext rotates
     * about). Uses imagettfbbox when GD is present; the raster engine already
     * requires either GD or Imagick, and the fallback estimate keeps the fit
     * conservative when GD is absent (Imagick path measures with its own API).
     *
     * @return array{w:float,h:float,cx:float,cy:float}|null
     */
    private function textBox(float $size, string $font, string $text): ?array
    {
        if (function_exists('imagettfbbox')) {
            $b = @imagettfbbox($size, 0, $font, $text);
            if (is_array($b) && count($b) === 8) {
                $xs = [(float) $b[0], (float) $b[2], (float) $b[4], (float) $b[6]];
                $ys = [(float) $b[1], (float) $b[3], (float) $b[5], (float) $b[7]];
                $minX = min($xs);
                $maxX = max($xs);
                $minY = min($ys);
                $maxY = max($ys);
                return [
                    'w' => max(1.0, $maxX - $minX),
                    'h' => max(1.0, $maxY - $minY),
                    'cx' => ($minX + $maxX) / 2,
                    'cy' => ($minY + $maxY) / 2,
                ];
            }
        }
        // Deliberate over-estimate (0.62 em/char, plus ascender+descender):
        // a larger assumed box only shrinks the fit, never clips the page.
        $w = $size * 0.62 * (function_exists('mb_strlen') ? mb_strlen($text) : strlen($text));
        if ($w < 1.0) {
            return null;
        }
        return ['w' => $w, 'h' => $size * 1.15, 'cx' => $w / 2, 'cy' => -$size * 0.35];
    }

    /**
     * Face colour and alpha of the single centred mark.
     *
     * ONE pass, ONE tone, no halo. That is deliberate:
     *
     *   • `cover` is exactly PDF_WATERMARK_OPACITY, so the rendered result is
     *     the configured opacity instead of something stronger. The previous
     *     version drew a dilated white halo at 90 % alpha plus a grey face at
     *     ~78 %, which on white paper read as an opaque banner;
     *   • `tone` is a restrained 107 grey (~42 %): dark enough to carry the
     *     contrast on paper, light enough that a long diagonal run never looks
     *     like a redaction bar;
     *   • with no halo there is no second compositing pass, so overlapping
     *     glyph edges cannot compound into a denser mark (the old GD path drew
     *     the halo EIGHT times, one per dilation offset).
     *
     * Consequence, documented in PDF_WATERMARK_REMOVAL_RESISTANCE.md: over a
     * dark photograph the mark is effectively invisible. That is the accepted
     * cost of "does not obscure the content" — a mark that inverts itself to
     * white over figures is exactly what made the old rendering distracting.
     *
     * @return array{tone:int,cover:float}
     */
    private function centerInk(): array
    {
        return ['tone' => 107, 'cover' => $this->opacity()];
    }

    /** Largest source PDF the vector pipeline will parse (bytes). */
    public function maxSourceBytes(): int
    {
        // Floor guards against 0/negative only: an operator may deliberately set
        // a small cap (e.g. on a memory-tight plan), and the error message states
        // the effective limit, so a deliberate cap is never silently ignored.
        return max(1024, Config::int('PDF_WATERMARK_MAX_SOURCE_BYTES', 50 * 1024 * 1024));
    }

    /**
     * Opacity used by the vector engines. Slightly lighter than the raster
     * engine's default because vector text is drawn UNDER crisp lecture ink
     * instead of being flattened into it — 0.10 keeps body text fully readable
     * while remaining visible on an empty margin.
     */
    public function vectorOpacity(): float
    {
        $raw = Config::string('PDF_WATERMARK_VECTOR_OPACITY', '');
        $o = is_numeric($raw) ? (float) $raw : 0.10;
        return max(0.04, min(0.35, $o));
    }

    /**
     * Opacity of the FRONT marks — the ones that cross the lecture content.
     *
     * They must be strong enough to be visible over black body text (where a
     * 0.10 mark is invisible) yet light enough that the text stays comfortably
     * readable: 0.30 of a mid grey turns a black glyph into ~33/255, a contrast
     * ratio of about 6:1 against the 213/255 it leaves on white paper.
     */
    public function vectorForegroundOpacity(): float
    {
        $raw = Config::string('PDF_WATERMARK_VECTOR_FG_OPACITY', '');
        $o = is_numeric($raw) ? (float) $raw : 0.30;
        return max(0.08, min(0.55, $o));
    }

    // ── ENGINE A/C: vector re-emission (FPDI + TCPDF, or FPDI + FPDF) ────────

    /**
     * Pick the vector renderer that is actually installed. TCPDF is preferred
     * because it embeds a Unicode face (accents render correctly) and keeps the
     * page geometry intact; the FPDF path is the minimal-dependency fallback.
     */
    private function renderVector(string $source, array $lines, string $out): int
    {
        $engine = $this->rendererStatus()['vector']['engine'];
        try {
            return $engine === 'tcpdf'
                ? $this->renderWithTcpdfFpdi($source, $lines, $out)
                : $this->renderWithFpdfFpdi($source, $lines, $out);
        } catch (ApiException $e) {
            throw $e;
        } catch (\Throwable $e) {
            // A parser refusal is a DOCUMENT problem, not a server problem: say
            // so (415/422) instead of blaming the platform. Everything else is
            // rethrown and becomes the generic 500 in personalize().
            if ($this->isPdfParseFailure($e)) {
                error_log('[pdf-watermark] unsupported pdf structure: ' . $e->getMessage());
                throw new ApiException(
                    422,
                    'This PDF uses a structure the watermarker cannot read (for example compressed cross-reference streams or encryption). It cannot be delivered to students.',
                    'pdf_parse'
                );
            }
            throw $e;
        }
    }

    /**
     * FPDI 2.x + TCPDF 6.x renderer — the production engine.
     *
     * Per page, in drawing order: BACK grid → imported lecture page → FRONT
     * marks → trace lattice → edge rails → interior anchor. The two watermark
     * layers that surround
     * the lecture are what make it impossible to delete "the watermark block"
     * from the page and keep a clean document; the dot lattice and the rails are
     * the representations that survive deleting all of the text.
     *
     * Finally PdfWatermarkBaker appends a second set of marks inside the
     * imported page's OWN content stream (see that class), so page content and
     * watermark become one inseparable stream on pages that qualify.
     */
    private function renderWithTcpdfFpdi(string $source, array $lines, string $out): int
    {
        $pdf = new \setasign\Fpdi\Tcpdf\Fpdi('P', 'pt', 'A4', true, 'UTF-8', false);
        $pdf->setPrintHeader(false);
        $pdf->setPrintFooter(false);
        $pdf->SetAutoPageBreak(false, 0);
        $pdf->SetMargins(0, 0, 0);
        $pdf->SetCellPaddings(0, 0, 0, 0);
        // Embed only the glyphs actually used: the full DejaVu face would add
        // ~100 KB to every personalized copy, while a subset adds a few KB.
        $pdf->setFontSubsetting(true);

        $pageCount = (int) $pdf->setSourceFile($source);
        if ($pageCount < 1) {
            throw new ApiException(422, 'This PDF has no pages.');
        }
        if ($pageCount > $this->maxPages()) {
            throw new ApiException(
                422,
                'This PDF has more pages than the watermarking limit (' . $this->maxPages() . ').'
            );
        }

        $identity = (string) ($lines[0] ?? '');
        $label = (string) ($lines[1] ?? '');
        if ($identity === '') {
            $identity = 'MedAcademy';
        }

        /** @var array<int,string> $baked one raw-operator block per page */
        $baked = [];

        for ($pageNo = 1; $pageNo <= $pageCount; $pageNo++) {
            $tpl = $pdf->importPage($pageNo);
            $size = $pdf->getTemplateSize($tpl);
            $w = (float) ($size['width'] ?? 0);
            $h = (float) ($size['height'] ?? 0);
            if ($w <= 0.0 || $h <= 0.0) {
                throw new ApiException(422, 'Page ' . $pageNo . ' has no usable dimensions.');
            }

            // FPDI reports the VISIBLE size, so a /Rotate 90 page arrives with
            // width and height already swapped. Adding the page in that
            // orientation keeps the watermark aligned with the reader's view.
            $orientation = $w > $h ? 'L' : 'P';
            $pdf->AddPage($orientation, [$w, $h], false, false);

            // Deterministic per (recipient, page, geometry): the same document
            // always renders the same way (testable, cacheable) while two
            // recipients get completely different layouts, so no mask, crop or
            // white rectangle can be prepared in advance for a given page.
            $seed = $this->pageSeed($identity, $pageNo, $w, $h);

            // A. BACK — painted first, so the lecture ink covers it.
            $this->drawTcpdfBackLayer($pdf, $w, $h, $identity, $label, $seed);

            // B. The ORIGINAL page, drawn ON TOP of the back layer.
            $pdf->useTemplate($tpl, 0, 0, $w, $h);

            // C. FRONT — painted last, so it crosses text, tables and figures.
            $this->drawTcpdfFrontLayer($pdf, $w, $h, $identity, $label, $seed);

            // D. TRACE — non-text representation of the recipient identity.
            $this->drawTcpdfTraceLattice($pdf, $w, $h, $identity, $seed);

            // E. RAILS — the complete identity on all four edges.
            $this->drawTcpdfRails($pdf, $w, $h, $identity, $label);

            // F. ANCHOR — one dark identity stamp in the page INTERIOR, so the
            //    "threshold away the tint, then crop the margins" combination
            //    still leaves the recipient id on the sheet.
            $this->drawTcpdfAnchor($pdf, $w, $h, $identity, $label, $seed);

            $baked[] = $this->bakedPageOps($pdf, $w, $h, $identity, $label, $seed);
        }

        $pdf->Output($out, 'F');

        // Bake a second copy of the marks INSIDE each imported page stream, so
        // deleting the page-level operators no longer yields a clean document.
        // A failure here is logged, never fatal: the layered marks are already
        // on the page, so the fallback is a weaker hardening level — never an
        // unwatermarked document.
        try {
            $bake = (new PdfWatermarkBaker())->bake($out, $baked, $this->vectorForegroundOpacity());
            if ($bake['baked'] === 0) {
                error_log('[pdf-watermark] content bake skipped: ' . (string) ($bake['reason'] ?? 'unknown'));
            }
        } catch (\Throwable $e) {
            error_log('[pdf-watermark] content bake failed: ' . $e->getMessage());
        }

        return $pageCount;
    }

    /**
     * Layer A — the back grid, drawn before the imported page.
     *
     * One mark per cell of a 3x4 lattice with seeded jitter. Every anchor is
     * CLAMPED by placeText() so the complete identity always fits inside the
     * page: the previous implementation anchored marks on a lattice that ran off
     * the sheet, which is why ids arrived visibly cut ("MED-0…") on some pages.
     */
    private function drawTcpdfBackLayer(\TCPDF $pdf, float $w, float $h, string $identity, string $label, string $seed): void
    {
        $state = $seed . '|back';
        $pdf->setAlpha($this->vectorOpacity());
        $pdf->SetTextColor(118, 118, 118);

        $cols = 3;
        $rows = 4;
        for ($row = 0; $row < $rows; $row++) {
            for ($col = 0; $col < $cols; $col++) {
                $x = ($col + 0.12 + 0.76 * $this->rand01($state)) * $w / $cols;
                $y = ($row + 0.16 + 0.68 * $this->rand01($state)) * $h / $rows;
                $angle = 45.0 + $this->randBetween($state, -7.0, 7.0);
                $text = ($row + $col) % 2 === 0 || $label === '' ? $identity : $label;
                $this->placeText($pdf, $w, $h, $text, $angle, $x, $y, self::VECTOR_TEXT_PT, 118, 0.0);
            }
        }
        $pdf->setAlpha(1);
    }

    /**
     * Layer C — the front marks, drawn after the imported page.
     *
     * These are the marks that defeat "just cover the empty areas": they are
     * spread over the whole sheet at nine different angles, so hiding them means
     * covering the lecture as well. Opacity is a separate, lower-ceiling setting
     * (vectorForegroundOpacity) because these marks sit ON the text.
     */
    private function drawTcpdfFrontLayer(\TCPDF $pdf, float $w, float $h, string $identity, string $label, string $seed): void
    {
        $state = $seed . '|front';
        $pdf->setAlpha($this->vectorForegroundOpacity());
        $pdf->SetTextColor(118, 118, 118);

        // Nine directions: a single 45° filter cannot remove them, and none of
        // the angles is horizontal (which would fight the line spacing).
        $angles = [-34.0, 22.0, -13.0, 37.0, -45.0, 17.0, -26.0, 31.0, -8.0];
        $cols = 3;
        $rows = 4;
        $i = 0;
        for ($row = 0; $row < $rows; $row++) {
            for ($col = 0; $col < $cols; $col++) {
                // One deliberate gap per page keeps the lattice from looking
                // like a tiled background a tool could template-match.
                if ($this->rand01($state) < 0.12) {
                    $i++;
                    continue;
                }
                $x = ($col + 0.12 + 0.76 * $this->rand01($state)) * $w / $cols;
                $y = ($row + 0.14 + 0.72 * $this->rand01($state)) * $h / $rows;
                $angle = $angles[$i % count($angles)] + $this->randBetween($state, -4.0, 4.0);
                $size = 9.0 + 2.0 * $this->rand01($state);
                $text = $i % 3 === 0 && $label !== '' ? $label : $identity;
                // A hairline stroke (0.18pt) keeps the mark legible where it
                // crosses dark text without filling the glyph interiors.
                $this->placeText($pdf, $w, $h, $text, $angle, $x, $y, $size, 112, 0.18);
                $i++;
            }
        }
        $pdf->setAlpha(1);
    }

    /**
     * Layer D — the trace lattice.
     *
     * Hundreds of ~1pt dots (a speckle texture, not text) plus an 8x4 dot matrix
     * in the lower-right corner that encodes a 32-bit code derived from the
     * identity. It exists because text and images can both be deleted as
     * objects; a lattice scored into the page cannot be removed by "delete the
     * text layer", and its presence at the documented position proves the copy
     * was issued by this service. See traceCode() for the value it encodes.
     */
    private function drawTcpdfTraceLattice(\TCPDF $pdf, float $w, float $h, string $identity, string $seed): void
    {
        $state = $seed . '|trace';
        $pdf->setAlpha($this->vectorForegroundOpacity() * 0.7);

        $area = $w * $h;
        $count = max(48, min(220, (int) round($area / 6000)));
        for ($i = 0; $i < $count; $i++) {
            $x = 3.0 + $this->rand01($state) * max(1.0, $w - 6.0);
            $y = 3.0 + $this->rand01($state) * max(1.0, $h - 6.0);
            $side = 0.7 + 0.9 * $this->rand01($state);
            $tone = 80 + (int) round(60.0 * $this->rand01($state));
            $pdf->SetFillColor($tone, $tone, $tone);
            $pdf->Rect($x, $y, $side, $side, 'F');
        }

        // The recoverable part: 8 columns x 4 rows, row-major, MSB first. The
        // cell is filled when the bit is 1, so 32 bits are readable from a
        // screenshot of the corner (or by the decoder documented in the docs).
        $pitch = 2.6;
        $dot = 1.7;
        $originX = max(10.0, $w - 12.0 - 8 * $pitch);
        $originY = max(10.0, $h - 10.0 - 4 * $pitch);
        $pdf->SetFillColor(70, 70, 70);
        foreach ($this->traceBits($identity) as $bitIndex => $bit) {
            if ($bit !== 1) {
                continue;
            }
            $col = $bitIndex % 8;
            $row = intdiv($bitIndex, 8);
            $pdf->Rect($originX + $col * $pitch, $originY + $row * $pitch, $dot, $dot, 'F');
        }
        $pdf->setAlpha(1);
    }

    /**
     * Layer E — the four edge rails.
     *
     * Two horizontal (bottom-left, top-right) and two vertical (left, right).
     * Each is drawn fully opaque in the measured width, and degrades to the id
     * alone when the whole identity is wider than the page — so a long name can
     * never push the account id out of view, and cropping one or two edges still
     * leaves at least one complete rail.
     */
    private function drawTcpdfRails(\TCPDF $pdf, float $w, float $h, string $identity, string $label): void
    {
        $pdf->setAlpha(1);
        $pdf->SetTextColor(60, 60, 60);
        $pdf->SetFont(self::VECTOR_FONT, '', self::VECTOR_EDGE_PT);

        $full = $identity;
        if ($pdf->GetStringWidth($full) > max(40.0, $w - 14.0)) {
            // Keep the id intact: it is the part that proves ownership.
            $full = $label !== '' ? $label : $identity;
        }
        if ($pdf->GetStringWidth($full) > max(40.0, $w - 14.0)) {
            $full = mb_substr($full, 0, 40);
        }
        $textW = (float) $pdf->GetStringWidth($full);

        // bottom-left and top-right (TCPDF y runs from the top)
        $pdf->Text(6, max(9.0, $h - 6), $full);
        $pdf->Text(max(6.0, $w - $textW - 6), 10, $full);

        // vertical rails, read bottom-to-top along both side edges
        foreach ([6.0, $w - 6.0] as $x) {
            $pdf->StartTransform();
            $pdf->Rotate(90, $x, $h / 2);
            $pdf->Text($x, $h / 2 + $textW / 2, $full);
            $pdf->StopTransform();
        }
    }

    /**
     * Layer F — the interior anchor.
     *
     * One short, comparatively dark identity stamp placed away from every edge
     * and at a seeded angle. It is aimed at the COMBINED attack rather than any
     * single one: flatten the page, threshold it to erase the tinted layers,
     * then crop the margins to drop the four rails. Neither the threshold nor
     * the crop reaches this mark, so that sequence still leaves the recipient
     * id on the sheet — and painting it out means covering lecture content.
     *
     * It is deliberately the darkest and the smallest layer: one line at 8pt,
     * roughly 0.1% of the page, drawn at alpha 0.85 over a 62-grey face so the
     * resulting ink sits below both binary thresholds used by the documented
     * attacks (190 and 128) instead of being mapped back to paper white.
     */
    private function drawTcpdfAnchor(\TCPDF $pdf, float $w, float $h, string $identity, string $label, string $seed): void
    {
        // Name + id, without the "| MedAcademy — do not share" tail: the anchor
        // is there to prove WHO received the copy, and space on the content is
        // the scarce resource.
        $head = trim(explode('|', $identity)[0]);
        $id = '';
        if (str_contains($identity, '\u{2022}')) {
            $id = trim(explode('|', explode('\u{2022}', $identity, 2)[1])[0]);
        }

        $candidates = [$head];
        if ($id !== '' && $id !== $head) {
            $candidates[] = $id;
        }

        $state = $seed . '|anchor';
        $x = $w * (0.16 + 0.34 * $this->rand01($state));
        $y = $h * (0.30 + 0.40 * $this->rand01($state));
        $angle = -22.0 + 44.0 * $this->rand01($state);

        foreach ($candidates as $text) {
            foreach ([self::VECTOR_ANCHOR_PT, 6.5, 5.5] as $size) {
                $pdf->setAlpha(0.85);
                if ($this->placeText($pdf, $w, $h, $text, $angle, $x, $y, $size, 62)) {
                    $pdf->setAlpha(1);
                    return;
                }
            }
        }
        $pdf->setAlpha(1);
    }

    // ── Seeded layout helpers (deterministic per recipient + page) ────────────

    /**
     * Layout seed. Deterministic for one (identity, page, geometry), so a
     * document renders identically every time (testable, cache-safe) while two
     * recipients get completely different layouts — a pre-computed mask or crop
     * for "the watermark position" does not exist.
     */
    private function pageSeed(string $identity, int $pageNo, float $w, float $h): string
    {
        return hash(
            'sha256',
            self::LAYERS_VERSION . '|' . $identity . '|' . $pageNo . '|'
            . number_format($w, 2, '.', '') . 'x' . number_format($h, 2, '.', '')
        );
    }

    /** Next pseudo-random value in [0,1) for a seed chain (hash-chained PRNG). */
    private function rand01(string &$state): float
    {
        $state = hash('sha256', $state, true);
        $n = unpack('N', substr($state, 0, 4))[1] ?? 0;
        return ((int) $n) / 4294967296.0;
    }

    private function randBetween(string &$state, float $min, float $max): float
    {
        return $min + ($max - $min) * $this->rand01($state);
    }

    /**
     * Anchor for a rotated text mark such that the WHOLE mark lies inside the
     * page. Returns null when it cannot fit at all, in which case the caller
     * skips it — a mark is never clipped at the edge.
     *
     * This is the fix for "the doctor id does not always appear completely":
     * the previous lattice anchored marks outside the sheet, so a viewer showed
     * a truncated "MED-0…" that looked like a rendering bug.
     *
     * TCPDF coordinates run from the page TOP-LEFT with y growing downwards, so
     * a mark rotated by `$angle` advances along (cos, -sin) and its glyphs face
     * (-sin, -cos).
     *
     * @return array{0:float,1:float}|null
     */
    private function fittedOrigin(
        \TCPDF $pdf,
        float $w,
        float $h,
        string $text,
        float $angle,
        float $x,
        float $y,
        float $size,
        string $style = 'B'
    ): ?array {
        if ($text === '') {
            return null;
        }
        $pdf->SetFont(self::VECTOR_FONT, $style, $size);
        $tw = (float) $pdf->GetStringWidth($text);
        if ($tw <= 0.0) {
            return null;
        }

        $a = deg2rad($angle);
        $c = cos($a);
        $s = sin($a);
        $ux = $c;
        $uy = -$s;
        $vx = -$s;
        $vy = -$c;
        $hh = $size * 0.80;

        $xs = [0.0, $tw * $ux, $tw * $ux + $hh * $vx, $hh * $vx];
        $ys = [0.0, $tw * $uy, $tw * $uy + $hh * $vy, $hh * $vy];
        $minX = min($xs);
        $maxX = max($xs);
        $minY = min($ys);
        $maxY = max($ys);

        $margin = 5.0;
        if (($maxX - $minX) > ($w - 2 * $margin) || ($maxY - $minY) > ($h - 2 * $margin)) {
            return null;
        }

        $dx = 0.0;
        if ($x + $minX < $margin) {
            $dx = $margin - ($x + $minX);
        }
        if ($x + $maxX + $dx > $w - $margin) {
            $dx = ($w - $margin) - ($x + $maxX);
        }
        $dy = 0.0;
        if ($y + $minY < $margin) {
            $dy = $margin - ($y + $minY);
        }
        if ($y + $maxY + $dy > $h - $margin) {
            $dy = ($h - $margin) - ($y + $maxY);
        }

        $px = $x + $dx;
        $py = $y + $dy;
        if ($px + $minX < $margin - 0.02 || $px + $maxX > $w - $margin + 0.02
            || $py + $minY < $margin - 0.02 || $py + $maxY > $h - $margin + 0.02) {
            return null;
        }
        return [$px, $py];
    }

    /** Draw one measured, clamped, rotated identity mark. */
    private function placeText(
        \TCPDF $pdf,
        float $w,
        float $h,
        string $text,
        float $angle,
        float $x,
        float $y,
        float $size,
        int $gray,
        float $stroke = 0.0
    ): bool {
        $origin = $this->fittedOrigin($pdf, $w, $h, $text, $angle, $x, $y, $size);
        if ($origin === null) {
            return false;
        }
        [$px, $py] = $origin;
        $pdf->SetTextColor($gray, $gray, $gray);
        $pdf->SetDrawColor($gray, $gray, $gray);
        $pdf->SetFont(self::VECTOR_FONT, 'B', $size);
        $pdf->StartTransform();
        $pdf->Rotate($angle, $px, $py);
        $pdf->Text($px, $py, $text, $stroke);
        $pdf->StopTransform();
        return true;
    }

    /**
     * The 32-bit code woven into the dot matrix (public: it is not a secret, it
     * is a fingerprint). Documented decoder: read the 8x4 matrix row-major from
     * the top-left cell, MSB first, and compare with this value; a delivered
     * copy whose matrix is missing or different has been tampered with.
     */
    public function traceCode(string $identity): string
    {
        return substr(hash('sha256', 'medacademy-trace|' . trim($identity)), 0, 8);
    }

    /** @return array<int,int> 32 bits, MSB-first, row-major over the 8x4 matrix */
    private function traceBits(string $identity): array
    {
        $hex = $this->traceCode($identity);
        $bits = [];
        for ($i = 0; $i < 32; $i++) {
            $nibble = (int) hexdec($hex[intdiv($i, 4)]);
            $bits[] = ($nibble >> (3 - ($i % 4))) & 1;
        }
        return $bits;
    }

    /**
     * Raw PDF operators for the marks PdfWatermarkBaker appends INSIDE the
     * imported page stream. Coordinates are page coordinates with the ORIGIN AT
     * THE BOTTOM-LEFT (these are read by a PDF viewer, not by TCPDF), hence the
     * `h - y` flip. The block reuses /MACWMF0 (the DejaVu subset already embedded
     * for the page-level marks) and /MACWGS0 (alpha state added by the baker).
     */
    private function bakedPageOps(
        \TCPDF $pdf,
        float $w,
        float $h,
        string $identity,
        string $label,
        string $seed
    ): string {
        $state = $seed . '|baked';
        // Eight marks in a 2x4 lattice: the baked layer must carry a readable
        // share of the page on its own, not a token sample. With the page-level
        // layers removed, this is what a "keep only the page XObject" attack
        // leaves behind.
        $angles = [-31.0, 21.0, -12.0, 36.0, -44.0, 15.0, -25.0, 29.0];
        $ops = '';
        $i = 0;
        for ($row = 0; $row < 4; $row++) {
            for ($col = 0; $col < 2; $col++) {
                $x = ($col + 0.15 + 0.70 * $this->rand01($state)) * $w / 2;
                $y = ($row + 0.14 + 0.72 * $this->rand01($state)) * $h / 4;
                $angle = $angles[$i % count($angles)] + $this->randBetween($state, -3.0, 3.0);
                $size = 9.5 + 1.5 * $this->rand01($state);
                $text = $i % 4 === 0 && $label !== '' ? $label : $identity;
                $i++;
                $origin = $this->fittedOrigin($pdf, $w, $h, $text, $angle, $x, $y, $size);
                if ($origin === null) {
                    continue;
                }
                [$px, $py] = $origin;
                $tone = (95 + (int) round(35.0 * $this->rand01($state))) / 255;
                $a = deg2rad($angle);
                $c = cos($a);
                $s = sin($a);
                // TCPDF writes the embedded Unicode face as UTF-16BE code units
                // (the subset maps CID == code point), so a hex string is valid.
                $hex = strtoupper(bin2hex((string) mb_convert_encoding($text, 'UTF-16BE', 'UTF-8')));
                $ops .= "q\n"
                    . '/' . PdfWatermarkBaker::GS_RES . " gs\n"
                    . $this->pdfNum($tone) . " g\n"
                    . $this->pdfNum($c) . ' ' . $this->pdfNum($s) . ' '
                    . $this->pdfNum(-$s) . ' ' . $this->pdfNum($c) . ' '
                    . $this->pdfNum($px) . ' ' . $this->pdfNum($h - $py) . " cm\n"
                    . "BT\n/" . PdfWatermarkBaker::FONT_RES . ' ' . $this->pdfNum($size) . " Tf\n"
                    . '<' . $hex . "> Tj\nET\nQ\n";
            }
        }

        // Dots too: the baked layer must not be text-only either.
        for ($k = 0; $k < 48; $k++) {
            $x = 3.0 + $this->rand01($state) * max(1.0, $w - 6.0);
            $y = 3.0 + $this->rand01($state) * max(1.0, $h - 6.0);
            $side = 0.9 + 0.9 * $this->rand01($state);
            $tone = (80 + (int) round(60.0 * $this->rand01($state))) / 255;
            $ops .= "q\n/" . PdfWatermarkBaker::GS_RES . " gs\n"
                . $this->pdfNum($tone) . " g\n"
                . $this->pdfNum($x) . ' ' . $this->pdfNum($y) . ' '
                . $this->pdfNum($side) . ' ' . $this->pdfNum($side) . " re f\nQ\n";
        }

        // The 32-bit trace matrix, in the opposite corner from the page-level
        // one, so destroying either copy leaves the other. PDF coordinates here,
        // so the origin is already the bottom-left corner.
        $pitch = 2.6;
        $dot = 1.7;
        $matrix = '';
        foreach ($this->traceBits($identity) as $bitIndex => $bit) {
            if ($bit !== 1) {
                continue;
            }
            $col = $bitIndex % 8;
            $row = intdiv($bitIndex, 8);
            $matrix .= 'q ' . $this->pdfNum(70 / 255) . ' g '
                . $this->pdfNum(12.0 + $col * $pitch) . ' ' . $this->pdfNum(12.0 + $row * $pitch) . ' '
                . $this->pdfNum($dot) . ' ' . $this->pdfNum($dot) . " re f Q\n";
        }
        if ($matrix !== '') {
            $ops .= 'q /' . PdfWatermarkBaker::GS_RES . " gs\n" . $matrix . "Q\n";
        }

        return $ops;
    }

    private function pdfNum(float $value): string
    {
        return rtrim(rtrim(number_format($value, 4, '.', ''), '0'), '.') ?: '0';
    }

    /**
     * True when a thrown exception means "this PDF cannot be parsed" rather than
     * "the server is broken". Checked by CLASS when the library is loaded, and
     * by message otherwise, so the classification survives a FPDI upgrade.
     */
    private function isPdfParseFailure(\Throwable $e): bool
    {
        foreach (['\\setasign\\Fpdi\\PdfParser\\PdfParserException'] as $class) {
            if (class_exists($class) && $e instanceof $class) {
                return true;
            }
        }
        $msg = strtolower($e->getMessage());
        foreach (['parser', 'xref', 'cross-reference', 'encrypted', 'not a pdf', 'unable to find', 'invalid page', 'object stream'] as $needle) {
            if (str_contains($msg, $needle)) {
                return true;
            }
        }
        return false;
    }

    // ── ENGINE C: vector re-emission (FPDI + plain FPDF) — fallback ───────────

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

            // ── 3. FRONT marks over the lecture (same reasoning as the TCPDF
            //    engine, without TCPDF's Unicode face: FPDF's core Helvetica is
            //    ASCII-only, so only glyphs it can draw are used here). ──
            if ($hasAlpha) {
                $pdf->SetAlpha($this->vectorForegroundOpacity());
            }
            $pdf->SetTextColor(112, 112, 112);
            $pdf->SetFont('Helvetica', 'B', 10);
            $front = [0.18, 0.52, 0.34, 0.70, 0.44, 0.84];
            foreach ($front as $k => $fx) {
                $text = $lines[$k % max(1, count($lines))] ?? $identity;
                if ($text === '') {
                    continue;
                }
                $fy = 0.14 + 0.70 * (0.17 + 0.13 * $k);
                if ($hasRotate) {
                    $pdf->Rotate(45, $fx * $w, $fy * $h);
                    $pdf->Text($fx * $w, $fy * $h, $text);
                    $pdf->Rotate(0);
                } else {
                    $pdf->Text($fx * $w, $fy * $h, $text);
                }
            }
            if ($hasAlpha) {
                $pdf->SetAlpha(1);
            }

            // ── 4. Edge rails: the complete identity, top-right and bottom-left ──
            $pdf->SetTextColor(60, 60, 60);
            $pdf->SetFont('Helvetica', '', 7);
            $rail = $pdf->GetStringWidth($identity) > max(40.0, $w - 14.0) ? ($lines[1] ?? '') : $identity;
            if ($rail !== '') {
                $pdf->Text(6, max(9.0, $h - 6), $rail);
                $pdf->Text(max(6.0, $w - $pdf->GetStringWidth($rail) - 6), 10, $rail);
            }
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
