# LanPlay elevated wrapper for phone controllers. Runs ELEVATED (UAC prompt) through invoke-elevated.ps1:
#   1. installs the ViGEmBus virtual-controller driver if it is missing (install-vigembus.ps1, next to this file)
#   2. creates/repairs inbound firewall rules for the phone controller port, home network (LocalSubnet) only
# An elevated child's stdout is not visible to the parent, so ONE JSON object {ok,message,driver,firewall} is written to -ResultFile.
#   -InstallerPath <ViGEmBus installer exe>  -Port 47921  -ResultFile <path>  [-Program <LanPlay.exe>]
# Exit 0 ok / 1 failed / 2 bad arguments. Runs on Windows PowerShell 5.1 (no ternary, no ??, no && / ||).
param(
    [string]$InstallerPath = '',
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$ResultFile,
    [string]$Program = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-ResultFile([object]$Value) {
    $json = ConvertTo-Json -InputObject $Value -Depth 6 -Compress
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $json.ToCharArray()) {
        if ([int]$ch -gt 127) { [void]$sb.AppendFormat('\u{0:x4}', [int]$ch) } else { [void]$sb.Append($ch) }
    }
    [System.IO.File]::WriteAllText($ResultFile, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
}

if ($Port -lt 1 -or $Port -gt 65535 -or -not [System.IO.Path]::IsPathRooted($ResultFile) -or ($Program -ne '' -and -not [System.IO.Path]::IsPathRooted($Program)) -or ($InstallerPath -ne '' -and -not [System.IO.Path]::IsPathRooted($InstallerPath))) {
    exit 2
}

$result = [ordered]@{ ok = $false; message = ''; driver = $null; firewall = $null }
try {
    if ($InstallerPath -ne '') {
        $installScript = Join-Path $PSScriptRoot 'install-vigembus.ps1'
        $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $text = (& $psExe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installScript -Installer $InstallerPath | Out-String).Trim()
        $driver = $null
        try { $driver = ConvertFrom-Json -InputObject $text } catch { $driver = $null }
        $result.driver = $driver
        if ($null -eq $driver -or -not $driver.installed) {
            $result.message = 'The virtual controller driver (ViGEmBus) could not be installed.'
            Write-ResultFile $result
            exit 1
        }
    }

    $rules = New-Object System.Collections.ArrayList
    $portRuleId = 'LanPlay-PhoneControllers-TCP'
    $existing = Get-NetFirewallRule -Name $portRuleId -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        New-NetFirewallRule -Name $portRuleId -DisplayName 'LanPlay Phone Controllers' -Direction Inbound -Action Allow -Protocol TCP `
            -LocalPort $Port -RemoteAddress LocalSubnet -Profile Any -Enabled True | Out-Null
        [void]$rules.Add([ordered]@{ id = $portRuleId; action = 'created' })
    } else {
        Set-NetFirewallRule -Name $portRuleId -Enabled True -Action Allow -Direction Inbound | Out-Null
        Get-NetFirewallRule -Name $portRuleId | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port | Out-Null
        Get-NetFirewallRule -Name $portRuleId | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet | Out-Null
        [void]$rules.Add([ordered]@{ id = $portRuleId; action = 'updated' })
    }
    if ($Program -ne '') {
        # A rule bound to LanPlay.exe keeps Windows from showing its "allow access?" prompt (dismissing it creates a Block rule).
        $appRuleId = 'LanPlay-PhoneControllers-App'
        $existingApp = Get-NetFirewallRule -Name $appRuleId -ErrorAction SilentlyContinue
        if ($null -eq $existingApp) {
            New-NetFirewallRule -Name $appRuleId -DisplayName 'LanPlay Phone Controllers (app)' -Direction Inbound -Action Allow -Protocol TCP `
                -LocalPort $Port -RemoteAddress LocalSubnet -Program $Program -Profile Any -Enabled True | Out-Null
            [void]$rules.Add([ordered]@{ id = $appRuleId; action = 'created' })
        } else {
            Set-NetFirewallRule -Name $appRuleId -Enabled True -Action Allow -Direction Inbound -Program $Program | Out-Null
            [void]$rules.Add([ordered]@{ id = $appRuleId; action = 'updated' })
        }
        $blocks = Get-NetFirewallApplicationFilter -Program $Program -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue |
            Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }
        foreach ($b in @($blocks)) {
            Remove-NetFirewallRule -Name $b.Name
            [void]$rules.Add([ordered]@{ id = [string]$b.Name; action = 'removed-block' })
        }
    }
    $result.firewall = $rules
    $result.ok = $true
    $result.message = 'ok'
    Write-ResultFile $result
    exit 0
} catch {
    $result.message = [string]$_.Exception.Message
    try { Write-ResultFile $result } catch { }
    exit 1
}
