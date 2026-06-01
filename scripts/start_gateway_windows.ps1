param(
  [switch]$Build
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Resolve-Path (Join-Path $ScriptDir "..")
$RunDir = Join-Path $AppDir ".run"
$PidFile = Join-Path $RunDir "windows_gateway.pid"
$LogFile = Join-Path $RunDir "windows_gateway.log"
$ConfigFile = if ($env:NEWHORIZONS_GATEWAY_CONFIG) { $env:NEWHORIZONS_GATEWAY_CONFIG } else { Join-Path $RunDir "windows_gateway_config.json" }
$PythonBin = if ($env:NEWHORIZONS_GATEWAY_PYTHON) { $env:NEWHORIZONS_GATEWAY_PYTHON } else { "py" }

New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

if (Test-Path $PidFile) {
  $OldPidText = Get-Content -Path $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($OldPidText) {
    $OldPidText = $OldPidText.Trim()
  }
  if ($OldPidText) {
    try {
      Stop-Process -Id ([int]$OldPidText) -Force -ErrorAction Stop
    } catch {
    }
  }
}

if ($Build) {
  Write-Host "Build flag is ignored on Windows; the gateway runs from the local Python environment."
}

$env:NEWHORIZONS_GATEWAY_CONFIG = $ConfigFile
$env:NEWHORIZONS_GATEWAY_PYTHON = $PythonBin
$env:NEWHORIZONS_GATEWAY_SERVER_URL = if ($env:NEWHORIZONS_GATEWAY_SERVER_URL) { $env:NEWHORIZONS_GATEWAY_SERVER_URL } else { "ws://127.0.0.1:5051/newhorizons/gateway/ws" }
$env:NEWHORIZONS_GATEWAY_DISCOVERY_ENABLED = if ($env:NEWHORIZONS_GATEWAY_DISCOVERY_ENABLED) { $env:NEWHORIZONS_GATEWAY_DISCOVERY_ENABLED } else { "1" }
$env:NEWHORIZONS_GATEWAY_ID = if ($env:NEWHORIZONS_GATEWAY_ID) { $env:NEWHORIZONS_GATEWAY_ID } else { "" }
$env:NEWHORIZONS_GATEWAY_APP_DIR = $AppDir
$env:NEWHORIZONS_GATEWAY_APP_ROOT = $AppDir
$env:NEWHORIZONS_GATEWAY_RESTART_COMMAND = if ($env:NEWHORIZONS_GATEWAY_RESTART_COMMAND) { $env:NEWHORIZONS_GATEWAY_RESTART_COMMAND } else { "powershell -ExecutionPolicy Bypass -File `"$ScriptDir\start_gateway_windows.ps1`"" }
$env:NEWHORIZONS_GATEWAY_LOG = $LogFile
$env:PYTHONUNBUFFERED = "1"

Set-Content -Path $LogFile -Value ""

$ArgumentList = @("-m", "newhorizons_gateway.main", "--config", $ConfigFile)
$Process = Start-Process -FilePath $PythonBin -ArgumentList $ArgumentList -WorkingDirectory $AppDir -RedirectStandardOutput $LogFile -RedirectStandardError $LogFile -PassThru -WindowStyle Hidden
Set-Content -Path $PidFile -Value $Process.Id

Start-Sleep -Seconds 1
if ($Process.HasExited) {
  Write-Error "Windows Gateway failed to start."
  if (Test-Path $LogFile) {
    Get-Content -Path $LogFile -TotalCount 120
  }
  exit 1
}

Write-Host "New Horizons Gateway is running on Windows."
Write-Host "PID: $($Process.Id)"
Write-Host "Gateway WebUI: http://127.0.0.1:5052"
Write-Host "Backend WSS: $($env:NEWHORIZONS_GATEWAY_SERVER_URL)"
Write-Host "FindMe UDP: 22346"
Write-Host "Device UDP control/data: 13250"
Write-Host "Log: $LogFile"
