#Requires -Version 5.1
<#
.SYNOPSIS
  Single entry point for the MedAcademy REAL PDF-watermark test workflow (Windows).

.DESCRIPTION
  Bootstraps a pinned, isolated test environment under the git-ignored
  .freebuff/pdf-watermark-tests/ directory and runs the real PHP watermark
  pipeline tests against the source-controlled implementation.

  Nothing is installed globally, no system setting is changed, and no
  production database, PDF, credential or server is touched. Ghostscript is
  never downloaded without the explicit -AcceptGhostscriptLicense opt-in, and
  even then this script only downloads + verifies it; the (elevated) install
  step is printed as a command for you to run yourself.

  Quick start:
    powershell -NoProfile -ExecutionPolicy Bypass -File backend\tests\pdf-watermark\run.ps1

.PARAMETER BootstrapOnly
  Prepare the workspace (download + verify pinned dependencies, build fixtures)
  without running the test suites.

.PARAMETER SkipBootstrap
  Skip dependency preparation and go straight to the suites (offline re-runs).

.PARAMETER UseSystemPhp
  Use a PHP found on PATH instead of downloading the pinned PHP 8.3.35 runtime.

.PARAMETER AcceptGhostscriptLicense
  Explicit opt-in required before Ghostscript is downloaded. Ghostscript is
  dual-licensed AGPL v3 / commercial (Artifex); see
  backend/docs/PDF_WATERMARK_LICENSING.md. Without this flag the workflow only
  DETECTS an already-installed renderer and otherwise stops with instructions.

.PARAMETER Clean
  Delete the whole test workspace (.freebuff/pdf-watermark-tests) first.

.OUTPUTS
  Exit code 0 = every required suite passed.
  Exit code 1 = a required suite failed (details in out\REPORT.md).
  Exit code 2 = prerequisite missing or Ghostscript licensing opt-in not given.

  out\summary.json  machine-readable summary
  out\REPORT.md     human-readable report
  out\gallery.html  visual gallery (inspect manually; never auto-opened)
#>
[CmdletBinding()]
param(
    [switch]$BootstrapOnly,
    [switch]$SkipBootstrap,
    [switch]$UseSystemPhp,
    [switch]$AcceptGhostscriptLicense,
    [switch]$Clean
)

# Explicit exit-code checks everywhere; 'Continue' avoids the PowerShell 5.1
# native-stderr pitfall (a php warning on stderr must never abort a run
# before suite output is captured).
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ── Layout and pinned, tested versions ───────────────────────────────────────
$Harness       = $PSScriptRoot
$RepoRoot      = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$Work          = Join-Path $RepoRoot '.freebuff\pdf-watermark-tests'
$Downloads     = Join-Path $Work 'downloads'
$LibDir        = Join-Path $Work 'lib'
$ComposerHome  = Join-Path $Work 'composer-home'
$PhpDir        = Join-Path $Work 'runtime\php'
$GsDir         = Join-Path $Work 'gs'
$Out           = Join-Path $Work 'out'
$Fixtures      = Join-Path $Work 'fixtures'

$PhpZipName    = 'php-8.3.35-nts-Win32-vs16-x64.zip'
$PhpZipUrl     = "https://windows.php.net/downloads/releases/$PhpZipName"
$PhpZipSha256  = '25a8e2ac9ff30f1d768d1447c09a600617fa6e6082729f6e95f008b59c91fe45'
$ComposerVer   = '2.10.3'
$ComposerUrl   = "https://getcomposer.org/download/$ComposerVer/composer.phar"
$ComposerSha256 = '7a2d379d5b8ffdaa028580ef26494c36d2feef4b178d3dd1473a4dbc5e17c8d6'
$GsAsset       = 'gs10080w64.exe'
$GsBase        = 'https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10080'
$GsSha512      = 'cb3ecc798508851ba28b05e3fb914ddefe78168190726376d8581546ce61d5b216ffa3359e6f829072786bc12350501c7b6f99110d578696b87213d157774269'

