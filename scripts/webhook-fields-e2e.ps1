$ErrorActionPreference = "Stop"

$databaseName = "brixchat_webhook_e2e_$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$runId = [Guid]::NewGuid().ToString("N")
$portFile = Join-Path $PSScriptRoot "..\.worktree-ports.json"
$worktreePorts = if (Test-Path -LiteralPath $portFile) {
  Get-Content -LiteralPath $portFile -Raw | ConvertFrom-Json
} else {
  $null
}
$postgresPort = if ($env:POSTGRES_PORT) {
  [int]$env:POSTGRES_PORT
} elseif ($worktreePorts) {
  [int]$worktreePorts.db
} else {
  5434
}
$redisPort = if ($env:REDIS_PORT) {
  [int]$env:REDIS_PORT
} elseif ($worktreePorts) {
  [int]$worktreePorts.redis
} else {
  6381
}
$databaseUrl = "postgresql://brixchat:brixchat@localhost:$postgresPort/$databaseName"
$composeProjectName = "brixchat-webhook-e2e-$($runId.Substring(0, 8))"
$postgresContainer = $null
$tempRoot = [IO.Path]::GetTempPath()
$apiProcess = $null
$workerProcess = $null
$apiStdoutTask = $null
$apiStderrTask = $null
$workerStdoutTask = $null
$workerStderrTask = $null
$passed = $false

