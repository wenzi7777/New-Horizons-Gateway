# Stop the Docker Gateway.
#
# Usage: .\stop_docker.ps1
param()
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Resolve-Path (Join-Path $ScriptDir ".."))

docker compose down
Write-Host "Gateway stopped."
