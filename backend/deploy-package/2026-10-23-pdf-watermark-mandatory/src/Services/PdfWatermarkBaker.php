<?php

declare(strict_types=1);

namespace MedAcademy\Services;

/**
 * PdfWatermarkBaker — moves part of the watermark INTO the lecture page content.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The FPDI/TCPDF pipeline emits each lecture page as ONE Form XObject and draws
 * the watermark as a separate block of operators in the page's own content
 * stream. That separation is convenient — and it is also the single cheapest way
 * to strip a watermark: keep the `/TPLn Do` invocation, throw away everything
 * else, and the page is complete and clean. A script does it in one line.
 *
 * Baking closes that hole. After TCPDF finishes writing the PDF, the marks are
 * APPENDED to the imported page's own content stream (the stream that contains
 * the lecture text, tables and images), and the font + graphics state they need
 * are added to that Form's own /Resources. From then on there is no "watermark
 * block" to delete: a mark can only be removed by editing the same stream the
 * lecture lives in, and any mistake there destroys the page. Removing the whole
 * Form XObject removes the lecture too.
 *
 * ── SAFETY MODEL ───────────────────────────────────────────────────────────
 * This is byte-level surgery on a PDF we just produced, so every assumption is
 * checked and anything unexpected means "skip baking, keep the layered marks":
 *
 *   • classic cross-reference table only (what TCPDF writes);
 *   • the page must have exactly one Form XObject whose /BBox equals its
 *     MediaBox and no /Rotate — that is the imported lecture page, and it is the
 *     only case where page coordinates and Form coordinates coincide;
 *   • the stream must be uncompressed or single /FlateDecode;
 *   • a DejaVu watermark font (TCPDF's embedded face) must already exist in the
 *     document, because the baked marks reuse it instead of adding a font;
 *   • the rebuilt file is re-parsed and its cross-reference offsets are verified
 *     before it replaces the original. Any failure keeps the original output.
 *
 * Baking never changes the *visible* result: it re-draws a second, differently
 * seeded set of marks inside the page. The marks the service already drew around
 * the imported page remain, so the two layers are redundant.
 */
final class PdfWatermarkBaker
{
    /**
     * Resource names used inside the imported Form — deliberately unusual. The
     * service emits operators that reference these names; the baker adds the
     * matching entries to the Form's /Resources.
     */
    public const FONT_RES = 'MACWMF0';
    public const GS_RES = 'MACWGS0';

    /** Marker so a document is never baked twice. */
    private const MARKER = '%MAC-WM-BAKED';

    /** Common page geometry noise (points) when comparing /BBox with /MediaBox. */
    private const TOLERANCE = 1.5;

