param(
    [ValidateSet('Daily','Report','Verify','Test')][string]$Action = 'Daily',
    [switch]$SkipCollect,
    [string]$DataDirectory = $env:EMBODIED_DATA_DIR,
    [string]$ReportDirectory = $env:EMBODIED_REPORT_DIR,
    [string]$Sources,
    [ValidateRange(1,100)][int]$Limit = 5,
    [ValidateRange(1,20)][int]$Pages = 2
)
$ErrorActionPreference = 'Stop'
$module = Join-Path $PSScriptRoot 'tools/embodied-news'
$localFile = Join-Path $PSScriptRoot 'config/embodied-news.local.json'
if (Test-Path -LiteralPath $localFile) {
    $local = Get-Content -LiteralPath $localFile -Raw -Encoding utf8 | ConvertFrom-Json
    if (-not $DataDirectory) { $DataDirectory = $local.dataDirectory }
    if (-not $ReportDirectory) { $ReportDirectory = $local.reportDirectory }
}
$previousTransport = $env:EMBODIED_BROWSER_TRANSPORT
try {
    $env:EMBODIED_BROWSER_TRANSPORT = 'ego-only'
    if ($Action -eq 'Daily' -and -not $SkipCollect) {
        try { & (Join-Path $module 'start-rsshub.ps1') }
        catch { Write-Warning ('RSSHub startup gap: ' + $_.Exception.Message) }
    }
    & (Join-Path $module 'run.ps1') -Action $Action -SkipCollect:$SkipCollect -DataDirectory $DataDirectory -ReportDirectory $ReportDirectory -Sources $Sources -Limit $Limit -Pages $Pages
    $result = $LASTEXITCODE
} finally { $env:EMBODIED_BROWSER_TRANSPORT = $previousTransport }
exit $result
