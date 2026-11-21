# LanPlay thin wrapper: create or remove the inbound rules for "Allow connections from the internet".
#   -Enable 1 -Name "LanPlay Internet Play" -TcpPorts 47984,47989,48010 -UdpPorts 47998-48000   (create or update)
#   -Enable 0 -Name "LanPlay Internet Play"                                                      (remove)
# Two port rules (one TCP, one UDP), RemoteAddress Any, all profiles, enabled. Stable rule ids make re-runs update
# instead of duplicating. Disabling removes the two ids and any other inbound rule with the same display name.
# Port lists arrive as ONE comma separated string (powershell.exe -File passes every value as a string); a range is "a-b".
# Prints ONE JSON object. Exit 0 ok / 1 failed / 2 bad arguments.
# Runs on Windows PowerShell 5.1 (no ternary, no ??, no && / ||).
param(
    [Parameter(Mandatory = $true)][int]$Enable,
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$TcpPorts = '',
    [string]$UdpPorts = ''
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

function Split-PortList([string]$Text) {
    return @($Text -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}

function Test-PortList([object[]]$List) {
    $List = @($List)
    if ($List.Count -eq 0) { return $false }
    foreach ($p in $List) {
        if (([string]$p) -notmatch '^[0-9]{1,5}(-[0-9]{1,5})?$') { return $false }
    }
    return $true
}

$tcp = @(Split-PortList $TcpPorts)
$udp = @(Split-PortList $UdpPorts)
$badArguments = (($Enable -ne 0) -and ($Enable -ne 1)) -or ($Name.Trim() -eq '')
if ($Enable -eq 1) {
    if (-not (Test-PortList $tcp)) { $badArguments = $true }
    if (-not (Test-PortList $udp)) { $badArguments = $true }
}
if ($badArguments) {
    Write-JsonResult ([ordered]@{ error = 'bad arguments' })
    exit 2
}

try {
    $ids = @('LanPlay-InternetPlay-TCP', 'LanPlay-InternetPlay-UDP')
    $results = New-Object System.Collections.ArrayList
    $removed = New-Object System.Collections.ArrayList
    if ($Enable -eq 1) {
        $wanted = @(
            [ordered]@{ id = $ids[0]; proto = 'TCP'; ports = $tcp },
            [ordered]@{ id = $ids[1]; proto = 'UDP'; ports = $udp }
        )
        foreach ($r in $wanted) {
            $existing = Get-NetFirewallRule -Name $r.id -ErrorAction SilentlyContinue
            if ($null -eq $existing) {
                New-NetFirewallRule -Name $r.id -DisplayName $Name -Direction Inbound -Action Allow -Protocol $r.proto `
                    -LocalPort $r.ports -RemoteAddress Any -Profile Any -Enabled True | Out-Null
                [void]$results.Add([ordered]@{ id = $r.id; action = 'created' })
            }
            else {
                Set-NetFirewallRule -Name $r.id -NewDisplayName $Name -Direction Inbound -Action Allow -Protocol $r.proto `
                    -LocalPort $r.ports -RemoteAddress Any -Profile Any -Enabled True | Out-Null
                [void]$results.Add([ordered]@{ id = $r.id; action = 'updated' })
            }
        }
    }
    else {
        $seen = @{}
        foreach ($id in $ids) {
            foreach ($r in @(Get-NetFirewallRule -Name $id -ErrorAction SilentlyContinue)) {
                $seen[[string]$r.Name] = $true
            }
        }
        foreach ($r in @(Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue)) {
            if ([string]$r.Direction -eq 'Inbound') { $seen[[string]$r.Name] = $true }
        }
        foreach ($ruleId in @($seen.Keys)) {
            Remove-NetFirewallRule -Name $ruleId
            [void]$removed.Add($ruleId)
        }
    }
    Write-JsonResult ([ordered]@{ rules = @($results.ToArray()); removed = @($removed.ToArray()) })
    exit 0
}
catch {
    Write-JsonResult ([ordered]@{ error = $_.Exception.Message })
    exit 1
}
