param(
    [Parameter(Mandatory = $true)][string]$ContentFile,
    [string]$MusicRoot = 'D:\Coding\video-factory\public',
    [int]$Seed = 20261021
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$taskPython = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
$taskFfmpeg = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Microsoft/WinGet/Packages') -Filter ffmpeg.exe -Recurse -File |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'ffprobe.exe') } | Select-Object -First 1
if (-not (Test-Path -LiteralPath $taskPython) -or -not $taskFfmpeg) { throw 'Bundled Python / FFmpeg runtime is missing.' }
$taskOldPath = $env:PATH
$taskOldUtf8 = $env:PYTHONUTF8
try {
    $env:PATH = $taskFfmpeg.DirectoryName + [IO.Path]::PathSeparator + $taskOldPath
    $env:PYTHONUTF8 = '1'
    . (Join-Path $PSScriptRoot 'lib/Invoke-LocalProcess.ps1')
    $taskArgs = @((Join-Path $PSScriptRoot 'bin/prepare-juya-audio.py'), $ContentFile, '--music-root', $MusicRoot, '--seed', [string]$Seed)
    $taskExit = Invoke-LocalProductionProcess -TaskExecutable $taskPython -TaskArguments $taskArgs
} finally {
    $env:PATH = $taskOldPath
    $env:PYTHONUTF8 = $taskOldUtf8
}
exit $taskExit
