<?php

declare(strict_types=1);

namespace MedAcademy\Utils;

/**
 * Minimal .env loader. Parses KEY=VALUE lines (comments with #, optional
 * single/double quotes) into $_ENV without overwriting already-set values.
 */
final class Env
{
    public static function load(string $path): void
    {
        if (!is_file($path) || !is_readable($path)) {
            return; // missing .env — rely on real environment variables
        }
        $raw = file_get_contents($path);
        if ($raw === false) {
            return;
        }
        // Strip UTF-8 BOM (\xEF\xBB\xBF) if present — common on Windows editors
        if (str_starts_with($raw, "\xEF\xBB\xBF")) {
            $raw = substr($raw, 3);
        }
        $lines = preg_split('/\r?\n/', $raw);
        if ($lines === false) {
            return;
        }
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
                continue;
            }
            [$key, $value] = explode('=', $line, 2);
            $key = trim($key);
            $value = trim($value);
            // Skip if key is empty (could be a malformed line)
            if ($key === '') {
                continue;
            }
            if (getenv($key) !== false) {
                continue; // real environment wins
            }
            // Strip inline comments from unquoted values.
            // Quoted values preserve # characters (for tokens, URLs, etc.).
            $trimmedValue = trim($value);
            $isQuoted = (strlen($trimmedValue) >= 2
                && (($trimmedValue[0] === '"' && $trimmedValue[-1] === '"')
                    || ($trimmedValue[0] === "'" && $trimmedValue[-1] === "'")));
            if ($isQuoted) {
                // Strip surrounding quotes only
                $value = substr($trimmedValue, 1, -1);
            } else {
                // Unquoted: strip inline comment after first unescaped #
                $hashPos = strpos($value, '#');
                if ($hashPos !== false) {
                    $value = substr($value, 0, $hashPos);
                }
                $value = trim($value);
            }
            $_ENV[$key] = $value;
            putenv($key . '=' . $value);
        }
    }
}
