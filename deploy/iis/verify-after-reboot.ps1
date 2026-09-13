$ErrorActionPreference='Stop'
$root='C:\ProgramData\Brixchat24'
$reportPath="$root\logs\reboot-verification.json"
$boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
$expectedIdentities=@{
  'Brixchat24-Web'='NT SERVICE\Brixchat24-Web';'Brixchat24-API'='NT SERVICE\Brixchat24-API';
  'Brixchat24-Worker'='NT SERVICE\Brixchat24-Worker';'Brixchat24-PostgreSQL'='NT SERVICE\Brixchat24-PostgreSQL';
  'Brixchat24-Redis'='NT SERVICE\Brixchat24-Redis';'Brixchat24-ClamAV'='NT SERVICE\Brixchat24-ClamAV'
}
foreach($identityName in @($expectedIdentities.Keys)){$expectedIdentities[$identityName]=$expectedIdentities[$identityName].Replace('\\','\')}
function Probe {
  $checks=@()
  foreach($name in $expectedIdentities.Keys) {
    $service=Get-CimInstance Win32_Service -Filter "Name='$name'"
    $checks+=@{name="service:$name";ok=($service.State -eq 'Running' -and $service.StartMode -eq 'Auto' -and $service.StartName -eq $expectedIdentities[$name]);state=$service.State;startMode=$service.StartMode;identity=$service.StartName}
  }
  foreach($component in @('API','Worker','Web','PostgreSQL','Redis','ClamAV')) {
    try {
      $limit=Get-Content "$root\logs\$component\resource-limits.json" | ConvertFrom-Json
      $checks+=@{name="resource:$component";ok=($limit.limitsApplied -eq $true -and ([datetime]$limit.appliedAt).ToUniversalTime() -ge $boot);memoryMiB=$limit.jobMemoryMiB;cpuPercent=$limit.cpuHardCapPercent;appliedAt=$limit.appliedAt}
    } catch {$checks+=@{name="resource:$component";ok=$false}}
  }
  try {$web=Invoke-WebRequest https://brixchat24.com/login -UseBasicParsing -TimeoutSec 10;$checks+=@{name='https:web';ok=$web.StatusCode -eq 200;status=$web.StatusCode}}catch{$checks+=@{name='https:web';ok=$false;error=$_.Exception.Message}}
  try {$apiResponse=Invoke-WebRequest https://api.brixchat24.com/health/ready -UseBasicParsing -TimeoutSec 10;$api=$apiResponse.Content|ConvertFrom-Json;$checks+=@{name='https:api-ready';ok=($api.status -eq 'ready' -and $api.dependencies.objectStorage.healthy -and $api.dependencies.malwareScanner.healthy -and $api.dependencies.redis.healthy -and $api.dependencies.postgresql -eq 'ok');status=$api.status}}catch{$checks+=@{name='https:api-ready';ok=$false;error=$_.Exception.Message}}
  try {$worker=Invoke-RestMethod http://127.0.0.1:4110/health -TimeoutSec 5;$checks+=@{name='worker';ok=($worker.status -eq 'ok' -and $worker.dependencies.workerLoop.healthy);status=$worker.status}}catch{$checks+=@{name='worker';ok=$false;error=$_.Exception.Message}}
  & "$root\postgres\pgsql\bin\pg_isready.exe" -h 127.0.0.1 -p 5434 -q
  $checks+=@{name='postgres';ok=$LASTEXITCODE -eq 0}
  $redis=& "$root\redis\Redis-7.4.9-Windows-x64-cygwin\redis-cli.exe" -h 127.0.0.1 -p 6381 ping
  $checks+=@{name='redis';ok=$redis -eq 'PONG';response=$redis}
  $allListeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
  foreach($port in @(3310,4410,4110,5434,6381,3311)) {
    $listeners=@($allListeners|Where-Object {$_.LocalPort -eq $port})
    $checks+=@{name="loopback:$port";ok=($listeners.Count -gt 0 -and @($listeners | Where-Object {$_.LocalAddress -notin @('127.0.0.1','::1')}).Count -eq 0);addresses=@($listeners.LocalAddress)}
  }
  Import-Module WebAdministration
  foreach($site in @('Brixchat24-Public','Brixchat24-API')) {
    $state=(Get-WebsiteState -Name $site).Value
    $checks+=@{name="iis:$site";ok=$state -eq 'Started';state=$state}
  }
  $certificates=@(Get-ChildItem Cert:\LocalMachine\WebHosting | Where-Object {$_.DnsNameList.Unicode -contains 'brixchat24.com' -or $_.DnsNameList.Unicode -contains 'api.brixchat24.com'})
  $checks+=@{name='certificates';ok=($certificates.Count -ge 2 -and @($certificates | Where-Object {$_.NotAfter -le (Get-Date).AddDays(14)}).Count -eq 0);count=$certificates.Count;expirations=@($certificates.NotAfter)}
  return $checks
}
$checks=@()
for($attempt=1;$attempt -le 30;$attempt++) {
  $checks=Probe
  if(@($checks|Where-Object {!$_.ok}).Count -eq 0){break}
  @{checkedAt=(Get-Date).ToUniversalTime().ToString('o');attempt=$attempt;failed=@($checks|Where-Object {!$_.ok}|ForEach-Object {$_.name})}|ConvertTo-Json|Set-Content "$root\logs\reboot-verification-progress.json"
  Start-Sleep -Seconds 10
}
$failed=@($checks|Where-Object {!$_.ok})
$report=@{checkedAt=(Get-Date).ToUniversalTime().ToString('o');bootedAt=$boot.ToString('o');status=if($failed.Count -eq 0){'passed'}else{'failed'};checks=$checks}
$report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $reportPath
if($failed.Count -gt 0){exit 1}
$env:NODE_EXTRA_CA_CERTS="$root\pgdata\server.crt"
& "$root\services\node.exe" "$root\releases\20260910-media\deploy\iis\verify-campaign-release.mjs" | Out-File "$root\logs\post-reboot-database-check.log"
exit $LASTEXITCODE
