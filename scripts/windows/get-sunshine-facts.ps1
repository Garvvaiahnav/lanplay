# LanPlay thin wrapper: REPORTS facts about Sunshine (service, uninstall registry entries, env). TypeScript decides.
# Prints ONE JSON object (non-ASCII escaped as \uXXXX so the console code page cannot mangle paths). Exit 0 ok / 1 failed.
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

function Get-Prop([object]$Obj, [string]$Name) {
    if ($null -eq $Obj) { return $null }
    $p = $Obj.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    if ($null -eq $p.Value) { return $null }
    return [string]$p.Value
}

try {
    $service = $null
    # Service name: "set SERVICE_NAME=SunshineService" (Sunshine src_assets/windows/misc/service/install-service.bat#L7)
    $svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='SunshineService'" -ErrorAction SilentlyContinue
    if ($null -ne $svc) {
        $service = [ordered]@{
            name      = [string]$svc.Name
            pathName  = [string]$svc.PathName
            startMode = [string]$svc.StartMode
            state     = [string]$svc.State
        }
    }

    $entries = New-Object System.Collections.ArrayList
    $skippedKeys = 0
    $roots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
            # One broken Uninstall key (Windows PowerShell 5.1 throws "Specified cast is not valid" on a malformed
            # registry value, even with -ErrorAction SilentlyContinue) must not fail the whole report: skip that key.
            $props = $null
            try {
                $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
            }
            catch {
                $skippedKeys++
                continue
            }
            $displayName = Get-Prop $props 'DisplayName'
            if ($null -eq $displayName) { continue }
            if (-not ($displayName -like 'Sunshine*')) { continue }
            $entry = [ordered]@{ displayName = $displayName }
            $v = Get-Prop $props 'DisplayVersion'
            if ($null -ne $v) { $entry.displayVersion = $v }
            $v = Get-Prop $props 'InstallLocation'
            if ($null -ne $v) { $entry.installLocation = $v }
            $v = Get-Prop $props 'UninstallString'
            if ($null -ne $v) { $entry.uninstallString = $v }
            [void]$entries.Add($entry)
        }
    }

    $envOut = [ordered]@{}
    foreach ($name in @('ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'LOCALAPPDATA', 'TEMP')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -ne $value) { $envOut[$name] = $value }
    }

    Write-JsonResult ([ordered]@{ service = $service; uninstallEntries = @($entries.ToArray()); env = $envOut; skippedUninstallKeys = $skippedKeys })
    exit 0
}
catch {
    Write-JsonResult ([ordered]@{ error = $_.Exception.Message })
    exit 1
}
