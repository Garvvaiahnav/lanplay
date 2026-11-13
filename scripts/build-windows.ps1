# Build the portable Windows LanPlay (dir + zip, no installer) ON the Windows PC.
# Usage (from the repo folder, in Windows PowerShell 5.1 or PowerShell 7):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-windows.ps1 [-SkipTests]
# Steps (each logged, stops on the first failure with its own exit code):
#   1 node/npm present (Node >= 22)      exit 10
#   2 fetch + SHA256-verify Sunshine MSI exit 11   (node scripts/fetch-vendor.mjs --windows)
#   3 npm ci (exact lockfile)            exit 12
#   4 typecheck + tests (unless -SkipTests) exit 13
#   5 npm run build                      exit 14
#   6 electron-builder --win dir zip     exit 15   (downloads the pinned Electron runtime, checksum-verified by @electron/get)
#   7 check the output                   exit 16
# Output: release\win-unpacked\LanPlay.exe and release\LanPlay-<version>-win.zip
param(
    [switch]$SkipTests
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Write-Step([string]$Text) {
    Write-Output ('==> ' + $Text)
}

function Invoke-Tool([string]$Exe, [string[]]$Arguments, [int]$FailCode, [string]$What) {
    Write-Output ('    ' + $Exe + ' ' + ($Arguments -join ' '))
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        Write-Output ('FAILED: ' + $What + ' (exit ' + $LASTEXITCODE + ')')
        exit $FailCode
    }
}

Write-Step '1/7 Node.js and npm'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $node -or $null -eq $npm) {
    Write-Output 'FAILED: Node.js 22 or newer is required (https://nodejs.org). Install it, open a new PowerShell, run again.'
    exit 10
}
$ver = (& $node.Source --version).Trim()
$major = [int]($ver.TrimStart('v').Split('.')[0])
if ($major -lt 22) {
    Write-Output ('FAILED: Node.js ' + $ver + ' is too old; need 22 or newer.')
    exit 10
}
Write-Output ('    node ' + $ver)

Write-Step '2/7 Sunshine installer (pinned SHA256)'
Invoke-Tool $node.Source @('scripts\fetch-vendor.mjs', '--windows') 11 'download/verify of the Sunshine MSI'

Write-Step '3/7 npm ci'
Invoke-Tool $npm.Source @('ci') 12 'npm ci'

if (-not $SkipTests) {
    Write-Step '4/7 typecheck + tests'
    Invoke-Tool $npm.Source @('run', 'typecheck') 13 'typecheck'
    Invoke-Tool $npm.Source @('test') 13 'tests'
}
else {
    Write-Step '4/7 tests skipped (-SkipTests)'
}

Write-Step '5/7 build'
Invoke-Tool $npm.Source @('run', 'build') 14 'build'

Write-Step '6/7 package (portable dir + zip)'
$builder = Join-Path $root 'node_modules\.bin\electron-builder.cmd'
if (-not (Test-Path -LiteralPath $builder)) {
    Write-Output ('FAILED: electron-builder not found at ' + $builder)
    exit 15
}
Invoke-Tool $builder @('--config', 'scripts\electron-builder.config.cjs', '--win', 'dir', 'zip', '--x64', '--publish', 'never') 15 'electron-builder'

Write-Step '7/7 check output'
$exe = Join-Path $root 'release\win-unpacked\LanPlay.exe'
$msi = Join-Path $root 'release\win-unpacked\resources\vendor\Sunshine-Windows-AMD64-installer.msi'
$ps = Join-Path $root 'release\win-unpacked\resources\ps\get-sunshine-facts.ps1'
foreach ($p in @($exe, $msi, $ps)) {
    if (-not (Test-Path -LiteralPath $p)) {
        Write-Output ('FAILED: missing ' + $p)
        exit 16
    }
}
$zip = @(Get-ChildItem -LiteralPath (Join-Path $root 'release') -Filter '*.zip' -ErrorAction SilentlyContinue)
Write-Output ''
Write-Output ('OK. Run: ' + $exe)
foreach ($z in $zip) { Write-Output ('Zip:  ' + $z.FullName) }
Write-Output ('Self-check from a terminal: & "' + $exe + '" --self-check > selfcheck.json')
exit 0
