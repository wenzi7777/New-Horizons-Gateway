# Stop the host-mode Gateway.
#
# Usage: .\stop.ps1
param()
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir    = Resolve-Path (Join-Path $ScriptDir "..")
$PidFile   = Join-Path $AppDir ".run\gateway.pid"

if (-not (Test-Path $PidFile)) {
    Write-Host "Gateway is not running (no PID file)."
    exit 0
}

$Pid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
if ($Pid) {
    try {
        Stop-Process -Id ([int]$Pid) -Force
        Write-Host "Gateway stopped (PID $Pid)."
    } catch {
        Write-Host "Gateway is not running."
    }
} else {
    Write-Host "Gateway is not running."
}
Remove-Item $PidFile -Force
