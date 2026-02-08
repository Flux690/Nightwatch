# Clipper Chaos Utility
# Trigger failure scenarios for testing Nightwatch

param(
    [Parameter(Position=0)]
    [string]$Scenario = "help"
)

function Write-Header($text) {
    Write-Host "`n=== $text ===" -ForegroundColor Yellow
    Write-Host ""
}

function Write-Success($text) {
    Write-Host "[OK] $text" -ForegroundColor Green
}

function Write-Error($text) {
    Write-Host "[X] $text" -ForegroundColor Red
}

function Write-Info($label, $text) {
    Write-Host "$label : " -ForegroundColor Yellow -NoNewline
    Write-Host $text
}

# Fast parallel stop (1 second timeout)
function Stop-Fast {
    param([string[]]$containers)
    $running = $containers | Where-Object { docker ps -q -f "name=^${_}$" }
    if ($running.Count -gt 0) {
        docker stop --time 1 $running 2>$null | Out-Null
        Write-Success "Stopped: $($running -join ', ')"
    } else {
        Write-Error "None running: $($containers -join ', ')"
    }
}

function Start-Containers {
    param([string[]]$containers)
    foreach ($container in $containers) {
        $exists = docker ps -aq -f "name=^${container}$"
        if ($exists) {
            docker start $container | Out-Null
            Write-Success "Started $container"
        } else {
            Write-Error "$container does not exist"
        }
    }
}

function Show-Help {
    Write-Host "Clipper Chaos Utility"
    Write-Host ""
    Write-Host "Usage: .\chaos.ps1 <scenario>"
    Write-Host ""
    Write-Host "Basic Scenarios (restart fixes):"
    Write-Host "  cache           Stop Redis (immediate detection, 3-node cascade)"
    Write-Host "  db              Stop PostgreSQL (needs interaction)"
    Write-Host "  storage         Stop S3 storage (needs interaction)"
    Write-Host "  transcoder      Stop transcoder worker"
    Write-Host "  notifier        Stop notifier worker"
    Write-Host "  pipeline        Stop cache + storage (5-node cascade)"
    Write-Host "  infra           Stop db + cache + storage (6-node cascade)"
    Write-Host ""
    Write-Host "Advanced Scenarios (requires docker exec or config change):"
    Write-Host "  oom             Redis OOM - rejects writes (needs user knowledge)"
    Write-Host "  maxclients      Redis connection limit - rejects connections (immediate)"
    Write-Host "  network         Disconnect API from network (immediate, needs reconnect)"
    Write-Host ""
    Write-Host "Utility:"
    Write-Host "  restore         Start all containers + reset all configs"
    Write-Host "  status          Show container status"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\chaos.ps1 cache       # Simple: restart fixes it"
    Write-Host "  .\chaos.ps1 maxclients  # Advanced: needs CONFIG SET to fix"
    Write-Host "  .\chaos.ps1 network     # Advanced: needs network connect to fix"
}

