<?php

declare(strict_types=1);

namespace MedAcademy\Notifications;

use MedAcademy\Utils\Config;

/**
 * Email delivery. Defaults to PHP mail() (works on most cPanel setups when
 * the server's mail transport is configured). Set SMTP_* in .env to use
 * SMTP (e.g. Hostinger's) instead — see Mailer\SmtpTransport.
 */
final class EmailService
{
    public static function send(string $to, string $subject, string $htmlBody): bool
    {
        $from = Config::string('MAIL_FROM', 'noreply@medacademy.eu.cc');
        $fromName = Config::string('MAIL_FROM_NAME', 'MedAcademy');

        if (Config::string('SMTP_HOST') !== '') {
            return SmtpTransport::send($to, $subject, $htmlBody, $from, $fromName);
        }

        $headers = [
            'From: ' . $fromName . ' <' . $from . '>',
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset=UTF-8',
            'X-Mailer: MedAcademy API',
        ];
        return mail($to, '=?UTF-8?B?' . base64_encode($subject) . '?=', $htmlBody, implode("\r\n", $headers));
    }
}