    /**
     * Bake `$blocks[$pageIndex]` into the imported page content stream.
     *
     * @param array<int,string> $blocks PDF drawing operators, page coordinates
     *                                  (origin bottom-left), already wrapped in q/Q.
     * @return array{baked:int,skipped:int,reason:?string}
     */
    public function bake(string $path, array $blocks, float $opacity): array
    {
        $report = ['baked' => 0, 'skipped' => 0, 'reason' => null];
        if ($blocks === []) {
            $report['reason'] = 'no blocks';
            return $report;
        }

        $raw = @file_get_contents($path);
        if ($raw === false || $raw === '') {
            $report['reason'] = 'unreadable output';
            return $report;
        }
        if (str_contains($raw, self::MARKER)) {
            $report['reason'] = 'already baked';
            return $report;
        }

        $doc = $this->parse($raw);
        if ($doc === null) {
            $report['reason'] = 'unsupported pdf structure';
            return $report;
        }

        $fontRef = $this->findWatermarkFont($doc['objects']);
        if ($fontRef === null) {
            $report['reason'] = 'watermark font object not found';
            return $report;
        }

        // One ExtGState shared by every baked mark (created once, appended).
        $gsNum = $doc['max'] + 1;
        $doc['max'] = $gsNum;
        $doc['objects'][$gsNum] = $gsNum . " 0 obj\n<< /Type /ExtGState /ca "
            . $this->num($opacity) . ' /CA ' . $this->num($opacity) . " >>\nendobj";

        $pageObjects = $this->pageObjects($doc['objects']);
        $index = 0;
        foreach ($pageObjects as $pageNum) {
            $block = $blocks[$index] ?? null;
            $index++;
            if ($block === null) {
                $report['skipped']++;
                continue;
            }
            $pageRaw = $doc['objects'][$pageNum];
            $pageBox = $this->box($pageRaw, '/MediaBox');
            if ($pageBox === null || $this->hasRotation($pageRaw)) {
                $report['skipped']++;
                continue;
            }
            $formNum = $this->importedForm($doc['objects'], $pageRaw, $pageBox);
            if ($formNum === null) {
                $report['skipped']++;
                continue;
            }
            $formRaw = $doc['objects'][$formNum];
            $resNum = $this->resourcesObjectNumber($formRaw);
            $updated = $this->appendToForm($formRaw, $block);
            if ($updated === null) {
                $report['skipped']++;
                continue;
            }

            if ($resNum !== null) {
                // The Form inherits a /Resources object — patch THAT object.
                // All imported pages may SHARE one resources object, so a page
                // after the first finds it already prepared: that is success,
                // not a reason to skip.
                $current = $doc['objects'][$resNum] ?? '';
                if (!str_contains($current, '/' . self::FONT_RES)) {
                    $resources = $this->patchDictObject($current, $fontRef, $gsNum);
                    if ($resources === null) {
                        $report['skipped']++;
                        continue;
                    }
                    $doc['objects'][$resNum] = $resources;
                }
            } else {
                $withRes = $this->addResourcesToObject($updated, $fontRef, $gsNum);
                if ($withRes === null) {
                    $report['skipped']++;
                    continue;
                }
                $updated = $withRes;
            }

            $doc['objects'][$formNum] = $updated;
            $report['baked']++;
        }

        if ($report['baked'] === 0) {
            $report['reason'] = 'no page could be baked safely';
            return $report;
        }

        $built = $this->rebuild($doc);
        if ($built === null || !$this->verify($built)) {
            $report['reason'] = 'rebuilt file failed verification';
            $report['baked'] = 0;
            return $report;
        }

        $tmp = $path . '.' . bin2hex(random_bytes(4)) . '.baked';
        if (@file_put_contents($tmp, $built) !== strlen($built) || !@rename($tmp, $path)) {
            @unlink($tmp);
            $report['reason'] = 'could not replace the output file';
            $report['baked'] = 0;
        }
        return $report;
    }

    // ── Page · Form discovery ─────────────────────────────────────────────────

    /** @return array<int,string> page object bodies keyed by object number */
    private function pageObjects(array $objects): array
    {
        $pages = [];
        foreach ($objects as $num => $raw) {
            $head = substr($raw, 0, 400);
            if (preg_match('#/Type\s*/Page\b#', $head) && !preg_match('#/Type\s*/Pages\b#', $head)) {
                $pages[$num] = $raw;
            }
        }
        ksort($pages);
        return array_keys($pages);
    }

    /**
     * The imported lecture page: the Form XObject the page's own content stream
     * invokes with `Do`, whose /BBox equals the page box.
     *
     * Matching on the INVOCATION (not just on the /BBox) is what makes this
     * correct when several pages share one imported form or when two pages have
     * the same geometry — the page content names the form it paints.
     */
    private function importedForm(array $objects, string $pageRaw, array $pageBox): ?int
    {
        $resources = $this->resolve($objects, $this->dictAfter($pageRaw, '/Resources'));
        if ($resources === null) {
            return null;
        }
        $xobj = $this->resolve($objects, $this->dictAfter($resources, '/XObject'));
        if ($xobj === null) {
            return null;
        }

        $map = [];
        preg_match_all('~/([A-Za-z0-9#_.+-]+)\s+(\d+)\s+0\s+R~', $xobj, $matches, PREG_SET_ORDER);
        foreach ($matches as $m) {
            $map[$m[1]] = (int) $m[2];
        }
        if ($map === []) {
            return null;
        }

        // /Contents must be a single indirect stream (what TCPDF writes); an
        // inline array of streams is not something we rewrite.
        if (!preg_match('#/Contents\s+(\d+)\s+0\s+R#', $pageRaw, $cm)) {
            return null;
        }
        $content = $this->decodeStream($objects[(int) $cm[1]] ?? '');
        if ($content === null) {
            return null;
        }

        $invoked = [];
        preg_match_all('~/([A-Za-z0-9#_.+-]+)\s+Do~', $content, $drawn, PREG_SET_ORDER);
        foreach ($drawn as $entry) {
            $num = $map[$entry[1]] ?? null;
            if ($num === null) {
                continue;
            }
            $raw = $objects[$num] ?? '';
            if (!preg_match('#/Subtype\s*/Form#', $raw)) {
                continue;
            }
            $box = $this->box($raw, '/BBox');
            if ($box === null
                || abs($box[0]) > self::TOLERANCE
                || abs($box[1]) > self::TOLERANCE
                || abs(($box[2] - $box[0]) - ($pageBox[2] - $pageBox[0])) > self::TOLERANCE
                || abs(($box[3] - $box[1]) - ($pageBox[3] - $pageBox[1])) > self::TOLERANCE) {
                continue;
            }
            $invoked[$num] = $num;
        }

        return count($invoked) === 1 ? array_values($invoked)[0] : null;
    }