function Write-Step([string]$m) { Write-Host "==> $m" }
function Write-Ok([string]$m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2([string]$m){ Write-Host "    $m" -ForegroundColor Yellow }

function Fail([string]$Message, [int]$Code = 1) {
    Write-Host ''
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit $Code
}

function Get-Hash([string]$Path, [string]$Alg) {
    return (Get-FileHash -Algorithm $Alg -Path $Path).Hash.ToLower()
}

function Assert-Hash([string]$Path, [string]$Alg, [string]$Expected, [string]$What) {
    $actual = Get-Hash $Path $Alg
    if ($actual -ne $Expected.ToLower()) {
        $msg = "checksum mismatch for {0}`n  expected ($Alg): {1}`n  actual   ($Alg): {2}`n" +
               "  Either the download is corrupt (retry) or the upstream artifact changed (investigate before updating the pin)."
        Fail ($msg -f $What, $Expected, $actual)
    }
}

function Get-RemoteFile([string]$Url, [string]$Dest, [string]$What) {
    if (Test-Path $Dest) { return }
    Write-Step "Downloading $What"
    Write-Host "       $Url"
    $part = "$Dest.part"
    Remove-Item $part -ErrorAction SilentlyContinue
    try {
        Invoke-WebRequest -Uri $Url -OutFile $part -UseBasicParsing -TimeoutSec 900 | Out-Null
        if (-not (Test-Path $part) -or (Get-Item $part).Length -le 0) { throw 'empty download' }
        Move-Item -Path $part -Destination $Dest -Force
    } catch {
        Remove-Item $part -ErrorAction SilentlyContinue
        $m = "download failed: {0}`n  {1}`n  Fix network/proxy access and re-run. Partial files are removed automatically."
        Fail ($m -f $Url, $_.Exception.Message)
    }
}

function Test-PhpUsable([string]$Php) {
    $problems = @()
    # NOTE: PHP code lives in single-quoted here-strings so the argument contains
    # no double quotes (PowerShell 5.1 strips embedded double quotes when building
    # the native command line).
    $phpVerCheck = @'
echo PHP_VERSION;
'@
    $phpExtCheck = @'
$m = array(); foreach (array('gd', 'pdo_sqlite', 'mbstring') as $e) { if (!extension_loaded($e)) { $m[] = $e; } } if (!function_exists('imagettftext')) { $m[] = 'gd-FreeType'; } if (!function_exists('proc_open')) { $m[] = 'proc_open'; } elseif (in_array('proc_open', array_map('trim', explode(',', (string) ini_get('disable_functions'))))) { $m[] = 'proc_open-disabled'; } echo implode(',', $m);
'@
    $phpMemCheck = @'
echo ini_get('memory_limit');
'@
    try {
        $v = & $Php -r $phpVerCheck 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $v) { return @('php cannot execute') }
        $ver = ($v -join '').Trim()
        if ([version](($ver -split '-')[0]) -lt [version]'8.1.0') { $problems += "PHP $ver is too old (need >= 8.1)" }
        $miss = & $Php -r $phpExtCheck 2>$null
        $missStr = ($miss -join '').Trim()
        if ($missStr -ne '') { $problems += "missing/disabled: $missStr" }
        $mem = & $Php -r $phpMemCheck 2>$null
        $memStr = ($mem -join '').Trim()
        if ($memStr -ne '' -and $memStr -ne '-1' -and $memStr -notmatch '^\s*\d+\s*G') {
            $num = [double]($memStr -replace '[^0-9.]', '')
            $mult = 1.0
            if ($memStr -match 'K') { $mult = 0.001 } elseif ($memStr -match 'G') { $mult = 1024.0 }
            if (($num * $mult) -lt 512) { $problems += "memory_limit=$memStr (need >= 512M for truecolor page layers)" }
        }
    } catch {
        $problems += "php failed to run: $($_.Exception.Message)"
    }
    return $problems
}

