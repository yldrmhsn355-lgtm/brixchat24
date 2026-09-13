param(
  [ValidatePattern('^[a-zA-Z0-9-]+$')][string]$ReleaseName = '20260910-services',
  [switch]$SkipZipAudit
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$auditRoot = 'C:\ProgramData\Brixchat24\zip-audit-20260910'
$releaseRoot = "C:\ProgramData\Brixchat24\releases\$ReleaseName"
$projectRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
New-Item -ItemType Directory -Force $auditRoot,$releaseRoot | Out-Null
function Is-Source([string]$relative) {
  if ($relative -match '(^|[\\/])(node_modules|\.git|\.next|\.turbo|\.data|dist|coverage|test-results|playwright-report|\.pnpm-store)([\\/]|$)') { return $false }
  $name = [IO.Path]::GetFileName($relative)
  if ($name -like '.env*' -and $name -notlike '*.example') { return $false }
  if ($name -match '\.(zip|dump|log|tsbuildinfo)$') { return $false }
  return $true
}
$count = 0
if (!$SkipZipAudit) {
$archive = [IO.Compression.ZipFile]::OpenRead('C:\Users\Administrator\Downloads\Brixchat24-transfer-windows-20260910.zip')
try {
  foreach ($entry in $archive.Entries) {
    $relative = $entry.FullName.Replace('/', '\')
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($auditRoot, $relative))
    if (!$target.StartsWith($auditRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe ZIP entry' }
    if (($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000) { throw 'ZIP symlink rejected' }
    if ($entry.Name -eq '' -or $relative.EndsWith('\') -or !(Is-Source $relative)) { continue }
    New-Item -ItemType Directory -Force ([IO.Path]::GetDirectoryName($target)) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$true)
    $count++
  }
} finally { $archive.Dispose() }
}
# Overlay the reviewed working source, including already deployed optional-integration fixes.
function Copy-Source([string]$directory) {
  foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
    $relative = $item.FullName.Substring($projectRoot.Length + 1)
    if (!(Is-Source $relative) -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    $destination = Join-Path $releaseRoot $relative
    if ($item.PSIsContainer) { New-Item -ItemType Directory -Force $destination | Out-Null; Copy-Source $item.FullName }
    else { Copy-Item -LiteralPath $item.FullName -Destination $destination -Force }
  }
}
Copy-Source $projectRoot
Write-Output "ZIP audited/extracted: $count source files. Release staged: $releaseRoot"
