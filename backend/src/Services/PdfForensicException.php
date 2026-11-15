<?php

declare(strict_types=1);

namespace MedAcademy\Services;

/**
 * Failure raised by PdfForensicClient. `code()` is a stable, loggable identifier that never
 * contains credentials, payloads or document content.
 *
 * Note: the property is deliberately NOT named `$code` — Exception::$code already exists and
 * cannot be redeclared as readonly.
 */
final class PdfForensicException extends \RuntimeException
{
    public function __construct(
        private readonly string $errorCode,
        string $message = '',
    ) {
        parent::__construct($message !== '' ? $message : $errorCode);
    }

    public function code(): string
    {
        return $this->errorCode;
    }
}
