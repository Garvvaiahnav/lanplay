# LanPlay thin wrapper: install the ViGEmBus virtual gamepad driver silently. MUST run elevated (called by setup-controllers.ps1).
#   -Installer <absolute path to ViGEmBus_1.22.0_x64_x86_arm64.exe>
# Prints ONE JSON object {installed,alreadyInstalled,rebootRequired,exitCode,signature,error?}. Exit 0 installed / 1 failed / 2 bad arguments.
# The installer is checked against the pinned SHA256 (vendor/manifest.json, vigembus-windows-installer) before it is run with
# administrator rights; the Authenticode status is reported for diagnostics but not required (offline revocation checks).
# Runs on Windows PowerShell 5.1 (no ternary, no ??, no && / ||).
param(
    [Parameter(Mandatory = $true)][string]$Installer
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$PinnedSha256 = '89220a7865076b342892f98865f3499fb7c4cfd673159e89d352c360fd014c6a'
$InstallTimeoutMs = 180000

function Write-JsonResult([object]$Value) {
    $json = ConvertTo-Json -InputObject $Value -Depth 6 -Compress
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $json.ToCharArray()) {
        if ([int]$ch -gt 127) { [void]$sb.AppendFormat('\u{0:x4}', [int]$ch) } else { [void]$sb.Append($ch) }
    }
    [Console]::Out.Write($sb.ToString())
}

# ViGEmBus is a KERNEL DRIVER service (INF: ServiceType 1, binary drivers\ViGEmBus.sys), and Get-Service lists Win32 services only,
# so it can report "absent" for an installed driver. The service control manager's registry key is the authoritative record.
function Test-BusInstalled {
    $key = 'HKLM:\SYSTEM\CurrentControlSet\Services\ViGEmBus'
    if (-not (Test-Path -LiteralPath $key)) { return $false }
    $t = Get-ItemProperty -LiteralPath $key -Name 'Type' -ErrorAction SilentlyContinue
    if ($null -eq $t) { return $false }
    return ([int]$t.Type -eq 1)
}

if (-not [System.IO.Path]::IsPathRooted($Installer)) {
    Write-JsonResult ([ordered]@{ installed = $false; error = 'the installer path must be absolute' })
    exit 2
}

$result = [ordered]@{ installed = $false; alreadyInstalled = $false; rebootRequired = $false; exitCode = $null; signature = $null }
try {
    if (Test-BusInstalled) {
        $result.installed = $true
        $result.alreadyInstalled = $true
        Write-JsonResult $result
        exit 0
    }
    if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
        $result.error = 'installer not found'
        Write-JsonResult $result
        exit 1
    }
    $hash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $PinnedSha256) {
        $result.error = 'installer does not match the pinned SHA256; refusing to run it'
        Write-JsonResult $result
        exit 1
    }
    try { $result.signature = [string](Get-AuthenticodeSignature -LiteralPath $Installer).Status } catch { $result.signature = 'unknown' }

    # Advanced Installer switches (pinned in vendor/manifest.json): no UI, quiet, never restart by itself.
    $p = Start-Process -FilePath $Installer -ArgumentList @('/exenoui', '/qn', '/norestart') -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit($InstallTimeoutMs)) {
        try { $p.Kill() } catch { Write-Verbose 'could not stop the installer process' }
        $result.error = 'the installer did not finish in time'
        Write-JsonResult $result
        exit 1
    }
    $code = [int]$p.ExitCode
    $result.exitCode = $code
    # 0 ok, 3010 ok but a restart is pending, 1638 another version is already present.
    if ($code -eq 3010) { $result.rebootRequired = $true }
    if (($code -eq 0 -or $code -eq 3010 -or $code -eq 1638) -and (Test-BusInstalled)) {
        $result.installed = $true
        Write-JsonResult $result
        exit 0
    }
    $result.error = 'the installer finished with exit code ' + $code + ' and the ViGEmBus service is not present'
    Write-JsonResult $result
    exit 1
}
catch {
    $result.error = $_.Exception.Message
    Write-JsonResult $result
    exit 1
}
