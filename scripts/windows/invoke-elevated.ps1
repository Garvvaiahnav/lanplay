# LanPlay thin wrapper: run ONE program elevated (UAC prompt) and wait for it.
#   -FilePath <absolute exe path>  (not "-File": that is powershell.exe's own switch)
#   -ArgumentListB64 <base64 of UTF-8 JSON array of ALREADY-QUOTED arguments>
# The arguments are quoted in TypeScript (QuoteWindowsArg, CommandLineToArgvW rules) because Windows PowerShell 5.1's
# Start-Process joins -ArgumentList elements with spaces WITHOUT quoting. They travel as base64 so no quote or
# non-ASCII character can be mangled by powershell.exe's own command-line parsing.
# Prints ONE JSON object {exitCode, cancelled}. Exit 0 = child ran (see exitCode) / 1 = failed or cancelled / 2 = bad arguments.
# Runs on Windows PowerShell 5.1 (no ternary, no ??, no && / ||).
param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$ArgumentListB64
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-JsonResult([object]$Value) {
    $json = ConvertTo-Json -InputObject $Value -Depth 6 -Compress
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $json.ToCharArray()) {
        if ([int]$ch -gt 127) { [void]$sb.AppendFormat('\u{0:x4}', [int]$ch) } else { [void]$sb.Append($ch) }
    }
    [Console]::Out.Write($sb.ToString())
}

$argLine = ''
try {
    if (-not [System.IO.Path]::IsPathRooted($FilePath)) { throw 'File must be an absolute path' }
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { throw ('File not found: ' + $FilePath) }
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentListB64))
    # No @(...) here: Windows PowerShell 5.1 emits a JSON array as ONE object; foreach enumerates it.
    $parts = ConvertFrom-Json -InputObject $json
    $strings = New-Object System.Collections.ArrayList
    foreach ($p in $parts) { [void]$strings.Add([string]$p) }
    $argLine = ($strings.ToArray()) -join ' '
}
catch {
    Write-JsonResult ([ordered]@{ error = $_.Exception.Message; exitCode = $null; cancelled = $false })
    exit 2
}

try {
    $proc = Start-Process -FilePath $FilePath -ArgumentList $argLine -Verb RunAs -Wait -PassThru
    Write-JsonResult ([ordered]@{ exitCode = [int]$proc.ExitCode; cancelled = $false })
    exit 0
}
catch {
    $msg = $_.Exception.Message
    # ERROR_CANCELLED (1223): the user clicked "No" on the UAC prompt.
    $cancelled = $false
    $inner = $_.Exception
    while ($null -ne $inner) {
        if ($inner -is [System.ComponentModel.Win32Exception]) {
            if ($inner.NativeErrorCode -eq 1223) { $cancelled = $true }
        }
        $inner = $inner.InnerException
    }
    Write-JsonResult ([ordered]@{ error = $msg; exitCode = $null; cancelled = $cancelled })
    exit 1
}