# ── Clean state ──────────────────────────────────────────────────────────────
if ($Clean) {
    if ($Work -like '*\.freebuff\pdf-watermark-tests' -and (Test-Path $Work)) {
        Write-Step "Removing $Work"
        Remove-Item -Recurse -Force $Work
    } else {
        Fail "refusing to clean an unexpected path: $Work"
    }
}
foreach ($d in @($Work, $Downloads, $LibDir, $ComposerHome, $Out, $Fixtures)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ── 1. PHP runtime ───────────────────────────────────────────────────────────
$PhpExe = $null
if ($UseSystemPhp) {
    Write-Step 'Looking for a system PHP (-UseSystemPhp)'
    $cmd = Get-Command php -ErrorAction SilentlyContinue
    if (-not $cmd) { Fail 'no php found on PATH. Install PHP >= 8.1 with gd (FreeType), pdo_sqlite and mbstring, or re-run WITHOUT -UseSystemPhp to use the pinned runtime.' 2 }
    $PhpExe = $cmd.Source
} else {
    $PhpExe = Join-Path $PhpDir 'php.exe'
    if (-not (Test-Path $PhpExe)) {
        $arch = "$env:PROCESSOR_ARCHITECTURE"
        if ($arch -ne '' -and $arch -ne 'AMD64') {
            Fail "the pinned PHP runtime is x86-64 only (host arch: $arch). Install a matching PHP and re-run with -UseSystemPhp." 2
        }
        Write-Step "Preparing pinned PHP 8.3.35 (NTS, x64) under $PhpDir"
        $zip = Join-Path $Downloads $PhpZipName
        Get-RemoteFile $PhpZipUrl $zip $PhpZipName
        # Official checksum: windows.php.net publishes an SPDX sidecar next to every build.
        $spdx = Join-Path $Downloads "$PhpZipName.spdx.json"
        Get-RemoteFile "$PhpZipUrl.spdx.json" $spdx "$PhpZipName.spdx.json"
        $sidecar = $null
        try { $sidecarDoc = Get-Content $spdx -Raw | ConvertFrom-Json } catch { Fail "cannot parse the official SPDX checksum file: $($_.Exception.Message)" }
        foreach ($pkg in $sidecarDoc.packages) {
            if ("$($pkg.downloadLocation)" -like "*$PhpZipName*") {
                foreach ($c in $pkg.checksums) { if ($c.algorithm -eq 'SHA256') { $sidecar = "$($c.checksumValue)" } }
            }
        }
        if (-not $sidecar) { Fail "the official SPDX file did not contain a SHA256 for $PhpZipName" }
        Assert-Hash $zip 'SHA256' $sidecar "$PhpZipName (official SPDX sidecar)"
        Assert-Hash $zip 'SHA256' $PhpZipSha256 "$PhpZipName (pinned in run.ps1)"
        if (Test-Path $PhpDir) { Remove-Item -Recurse -Force $PhpDir }
        $tmpDir = "$PhpDir.tmp"
        if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
        Write-Step 'Extracting PHP into the ignored workspace'
        try {
            Expand-Archive -Path $zip -DestinationPath $tmpDir -Force
        } catch {
            Fail "could not extract the PHP zip: $($_.Exception.Message)"
        }
        Move-Item -Path $tmpDir -Destination $PhpDir
        Copy-Item (Join-Path $Harness 'php.ini') (Join-Path $PhpDir 'php.ini') -Force
    }
}
if (-not (Test-Path $PhpExe)) { Fail "PHP executable not found at $PhpExe" 2 }
if (-not $UseSystemPhp -and -not (Test-Path (Join-Path (Split-Path $PhpExe) 'php.ini'))) {
    Copy-Item (Join-Path $Harness 'php.ini') (Join-Path (Split-Path $PhpExe) 'php.ini') -Force
}
$phpProblems = @(Test-PhpUsable $PhpExe)
if ($phpProblems.Count -gt 0 -and $phpProblems[0]) {
    $hint = if ($UseSystemPhp) {
        'Your PHP is missing required extensions. Install php-gd (FreeType), php-sqlite/pdo_sqlite and php-mbstring, or re-run WITHOUT -UseSystemPhp.'
    } else {
        'The pinned runtime is broken - run run.ps1 -Clean to re-download it.'
    }
    Fail ("PHP check failed for $PhpExe`n  - " + ($phpProblems -join "`n  - ") + "`n$hint") 2
}
$phpVer = ((& $PhpExe -r 'echo PHP_VERSION;') -join '').Trim()
Write-Ok "PHP $phpVer  ($PhpExe)"

# ── 2. Composer (pinned phar, verified) ─────────────────────────────────────
$ComposerPhar = Join-Path $Downloads 'composer.phar'
if (-not $SkipBootstrap) {
    Get-RemoteFile $ComposerUrl $ComposerPhar "composer.phar $ComposerVer"
    Assert-Hash $ComposerPhar 'SHA256' $ComposerSha256 "composer.phar $ComposerVer"
    Write-Ok "Composer $ComposerVer verified (sha256)"
}

# ── 3. FPDF + FPDI via Composer into the ignored workspace ──────────────────
if (-not $SkipBootstrap) {
    Write-Step 'Installing pinned FPDF/FPDI (composer install --no-interaction)'
    Copy-Item (Join-Path $Harness 'composer.json') $LibDir -Force
    Copy-Item (Join-Path $Harness 'composer.lock') $LibDir -Force
    $env:COMPOSER_HOME = $ComposerHome
    & $PhpExe $ComposerPhar install --working-dir="$LibDir" --no-interaction --no-progress --prefer-dist --no-ansi
    $cRc = $LASTEXITCODE
    if ($cRc -ne 0) { Fail "composer install failed (exit $cRc) - see the output above. Check network access to repo.packagist.org / api.github.com." 2 }
}
if (-not (Test-Path (Join-Path $LibDir 'vendor\autoload.php'))) {
    Fail "FPDF/FPDI are not installed (missing $LibDir\vendor\autoload.php). Re-run WITHOUT -SkipBootstrap." 2
}
Write-Ok 'FPDF/FPDI present (lib\vendor)'

# ── 4. Ghostscript (detect; download only after explicit opt-in, install by
#        hand with a printed command — this script never elevates itself) ────
function Find-Ghostscript {
    $candidates = @()
    if ($env:GHOSTSCRIPT_BIN) { $candidates += $env:GHOSTSCRIPT_BIN }
    foreach ($n in @('gswin64c', 'gswin32c', 'gs')) {
        $c = Get-Command $n -ErrorAction SilentlyContinue
        if ($c) { $candidates += $c.Source }
    }
    $candidates += (Join-Path $GsDir 'bin\gswin64c.exe')
    $candidates += (Join-Path $GsDir 'bin\gswin32c.exe')
    foreach ($bin in $candidates) {
        if (-not $bin) { continue }
        try {
            $v = & $bin --version 2>$null
            if ($LASTEXITCODE -eq 0 -and $v) {
                $m = [regex]::Match(("$v" -join ' '), '\d+\.\d+(\.\d+)?')
                return @{ bin = $bin; version = $(if ($m.Success) { $m.Value } else { 'unknown' }) }
            }
        } catch { continue }
    }
    return $null
}

$gsInfo = Find-Ghostscript
$gsInWorkspace = Test-Path (Join-Path $GsDir 'bin\gswin64c.exe')

if (-not $gsInfo -and -not $gsInWorkspace) {
    # ── No renderer detected: disclose the licensing situation ──
    Write-Host ''
    Write-Host 'GHOSTSCRIPT NOT FOUND - LICENSING DISCLOSURE' -ForegroundColor Yellow
    $disclosure = @'
  Ghostscript is dual-licensed: AGPL v3 (which contains a network-use clause)
  OR a commercial license sold exclusively by Artifex Software. Deciding which
  one applies to this deployment is a legal question this test workflow CANNOT
  answer; see backend/docs/PDF_WATERMARK_LICENSING.md.

  This workflow will neither download nor install Ghostscript without an
  explicit opt-in. Passing the local tests does NOT resolve licensing
  obligations and does NOT prove shared-hosting (cPanel) compatibility.

  Options:
    A) Use an already-installed renderer (recommended):
         install Ghostscript yourself (e.g. winget install ArtifexSoftware.GhostScript)
         or set GHOSTSCRIPT_BIN=<path-to-gswin64c.exe>, then re-run this script.
    B) Opt in to the download:
         re-run with -AcceptGhostscriptLicense
         The official Artifex installer is downloaded and SHA-512-verified against
         the publisher's SHA512SUMS plus a hash pinned in run.ps1. This script
         then prints the exact command to install it (silently, into the ignored
         workspace .freebuff/pdf-watermark-tests/gs - never into "Program Files",
         PATH untouched) for YOU to run in an elevated PowerShell. The script
         never elevates itself and never executes the installer on its own.
