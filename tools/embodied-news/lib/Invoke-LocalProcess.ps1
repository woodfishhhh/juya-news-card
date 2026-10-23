function Invoke-LocalProductionProcess {
    param([string]$TaskExecutable, [string[]]$TaskArguments)
    $taskInfo = [Diagnostics.ProcessStartInfo]::new()
    $taskInfo.FileName = $TaskExecutable
    $taskInfo.UseShellExecute = $false
    $taskInfo.RedirectStandardOutput = $true
    $taskInfo.RedirectStandardError = $true
    $taskInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $taskInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($taskArgument in $TaskArguments) { $taskInfo.ArgumentList.Add($taskArgument) }
    $taskChild = [Diagnostics.Process]::new()
    $taskChild.StartInfo = $taskInfo
    [void]$taskChild.Start()
    $taskOutput = $taskChild.StandardOutput.ReadToEndAsync()
    $taskError = $taskChild.StandardError.ReadToEndAsync()
    $taskChild.WaitForExit()
    [Console]::Out.Write($taskOutput.Result)
    [Console]::Error.Write($taskError.Result)
    return $taskChild.ExitCode
}
