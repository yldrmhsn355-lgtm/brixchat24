param([Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9-]+$')][string]$ReleaseName)
$ErrorActionPreference = 'Stop'
$releaseRoot = "C:\ProgramData\Brixchat24\releases\$ReleaseName"
if (!(Test-Path -LiteralPath "$releaseRoot\apps\web\.next\BUILD_ID")) { throw 'Production build is missing' }
if (!(Test-Path -LiteralPath "$releaseRoot\deploy\iis\service-entry.mjs")) { throw 'Service entry is missing' }
$servicesRoot = 'C:\ProgramData\Brixchat24\services'
$backupRoot = 'C:\ProgramData\Brixchat24\backups'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$original = @{}
$scopedAccounts = @()
foreach ($component in @('API','Web','Worker')) {
  $file = "$servicesRoot\Brixchat24-$component.xml"
  $xml = [IO.File]::ReadAllText($file)
  $document = [xml]$xml
  $oldRoot = [string]$document.service.workingdirectory
  if ($oldRoot -notmatch '^C:\\ProgramData\\Brixchat24\\releases\\[a-zA-Z0-9-]+$') { throw "Unexpected service root: $component" }
  $original[$component] = $xml
  [IO.File]::WriteAllText("$backupRoot\service-$component-before-$ReleaseName-$stamp.xml", $xml, (New-Object Text.UTF8Encoding $false))
  $serviceIdentity = (Get-CimInstance Win32_Service -Filter "Name='Brixchat24-$component'").StartName
  if($serviceIdentity -eq "NT SERVICE\Brixchat24-$component") {
    $scopedAccounts += $serviceIdentity
    $releaseAcl=Get-Acl -LiteralPath $releaseRoot
    $releaseAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($serviceIdentity,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
    Set-Acl -LiteralPath $releaseRoot -AclObject $releaseAcl
    if($component -eq 'Web') {
      $cachePath="$releaseRoot\apps\web\.next\cache"
      New-Item -ItemType Directory -Force $cachePath | Out-Null
      $cacheAcl=Get-Acl -LiteralPath $cachePath
      $cacheAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($serviceIdentity,'Modify','ContainerInherit,ObjectInherit','None','Allow')))
      Set-Acl -LiteralPath $cachePath -AclObject $cacheAcl
    }
  }
}
if($scopedAccounts.Count -gt 0) {
  & "$PSScriptRoot\grant-package-files.ps1" -ReleaseRoot $releaseRoot -Accounts $scopedAccounts
}
try {
  foreach ($component in @('API','Web','Worker')) {
    $document = [xml]$original[$component]
    $oldRoot = [string]$document.service.workingdirectory
    $updated = $original[$component].Replace($oldRoot,$releaseRoot)
    [IO.File]::WriteAllText("$servicesRoot\Brixchat24-$component.xml", $updated, (New-Object Text.UTF8Encoding $false))
    Restart-Service -Name "Brixchat24-$component"
    Write-Output "$component switched to $ReleaseName"
  }
  $healthy = $false
  for ($attempt=0; $attempt -lt 30; $attempt++) {
    try {
      $api = Invoke-RestMethod 'http://127.0.0.1:4410/health/ready' -TimeoutSec 3
      $workerResponse = Invoke-WebRequest 'http://127.0.0.1:4110/health' -SkipHttpErrorCheck -TimeoutSec 3
      $worker = $workerResponse.Content | ConvertFrom-Json
      $web = Invoke-WebRequest 'http://127.0.0.1:3310/login' -TimeoutSec 3
      $healthy = $api.dependencies.postgresql -eq 'ok' -and $api.dependencies.redis.healthy -and $worker.dependencies.postgresql.healthy -and $worker.dependencies.redis.healthy -and $worker.dependencies.workerLoop.healthy -and $web.StatusCode -eq 200
      if ($healthy) { break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (!$healthy) { throw 'Core service checks did not pass after promotion' }
  Write-Output "Release $ReleaseName promoted; core service checks passed. Optional capability checks are reported separately."
} catch {
  $promotionError = $_
  foreach ($component in @('API','Web','Worker')) {
    [IO.File]::WriteAllText("$servicesRoot\Brixchat24-$component.xml", $original[$component], (New-Object Text.UTF8Encoding $false))
    Restart-Service -Name "Brixchat24-$component" -ErrorAction Continue
  }
  throw $promotionError
}
