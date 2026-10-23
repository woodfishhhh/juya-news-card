param(
    [Parameter(Mandatory = $true)][string]$ContentFile,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$JuyaRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')),
    [switch]$Serve,
    [ValidateRange(1024, 65535)][int]$Port = 18763
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$taskNode = Join-Path $env:ProgramFiles 'nodejs/node.exe'
$taskLoaderPath = Join-Path $JuyaRoot 'node_modules/tsx/dist/loader.mjs'
if (-not (Test-Path -LiteralPath $taskLoaderPath)) { throw 'Juya local dependencies are missing.' }
$taskLoaderUri = [Uri]::new((Get-Item -LiteralPath $taskLoaderPath).FullName).AbsoluteUri
$taskContentPath = if ([IO.Path]::IsPathRooted($ContentFile)) { $ContentFile } else { Join-Path $PSScriptRoot $ContentFile }
$taskOutputPath = if ([IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $PSScriptRoot $OutputDirectory }
$taskArguments = @('--import', $taskLoaderUri, (Join-Path $PSScriptRoot 'bin/build-juya-cards.mjs'), '--content-file', $taskContentPath, '--output', $taskOutputPath, '--juya-root', $JuyaRoot)
if ($Serve) { $taskArguments += @('--serve', 'true', '--port', [string]$Port) }
if ($Serve) {
    & $taskNode @taskArguments
    exit $LASTEXITCODE
}
$taskProcessInfo = [Diagnostics.ProcessStartInfo]::new()
$taskProcessInfo.FileName = $taskNode
$taskProcessInfo.UseShellExecute = $false
$taskProcessInfo.RedirectStandardOutput = $true
$taskProcessInfo.RedirectStandardError = $true
$taskProcessInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
$taskProcessInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
foreach ($taskArgument in $taskArguments) { $taskProcessInfo.ArgumentList.Add($taskArgument) }
$taskProcess = [Diagnostics.Process]::new()
$taskProcess.StartInfo = $taskProcessInfo
[void]$taskProcess.Start()
$taskStdout = $taskProcess.StandardOutput.ReadToEndAsync()
$taskStderr = $taskProcess.StandardError.ReadToEndAsync()
$taskProcess.WaitForExit()
[Console]::Out.Write($taskStdout.Result)
[Console]::Error.Write($taskStderr.Result)
exit $taskProcess.ExitCode