function Stop-ProcessTree([int]$ProcessId) {
  $children = Get-CimInstance Win32_Process | Where-Object {
    $_.ParentProcessId -eq $ProcessId
  }
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId ([int]$child.ProcessId)
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Start-IsolatedPnpmProcess([string[]]$Arguments, [string]$Port) {
  $node = (Get-Command node.exe).Source
  $pnpmBin = Split-Path (Get-Command pnpm.cmd).Source
  $pnpmCli = @(
    (Join-Path $pnpmBin "pnpm.cjs"),
    (Join-Path $pnpmBin "..\node_modules\pnpm\bin\pnpm.cjs"),
    (Join-Path $pnpmBin "node_modules\pnpm\bin\pnpm.cjs")
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $pnpmCli) {
    throw "Could not resolve the pnpm CLI from $pnpmBin"
  }
  $quotedArguments = @('"' + $pnpmCli + '"') + ($Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' })
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $node
  $startInfo.Arguments = $quotedArguments -join " "
  $startInfo.WorkingDirectory = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables["PORT"] = $Port
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "Could not start pnpm process"
  }
  return @($process, $process.StandardOutput.ReadToEndAsync(), $process.StandardError.ReadToEndAsync())
}

function Wait-ForHealthyRuntime {
  $deadline = (Get-Date).AddSeconds(45)
  do {
    try {
      $api = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4419/health/live" -TimeoutSec 2
      $workerListener = [Net.Sockets.TcpClient]::new()
      $workerListener.Connect("127.0.0.1", 4510)
      $workerListening = $workerListener.Connected
      $workerListener.Dispose()
      if ($api.StatusCode -eq 200 -and $workerListening) {
        return
      }
    } catch {
      # Runtime is still starting.
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  throw "Local API or worker did not become healthy"
}

try {
  docker info --format "{{.ServerVersion}}" | Out-Null
  $occupiedPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
    $_.LocalPort -in @(4419, 4510, $postgresPort, $redisPort)
  }
  if ($occupiedPorts) {
    throw "Webhook E2E ports are already in use: $($occupiedPorts.LocalPort -join ',')"
  }
  $env:COMPOSE_PROJECT_NAME = $composeProjectName
  $env:POSTGRES_PORT = "$postgresPort"
  $env:REDIS_PORT = "$redisPort"
  docker compose up -d --wait postgres redis | Out-Null
  $postgresContainer = (docker compose ps -q postgres).Trim()
  if (-not $postgresContainer) {
    throw "Could not resolve the isolated PostgreSQL container"
  }
  docker exec $postgresContainer psql -U brixchat -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $databaseName" | Out-Null

  $env:DATABASE_URL = $databaseUrl
  $env:REDIS_URL = "redis://localhost:$redisPort"
  $env:WORKER_HEALTH_PORT = "4510"
  $env:META_WHATSAPP_APP_SECRET = "local-app-secret"
  $env:API_PUBLIC_URL = "http://localhost:4419"
  $env:WEB_PUBLIC_URL = "http://localhost:3000"
  $env:APP_ENV = "development"

  pnpm db:migrate | Out-Null
  pnpm db:seed | Out-Null

  # Railway uses PORT for both services. Give each child an immutable, isolated
  # environment so their listeners cannot race on the parent process state.
  $workerRuntime = Start-IsolatedPnpmProcess -Arguments @("--filter", "@brixchat/worker", "start") -Port "4510"
  $workerProcess, $workerStdoutTask, $workerStderrTask = $workerRuntime
  $apiRuntime = Start-IsolatedPnpmProcess -Arguments @("--filter", "@brixchat/api", "start") -Port "4419"
  $apiProcess, $apiStdoutTask, $apiStderrTask = $apiRuntime

  Wait-ForHealthyRuntime
  $env:API_URL = "http://127.0.0.1:4419"
  $env:SIMULATOR_CHANNEL_PUBLIC_ID = "00000000-0000-4000-8000-000000000022"
  pnpm webhook:simulate:fields | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Webhook simulator failed"
  }

  $deadline = (Get-Date).AddSeconds(45)
  $processed = "0"
  do {
    $processed = (docker exec $postgresContainer psql -U brixchat -d $databaseName -Atc "SELECT count(*) FROM provider_webhook_events WHERE status='processed'").Trim()
    if ($processed -eq "33") {
      break
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)

  $summary = docker exec $postgresContainer psql -U brixchat -d $databaseName -Atc "SELECT status||'='||count(*) FROM provider_webhook_events GROUP BY status ORDER BY status"
  if ($processed -ne "33") {
    throw "Worker processed $processed of 33 webhook fields ($($summary -join ','))"
  }
  $channelHealth = (docker exec $postgresContainer psql -U brixchat -d $databaseName -Atc "SELECT (last_webhook_at IS NOT NULL)::text||'|'||COALESCE(last_webhook_result,'') FROM channels WHERE public_id='00000000-0000-4000-8000-000000000022'::uuid").Trim()
  if ($channelHealth -ne "true|processed") {
    throw "Channel webhook health was not finalized: $channelHealth"
  }

  # Meta can redeliver an older message after a newer one. Prove that the
  # authoritative conversation pointer, inbox ordering, and 24-hour window do
  # not move backwards when that happens.
  $testPhone = "4477009$(Get-Random -Minimum 10000 -Maximum 99999)"
  $newestMessageId = "inbox-new-$runId"
  $delayedMessageId = "inbox-delayed-$runId"
  $env:SIMULATOR_PHONE = $testPhone
  $env:SIMULATOR_NAME = "Inbox Ordering"
  $env:SIMULATOR_PROVIDER_MESSAGE_ID = $newestMessageId
  $env:SIMULATOR_TIMESTAMP = "2000000000"
  $env:SIMULATOR_TEXT = "Newest Meta message"
  pnpm webhook:simulate:incoming | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Newest inbound webhook simulation failed"
  }

  $env:SIMULATOR_PROVIDER_MESSAGE_ID = $delayedMessageId
  $env:SIMULATOR_TIMESTAMP = "1999999900"
  $env:SIMULATOR_TEXT = "Delayed older Meta message"
  pnpm webhook:simulate:incoming | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Delayed inbound webhook simulation failed"
  }

  $deadline = (Get-Date).AddSeconds(45)
  $inboundProcessed = "0"
  do {
    $inboundProcessed = (docker exec $postgresContainer psql -U brixchat -d $databaseName -Atc "SELECT count(*) FROM messages WHERE provider_message_id IN ('$newestMessageId','$delayedMessageId')").Trim()
    if ($inboundProcessed -eq "2") {
      break
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  if ($inboundProcessed -ne "2") {
    throw "Worker persisted $inboundProcessed of 2 ordering-test messages"
  }

  $orderingState = (docker exec $postgresContainer psql -U brixchat -d $databaseName -AtF "|" -c "SELECT pointer.body,extract(epoch from c.last_message_at)::bigint,c.unread_count,extract(epoch from c.customer_service_window_expires_at)::bigint,ordered.body FROM conversations c JOIN messages tested ON tested.conversation_id=c.id AND tested.provider_message_id='$newestMessageId' JOIN messages pointer ON pointer.id=c.last_message_id CROSS JOIN LATERAL (SELECT body FROM messages WHERE conversation_id=c.id ORDER BY coalesce(provider_timestamp,sent_at) DESC,id DESC LIMIT 1) ordered").Trim()
  $expectedOrderingState = "Newest Meta message|2000000000|2|2000086400|Newest Meta message"
  if ($orderingState -ne $expectedOrderingState) {
    throw "Delayed webhook regressed inbox state: expected '$expectedOrderingState', got '$orderingState'"
  }

  Write-Output "Webhook field and inbox ordering E2E passed: API=200 worker_listener=4510 processed=33 channel_health=$channelHealth ordering=$orderingState ($($summary -join ','))"
  $passed = $true
} finally {
  if ($apiProcess -and -not $apiProcess.HasExited) {
    Stop-ProcessTree -ProcessId $apiProcess.Id
  }
  if ($workerProcess -and -not $workerProcess.HasExited) {
    Stop-ProcessTree -ProcessId $workerProcess.Id
  }
  if (-not $passed) {
    Write-Output "--- API output log ---"
    if ($apiStdoutTask) { Write-Output $apiStdoutTask.Result }
    Write-Output "--- API error log ---"
    if ($apiStderrTask) { Write-Output $apiStderrTask.Result }
    Write-Output "--- Worker output log ---"
    if ($workerStdoutTask) { Write-Output $workerStdoutTask.Result }
    Write-Output "--- Worker error log ---"
    if ($workerStderrTask) { Write-Output $workerStderrTask.Result }
  }
  if ($postgresContainer) {
    docker exec $postgresContainer psql -U brixchat -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE $databaseName WITH (FORCE)" | Out-Null
  }
  if ($env:COMPOSE_PROJECT_NAME -eq $composeProjectName) {
    docker compose down -v --remove-orphans | Out-Null
  }
}