switch ($Scenario.ToLower()) {
    "cache" {
        Write-Header "Scenario: Cache Failure"
        Stop-Fast @("cache")
        Write-Host ""
        Write-Info "Detection" "Immediate (workers poll Redis)"
        Write-Info "Cascade" "cache -> transcoder, notifier (3 nodes)"
        Write-Info "Fix" "docker start cache"
    }
    "oom" {
        Write-Header "Scenario: Redis OOM (running but full)"
        Write-Host "Configuring Redis memory limit..." -ForegroundColor Cyan
        docker exec cache redis-cli CONFIG SET maxmemory 1mb | Out-Null
        Write-Success "Set maxmemory to 1mb"
        docker exec cache redis-cli CONFIG SET maxmemory-policy noeviction | Out-Null
        Write-Success "Set maxmemory-policy to noeviction"

        Write-Host "Filling Redis with data..." -ForegroundColor Cyan
        $padding = "X" * 1024
        $filled = $false
        for ($i = 0; $i -lt 2000; $i++) {
            $result = docker exec cache redis-cli SET "fill:$i" $padding 2>&1
            if ($result -match "OOM") {
                Write-Success "Redis is full after $i keys"
                $filled = $true
                break
            }
        }
        if (-not $filled) {
            Write-Success "Filled 2000 keys into Redis"
        }

        Write-Host ""
        Write-Info "Detection" "On next write (upload a video)"
        Write-Info "Cascade" "cache -> api (2 nodes)"
        Write-Info "Fix" "docker exec cache redis-cli CONFIG SET maxmemory 0"
        Write-Info "Note" "Requires user knowledge (maxmemory value)"
    }
    "maxclients" {
        Write-Header "Scenario: Redis Connection Limit (running but rejecting)"
        Write-Host "Limiting Redis to 1 connection..." -ForegroundColor Cyan
        docker exec cache redis-cli CONFIG SET maxclients 1 | Out-Null
        Write-Success "Set maxclients to 1"
        Write-Host ""
        Write-Info "Detection" "Immediate (workers can't connect)"
        Write-Info "Cascade" "cache -> transcoder, notifier (3 nodes)"
        Write-Info "Fix" "docker exec cache redis-cli CONFIG SET maxclients 10000"
        Write-Info "Note" "Container is UP - restart won't help without config fix"
    }
    "network" {
        Write-Header "Scenario: Network Partition (API isolated)"
        Write-Host "Disconnecting API from network..." -ForegroundColor Cyan
        docker network disconnect clipper_default api 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Success "API disconnected from clipper_default network"
        } else {
            Write-Error "Failed to disconnect (may already be disconnected)"
        }
        Write-Host ""
        Write-Info "Detection" "Immediate (API can't reach cache/db/storage)"
        Write-Info "Cascade" "network -> api (API isolated)"
        Write-Info "Fix" "docker network connect clipper_default api"
        Write-Info "Note" "Container is UP - restart alone won't fix"
    }
    "db" {
        Write-Header "Scenario: Database Failure"
        Stop-Fast @("db")
        Write-Host ""
        Write-Info "Detection" "On interaction (upload/list videos)"
        Write-Info "Cascade" "db -> api (2 nodes)"
        Write-Info "Fix" "docker start db"
    }
    "storage" {
        Write-Header "Scenario: Storage Failure"
        Stop-Fast @("storage")
        Write-Host ""
        Write-Info "Detection" "On interaction (upload a video)"
        Write-Info "Cascade" "storage -> api (2 nodes)"
        Write-Info "Fix" "docker start storage"
    }
    "transcoder" {
        Write-Header "Scenario: Transcoder Failure"
        Stop-Fast @("transcoder")
        Write-Host ""
        Write-Info "Detection" "Videos stay 'pending' indefinitely"
        Write-Info "Fix" "docker start transcoder"
    }
    "notifier" {
        Write-Header "Scenario: Notifier Failure"
        Stop-Fast @("notifier")
        Write-Host ""
        Write-Info "Detection" "No email notifications sent"
        Write-Info "Fix" "docker start notifier"
    }
    "pipeline" {
        Write-Header "Scenario: Pipeline Block (cache + storage)"
        Stop-Fast @("cache", "storage")
        Write-Host ""
        Write-Info "Detection" "Immediate (cache) + on interaction (storage)"
        Write-Info "Cascade" "cache + storage -> api, transcoder, notifier (5 nodes)"
        Write-Info "Fix" "docker start cache storage"
    }
    "infra" {
        Write-Header "Scenario: Total Infrastructure Failure"
        Stop-Fast @("db", "cache", "storage")
        Write-Host ""
        Write-Info "Detection" "Immediate (all failures in single batch)"
        Write-Info "Cascade" "db + cache + storage -> api, transcoder, notifier (6 nodes)"
        Write-Info "Fix" "docker start db cache storage"
    }
    "restore" {
        Write-Header "Restoring All Containers"

        # Reset Redis config if cache is running
        $cacheRunning = docker ps -q -f "name=^cache$"
        if ($cacheRunning) {
            Write-Host "Resetting Redis config..." -ForegroundColor Cyan
            docker exec cache redis-cli CONFIG SET maxmemory 0 2>$null | Out-Null
            docker exec cache redis-cli CONFIG SET maxmemory-policy noeviction 2>$null | Out-Null
            docker exec cache redis-cli CONFIG SET maxclients 10000 2>$null | Out-Null
            docker exec cache redis-cli FLUSHALL 2>$null | Out-Null
            Write-Success "Redis config reset and data flushed"
        }

        # Reconnect API to network if disconnected
        docker network connect clipper_default api 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Success "API reconnected to network"
        }

        # Start infra containers
        Start-Containers @("db", "cache", "storage")
        Start-Sleep -Seconds 2

        # Reset Redis config after start (in case it was stopped)
        docker exec cache redis-cli CONFIG SET maxmemory 0 2>$null | Out-Null
        docker exec cache redis-cli CONFIG SET maxmemory-policy noeviction 2>$null | Out-Null
        docker exec cache redis-cli CONFIG SET maxclients 10000 2>$null | Out-Null
        docker exec cache redis-cli FLUSHALL 2>$null | Out-Null
        Write-Success "Redis config reset and data flushed"

        # Restart workers to reset connection state (fixes stale connectionErrorLogged flag)
        Write-Host "Restarting workers to reset connection state..." -ForegroundColor Cyan
        docker restart transcoder notifier 2>$null | Out-Null
        Write-Success "Workers restarted (transcoder, notifier)"

        docker exec storage awslocal s3 mb s3://clipper-videos 2>$null
        Write-Success "S3 bucket ready"
    }
    "status" {
        Write-Header "Container Status"
        docker ps -a --format "table {{.Names}}`t{{.Status}}" | Select-String -Pattern "(NAMES|db|cache|storage|mailhog|api|transcoder|notifier|frontend)"
    }
    default {
        if ($Scenario -ne "help" -and $Scenario -ne "--help" -and $Scenario -ne "-h") {
            Write-Error "Unknown scenario: $Scenario"
            Write-Host ""
        }
        Show-Help
    }
}
