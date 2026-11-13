# LanPlay thin wrapper: list Windows Firewall rules by display name (and optionally by program path).
#   -Names   "Sunshine,LanPlay Pair Agent"  (comma separated: powershell.exe -File passes every value as ONE string)
#   -Program "C:\...\LanPlay.exe"           (optional; also lists rules bound to that program, e.g. a Block rule
#                                            created when someone dismissed the Windows firewall prompt)
# Prints ONE JSON object {rules:[...]}. Exit 0 ok / 1 failed / 2 bad arguments.
# Runs on Windows PowerShell 5.1 (no ternary, no ??, no && / ||).
param(
    [Parameter(Mandatory = $true)][string]$Names,
    [string]$Program = ''
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

function Join-Value([object]$Value) {
    if ($null -eq $Value) { return '' }
    return (@($Value) | ForEach-Object { [string]$_ }) -join ','
}

function Convert-Rule([object]$Rule, [string]$MatchedBy) {
    $port = $Rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
    $addr = $Rule | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue
    $app = $Rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
    $protocol = ''
    $localPort = ''
    if ($null -ne $port) {
        $protocol = Join-Value $port.Protocol
        $localPort = Join-Value $port.LocalPort
    }
    $remote = ''
    if ($null -ne $addr) { $remote = Join-Value $addr.RemoteAddress }
    $programPath = ''
    if ($null -ne $app) { $programPath = Join-Value $app.Program }
    return [ordered]@{
        id            = [string]$Rule.Name
        name          = [string]$Rule.DisplayName
        enabled       = ([string]$Rule.Enabled -eq 'True')
        direction     = [string]$Rule.Direction
        action        = [string]$Rule.Action
        profile       = [string]$Rule.Profile
        protocol      = $protocol
        localPort     = $localPort
        remoteAddress = $remote
        program       = $programPath
        matchedBy     = $MatchedBy
    }
}

$list = @($Names -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
if ($list.Count -eq 0) {
    Write-JsonResult ([ordered]@{ error = 'no rule names given' })
    exit 2
}

try {
    $rules = New-Object System.Collections.ArrayList
    foreach ($n in $list) {
        foreach ($r in @(Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue)) {
            [void]$rules.Add((Convert-Rule $r 'name'))
        }
    }
    if ($Program -ne '') {
        foreach ($f in @(Get-NetFirewallApplicationFilter -Program $Program -ErrorAction SilentlyContinue)) {
            foreach ($r in @($f | Get-NetFirewallRule -ErrorAction SilentlyContinue)) {
                [void]$rules.Add((Convert-Rule $r 'program'))
            }
        }
    }
    Write-JsonResult ([ordered]@{ rules = @($rules.ToArray()) })
    exit 0
}
catch {
    Write-JsonResult ([ordered]@{ error = $_.Exception.Message })
    exit 1
}
