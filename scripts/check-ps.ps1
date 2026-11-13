# Dev-only static check, run by scripts/check-ps.mjs with the portable pwsh 7.7 (vendor/pwsh-macos).
# For every file given: parse with [System.Management.Automation.Language.Parser]::ParseFile, then reject syntax
# that Windows PowerShell 5.1 cannot run (ternary, ??, ??=, ?. / ?[], && / || pipeline chains), and enforce the
# LanPlay wrapper rules (Set-StrictMode -Version Latest, $ErrorActionPreference = 'Stop', explicit exit codes).
# Optional: PSScriptAnalyzer from -AnalyzerPath. Prints ONE JSON object.
param(
    [Parameter(Mandatory = $true)][string]$Files,
    [string]$AnalyzerPath = '',
    [string]$WrapperFiles = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# -File passes every value as ONE string: lists are '|' separated.
$fileList = @($Files -split '\|' | Where-Object { $_ -ne '' })
$wrapperList = @($WrapperFiles -split '\|' | Where-Object { $_ -ne '' })

$results = @()
foreach ($f in $fileList) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errors)
    $problems = @()
    foreach ($e in $errors) { $problems += ('parse: ' + $e.Message + ' (line ' + $e.Extent.StartLineNumber + ')') }

    $ps7 = $ast.FindAll({
            param($n)
            if ($n -is [System.Management.Automation.Language.TernaryExpressionAst]) { return $true }
            if ($n -is [System.Management.Automation.Language.PipelineChainAst]) { return $true }
            if ($n -is [System.Management.Automation.Language.BinaryExpressionAst] -and $n.Operator -eq [System.Management.Automation.Language.TokenKind]::QuestionQuestion) { return $true }
            if ($n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Operator -eq [System.Management.Automation.Language.TokenKind]::QuestionQuestionEquals) { return $true }
            if ($n -is [System.Management.Automation.Language.MemberExpressionAst] -and $n.NullConditional) { return $true }
            if ($n -is [System.Management.Automation.Language.IndexExpressionAst] -and $n.NullConditional) { return $true }
            return $false
        }, $true)
    foreach ($n in $ps7) { $problems += ('PS7-only syntax not allowed on Windows PowerShell 5.1: ' + $n.GetType().Name + ' at line ' + $n.Extent.StartLineNumber + ': ' + $n.Extent.Text) }

    if ($wrapperList -contains $f) {
        $text = Get-Content -LiteralPath $f -Raw
        if ($text -notmatch '(?m)^\s*Set-StrictMode -Version Latest\s*$') { $problems += 'missing: Set-StrictMode -Version Latest' }
        if ($text -notmatch "(?m)^\s*\`$ErrorActionPreference = 'Stop'\s*$") { $problems += "missing: `$ErrorActionPreference = 'Stop'" }
        $exits = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ExitStatementAst] }, $true)
        if (@($exits).Count -lt 2) { $problems += 'expected explicit exit codes (at least success + failure)' }
        foreach ($x in $exits) {
            if ($null -eq $x.Pipeline) { $problems += ('bare exit without code at line ' + $x.Extent.StartLineNumber) }
        }
        if ($text -match '[^\x00-\x7F]') { $problems += 'non-ASCII characters (Windows PowerShell 5.1 reads BOM-less files as ANSI)' }
    }
    $results += [ordered]@{ file = $f; ok = ($problems.Count -eq 0); problems = $problems }
}

$analyzer = [ordered]@{ ran = $false; reason = 'no analyzer path given'; findings = @() }
if ($AnalyzerPath -ne '') {
    try {
        Import-Module (Join-Path $AnalyzerPath 'PSScriptAnalyzer') -ErrorAction Stop
        $findings = @()
        foreach ($f in $fileList) {
            foreach ($d in @(Invoke-ScriptAnalyzer -Path $f -Severity Warning, Error -ExcludeRule PSAvoidUsingWriteHost)) {
                $findings += [ordered]@{ file = $f; rule = $d.RuleName; severity = [string]$d.Severity; line = $d.Line; message = $d.Message }
            }
        }
        $analyzer = [ordered]@{ ran = $true; reason = ''; findings = $findings }
    }
    catch {
        $analyzer = [ordered]@{ ran = $false; reason = $_.Exception.Message; findings = @() }
    }
}

[ordered]@{ results = $results; analyzer = $analyzer } | ConvertTo-Json -Depth 6 -Compress
exit 0
