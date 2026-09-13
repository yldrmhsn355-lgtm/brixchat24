param([ValidateSet('PostgreSQL','Redis')][string[]]$Components=@('PostgreSQL','Redis'))
$ErrorActionPreference='Stop'
$root='C:\ProgramData\Brixchat24'
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
foreach($component in $Components) {
  $id="Brixchat24-$component"
  $account="NT SERVICE\$id"
  $before=Get-CimInstance Win32_Service -Filter "Name='$id'"
  if($before.StartName -notin @('LocalSystem',$account)){throw 'Unexpected service identity'}
  $runtime=if($component -eq 'PostgreSQL'){"$root\postgres"}else{"$root\redis"}
  $data=if($component -eq 'PostgreSQL'){"$root\pgdata"}else{"$root\redis-data"}
  $backup=@{service=$id;previousIdentity=$before.StartName;runtimeAcl=(Get-Acl -LiteralPath $runtime).Sddl;dataAcl=(Get-Acl -LiteralPath $data).Sddl}
  $backup|ConvertTo-Json|Set-Content -LiteralPath "$root\backups\$id-identity-$stamp.json"
  & icacls.exe $runtime /grant "${account}:(OI)(CI)RX" /T /L /Q
  if($LASTEXITCODE -ne 0){throw 'Runtime ACL update failed'}
  $originalXml=$null
  if($component -eq 'Redis') {
    # Use Windows ACL enforcement without Cygwin synthesizing POSIX deny entries.
    # The mount is scoped to Redis data; other Cygwin paths keep their defaults.
    $etcPath="$root\redis\etc"
    New-Item -ItemType Directory -Force $etcPath | Out-Null
    $fstabPath=Join-Path $etcPath 'fstab'
    $fstabLine="C:/ProgramData/Brixchat24/redis-data /cygdrive/c/ProgramData/Brixchat24/redis-data ntfs binary,noacl,posix=0 0 0`n"
    if((Test-Path -LiteralPath $fstabPath) -and [IO.File]::ReadAllText($fstabPath) -ne $fstabLine){throw 'Existing Cygwin fstab requires review'}
    [IO.File]::WriteAllText($fstabPath,$fstabLine)
    & icacls.exe $etcPath /grant "${account}:(OI)(CI)RX" /T /L /Q
    if($LASTEXITCODE -ne 0){throw 'Cygwin config ACL update failed'}
    $xmlPath="$root\services\$id.xml"
    $originalXml=[IO.File]::ReadAllText($xmlPath)
    [IO.File]::WriteAllText("$root\backups\$id-before-identity-$stamp.xml",$originalXml)
    $config=[xml]$originalXml
    $config.service.workingdirectory="$root\redis\Redis-7.4.9-Windows-x64-cygwin"
    $logPath="$root\logs\Redis"
    New-Item -ItemType Directory -Force $logPath | Out-Null
    & icacls.exe $logPath /grant "${account}:(OI)(CI)M" /T /L /Q
    $config.service.logpath=$logPath
    if(!$config.service.serviceaccount) {
      $entry=$config.CreateElement('serviceaccount')
      $domain=$config.CreateElement('domain');$domain.InnerText='NT SERVICE';[void]$entry.AppendChild($domain)
      $username=$config.CreateElement('user');$username.InnerText=$id;[void]$entry.AppendChild($username)
      [void]$config.service.AppendChild($entry)
    }
    $config.Save($xmlPath)
    foreach($path in @("$root\services\$id.exe",$xmlPath,"$root\redis.conf")){
      & icacls.exe $path /grant "${account}:RX" /Q
      if($LASTEXITCODE -ne 0){throw 'Redis file ACL update failed'}
    }
  }
  $dependents=@(Get-Service Brixchat24-API,Brixchat24-Worker | Where-Object Status -eq Running | Select-Object -ExpandProperty Name)
  try {
    foreach($dependent in $dependents){Stop-Service -Name $dependent}
    Stop-Service -Name $id
    if($component -eq 'Redis') {
      $redisBackup="$root\backups\redis-before-identity-$stamp"
      New-Item -ItemType Directory -Force $redisBackup | Out-Null
      Copy-Item -LiteralPath $data -Destination $redisBackup -Recurse
      $items=@(Get-Item -LiteralPath $data)+@(Get-ChildItem -LiteralPath $data -Recurse -Force)
      if($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }){throw 'Redis data contains a reparse point'}
      $aclRecords=@($items | ForEach-Object { @{path=$_.FullName;sddl=(Get-Acl -LiteralPath $_.FullName).Sddl} })
      $aclRecords | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$redisBackup\original-acls.json"
      # Replace Cygwin's synthetic POSIX deny/mask entries with a private Windows DACL.
      # Only SYSTEM, administrators and the Redis service can access this data.
      foreach($item in $items) {
        $acl=if($item.PSIsContainer){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity}
        $acl.SetAccessRuleProtection($true,$false)
        $acl.SetOwner((New-Object Security.Principal.NTAccount($account)))
        $inherit=if($item.PSIsContainer){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
        foreach($entry in @(@('NT AUTHORITY\SYSTEM','FullControl'),@('BUILTIN\Administrators','FullControl'),@($account,'FullControl'))) {
          $rule=New-Object Security.AccessControl.FileSystemAccessRule($entry[0],$entry[1],$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
          $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $item.FullName -AclObject $acl
      }
    }
    # Redis shutdown writes a new snapshot/manifest with the old account's ACL.
    # Grant the final on-disk files only after shutdown has completed.
    & icacls.exe $data /grant "${account}:(OI)(CI)M" /T /L /Q
    if($LASTEXITCODE -ne 0){throw 'Data ACL update failed'}
    if($component -eq 'Redis') {
      if((Resolve-Path -LiteralPath $data).Path -ne 'C:\ProgramData\Brixchat24\redis-data'){throw 'Unexpected Redis data path'}
      & icacls.exe $data /setowner $account /T /L /Q
      if($LASTEXITCODE -ne 0){throw 'Redis data ownership update failed'}
    }
    & sc.exe config $id obj= $account
    if($LASTEXITCODE -ne 0){throw 'Service identity change failed'}
    Start-Service -Name $id
    $passed=$false
    for($attempt=0;$attempt -lt 20;$attempt++) {
      if($component -eq 'PostgreSQL') {
        & "$root\postgres\pgsql\bin\pg_isready.exe" -h 127.0.0.1 -p 5434 -q
        $passed=$LASTEXITCODE -eq 0
      } else {
        $ping=& "$root\redis\Redis-7.4.9-Windows-x64-cygwin\redis-cli.exe" -h 127.0.0.1 -p 6381 ping
        $passed=$ping -eq 'PONG'
      }
      if($passed){break}
      Start-Sleep -Seconds 2
    }
    if(!$passed){throw "$id health failed under new identity"}
    Write-Output "$id verified as $account"
  } catch {
    if($component -eq 'Redis') {
      & icacls.exe $data /setowner 'NT AUTHORITY\SYSTEM' /T /L /Q | Out-Null
    }
    & sc.exe config $id obj= $before.StartName | Out-Null
    if($originalXml){[IO.File]::WriteAllText("$root\services\$id.xml",$originalXml)}
    if((Get-Service $id).Status -eq 'Running'){Stop-Service $id}
    Start-Service $id
    throw
  } finally {
    foreach($dependent in $dependents){Start-Service -Name $dependent}
  }
}
