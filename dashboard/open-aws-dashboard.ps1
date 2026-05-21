param(
  [string]$KeyPath = "$env:USERPROFILE\Downloads\frost.pem",
  [string]$HostName = "ec2-54-198-129-209.compute-1.amazonaws.com",
  [string]$UserName = "ubuntu",
  [int]$LocalPort = 9090,
  [int]$RemotePort = 9090
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $KeyPath)) {
  throw "SSH key not found: $KeyPath"
}

$dashboardPath = Join-Path $PSScriptRoot "index.html"
if (-not (Test-Path -LiteralPath $dashboardPath)) {
  throw "Dashboard file not found: $dashboardPath"
}

$sshTarget = "$UserName@$HostName"
$sshArgs = @(
  "-i", "`"$KeyPath`"",
  "-L", "$LocalPort`:127.0.0.1:$RemotePort",
  $sshTarget
)

$command = "ssh $($sshArgs -join ' ')"
Start-Process powershell.exe -ArgumentList @("-NoExit", "-Command", $command)

Start-Sleep -Seconds 2
Start-Process $dashboardPath

Write-Host "Tunnel requested: http://127.0.0.1:$LocalPort -> $sshTarget`:127.0.0.1:$RemotePort"
Write-Host "Keep the tunnel PowerShell window open while using the dashboard."