    /** Object number of a Form's indirect /Resources, or null when inline. */
    private function resourcesObjectNumber(string $formRaw): ?int
    {
        $head = substr($formRaw, 0, (int) (strpos($formRaw, 'stream') ?: strlen($formRaw)));
        return preg_match('#/Resources\s+(\d+)\s+0\s+R#', $head, $m) ? (int) $m[1] : null;
    }

    /** Append the block to the Form's content stream (no resource changes). */
    private function appendToForm(string $formRaw, string $block): ?string
    {
        $streamAt = strpos($formRaw, 'stream');
        if ($streamAt === false) {
            return null;
        }
        $dict = substr($formRaw, 0, $streamAt);
        if (!preg_match('#/Length\s+\d+#', $dict) || preg_match('#/Length\s+\d+\s+0\s+R#', $dict)) {
            return null; // indirect /Length: cannot adjust it safely here
        }

        $decoded = $this->decodeStream($formRaw);
        if ($decoded === null || str_contains($decoded, self::MARKER)) {
            return null;
        }

        $newStream = rtrim($decoded, "\r\n") . "\n" . self::MARKER . "\n" . $block;
        $encoded = gzcompress($newStream, 9);
        if ($encoded === false) {
            return null;
        }

        $dict = preg_replace('#/Length\s+\d+#', '/Length ' . strlen($encoded), $dict, 1) ?? $dict;
        if ($this->streamFilter($dict) === 'none') {
            $dict = preg_replace('#>>\s*$#', "/Filter /FlateDecode >>\n", $dict, 1) ?? $dict;
        }

        return $dict . "stream\n" . $encoded . "\nendstream\nendobj";
    }

    /** Add the font + graphics state to an object's own (inline) dictionary. */
    private function addResourcesToObject(string $objectRaw, int $fontRef, int $gsNum): ?string
    {
        $streamAt = strpos($objectRaw, 'stream');
        $head = $streamAt === false ? $objectRaw : substr($objectRaw, 0, $streamAt);
        $tail = $streamAt === false ? '' : substr($objectRaw, $streamAt);

        $open = strpos($head, '<<');
        if ($open === false) {
            return null;
        }
        $close = $this->matchingClose($head, $open);
        if ($close === null) {
            return null;
        }
        $dictText = substr($head, $open, $close - $open + 2);
        $patched = $this->insertResources($dictText, $fontRef, $gsNum);
        if ($patched === null) {
            return null;
        }
        return substr($head, 0, $open) . $patched . substr($head, $close + 2) . $tail;
    }

    /** Add the font + graphics state to a standalone resources-dictionary object. */
    private function patchDictObject(string $objectRaw, int $fontRef, int $gsNum): ?string
    {
        if (!str_contains($objectRaw, '/Font') && !str_contains($objectRaw, '<<')) {
            return null;
        }
        return $this->addResourcesToObject(rtrim($objectRaw) . "\n", $fontRef, $gsNum);
    }

    /** Decoded stream body of an object (FlateDecode or uncompressed), or null. */
    private function decodeStream(string $objectRaw): ?string
    {
        $streamAt = strpos($objectRaw, 'stream');
        if ($streamAt === false) {
            return null;
        }
        $dict = substr($objectRaw, 0, $streamAt);
        $body = substr($objectRaw, $streamAt);
        $endAt = strrpos($body, 'endstream');
        if ($endAt === false) {
            return null;
        }
        $payload = substr($body, strlen('stream'), $endAt - strlen('stream'));
        $payload = trim($payload, "\r\n");

        $filter = $this->streamFilter($dict);
        if ($filter === 'flate') {
            $decoded = @gzuncompress($payload);
            return $decoded === false ? null : $decoded;
        }
        return $filter === 'none' ? $payload : null;
    }

