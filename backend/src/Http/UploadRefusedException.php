<?php

declare(strict_types=1);

namespace MedAcademy\Http;

/**
 * An upload refusal that carries its own correlation id.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `UploadIntegrityService` writes one structured log line per stage under an
 * operation id (`up_…`), and the SUCCESSFUL upload response returns that id. On a
 * REFUSAL the id was written to the log and then dropped: the app showed
 * "Upload failed." (or "the PDF could not be read"), the doctor could not quote
 * anything, and an operator had to guess which line in a busy log belonged to
 * that attempt. Some refusals are only distinguishable by their bytes
 * (`pdf_invalid` for a damaged file vs. for a 9.5 MB body that was never the
 * selected 191 KB document), so guessing is not good enough.
 *
 * The refusal therefore keeps the same shape as any ApiException — same status,
 * same stable code in `errors[0]` — and adds the operation id, the stage and the
 * reason. `Middleware\ErrorHandler` copies them into the response's error object,
 * so the doctor's dialog can say "reference up_719a7e6cedaf" and `grep` on the
 * server finds exactly one attempt.
 *
 * Nothing here exposes content, a path or an identity: an operation id is a
 * random 6-byte hex token and the stage/reason are fixed vocabulary.
 */
final class UploadRefusedException extends ApiException
{
    public function __construct(
        int $status,
        string $message,
        string|array $errors,
        public readonly string $op,
        /** validate|persist|verify|pdf|inspect */
        public readonly string $stage,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($status, $message, $errors, $previous);
    }

    /** The stable machine-readable code (`errors[0]`), e.g. `pdf_invalid`. */
    public function reason(): string
    {
        foreach ($this->errors as $candidate) {
            if (is_string($candidate) && $candidate !== '') {
                return $candidate;
            }
        }
        return '';
    }
}
