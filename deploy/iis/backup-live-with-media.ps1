$ErrorActionPreference='Stop'
$root='C:\ProgramData\Brixchat24'
$source="$root\media"
if((Resolve-Path -LiteralPath $source).Path -ne $source){throw 'Unexpected media directory'}
if((Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Media root is a reparse point'}
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$destination="$root\backups\live-media-$stamp"
if(Test-Path -LiteralPath $destination){throw 'Backup destination already exists'}
New-Item -ItemType Directory -Path $destination | Out-Null
$running=@(Get-Service Brixchat24-API,Brixchat24-Worker | Where-Object Status -eq Running | Select-Object -ExpandProperty Name)
try {
  # Briefly pause all production writers so the DB archive and media agree.
  foreach($name in $running){Stop-Service -Name $name}
  $env:NODE_EXTRA_CA_CERTS="$root\pgdata\server.crt"
  $databaseOutput=& "$root\services\node.exe" "$PSScriptRoot\backup-database.mjs" "$root\live\admin.env"
  if($LASTEXITCODE -ne 0){throw 'Database backup failed'}
  $database=$databaseOutput | ConvertFrom-Json
  & robocopy.exe $source "$destination\media" /E /COPY:DAT /DCOPY:DAT /XJ /XD .staging /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if($LASTEXITCODE -ge 8){throw 'Media copy failed'}
  $files=@()
  foreach($item in Get-ChildItem -LiteralPath $source -File -Recurse -Force) {
    $relative=$item.FullName.Substring($source.Length+1)
    if($relative -like '.staging\*'){continue}
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Unexpected media file link'}
    $copied=Join-Path "$destination\media" $relative
    $hash=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    if((Get-FileHash -LiteralPath $copied -Algorithm SHA256).Hash -ne $hash){throw 'Media hash verification failed'}
    $files+=@{path=$relative;bytes=$item.Length;sha256=$hash}
  }
  @{completedAt=(Get-Date).ToUniversalTime().ToString('o');database=$database;mediaFiles=$files;consistentWriterPause=$true} |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$destination\manifest.json"
  Write-Output "Verified database and private media backup: $destination"
} finally {
  foreach($name in $running){Start-Service -Name $name}
}
