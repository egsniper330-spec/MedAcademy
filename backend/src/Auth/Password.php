<?php

declare(strict_types=1);

namespace MedAcademy\Auth;

/**
 * Password hashing.
 *
 * Supabase GoTrue stores bcrypt hashes of the form "$2a$10$..." in
 * auth.users.encrypted_password. PHP's password_verify() recognises the
 * $2a$ prefix natively, so an exported hash keeps working without a
 * password reset. New passwords are hashed with password_hash() (bcrypt,
 * $2y$), which password_verify() also validates. See docs/AUTH_MIGRATION.md.
 */
final class Password
{
    public static function hash(string $plain): string
    {
        $hash = password_hash($plain, PASSWORD_BCRYPT, ['cost' => 10]);
        if ($hash === false) {
            throw new \RuntimeException('password_hash failed');
        }
        return $hash;
    }

    public static function verify(string $plain, string $hash): bool
    {
        if ($plain === '' || $hash === '') {
            return false;
        }
        return password_verify($plain, $hash);
    }

    /**
     * True if the stored hash should be re-hashed (e.g. a Supabase $2a$ hash
     * that was successfully verified — re-hash transparently on next login).
     */
    public static function needsRehash(string $hash): bool
    {
        return password_needs_rehash($hash, PASSWORD_BCRYPT, ['cost' => 10]);
    }
}
