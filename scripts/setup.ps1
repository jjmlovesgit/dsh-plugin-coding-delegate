# Setup Script for DSH Laya Hybrid System
$ErrorActionPreference = "Stop"

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Setting up DSH Laya Hybrid Router Environment" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

$RootDir = Resolve-Path "$PSScriptRoot\.."
Set-Location $RootDir

# 1. Create Python Virtual Environment
$VenvDir = Join-Path $RootDir ".venv"
if (-not (Test-Path $VenvDir)) {
    Write-Host "[1/4] Creating Python virtual environment at .venv..." -ForegroundColor Yellow
    python -m venv $VenvDir
    Write-Host "Virtual environment created." -ForegroundColor Green
} else {
    Write-Host "[1/4] Python virtual environment already exists." -ForegroundColor Green
}

$PythonExe = Join-Path $VenvDir "Scripts\python.exe"
$PipExe = Join-Path $VenvDir "Scripts\pip.exe"

# 2. Upgrade pip and install Python dependencies
Write-Host "[2/4] Installing Python dependencies (torch, laya, fastapi, uvicorn)..." -ForegroundColor Yellow
& $PythonExe -m pip install --upgrade pip setuptools wheel --quiet

# Install PyTorch with CUDA support and dependencies
& $PipExe install torch --index-url https://download.pytorch.org/whl/cu124 --extra-index-url https://pypi.org/simple --quiet
& $PipExe install fastapi uvicorn laya httpx pytest orjson pydantic requests --quiet
Write-Host "Python dependencies installed successfully." -ForegroundColor Green

# 3. Setup & build TypeScript Plugin
$PluginDir = Join-Path $RootDir "plugin"
Write-Host "[3/4] Installing npm dependencies and building TypeScript plugin..." -ForegroundColor Yellow
Set-Location $PluginDir

npm install --loglevel error
npm run build

Write-Host "TypeScript plugin compiled to ./plugin/dist." -ForegroundColor Green

# 4. Verify .env file
Set-Location $RootDir
$EnvExample = Join-Path $RootDir ".env.example.txt"
$EnvFile = Join-Path $RootDir ".env"
if (-not (Test-Path $EnvFile)) {
    if (Test-Path $EnvExample) {
        Copy-Item $EnvExample $EnvFile
        Write-Host "[4/4] Created .env from .env.example.txt." -ForegroundColor Green
    }
} else {
    Write-Host "[4/4] .env file present." -ForegroundColor Green
}

Write-Host ""
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Setup complete! Next steps:" -ForegroundColor Cyan
Write-Host " 1. Run .\scripts\start-daemon.ps1 to launch Laya FastAPI daemon" -ForegroundColor Cyan
Write-Host " 2. Run .\scripts\register-plugin.ps1 to register DSH plugin" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
