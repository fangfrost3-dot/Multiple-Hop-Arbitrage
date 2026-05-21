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

$sshTarget = "$UserName@$HostName"
$dashboardUrl = "http://127.0.0.1:$LocalPort/dashboard"
$sshArgs = @(
  "-i", "`"$KeyPath`"",
  "-L", "$LocalPort`:127.0.0.1:$RemotePort",
  $sshTarget
)

$command = "ssh $($sshArgs -join ' ')"
Start-Process powershell.exe -ArgumentList @("-NoExit", "-Command", $command)

Start-Sleep -Seconds 2
Start-Process $dashboardUrl

Write-Host "Tunnel requested: http://127.0.0.1:$LocalPort -> $sshTarget`:127.0.0.1:$RemotePort"
Write-Host "Dashboard URL: $dashboardUrl"
Write-Host "Keep the tunnel PowerShell window open while using the dashboard."
