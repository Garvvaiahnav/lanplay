# LanPlay thin wrapper: which of the given ports are listening (TCP) / bound (UDP), and by which process.
#   -Ports "47984,47989,47990,48010,47920"  (comma separated)
# Prints ONE JSON object {listeners:[{port,protocol,address,pid,process}]}. Exit 0 ok / 1 failed / 2 bad arguments.
# Runs on Windows PowerShell 5.1 (no ternary, no ??, no && / ||).
param(
    [Parameter(Mandatory = $true)][string]$Ports
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

function Get-ProcName([int]$ProcessId) {
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $p) { return '' }
    return [string]$p.ProcessName
}

$portList = New-Object System.Collections.ArrayList
foreach ($s in ($Ports -split ',')) {
    $t = $s.Trim()
    if ($t -eq '') { continue }
    $n = 0
    if (-not [int]::TryParse($t, [ref]$n)) {
        Write-JsonResult ([ordered]@{ error = 'bad port: ' + $t })
        exit 2
    }
    [void]$portList.Add($n)
}

try {
    $out = New-Object System.Collections.ArrayList
    foreach ($port in $portList) {
        foreach ($c in @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
            [void]$out.Add([ordered]@{ port = [int]$port; protocol = 'tcp'; address = [string]$c.LocalAddress; pid = [int]$c.OwningProcess; process = (Get-ProcName ([int]$c.OwningProcess)) })
        }
        foreach ($u in @(Get-NetUDPEndpoint -LocalPort $port -ErrorAction SilentlyContinue)) {
            [void]$out.Add([ordered]@{ port = [int]$port; protocol = 'udp'; address = [string]$u.LocalAddress; pid = [int]$u.OwningProcess; process = (Get-ProcName ([int]$u.OwningProcess)) })
        }
    }
    Write-JsonResult ([ordered]@{ listeners = @($out.ToArray()) })
    exit 0
}
catch {
    Write-JsonResult ([ordered]@{ error = $_.Exception.Message })
    exit 1
}
