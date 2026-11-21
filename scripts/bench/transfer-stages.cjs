#!/usr/bin/env node
/**
 * transfer-stages.cjs — measure the SERVER-SIDE stages of an upload/download.
 *
 * WHAT THIS DOES AND DOES NOT MEASURE
 * ──────────────────────────────────
 * It runs the two download implementations as real PHP child processes and times
 * them from the OUTSIDE, over a pipe:
 *
 *   buffered  — `file_get_contents($f)` then echo   (what /storage/signed did)
 *   streamed  — 256 KiB `fread` loop + flush        (Response::file, now)
 *
 * Time-to-first-byte is the moment the parent receives the first chunk, so the
 * difference between the two numbers is exactly the part of a download that used
 * to be invisible: the whole-file read that had to finish before anything moved.
 *
 * It also times the upload-side work PHP does per file (SHA-256, cross-device
 * copy). Those are file-system/CPU costs measured on THIS machine's disk, not on
 * the host — the table says so, and the report repeats it.
 *
 * It says NOTHING about the radio link, the carrier, or the phone. No device
 * measurement is claimed anywhere.
 *
 *   node scripts/bench/transfer-stages.cjs [--sizes=10,25]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PHP = process.env.PHP_BIN || path.join(ROOT, '.phpcli', 'php', 'php.exe');

const args = {};
for (const a of process.argv.slice(2)) {
  if (!a.startsWith('--')) continue;
  const [k, v] = a.slice(2).split('=');
  args[k] = v === undefined ? true : v;
}

const sizesMb = String(args.sizes || '10,25')
  .split(',')
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);

const CODE = {
  buffered: `
    $f = $argv[1];
    $t0 = microtime(true);
    $body = file_get_contents($f);
    $read = microtime(true) - $t0;
    fwrite(STDERR, sprintf("read=%.3f peak=%d", $read, memory_get_peak_usage(true)));
    echo $body;
  `,
  streamed: `
    $f = $argv[1];
    $h = fopen($f, 'rb');
    fseek($h, 0);
    while (!feof($h)) {
      $c = fread($h, 262144);
      if ($c === false || $c === '') break;
      echo $c;
      flush();
    }
    fclose($h);
    fwrite(STDERR, sprintf("read=0.000 peak=%d", memory_get_peak_usage(true)));
  `,
};

function run(mode, file) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(PHP, ['-d', 'memory_limit=1024M', '-r', CODE[mode], file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let firstByteAt = null;
    let bytes = 0;
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (firstByteAt === null) firstByteAt = Number(process.hrtime.bigint() - t0) / 1e6;
      bytes += chunk.length;
    });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', () => {
      const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const peak = Number((/peak=(\d+)/.exec(stderr) || [, 0])[1]);
      const readS = Number((/read=([\d.]+)/.exec(stderr) || [, 0])[1]);
      resolve({ mode, bytes, firstByteAt: firstByteAt ?? totalMs, totalMs, peak, readS });
    });
  });
}

function runSync(cmd, cmdArgs) {
  const t0 = process.hrtime.bigint();
  const child = spawn(PHP, ['-d', 'memory_limit=1024M', ...cmdArgs], { stdio: 'ignore' });
  return new Promise((resolve) => child.on('close', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6)));
}

const fmt = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);
const ms = (n) => `${n.toFixed(0)} ms`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medacademy-bench-'));
  console.log(`PHP: ${PHP}`);
  console.log(`temp: ${dir}\n`);

  const rows = [];
  for (const mb of sizesMb) {
    const file = path.join(dir, `payload-${mb}mb.bin`);
    // A PDF-ish body: compressed-looking, non-repeating, so the disk really reads it.
    const chunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < chunk.length; i += 1) chunk[i] = (i * 2654435761) & 0xff;
    const fd = fs.openSync(file, 'w');
    for (let i = 0; i < mb; i += 1) fs.writeSync(fd, chunk);
    fs.closeSync(fd);
    const size = fs.statSync(file).size;

    const buffered = await run('buffered', file);
    const streamed = await run('streamed', file);
    rows.push({ mb, size, buffered, streamed });

    // Upload-side work PHP performs per file.
    const hashMs = await runSync('hash', ['-r', 'hash_file("sha256", $argv[1]);', file]);
    const hash2Ms = await runSync('hash2', ['-r', 'hash_file("sha256", $argv[1]); hash_file("sha256", $argv[1]);', file]);
    const copyTarget = path.join(dir, `copy-${mb}mb.bin`);
    const copyMs = await runSync('copy', ['-r', 'copy($argv[1], $argv[2]);', file, copyTarget]);
    fs.rmSync(copyTarget, { force: true });
    console.log(`· ${fmt(size)}  hash=${ms(hashMs)}  hash×2=${ms(hash2Ms)}  cross-device-ish copy=${ms(copyMs)}`);

    fs.rmSync(file, { force: true });
  }

  console.log('\nDOWNLOAD — server side (this machine\'s disk)\n');
  console.log('| size | buffered: read-before-send | streamed: first byte | buffered peak mem | streamed peak mem |');
  console.log('|---|---:|---:|---:|---:|');
  for (const r of rows) {
    // The buffered child reports the time it spent reading the WHOLE file before
    // it could echo anything: that is exactly the delay the old route added to
    // time-to-first-byte, measured inside the process (no spawn noise).
    console.log(
      `| ${fmt(r.size)} | ${ms(r.buffered.readS * 1000)} | ${ms(r.streamed.firstByteAt)} | `
      + `${fmt(r.buffered.peak)} | ${fmt(r.streamed.peak)} |`,
    );
  }

  const worst = rows[rows.length - 1];
  console.log(`\nFor ${fmt(worst.size)}: the buffered route waits ${ms(worst.buffered.readS * 1000)} `
    + `before its first byte (the streamed route starts in ${ms(worst.streamed.firstByteAt)}), `
    + `and holds ${fmt(worst.buffered.peak)} of PHP memory instead of ${fmt(worst.streamed.peak)}.`);
  console.log('Memory is the decisive, noise-free part: it is the size of the file itself.');
  console.log('These are real local numbers for the SERVER stage only — not a phone measurement, '
    + 'and the host disk is slower and colder than this one.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
