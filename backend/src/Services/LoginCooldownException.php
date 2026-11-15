<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Http\ApiException;

/**
 * A login attempt refused by the source+identifier cooldown.
 *
 * It is an ApiException with the same 429 envelope as the per-IP limiter, so
 * every existing error path renders it unchanged. It also carries the exact
 * number of seconds the pair must wait, which the error handler emits as a
 * `Retry-After` header. The body never says whether the identifier exists.
 */
final class LoginCooldownException extends ApiException
{
    public readonly int $retryAfter;

    public function __construct(int $retryAfter)
    {
        $this->retryAfter = max(1, $retryAfter);
        parent::__construct(429, 'Too many attempts. Please try again later.', 'rate_limited');
    }
}
