# LanPlay thin wrapper: is this process elevated? Prints ONE JSON object. Exit 0 ok / 1 failed.
# Runs on Windows PowerShell 5.1 (no ternary, no ??, no && / ||).
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

try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Write-JsonResult ([ordered]@{ isAdmin = [bool]$isAdmin; userName = $id.Name })
    exit 0
}
catch {
    Write-JsonResult ([ordered]@{ error = $_.Exception.Message })
    exit 1
}
