# Deliberately bad wrapper for the check-ps test: PS7-only syntax, no StrictMode, bare exit.
$a = $null ?? 'x'
$b = $true ? 1 : 2
Get-Date && Get-Date
$c = ${a}?.Length
exit
