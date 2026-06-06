# Start the Gateway in Docker (Windows).
#
# Docker bridge networking does not preserve the device UDP source IP.
# Use scripts\start.ps1 for local development.
#
# Usage: .\start_docker.ps1 [-Build]
param([switch]$Build)
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir    = Resolve-Path (Join-Path $ScriptDir "..")

Set-Location $AppDir

$ComposeArgs = @(
    "-f", "docker-compose.yml",
    "-f", "docker-compose.container-discovery.yml",
    "up", "-d"
)
if ($Build) { $ComposeArgs += "--build" }

docker compose @ComposeArgs

$WebPort = if ($env:NEWHORIZONS_GATEWAY_WEB_PORT) { $env:NEWHORIZONS_GATEWAY_WEB_PORT } else { "5052" }
Write-Host "Gateway started (Docker)"
Write-Host "WebUI   http://127.0.0.1:$WebPort"