'@
    Write-Host $disclosure
    if (-not $AcceptGhostscriptLicense) {
        Fail 'Ghostscript is required for the raster tests and no renderer was found. Choose option A above, or opt in with -AcceptGhostscriptLicense (option B).' 2
    }

    Write-Step 'License opt-in accepted: downloading + SHA-512 verifying the official Ghostscript installer'
    $installer = Join-Path $Downloads $GsAsset
    Get-RemoteFile "$GsBase/SHA512SUMS" (Join-Path $Downloads 'SHA512SUMS') 'SHA512SUMS (Artifex)'
    Get-RemoteFile "$GsBase/$GsAsset" $installer $GsAsset
    $sums = Get-Content (Join-Path $Downloads 'SHA512SUMS') -Raw
    $sm = [regex]::Match($sums, "(?m)^([0-9a-f]{128})\s+\*?" + [regex]::Escape($GsAsset) + "\s*$")
    if (-not $sm.Success) { Fail "the publisher SHA512SUMS does not contain an entry for $GsAsset" 2 }
    Assert-Hash $installer 'SHA512' $sm.Groups[1].Value "$GsAsset (publisher SHA512SUMS)"
    Assert-Hash $installer 'SHA512' $GsSha512 "$GsAsset (pinned in run.ps1)"
    Write-Ok "$GsAsset sha512 verified (publisher SHA512SUMS + pinned hash)"

    Write-Host ''
    Write-Host '  Install step (run it yourself in an ELEVATED PowerShell, then re-run this script):' -ForegroundColor Yellow
    Write-Host "      Start-Process -FilePath '$installer' -ArgumentList '/S','/D=$GsDir' -Wait"
    Write-Host '  (or simply double-click the verified installer and choose the folder above.)'
    Fail "Ghostscript downloaded and verified; installation is left to you (this script never elevates or executes installers). The command above installs it into $GsDir." 2
}