    /**
     * Insert `/MACWMF0` (font) and `/MACWGS0` (alpha state) into a resources
     * dictionary, creating the sub-dictionaries when they are absent.
     *
     * Returns null (⇒ skip this page) rather than half-editing a dictionary.
     */
    private function insertResources(string $dict, int $fontRef, int $gsNum): ?string
    {
        if (str_contains($dict, '/' . self::FONT_RES) || str_contains($dict, '/' . self::GS_RES)) {
            return null; // already contains our names: refuse to double-bake
        }
        $fontEntry = '/' . self::FONT_RES . ' ' . $fontRef . ' 0 R';
        $gsEntry = '/' . self::GS_RES . ' ' . $gsNum . ' 0 R';

        $resources = $dict;
        foreach ([['/Font', $fontEntry], ['/ExtGState', $gsEntry]] as [$key, $entry]) {
            $keyPos = strpos($resources, $key);
            if ($keyPos !== false) {
                $keyOpen = strpos($resources, '<<', $keyPos);
                $keyClose = $keyOpen === false ? null : $this->matchingClose($resources, $keyOpen);
                if ($keyOpen === false || $keyClose === null) {
                    return null;
                }
                $resources = substr($resources, 0, $keyClose) . ' ' . $entry . ' '
                    . substr($resources, $keyClose);
            } else {
                if (!str_ends_with(rtrim($resources), '>>')) {
                    return null;
                }
                $resources = rtrim(substr(rtrim($resources), 0, -2)) . ' '
                    . $key . ' << ' . $entry . ' >> >>';
            }
        }
        return $resources;
    }

    /** The embedded DejaVu face TCPDF already wrote for the page-level marks. */
    private function findWatermarkFont(array $objects): ?int
    {
        $fallback = null;
        foreach ($objects as $num => $raw) {
            if (!preg_match('#/Type\s*/Font#', $raw)) {
                continue;
            }
            if (preg_match('#/BaseFont\s*/(?:[A-Z]{6}\+)?DejaVuSans-Bold#i', $raw)) {
                return (int) $num; // the face the marks are drawn with
            }
            if ($fallback === null && preg_match('#/BaseFont\s*/(?:[A-Z]{6}\+)?DejaVu#i', $raw)) {
                $fallback = (int) $num;
            }
        }
        return $fallback;
    }

    // ── Parsing · rebuilding ──────────────────────────────────────────────────

