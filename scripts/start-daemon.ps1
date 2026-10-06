# Launcher Script for Laya System 1 Decision Daemon
param(
    [switch]$Foreground
)

$ErrorActionPreference = "Stop"

$RootDir = Resolve-Path "$PSScriptRoot\.."
Set-Location $RootDir

$VenvPython = Join-Path $RootDir ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    $VenvPython = "python"
}

$DaemonUrl = "http://127.0.0.1:11435"
$HealthUrl = "$DaemonUrl/health"

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Starting Laya FastAPI Daemon (Port 11435)" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# Check if daemon is already running
try {
    $res = Invoke-RestMethod -Uri $HealthUrl -Method Get -ErrorAction SilentlyContinue
    if ($res -and $res.status -eq "ok") {
        Write-Host "Laya daemon is already running on $DaemonUrl" -ForegroundColor Green
        Write-Host " - Device: $($res.device) | Model: $($res.model) | CUDA: $($res.cuda_available)" -ForegroundColor Yellow
        Write-Host " - Monitor live logs: Get-Content daemon.log -Wait -Tail 30" -ForegroundColor Cyan
        exit 0
    }
} catch {
    # Not running, proceed to start
}

if ($Foreground) {
    Write-Host "Launching Laya daemon in FOREGROUND mode..." -ForegroundColor Yellow
    Write-Host "Press Ctrl+C to stop daemon." -ForegroundColor Yellow
    & $VenvPython -m uvicorn daemon.laya_server:app --host 127.0.0.1 --port 11435
    exit 0
}

Write-Host "Launching Laya daemon process in background..." -ForegroundColor Yellow

$Process = Start-Process -FilePath $VenvPython `
    -ArgumentList "-m uvicorn daemon.laya_server:app --host 127.0.0.1 --port 11435" `
    -WorkingDirectory $RootDir `
    -PassThru `
    -WindowStyle Hidden

Write-Host "Process started with PID: $($Process.Id)" -ForegroundColor Yellow
Write-Host "Waiting for daemon health check at $HealthUrl..." -ForegroundColor Yellow

$maxRetries = 20
$retryCount = 0
$healthy = $false

while ($retryCount -lt $maxRetries) {
    Start-Sleep -Milliseconds 500
    $retryCount++
    try {
        $health = Invoke-RestMethod -Uri $HealthUrl -Method Get -ErrorAction SilentlyContinue
        if ($health -and $health.status -eq "ok") {
            $healthy = $true
            Write-Host "Laya Daemon is ONLINE and READY!" -ForegroundColor Green
            Write-Host " - Status: $($health.status)" -ForegroundColor Green
            Write-Host " - Model:  $($health.model)" -ForegroundColor Green
            Write-Host " - Device: $($health.device) (CUDA: $($health.cuda_available))" -ForegroundColor Green
            Write-Host " - Monitor live logs: Get-Content daemon.log -Wait -Tail 30" -ForegroundColor Cyan
            break
        }
    } catch {
        Write-Host -NoNewline "."
    }
}

if (-not $healthy) {
    Write-Error "Failed to start Laya daemon within timeout period."
    exit 1
}
