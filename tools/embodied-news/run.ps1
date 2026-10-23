param(
    [ValidateSet('Daily', 'Report', 'Verify', 'Test')]
    [string]$Action = 'Daily',
    [switch]$SkipCollect,
    [string]$Sources,
    [string]$DataDirectory = $env:EMBODIED_DATA_DIR,
    [string]$ReportDirectory = $env:EMBODIED_REPORT_DIR,
    [ValidateRange(1, 100)][int]$Limit = 5,
    [ValidateRange(1, 20)][int]$Pages = 2
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
# Use the native runtime verified during deployment; the PATH nvm shim may not work under WSL interop.
$taskNode = Join-Path $env:ProgramFiles 'nodejs/node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) {
    $taskNode = Get-Command node.exe -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) { throw 'Run npm ci in this folder first.' }

if (-not $DataDirectory) { $DataDirectory = Join-Path $PSScriptRoot 'data/live' }
if (-not $ReportDirectory) { $ReportDirectory = Join-Path $PSScriptRoot 'reports/daily' }
switch ($Action) {
    'Daily' {
        $taskArguments = @('bin/daily.mjs', '--data', $DataDirectory, '--output', $ReportDirectory, '--limit', [string]$Limit, '--pages', [string]$Pages)
        if ($SkipCollect) { $taskArguments += @('--skip-collect', 'true') }
        if ($Sources) { $taskArguments += @('--sources', $Sources) }
    }
    'Report' { $taskArguments = @('bin/report.mjs', '--data', $DataDirectory, '--output', (Join-Path (Split-Path $ReportDirectory) 'current')) }
    'Verify' { $taskArguments = @('bin/verify.mjs', $DataDirectory) }
    'Test' { $taskArguments = @('--test', 'test/*.test.mjs') }
}

$taskInfo = [System.Diagnostics.ProcessStartInfo]::new()
$taskInfo.FileName = $taskNode
$taskInfo.WorkingDirectory = $PSScriptRoot
$taskInfo.UseShellExecute = $false
$taskInfo.RedirectStandardOutput = $true
$taskInfo.RedirectStandardError = $true
$taskInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
$taskInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
foreach ($argument in $taskArguments) { $taskInfo.ArgumentList.Add($argument) }
$taskProcess = [System.Diagnostics.Process]::Start($taskInfo)
try {
    $taskErrorRead = $taskProcess.StandardError.ReadToEndAsync()
    while ($null -ne ($line = $taskProcess.StandardOutput.ReadLine())) { [Console]::WriteLine($line) }
    $taskProcess.WaitForExit()
    $taskErrorText = $taskErrorRead.GetAwaiter().GetResult()
    if ($taskErrorText) { [Console]::Error.Write($taskErrorText) }
    $taskExitCode = $taskProcess.ExitCode
} finally {
    $taskProcess.Dispose()
}
exit $taskExitCode
