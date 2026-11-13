# LanPlay thin wrapper: OS, GPUs (name + driver), admin status, user name, PowerShell version. For diagnostics only.
# Prints ONE JSON object. Exit 0 ok / 1 failed.
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
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $gpus = New-Object System.Collections.ArrayList
    foreach ($g in @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue)) {
        [void]$gpus.Add([ordered]@{ name = [string]$g.Name; driverVersion = [string]$g.DriverVersion })
    }
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    Write-JsonResult ([ordered]@{
            os        = [string]$os.Caption
            version   = [string]$os.Version
            build     = [string]$os.BuildNumber
            gpus      = @($gpus.ToArray())
            isAdmin   = [bool]$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            userName  = [string]$id.Name
            psVersion = [string]$PSVersionTable.PSVersion
        })
    exit 0
}
catch {
    Write-JsonResult ([ordered]@{ error = $_.Exception.Message })
    exit 1
}
