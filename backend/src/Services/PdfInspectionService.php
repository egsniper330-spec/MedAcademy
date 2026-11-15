<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Config;

/**
 * PdfInspectionService — upload-time validation of a doctor's source PDF.
 *
 * This is the ONLY part of the retired in-house watermark renderer that was still in
 * active use: `UploadIntegrityService` calls it while a material is being uploaded, so a
 * document that could never be delivered is refused while the doctor can still act on the
 * message. Extracted here so the upload path no longer depends on a renderer that no
 * longer renders anything.
 *
 * What it checks, in order — all on the bytes actually on disk, never on client claims:
 *   1. the file is non-empty and within the configured source cap;
 *   2. it starts with `%PDF-`;
 *   3. it ends with an `%%EOF` trailer (a prefix is a truncated transfer, not a PDF);
 *   4. its trailer does not declare `/Encrypt`;
 *   5. optionally, the FPDI parser can open it.
 *
 * Step 5 is OFF by default. Personalization now happens in the forensic service, whose
 * renderer is PDFium: a PDF using compressed cross-reference/object streams (what Acrobat,
 * Word and most "optimised" exporters emit) is perfectly deliverable there, while the free
 * FPDI parser cannot read it. Running that parse would reject documents that would in fact
 * be delivered fine, so it only runs when an operator explicitly asks for it with
 * `PDF_INSPECT_FPDI=1` (for example while comparing a legacy export).
 *
 * Error codes are the existing, already-translated ones: pdf_empty, source_too_large,
 * pdf_invalid, pdf_truncated, pdf_encrypted, pdf_unsupported_format.
 */
final class PdfInspectionService
{
    /**
     * @return array{size:int,page_count:?int}
     *
     * @throws ApiException 422 with a stable reason code when the file cannot be delivered
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
                'This PDF is larger than the allowed limit ('
                . (int) round($this->maxSourceBytes() / 1048576) . ' MB).',
                'source_too_large'
            );
        }

        $head = (string) @file_get_contents($absPath, false, null, 0, 1024);
        if (!str_starts_with($head, '%PDF-')) {
            throw new ApiException(422, 'This file is not a valid PDF.', 'pdf_invalid');
        }

        // A missing trailer means the transfer stopped early: the bytes on disk are a
        // PREFIX of a real document. Catch it now, not at delivery.
        $tail = (string) @file_get_contents($absPath, false, null, max(0, $size - 4096));
        if (!str_contains($tail, '%%EOF')) {
            throw new ApiException(
                422,
                'This PDF is incomplete (the file was cut short while uploading). Please upload it again.',
                'pdf_truncated'
            );
        }
        if (str_contains($tail, '/Encrypt')) {
            throw new ApiException(422, 'This PDF is encrypted and cannot be processed. Upload an unencrypted PDF.', 'pdf_encrypted');
        }

        $pages = null;
        if ($this->fpdiEnabled() && class_exists('setasign\\Fpdi\\Fpdi')) {
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
                        'This PDF is saved in a compressed format the parser cannot read. Re-export it as a standard PDF '
                        . '(in Acrobat/Word choose "Print to PDF", or save with PDF 1.4 compatibility) and upload that copy.',
                        'pdf_unsupported_format',
                        $e
                    );
                }
                if ($encrypted) {
                    throw new ApiException(422, 'This PDF is encrypted and cannot be processed. Upload an unencrypted PDF.', 'pdf_encrypted', $e);
                }
                throw new ApiException(
                    422,
                    'This PDF could not be read (it may be damaged or use an unsupported format). Please upload a different copy.',
                    'pdf_invalid',
                    $e
                );
            } finally {
                // FPDI keeps the source stream open for the reader's lifetime; on Windows an
                // open handle blocks the rename that stores the file, so release it first.
                unset($reader);
                gc_collect_cycles();
            }
        }

        return ['size' => $size, 'page_count' => $pages];
    }

    /** Effective cap for a source PDF. A deliberate operator cap is never silently ignored. */
    public function maxSourceBytes(): int
    {
        return max(1024, Config::int('PDF_INSPECT_MAX_SOURCE_BYTES', Config::int('PDF_WATERMARK_MAX_SOURCE_BYTES', 50 * 1024 * 1024)));
    }

    private function fpdiEnabled(): bool
    {
        return Config::string('PDF_INSPECT_FPDI', '0') === '1';
    }

    /**
     * Did the parser fail because of the FILE's container format (compressed cross-reference /
     * object streams) rather than because the document is damaged? The message and the specific
     * COMPRESSED_XREF code are what is matched — the same exception class is thrown for real
     * corruption, which must stay pdf_invalid.
     */
    private function isUnsupportedContainer(\Throwable $e): bool
    {
        for ($c = $e; $c !== null; $c = $c->getPrevious()) {
            if (stripos($c->getMessage(), 'compression technique') !== false
                || stripos($c->getMessage(), 'not supported by the free parser') !== false
            ) {
                return true;
            }
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
     * Did the parser refuse because the document is encrypted? Needed on top of the trailer
     * scan: in a large document the trailer carrying `/Encrypt` can sit further than 4 KB from EOF.
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
}
