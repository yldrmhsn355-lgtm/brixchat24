$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$serviceFile = 'C:\ProgramData\Brixchat24\services\Brixchat24-Web.xml'
$service = [xml](Get-Content -LiteralPath $serviceFile -Raw)
$releaseRoot = [string]$service.service.workingdirectory
if ($releaseRoot -notmatch '^C:\\ProgramData\\Brixchat24\\releases\\[a-zA-Z0-9-]+$') {
  throw 'Unexpected production release path'
}
$releaseRoot = (Resolve-Path -LiteralPath $releaseRoot).Path
$webRoot = Join-Path $releaseRoot 'apps\web'
$sourceBuild = Join-Path $sourceRoot 'apps\web\.next'
if (!(Test-Path -LiteralPath "$sourceBuild\BUILD_ID")) { throw 'Verified production build is missing' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$staged = Join-Path $webRoot ".next-professional-$stamp"
$active = Join-Path $webRoot '.next'
$previous = Join-Path $webRoot ".next-before-professional-$stamp"
$failed = Join-Path $webRoot ".next-failed-professional-$stamp"
# Check every directory before any recursive move; all targets stay in this release.
foreach ($target in @($staged, $active, $previous, $failed)) {
  if (![IO.Path]::GetFullPath($target).StartsWith($webRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Build target is outside the named release'
  }
}
& robocopy $sourceBuild $staged /E /XD cache /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -gt 7) { throw 'Build staging failed' }
$cache = Join-Path $staged 'cache'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$cacheAcl = Get-Acl -LiteralPath $cache
$cacheAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('NT SERVICE\Brixchat24-Web','Modify','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl -LiteralPath $cache -AclObject $cacheAcl
$sourceBackup = "C:\ProgramData\Brixchat24\backups\professional-theme-source-$stamp"
$files = @('app\globals.css','app\design-system.css','app\professional-theme.css','app\layout.tsx','app\platform-admin\platform-admin.css','app\app\campaigns\page.module.css','app\app\templates\templates.module.css')
foreach ($file in $files) {
  $liveFile = Join-Path $webRoot $file
  if (Test-Path -LiteralPath $liveFile) {
    $savedFile = Join-Path $sourceBackup $file
    New-Item -ItemType Directory -Force (Split-Path -Parent $savedFile) | Out-Null
    Copy-Item -LiteralPath $liveFile -Destination $savedFile
  }
}
$swapped = $false
try {
  Stop-Service Brixchat24-Web
  Move-Item -LiteralPath $active -Destination $previous
  Move-Item -LiteralPath $staged -Destination $active
  $swapped = $true
  foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path "$sourceRoot\apps\web" $file) -Destination (Join-Path $webRoot $file) -Force
  }
  Start-Service Brixchat24-Web
  $healthy = $false
  for ($i=0; $i -lt 15; $i++) {
    try {
      if ((Invoke-WebRequest 'http://127.0.0.1:3310/login' -TimeoutSec 10).StatusCode -eq 200) { $healthy=$true; break }
    } catch {}
    Start-Sleep -Seconds 2
  }
  if (!$healthy) { throw 'Web did not become healthy after the theme update' }
  Write-Output "Professional theme deployed. Previous build: $previous"
} catch {
  if ($swapped -or (Test-Path -LiteralPath $previous)) {
    Stop-Service Brixchat24-Web -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $active) { Move-Item -LiteralPath $active -Destination $failed }
    Move-Item -LiteralPath $previous -Destination $active
    foreach ($file in $files) {
      $savedFile = Join-Path $sourceBackup $file
      if (Test-Path -LiteralPath $savedFile) { Copy-Item -LiteralPath $savedFile -Destination (Join-Path $webRoot $file) -Force }
    }
    Start-Service Brixchat24-Web
  }
  throw
}