# ── 5. Watermark font (a TTF is REQUIRED by the raster engine) ───────────────
function Find-Font {
    if ($env:PDF_WATERMARK_FONT -and (Test-Path $env:PDF_WATERMARK_FONT)) { return $env:PDF_WATERMARK_FONT }
    $fonts = Join-Path $env:WINDIR 'Fonts'
    foreach ($f in @('arialbd.ttf', 'segoeuib.ttf', 'calibrib.ttf', 'arial.ttf', 'verdanab.ttf')) {
        $p = Join-Path $fonts $f
        if (Test-Path $p) { return $p }
    }
    return $null
}
$font = Find-Font
if (-not $font) {
    Fail "no TrueType font found (looked in $env:WINDIR\Fonts). Set PDF_WATERMARK_FONT to any .ttf path and re-run." 2
}
Write-Ok "Font: $font"

# ── 6. pdftotext (optional; text checks are reported as SKIPPED without it) ──
function Find-Pdftotext {
    if ($env:PDFTOTEXT -and (Test-Path $env:PDFTOTEXT)) { return $env:PDFTOTEXT }
    $c = Get-Command pdftotext -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($cand in @('C:\msys64\mingw64\bin\pdftotext.exe', 'C:\msys64\usr\bin\pdftotext.exe',
                        'D:\msys64\mingw64\bin\pdftotext.exe', 'C:\Program Files\Git\mingw64\bin\pdftotext.exe')) {
        if (Test-Path $cand) { return $cand }
    }
    return $null
}
$pdftotext = Find-Pdftotext
if ($pdftotext) {
    Write-Ok "pdftotext: $pdftotext"
} else {
    Write-Warn2 'pdftotext not found - the marker text-extraction checks will run as SKIPPED (install pdftotext from Xpdf or Poppler, or set PDFTOTEXT, to enable them).'
}

$gsInfo = Find-Ghostscript
if (-not $gsInfo) { Fail 'renderer disappeared during bootstrap' 2 }

