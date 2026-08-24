<?php

declare(strict_types=1);

namespace MedAcademy\Validation;

use MedAcademy\Http\ApiException;

/**
 * Lightweight validator. Rules are applied per field and collected into a
 * single 422 response so clients can show field-level errors.
 */
final class Validator
{
    private array $errors = [];

    public static function make(array $data, array $rules): self
    {
        $v = new self();
        foreach ($rules as $field => $ruleList) {
            foreach ((array) $ruleList as $rule) {
                $v->apply($field, $data, $rule);
            }
        }
        return $v;
    }

    public function fails(): bool
    {
        return $this->errors !== [];
    }

    public function errors(): array
    {
        return $this->errors;
    }

    public function throwIfInvalid(): void
    {
        if ($this->fails()) {
            throw new ApiException(422, 'Validation failed', ['validation_error' => $this->errors]);
        }
    }

    private function apply(string $field, array $data, string $rule): void
    {
        $value = $data[$field] ?? null;
        $has = array_key_exists($field, $data);

        switch (true) {
            case $rule === 'required':
                if (!$has || $value === null || $value === '') {
                    $this->add($field, 'required');
                }
                break;

            case $rule === 'string':
                if ($has && $value !== null && !is_string($value)) {
                    $this->add($field, 'must be a string');
                }
                break;

            case $rule === 'email':
                if ($has && $value !== null && $value !== '' && !filter_var($value, FILTER_VALIDATE_EMAIL)) {
                    $this->add($field, 'must be a valid email');
                }
                break;

            case $rule === 'uuid':
                if ($has && $value !== null && $value !== '' && !\MedAcademy\Utils\Uuid::isValid((string) $value)) {
                    $this->add($field, 'must be a valid UUID');
                }
                break;

            case $rule === 'boolean':
                if ($has && $value !== null && !is_bool($value) && !in_array($value, [0, 1, '0', '1', 'true', 'false'], true)) {
                    $this->add($field, 'must be a boolean');
                }
                break;

            case $rule === 'integer':
                if ($has && $value !== null && !is_int($value) && !(is_string($value) && ctype_digit($value))) {
                    $this->add($field, 'must be an integer');
                }
                break;

            case $rule === 'array':
                if ($has && $value !== null && !is_array($value)) {
                    $this->add($field, 'must be an array');
                }
                break;

            case str_starts_with($rule, 'min:'):
                $min = (int) substr($rule, 4);
                if ($has && $value !== null && (is_string($value) ? mb_strlen($value) < $min : $value < $min)) {
                    $this->add($field, "must be at least {$min}" . (is_string($value) ? ' characters' : ''));
                }
                break;

            case str_starts_with($rule, 'max:'):
                $max = (int) substr($rule, 4);
                if ($has && $value !== null && (is_string($value) ? mb_strlen($value) > $max : $value > $max)) {
                    $this->add($field, "must be at most {$max}" . (is_string($value) ? ' characters' : ''));
                }
                break;

            case str_starts_with($rule, 'in:'):
                $allowed = explode(',', substr($rule, 3));
                if ($has && $value !== null && !in_array((string) $value, $allowed, true)) {
                    $this->add($field, 'must be one of: ' . implode(', ', $allowed));
                }
                break;
        }
    }

    private function add(string $field, string $message): void
    {
        if (!isset($this->errors[$field])) {
            $this->errors[$field] = [];
        }
        $this->errors[$field][] = $message;
    }
}
