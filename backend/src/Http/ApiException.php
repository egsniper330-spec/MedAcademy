<?php

declare(strict_types=1);

namespace MedAcademy\Http;

/**
 * Exception that carries an HTTP status code. Thrown by controllers and
 * services to produce a JSON error response (see Middleware\ErrorHandler).
 */
class ApiException extends \RuntimeException
{
    public readonly int $status;

    /** @var array<int|string, mixed> Normalized to always be an array. */
    public readonly array $errors;

    public function __construct(
        int $status,
        string $message,
        string|array $errors = [],
        ?\Throwable $previous = null
    ) {
        $this->status = $status;
        // Normalize string error codes to array so all consumers see an array.
        $this->errors = is_string($errors) ? [$errors] : $errors;
        parent::__construct($message, 0, $previous);
    }
}