# ── 7. Environment for the suites ───────────────────────────────────────────
$env:PDFTEST_WORKDIR     = $Work
$env:PDF_WATERMARK_MODE  = 'raster'
$env:GHOSTSCRIPT_BIN     = $gsInfo.bin
$env:PDF_WATERMARK_FONT  = $font
$env:PDF_WATERMARK_TEST_TMP = Join-Path $Out 'tmp'
if ($pdftotext) { $env:PDFTOTEXT = $pdftotext } else { Remove-Item Env:PDFTOTEXT -ErrorAction SilentlyContinue }

# ── 8. Fixtures (deterministic generation, no committed sample PDFs) ─────────
if (-not $SkipBootstrap) {
    Write-Step 'Building fixtures (source.pdf + failure fixtures)'
    $env:PDFTEST_JSON_OUT = Join-Path $Out 'make_fixture.json'
    Remove-Item $env:PDFTEST_JSON_OUT -ErrorAction SilentlyContinue
    $fx = & $PhpExe -d "auto_prepend_file=$(Join-Path $Harness 'prepend.php')" (Join-Path $Harness 'make_fixture.php') 2>&1
    $fxRc = $LASTEXITCODE
    $fx | Set-Content (Join-Path $Out 'make_fixture.log') -Encoding UTF8
    if ($fxRc -ne 0) {
        $fx | ForEach-Object { Write-Host "      $_" }
        Fail "fixture generation failed (exit $fxRc) - see out\make_fixture.log" 2
    }
    Write-Ok 'fixtures built'
}

if ($BootstrapOnly) {
    Write-Host ''
    Write-Host "Bootstrap complete. Workspace: $Work" -ForegroundColor Green
    exit 0
}

# ── 9. Run the suites ────────────────────────────────────────────────────────
Write-Step 'Running test suites (each suite writes out\<id>.json + out\<id>.log)'
$suiteDefs = @(
    @{ id = 'real_pipeline';  script = 'run_real_test.php' },
    @{ id = 'repo_verify';    script = (Join-Path $RepoRoot 'backend\scripts\verify-watermark.php') },
    @{ id = 'error_handling'; script = 'error_tests.php' },
    @{ id = 'authorization';  script = 'auth_tests.php' },
    @{ id = 'gallery';        script = 'make_gallery.php' }
)

$exitCodes = @{}
foreach ($s in $suiteDefs) {
    $id = $s['id']
    $scriptPath = $s['script']
    if (-not [System.IO.Path]::IsPathRooted($scriptPath)) { $scriptPath = Join-Path $Harness $scriptPath }
    $jsonOut = Join-Path $Out "$id.json"
    $logOut  = Join-Path $Out "$id.log"
    Remove-Item $jsonOut -ErrorAction SilentlyContinue
    Remove-Item $logOut  -ErrorAction SilentlyContinue
    $env:PDFTEST_JSON_OUT = $jsonOut

    $lines = & $PhpExe -d "auto_prepend_file=$(Join-Path $Harness 'prepend.php')" $scriptPath 2>&1
    $rc = $LASTEXITCODE
    $lines | Set-Content -Path $logOut -Encoding UTF8
    $exitCodes[$id] = $rc

    if ($rc -eq 0) {
        Write-Ok "$id : PASS"
    } else {
        Write-Host "    $id : FAIL (exit $rc) - last lines of out\$id.log:" -ForegroundColor Red
        $lines | Select-Object -Last 15 | ForEach-Object { Write-Host "      $_" }
    }
}
$exitJson = $exitCodes | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $Out 'exitcodes.json'), $exitJson)

# ── 10. Machine-readable summary + human-readable report ─────────────────────
Write-Step 'Writing out\summary.json and out\REPORT.md'
$sumLines = & $PhpExe (Join-Path $Harness 'summarize.php') 2>&1
$sumRc = $LASTEXITCODE
$sumLines | ForEach-Object { Write-Host "    $_" }

if ($sumRc -eq 0) {
    Write-Host ''
    Write-Host "ALL REQUIRED SUITES PASSED - report: $(Join-Path $Out 'REPORT.md')" -ForegroundColor Green
} else {
    Write-Host ''
    Write-Host "TEST FAILURE - see $(Join-Path $Out 'REPORT.md')" -ForegroundColor Red
}
Write-Host "Visual gallery (inspect manually, never auto-opened): $(Join-Path $Out 'gallery.html')"
exit $sumRc
