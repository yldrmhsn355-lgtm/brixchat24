#requires -Version 7.0
$ErrorActionPreference = 'Stop'
# Read-only production audit. Never print keys, filenames, credentials or content.
foreach ($line in Get-Content -LiteralPath 'C:\ProgramData\Brixchat24\live\api.env') {
  if ($line -match '^\s*(?:export )?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim().Trim('"').Trim("'"), 'Process') }
}
$env:PGSSLROOTCERT = $env:NODE_EXTRA_CA_CERTS
$env:PGOPTIONS = '-c default_transaction_read_only=on'
$psql = 'C:\ProgramData\Brixchat24\postgres\pgsql\bin\psql.exe'
if (!$env:API_DATABASE_URL) { throw 'API_DATABASE_URL missing; refusing database fallback' }
$rows = & $psql $env:API_DATABASE_URL -X --csv -c "SELECT attachment_type,storage_key,stored_size,stored_sha256 FROM message_attachments WHERE deleted_at IS NULL AND processing_status='stored' AND scan_status='clean'" | ConvertFrom-Csv
if ($LASTEXITCODE -ne 0) { throw 'Read-only database query failed' }
$root = [IO.Path]::GetFullPath($env:OBJECT_STORAGE_FILESYSTEM_ROOT)
$results = foreach ($row in $rows) {
  $path = [IO.Path]::GetFullPath((Join-Path $root $row.storage_key))
  if (!$path.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Object path outside storage root' }
  $exists = Test-Path -LiteralPath $path -PathType Leaf
  $sizeOK = $false; $hashOK = $false
  if ($exists) {
    $sizeOK = (Get-Item -LiteralPath $path).Length -eq [long]$row.stored_size
    $hashOK = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $row.stored_sha256
  }
  [pscustomobject]@{Type=$row.attachment_type; Exists=$exists; SizeOK=$sizeOK; HashOK=$hashOK}
}
$results | Group-Object Type | ForEach-Object { [pscustomobject]@{Type=$_.Name; Total=$_.Count; Missing=@($_.Group | Where-Object {!$_.Exists}).Count; SizeMismatch=@($_.Group | Where-Object {!$_.SizeOK}).Count; HashMismatch=@($_.Group | Where-Object {!$_.HashOK}).Count} } | ConvertTo-Json -Compress
& $psql $env:API_DATABASE_URL -X --csv -c 'SELECT status,last_error_code,last_connected_at,last_disconnected_at,restart_attempts FROM whatsapp_web_sessions'
Get-Content -LiteralPath (Join-Path $PSScriptRoot 'audit-chat-processing.sql') -Raw | & $psql $env:API_DATABASE_URL -X -v ON_ERROR_STOP=1
if ($LASTEXITCODE -ne 0) { throw 'Read-only processing audit failed' }
