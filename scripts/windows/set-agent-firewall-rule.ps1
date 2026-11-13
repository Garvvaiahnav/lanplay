# LanPlay thin wrapper: idempotently create/repair the inbound rules for the LanPlay pair agent.
#   -Port 47920 -Name "LanPlay Pair Agent" [-Program "C:\...\LanPlay.exe"]
# Two port rules (TCP for the HTTP API, UDP for discovery), RemoteAddress LocalSubnet, all profiles, enabled.
# With -Program: two more rules bound to LanPlay.exe (same port/scope) so Windows does not show its
# "allow access?" prompt when the app starts listening (dismissing it would create a Block rule).
# Stable rule ids (-Name) make re-runs update instead of duplicating.
# Prints ONE JSON object. Exit 0 ok / 1 failed / 2 bad arguments.
# Runs on Windows PowerShell 5.1 (no ternary, no ??, no && / ||).
param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Name,
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

if ($Port -lt 1 -or $Port -gt 65535 -or $Name.Trim() -eq '' -or ($Program -ne '' -and -not [System.IO.Path]::IsPathRooted($Program))) {
    Write-JsonResult ([ordered]@{ error = 'bad arguments' })
    exit 2
}

try {
    $results = New-Object System.Collections.ArrayList
    foreach ($proto in @('TCP', 'UDP')) {
        $id = 'LanPlay-PairAgent-' + $proto
        $existing = Get-NetFirewallRule -Name $id -ErrorAction SilentlyContinue
        if ($null -eq $existing) {
            New-NetFirewallRule -Name $id -DisplayName $Name -Direction Inbound -Action Allow -Protocol $proto `
                -LocalPort $Port -RemoteAddress LocalSubnet -Profile Any -Enabled True | Out-Null
            [void]$results.Add([ordered]@{ id = $id; action = 'created' })
        }
        else {
            Set-NetFirewallRule -Name $id -NewDisplayName $Name -Direction Inbound -Action Allow -Protocol $proto `
                -LocalPort $Port -RemoteAddress LocalSubnet -Profile Any -Enabled True | Out-Null
            [void]$results.Add([ordered]@{ id = $id; action = 'updated' })
        }
    }
    if ($Program -ne '') {
        foreach ($proto in @('TCP', 'UDP')) {
            $id = 'LanPlay-PairAgent-App-' + $proto
            $existing = Get-NetFirewallRule -Name $id -ErrorAction SilentlyContinue
            if ($null -eq $existing) {
                New-NetFirewallRule -Name $id -DisplayName $Name -Direction Inbound -Action Allow -Protocol $proto `
                    -LocalPort $Port -RemoteAddress LocalSubnet -Profile Any -Enabled True -Program $Program | Out-Null
                [void]$results.Add([ordered]@{ id = $id; action = 'created' })
            }
            else {
                Set-NetFirewallRule -Name $id -NewDisplayName $Name -Direction Inbound -Action Allow -Protocol $proto `
                    -LocalPort $Port -RemoteAddress LocalSubnet -Profile Any -Enabled True -Program $Program | Out-Null
                [void]$results.Add([ordered]@{ id = $id; action = 'updated' })
            }
        }
    }
    Write-JsonResult ([ordered]@{ rules = @($results.ToArray()) })
    exit 0
}
catch {
    Write-JsonResult ([ordered]@{ error = $_.Exception.Message })
    exit 1
}
