# LanPlay thin wrapper (read-only): is the ViGEmBus virtual gamepad driver installed, running, and which version?
# Prints ONE JSON object {installed, serviceStatus, version}. serviceStatus is the driver state ('Running', 'Stopped', ...) or null;
# version is the file version of drivers\ViGEmBus.sys or null. Exit 0 ok / 1 failed.
# ViGEmBus is a KERNEL DRIVER (INF: ServiceType 1), which Get-Service does not list, so the service control manager's registry
# key decides "installed" and Win32_SystemDriver reports the state.
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
    $installed = $false
    $serviceStatus = $null
    $version = $null
    $key = 'HKLM:\SYSTEM\CurrentControlSet\Services\ViGEmBus'
    if (Test-Path -LiteralPath $key) {
        $t = Get-ItemProperty -LiteralPath $key -Name 'Type' -ErrorAction SilentlyContinue
        if (($null -ne $t) -and ([int]$t.Type -eq 1)) { $installed = $true }
    }
    if ($installed) {
        $drv = Get-CimInstance -ClassName Win32_SystemDriver -Filter "Name='ViGEmBus'" -ErrorAction SilentlyContinue
        if ($null -ne $drv) { $serviceStatus = [string]$drv.State }
        $sys = Join-Path ([Environment]::GetFolderPath('System')) 'drivers\ViGEmBus.sys'
        if (Test-Path -LiteralPath $sys -PathType Leaf) { $version = [string](Get-Item -LiteralPath $sys).VersionInfo.FileVersion }
    }
    Write-JsonResult ([ordered]@{ installed = $installed; serviceStatus = $serviceStatus; version = $version })
    exit 0
}
catch {
    Write-JsonResult ([ordered]@{ error = $_.Exception.Message })
    exit 1
}
