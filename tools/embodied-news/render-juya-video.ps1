param(
    [Parameter(Mandatory = $true)][string]$Manifest,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$Name,
    [int]$Seed = 20261021,
    [switch]$Overwrite
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$taskPython = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'Bundled Python runtime is missing; use load_workspace_dependencies to locate the installed runtime.' }
$taskFfmpeg = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Microsoft/WinGet/Packages') -Filter ffmpeg.exe -Recurse -File |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'ffprobe.exe') } | Select-Object -First 1
if (-not $taskFfmpeg) { throw 'FFmpeg and FFprobe are missing.' }
$taskOldPath = $env:PATH
$taskOldUtf8 = $env:PYTHONUTF8
try {
    $env:PATH = $taskFfmpeg.DirectoryName + [IO.Path]::PathSeparator + $taskOldPath
    $env:PYTHONUTF8 = '1'
    $taskArgs = @((Join-Path $PSScriptRoot 'bin/render-juya-video.py'), $Manifest, '--output-dir', $OutputDirectory, '--seed', [string]$Seed)
    if ($Name) { $taskArgs += @('--name', $Name) }
    if ($Overwrite) { $taskArgs += '--overwrite' }
    . (Join-Path $PSScriptRoot 'lib/Invoke-LocalProcess.ps1')
    $taskExit = Invoke-LocalProductionProcess -TaskExecutable $taskPython -TaskArguments $taskArgs
} finally {
    $env:PATH = $taskOldPath
    $env:PYTHONUTF8 = $taskOldUtf8
}
exit $taskExit