    /**
     * Parse a classic-xref PDF into raw object bodies. Returns null when the file
     * uses a structure this baker deliberately does not touch (xref streams,
     * object streams, broken offsets).
     *
     * @return array{objects:array<int,string>,max:int,root:?string,info:?string,id:?string,header:string}|null
     */
    private function parse(string $raw): ?array
    {
        if (!str_starts_with($raw, '%PDF-') || str_contains($raw, '/ObjStm')) {
            return null;
        }
        $tailStart = max(0, strlen($raw) - 4096);
        $tail = substr($raw, $tailStart);
        if (!preg_match('#startxref\s+(\d+)\s+%%EOF#s', $tail, $m)) {
            return null;
        }
        $xrefAt = (int) $m[1];
        if ($xrefAt >= strlen($raw) || substr($raw, $xrefAt, 4) !== 'xref') {
            return null;
        }

        // Trailer dictionary (the one after the xref table).
        $trailerAt = strpos($raw, 'trailer', $xrefAt);
        if ($trailerAt === false) {
            return null;
        }
        $trailerOpen = strpos($raw, '<<', $trailerAt);
        if ($trailerOpen === false) {
            return null;
        }
        $trailerClose = $this->matchingClose($raw, $trailerOpen);
        if ($trailerClose === null) {
            return null;
        }
        $trailer = substr($raw, $trailerOpen, $trailerClose - $trailerOpen + 2);
        $root = preg_match('#/Root\s+(\d+\s+0\s+R)#', $trailer, $rm) ? $rm[1] : null;
        $info = preg_match('#/Info\s+(\d+\s+0\s+R)#', $trailer, $im) ? $im[1] : null;
        $id = preg_match('#/ID\s*(\[[^\]]*\])#', $trailer, $idm) ? $idm[1] : null;
        if ($root === null) {
            return null;
        }

        // xref subsections: "start count" then count 20-byte entries.
        $offsets = [];
        $pos = $xrefAt + 4;
        $table = substr($raw, $pos, $trailerAt - $pos);
        $lines = preg_split('/\r\n|\r|\n/', $table) ?: [];
        $i = 0;
        while ($i < count($lines)) {
            $line = trim($lines[$i]);
            if ($line === '') {
                $i++;
                continue;
            }
            if (!preg_match('/^(\d+)\s+(\d+)$/', $line, $sm)) {
                $i++;
                continue;
            }
            $start = (int) $sm[1];
            $count = (int) $sm[2];
            $i++;
            for ($k = 0; $k < $count; $k++, $i++) {
                if (!isset($lines[$i])) {
                    break;
                }
                if (!preg_match('/^(\d{10})\s+(\d{5})\s+([nf])/', trim($lines[$i]), $em)) {
                    continue;
                }
                if ($em[3] === 'n') {
                    $offsets[$start + $k] = (int) $em[1];
                }
            }
        }
        if ($offsets === []) {
            return null;
        }

        // Objects are NOT stored in object-number order (TCPDF rewrites the
        // page streams last), so slice by FILE OFFSET and keep the number.
        $byOffset = [];
        foreach ($offsets as $num => $start) {
            $byOffset[$start] = $num;
        }
        ksort($byOffset);
        $starts = array_keys($byOffset);

        $objects = [];
        foreach ($starts as $idx => $start) {
            $num = $byOffset[$start];
            $nextStart = $idx + 1 < count($starts) ? $starts[$idx + 1] : strlen($raw);
            if ($start >= strlen($raw) || $nextStart <= $start) {
                return null;
            }
            if (!preg_match('#^' . $num . '\s+\d+\s+obj#', substr($raw, $start, 40))) {
                return null; // offset does not point at the object: refuse
            }
            $chunk = substr($raw, $start, $nextStart - $start);
            $endAt = strrpos($chunk, 'endobj');
            if ($endAt === false) {
                return null;
            }
            $objects[$num] = substr($chunk, 0, $endAt + 6);
        }

        return [
            'objects' => $objects,
            'max' => max(array_keys($objects)),
            'root' => $root,
            'info' => $info,
            'id' => $id,
            'header' => substr($raw, 0, $starts[0]),
        ];
    }

    /** Serialise the document with a fresh, self-consistent xref table. */
    private function rebuild(array $doc): ?string
    {
        ksort($doc['objects']);
        $out = $doc['header'];
        $offsets = [];
        foreach ($doc['objects'] as $num => $raw) {
            $offsets[$num] = strlen($out);
            $out .= rtrim($raw, "\r\n") . "\n";
        }
        $size = max($doc['max'], max(array_keys($doc['objects']))) + 1;

        $xrefAt = strlen($out);
        $out .= "xref\n0 " . $size . "\n";
        $out .= "0000000000 65535 f \n";
        for ($n = 1; $n < $size; $n++) {
            if (isset($offsets[$n])) {
                $out .= sprintf("%010d 00000 n \n", $offsets[$n]);
            } else {
                $out .= "0000000000 65535 f \n";
            }
        }
        $trailer = '<< /Size ' . $size . ' /Root ' . $doc['root'];
        if ($doc['info'] !== null) {
            $trailer .= ' /Info ' . $doc['info'];
        }
        if ($doc['id'] !== null) {
            $trailer .= ' /ID ' . $doc['id'];
        }
        $trailer .= ' >>';
        $out .= "trailer\n" . $trailer . "\nstartxref\n" . $xrefAt . "\n%%EOF\n";

        return str_starts_with($out, '%PDF-') ? $out : null;
    }

