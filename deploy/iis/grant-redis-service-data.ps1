$ErrorActionPreference='Stop'
$data='C:\ProgramData\Brixchat24\redis-data'
if((Resolve-Path -LiteralPath $data).Path -ne $data){throw 'Unexpected Redis data directory'}
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$backup="C:\ProgramData\Brixchat24\backups\redis-data-acls-$stamp.txt"
& icacls.exe $data /save $backup /T /L /Q
if($LASTEXITCODE -ne 0){throw 'Redis ACL backup failed'}
& icacls.exe $data /grant 'NT SERVICE\Brixchat24-Redis:(OI)(CI)M' '*S-1-5-32-544:(OI)(CI)F' /T /L /Q
if($LASTEXITCODE -ne 0){throw 'Redis ACL update failed'}
[IO.File]::WriteAllText('C:\ProgramData\Brixchat24\logs\redis-data-acl-result.json',(@{completedAt=(Get-Date).ToUniversalTime().ToString('o');backup=$backup;status='complete'}|ConvertTo-Json))
