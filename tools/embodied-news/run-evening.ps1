param(
    [switch]$SkipCollect,
    [string]$DataDirectory = $env:EMBODIED_DATA_DIR,
    [string]$ReportDirectory = $env:EMBODIED_REPORT_DIR,
    [ValidateRange(1, 100)][int]$Limit = 5,
    [ValidateRange(1, 20)][int]$Pages = 2
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$taskPreviousBrowserTransport = $env:EMBODIED_BROWSER_TRANSPORT
try {
    $env:EMBODIED_BROWSER_TRANSPORT = 'ego-only'
    if (-not $SkipCollect) {
        try { & (Join-Path $PSScriptRoot 'start-rsshub.ps1') }
        catch { Write-Warning ('RSSHub startup gap: ' + $_.Exception.Message) }
    }
    & (Join-Path $PSScriptRoot 'run.ps1') -SkipCollect:$SkipCollect -Limit $Limit -Pages $Pages -DataDirectory $DataDirectory -ReportDirectory $ReportDirectory
    $taskEveningExitCode = $LASTEXITCODE
} finally {
    $env:EMBODIED_BROWSER_TRANSPORT = $taskPreviousBrowserTransport
}
exit $taskEveningExitCode