    /** Structural self-check: header, EOF, and every xref offset points at its object. */
    private function verify(string $bytes): bool
    {
        if (!str_starts_with($bytes, '%PDF-') || !str_contains(substr($bytes, -64), '%%EOF')) {
            return false;
        }
        if (!preg_match('#startxref\s+(\d+)\s+%%EOF\s*$#s', $bytes, $m)) {
            return false;
        }
        $at = (int) $m[1];
        if (substr($bytes, $at, 4) !== 'xref') {
            return false;
        }
        $trailerAt = strpos($bytes, 'trailer', $at);
        if ($trailerAt === false) {
            return false;
        }
        $table = substr($bytes, $at + 4, $trailerAt - ($at + 4));
        $lines = preg_split('/\r\n|\r|\n/', $table) ?: [];
        $num = 0;
        $checked = 0;
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            if (preg_match('/^(\d+)\s+(\d+)$/', $line, $sm)) {
                $num = (int) $sm[1];
                continue;
            }
            if (preg_match('/^(\d{10})\s+(\d{5})\s+([nf])/', $line, $em)) {
                if ($em[3] !== 'n') {
                    $num++;
                    continue;
                }
                $offset = (int) $em[1];
                if (!preg_match('#^' . $num . '\s+\d+\s+obj#', substr($bytes, $offset, 40))) {
                    return false;
                }
                $checked++;
                $num++;
            }
        }
        return $checked > 0;
    }

    // ── Small PDF text helpers ────────────────────────────────────────────────

    /** Index of the `>>` that closes the `<<` at $open, or null. */
    private function matchingClose(string $text, int $open): ?int
    {
        $depth = 0;
        $len = strlen($text);
        for ($i = $open; $i < $len - 1; $i++) {
            $two = substr($text, $i, 2);
            if ($two === '<<') {
                $depth++;
                $i++;
                continue;
            }
            if ($two === '>>') {
                $depth--;
                if ($depth === 0) {
                    return $i;
                }
                $i++;
            }
        }
        return null;
    }

    /**
     * The value that follows `$key`: the inline `<< … >>` dictionary, or the
     * indirect reference text `N 0 R`. Null when the key is absent.
     */
    private function dictAfter(string $text, string $key): ?string
    {
        if (!preg_match('#' . preg_quote($key, '#') . '\s*#', $text, $m, PREG_OFFSET_CAPTURE)) {
            return null;
        }
        $pos = (int) $m[0][1] + strlen($m[0][0]);
        $after = substr($text, $pos, 32);
        if (preg_match('#^(\d+\s+0\s+R)#', ltrim($after), $ref)) {
            return $ref[1];
        }
        if (!str_starts_with(ltrim($after), '<<')) {
            return null;
        }
        $open = (int) strpos($text, '<<', $pos);
        $close = $this->matchingClose($text, $open);
        if ($close === null) {
            return null;
        }
        return substr($text, $open, $close - $open + 2);
    }

    /** Resolve a `<< … >>` value or an `N 0 R` reference to dictionary text. */
    private function resolve(array $objects, ?string $value): ?string
    {
        if ($value === null) {
            return null;
        }
        if (str_starts_with($value, '<<')) {
            return $value;
        }
        if (!preg_match('#^(\d+)\s+0\s+R$#', trim($value), $m)) {
            return null;
        }
        $raw = $objects[(int) $m[1]] ?? null;
        if ($raw === null) {
            return null;
        }
        $open = strpos($raw, '<<');
        if ($open === false) {
            return null;
        }
        $close = $this->matchingClose($raw, $open);
        return $close === null ? null : substr($raw, $open, $close - $open + 2);
    }

    /** @return array{0:float,1:float,2:float,3:float}|null */
    private function box(string $text, string $key): ?array
    {
        if (!preg_match('#' . preg_quote($key, '#') . '\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]#', $text, $m)) {
            return null;
        }
        return [(float) $m[1], (float) $m[2], (float) $m[3], (float) $m[4]];
    }

    /** True when the page carries a non-zero /Rotate (coordinate space differs). */
    private function hasRotation(string $pageRaw): bool
    {
        if (!preg_match('#/Rotate\s+(-?\d+)#', $pageRaw, $m)) {
            return false;
        }
        return (int) $m[1] % 360 !== 0;
    }

    /** 'flate', 'none' or 'other' for a stream dictionary. */
    private function streamFilter(string $dict): string
    {
        if (!preg_match('#/Filter\s*(/[\w]+|\[[^\]]*\])#', $dict, $m)) {
            return 'none';
        }
        $value = trim($m[1]);
        if ($value === '/FlateDecode' || $value === '/Fl') {
            return 'flate';
        }
        return 'other';
    }

    private function num(float $value): string
    {
        return rtrim(rtrim(number_format($value, 3, '.', ''), '0'), '.') ?: '0';
    }
}
