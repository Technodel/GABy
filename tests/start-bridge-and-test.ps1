# SUNy Bridge + Test Runner
# Starts the bridge client and runs the task execution test suite
#
# Usage: .\start-bridge-and-test.ps1 -Token "your-jwt-token"
#   OR: .\start-bridge-and-test.ps1 -Login
#
# Parameters:
#   -Token    : A JWT token obtained from SUNy web app (login, then get from cookie/localStorage)
#   -Login    : Opens browser to SUNy login page for manual token retrieval

param(
    [string]$Token = "",
    [switch]$Login = $false,
    [switch]$NoBridge = $false,
    [string]$ServerUrl = "https://suny.technodel.tech"
)

$ProjectRoot = "D:\Projects\SUNy"
$BridgeScript = Join-Path $ProjectRoot "bridge\start-silent.js"
$TestRunner = Join-Path $ProjectRoot "run-task-test-production.js"
$TokenFile = Join-Path $env:USERPROFILE ".suny\refresh_token"

function Write-Step($msg) {
    Write-Host "`n==> $msg" -ForegroundColor Cyan
}

function Write-Success($msg) {
    Write-Host "  ✅ $msg" -ForegroundColor Green
}

function Write-Warning($msg) {
    Write-Host "  ⚠️  $msg" -ForegroundColor Yellow
}

function Write-ErrorMsg($msg) {
    Write-Host "  ❌ $msg" -ForegroundColor Red
}

# ── ASCII Art Header ──
Write-Host @"

╔══════════════════════════════════════════════════════╗
║     SUNy Bridge + Task Test Runner                    ║
║     $($ServerUrl)                                       ║
╚══════════════════════════════════════════════════════╝

"@ -ForegroundColor Magenta

# ── Step 1: Token Discovery ──
if ($Login) {
    Write-Step "Opening browser for login..."
    Start-Process "$ServerUrl/login"
    Write-Host "After logging in, press any key to continue..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

if (-not $Token -and (Test-Path $TokenFile)) {
    Write-Step "Reading token from $TokenFile..."
    $Token = Get-Content $TokenFile -Raw | ForEach-Object { $_.Trim() }
    if ($Token) { Write-Success "Token loaded from saved file" }
}

if (-not $Token) {
    Write-ErrorMsg "No token provided. Use -Token <JWT> or run with -Login first."
    Write-Host "`nTo get a token:"
    Write-Host "  1. Open $ServerUrl in your browser"
    Write-Host "  2. Log in as test/test"
    Write-Host "  3. Open DevTools (F12) → Application → Cookies → suny_token"
    Write-Host "  4. Copy the token value and run:"
    Write-Host "     .\start-bridge-and-test.ps1 -Token `"<paste-token-here>`""
    exit 1
}

# ── Step 2: Health Check ──
Write-Step "Checking server health..."
try {
    $health = Invoke-WebRequest -Uri "$ServerUrl/api/health" -UseBasicParsing -TimeoutSec 10
    $healthData = $health.Content | ConvertFrom-Json
    if ($healthData.status -eq "ok") {
        Write-Success "Server healthy (uptime: $([math]::Round($healthData.uptime))s)"
    }
} catch {
    Write-ErrorMsg "Server unreachable: $_"
    exit 1
}

# ── Step 3: Start Bridge (if not skipped) ──
if (-not $NoBridge) {
    Write-Step "Starting SUNy Bridge..."
    
    # Check if bridge is already running
    $existingBridge = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { 
        $_.CommandLine -match "start-silent" -or $_.CommandLine -match "bridge" 
    }
    
    if ($existingBridge) {
        Write-Warning "Bridge already running (PID: $($existingBridge.Id)). Will use existing."
    } else {
        # Start bridge in background
        $bridgeArgs = @($BridgeScript, "--token", $Token, "--server", ($ServerUrl -replace "^https", "wss"))
        $bridgeProcess = Start-Process -FilePath "node" -ArgumentList $bridgeArgs -NoNewWindow -PassThru
        Write-Success "Bridge started (PID: $($bridgeProcess.Id))"
        
        # Wait for bridge to connect
        Write-Host "  Waiting for bridge connection..." -NoNewline
        Start-Sleep -Seconds 3
        Write-Host " done"
    }
}

# ── Step 4: Register project path ──
Write-Step "Registering test project directory..."
$testTempDir = Join-Path $ProjectRoot "task-exec-temp"
if (Test-Path $testTempDir) {
    Write-Success "Test temp directory exists: $testTempDir"
} else {
    $testProjectDir = Join-Path $ProjectRoot "task-exec-test"
    if (Test-Path $testProjectDir) {
        Write-Success "Test project directory exists: $testProjectDir"
    } else {
        Write-ErrorMsg "Neither task-exec-test nor task-exec-temp found!"
        Write-Host "Create task-exec-test with sample files first."
        exit 1
    }
}

# ── Step 5: Run Tests ──
Write-Step "Running task execution test suite..."
Write-Host "  (This will take several minutes...)" -ForegroundColor Yellow
Write-Host ""

try {
    node $TestRunner
} catch {
    Write-ErrorMsg "Test runner failed: $_"
}

# ── Step 6: Cleanup ──
Write-Step "Tests complete."
if ($bridgeProcess -and -not $bridgeProcess.HasExited) {
    Write-Host "  Stopping bridge process..."
    $bridgeProcess.Kill()
    Write-Success "Bridge stopped"
}

Write-Success "Done!"
