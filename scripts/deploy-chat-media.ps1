#requires -Version 7.0
param([switch]$WebOnly)
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
$release='C:\ProgramData\Brixchat24\releases\20260910-platform-admin'
$runtime='C:\ProgramData\Brixchat24\media-runtime-20260912'
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$backup="C:\ProgramData\Brixchat24\backups\chat-media-$stamp"
$webRoot=Join-Path $release 'apps\web'
$active=Join-Path $webRoot '.next'
$staged=Join-Path $webRoot ".next-media-$stamp"
$previous=Join-Path $webRoot ".next-before-media-$stamp"
$failed=Join-Path $webRoot ".next-failed-media-$stamp"
foreach($path in @($active,$staged,$previous,$failed)) {
  if (![IO.Path]::GetFullPath($path).StartsWith($webRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid build target' }
}
if (!(Test-Path "$sourceRoot\apps\web\.next\BUILD_ID")) {throw 'Build missing'}
Copy-Item -LiteralPath "$sourceRoot\packages\integrations\node_modules\ffmpeg-static\ffmpeg.exe" -Destination "$runtime\node_modules\ffmpeg-static\ffmpeg.exe" -Force
& icacls $runtime /grant 'NT SERVICE\Brixchat24-API:(OI)(CI)(RX)' 'NT SERVICE\Brixchat24-Worker:(OI)(CI)(RX)' /T /Q | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) {throw 'Runtime read permissions failed'}
$converterVersion = & "$runtime\node_modules\ffmpeg-static\ffmpeg.exe" -version
if ($LASTEXITCODE -ne 0) {throw 'Converter failed'}
$converterVersion | Select-Object -First 1
foreach($name in @('file-type','ffmpeg-static')) {
  $link=Join-Path $release "packages\integrations\node_modules\$name"
  if (!(Test-Path -LiteralPath $link)) { New-Item -ItemType SymbolicLink -Path $link -Target "$runtime\node_modules\$name" | Out-Null }
}
$files=@('packages\integrations\package.json','packages\integrations\src\media\index.ts','packages\integrations\src\media\formats.ts','packages\integrations\src\media\audio.ts','apps\worker\src\index.ts','apps\api\src\milestone5-routes.ts','apps\web\app\app\inbox\workspace.tsx','apps\web\app\app\inbox\message-attachment.tsx','apps\web\app\app\inbox\attachment-download.ts','apps\web\app\app\inbox\use-media-urls.ts')
if($WebOnly) { $files=@($files | Where-Object {$_.StartsWith('apps\web\')}) }
foreach($file in $files) {
  $old=Join-Path $release $file
  if(Test-Path -LiteralPath $old) { $saved=Join-Path $backup $file; New-Item -ItemType Directory -Force (Split-Path -Parent $saved) | Out-Null; Copy-Item -LiteralPath $old -Destination $saved }
}
& robocopy "$sourceRoot\apps\web\.next" $staged /E /XD cache /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
if($LASTEXITCODE -gt 7) {throw 'Build staging failed'}
New-Item -ItemType Directory -Force "$staged\cache" | Out-Null
$acl=Get-Acl -LiteralPath "$staged\cache"
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new('NT SERVICE\Brixchat24-Web','Modify','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath "$staged\cache" -AclObject $acl
$swapped=$false
try {
  if(!$WebOnly) { Stop-Service Brixchat24-Worker; Stop-Service Brixchat24-API }
  Stop-Service Brixchat24-Web
  foreach($file in $files) {Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $release $file) -Force}
  Move-Item -LiteralPath $active -Destination $previous
  Move-Item -LiteralPath $staged -Destination $active
  $swapped=$true
  if(!$WebOnly) { Start-Service Brixchat24-API; Start-Service Brixchat24-Worker }
  Start-Service Brixchat24-Web
  $healthy=$false
  for($i=0;$i -lt 60;$i++) {
    try {
      $api=Invoke-WebRequest 'http://127.0.0.1:4410/health/ready' -TimeoutSec 5
      $web=Invoke-WebRequest 'http://127.0.0.1:3310/login' -TimeoutSec 5
      $worker=Invoke-WebRequest 'http://127.0.0.1:4110/health' -TimeoutSec 5
      if($api.StatusCode -eq 200 -and $web.StatusCode -eq 200 -and $worker.StatusCode -eq 200) {$healthy=$true;break}
    }catch{}
    Start-Sleep -Seconds 2
  }
  if(!$healthy) {throw 'Post-deploy readiness failed'}
  [pscustomobject]@{Status='deployed';Backup=$backup;PreviousBuild=$previous} | ConvertTo-Json -Compress
}catch {
  $failure=$_
  Stop-Service Brixchat24-Web -ErrorAction SilentlyContinue
  if(!$WebOnly) {Stop-Service Brixchat24-API,Brixchat24-Worker -ErrorAction SilentlyContinue}
  if(Test-Path -LiteralPath $previous) {
    if(Test-Path -LiteralPath $active) {Move-Item -LiteralPath $active -Destination $failed}
    Move-Item -LiteralPath $previous -Destination $active
  }
  foreach($file in $files) { $saved=Join-Path $backup $file; if(Test-Path -LiteralPath $saved) {Copy-Item -LiteralPath $saved -Destination (Join-Path $release $file) -Force} }
  if(!$WebOnly) {Start-Service Brixchat24-API,Brixchat24-Worker}
  Start-Service Brixchat24-Web
  throw $failure
}
