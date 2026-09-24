<?php

declare(strict_types=1);

namespace MedAcademy\Http;

/**
 * A capability was refused because its Super Admin feature flag is disabled.
 *
 * Carries its own machine-readable code so the client can distinguish
 * "this feature is switched off" from a permission error, a maintenance
 * window, a suspended account or a transient failure:
 *
 *   HTTP 403
 *   { "error": { "code": "feature_disabled", "feature": "doctor_earnings", ... } }
 *
 * ErrorHandler maps this class to that code (see Middleware/ErrorHandler.php).
 */
final class FeatureDisabledException extends ApiException
{
    public function __construct(
        public readonly string $feature,
        string $message = 'This feature is temporarily unavailable.'
    ) {
        parent::__construct(403, $message, 'feature_disabled');
    }
}
