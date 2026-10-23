param([ValidateRange(10, 180)][int]$TimeoutSeconds = 60)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$taskConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config/rsshub.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not ($taskConfig.sources | Where-Object { $_.enabled -and $_.route })) { return }
$taskUri = [Uri]$taskConfig.baseUrl
if ($taskUri.Host -notin @('127.0.0.1', 'localhost')) { return }
try {
    $taskResponse = Invoke-WebRequest -Uri ($taskConfig.baseUrl.TrimEnd('/') + '/healthz') -TimeoutSec 3 -NoProxy
    if ($taskResponse.StatusCode -eq 200 -and $taskResponse.Content.Trim() -eq 'ok') { Write-Output 'RSSHub local service is ready.'; return }
} catch { }
$taskDocker = Join-Path $env:ProgramFiles 'Docker/Docker/resources/bin/docker.exe'
if (-not (Test-Path -LiteralPath $taskDocker)) { throw 'Docker Desktop is required for the configured local RSSHub service.' }
& $taskDocker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Start-Process -FilePath (Join-Path $env:ProgramFiles 'Docker/Docker/Docker Desktop.exe')
    $taskUntil = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Seconds 3
        & $taskDocker info --format '{{.ServerVersion}}' 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
    } while ([DateTime]::UtcNow -lt $taskUntil)
    if ($LASTEXITCODE -ne 0) { throw 'Docker did not become ready; RSSHub sources must remain reported as unavailable.' }
}
& $taskDocker compose -f (Join-Path $PSScriptRoot 'deploy/rsshub.compose.yaml') up -d
if ($LASTEXITCODE -ne 0) { throw 'RSSHub compose startup failed.' }
$taskUntil = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
    try {
        $taskResponse = Invoke-WebRequest -Uri ($taskConfig.baseUrl.TrimEnd('/') + '/healthz') -TimeoutSec 3 -NoProxy
        if ($taskResponse.StatusCode -eq 200 -and $taskResponse.Content.Trim() -eq 'ok') { Write-Output 'RSSHub local service is ready.'; return }
    } catch { }
    Start-Sleep -Seconds 2
} while ([DateTime]::UtcNow -lt $taskUntil)
throw 'RSSHub health check timed out.'
