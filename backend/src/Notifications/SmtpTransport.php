<?php

declare(strict_types=1);

namespace MedAcademy\Notifications;

use MedAcademy\Utils\Config;

/**
 * Minimal SMTP client (no external dependencies) used when SMTP_* env vars
 * are configured. Supports STARTTLS and implicit TLS (port 465).
 */
final class SmtpTransport
{
    public static function send(string $to, string $subject, string $htmlBody, string $from, string $fromName): bool
    {
        $host = Config::string('SMTP_HOST');
        $port = Config::int('SMTP_PORT', 587);
        $user = Config::string('SMTP_USER');
        $pass = Config::string('SMTP_PASS');
        $secure = Config::string('SMTP_SECURE', 'tls');

        $prefix = $secure === 'ssl' ? 'ssl://' : '';
        $sock = @stream_socket_client($prefix . $host . ':' . $port, $errno, $errstr, 15);
        if ($sock === false) {
            return false;
        }
        stream_set_timeout($sock, 15);

        $read = static function ($sock) {
            $line = '';
            while (($chunk = fgets($sock, 515)) !== false) {
                $line .= $chunk;
                if (isset($chunk[3]) && $chunk[3] === ' ') {
                    break;
                }
            }
            return $line;
        };
        $cmd = static function ($sock, $c) use ($read) {
            fwrite($sock, $c . "\r\n");
            return $read($sock);
        };

        $read($sock);
        $cmd($sock, 'EHLO medacademy');
        if ($secure === 'tls') {
            $cmd($sock, 'STARTTLS');
            if (!stream_socket_enable_crypto($sock, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                fclose($sock);
                return false;
            }
            $cmd($sock, 'EHLO medacademy');
        }
        $cmd($sock, 'AUTH LOGIN');
        $cmd($sock, base64_encode($user));
        $r = $cmd($sock, base64_encode($pass));
        if (str_starts_with($r, '5')) {
            fclose($sock);
            return false;
        }
        $cmd($sock, 'MAIL FROM:<' . $from . '>');
        $cmd($sock, 'RCPT TO:<' . $to . '>');
        $cmd($sock, 'DATA');
        $body = "Subject: =?UTF-8?B?" . base64_encode($subject) . "?=\r\n"
            . "From: " . $fromName . " <" . $from . ">\r\n"
            . "To: <" . $to . ">\r\n"
            . "MIME-Version: 1.0\r\n"
            . "Content-Type: text/html; charset=UTF-8\r\n"
            . "\r\n"
            . $htmlBody . "\r\n.";
        fwrite($sock, $body . "\r\n");
        $r = $read($sock);
        $cmd($sock, 'QUIT');
        fclose($sock);
        return str_starts_with($r, '2') || str_starts_with($r, '3');
    }
}
