param([ValidateSet('Web','API','Worker')][string[]]$Components=@('Web','API','Worker'),[switch]$SkipPackageFileGrant)
$ErrorActionPreference='Stop'
$root='C:\ProgramData\Brixchat24'
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$aclBackup=@{}
function Grant-ServicePath([string]$Path,[string]$Account,[string]$Rights,[bool]$Children=$false) {
  if(!(Test-Path -LiteralPath $Path)) { throw "Missing ACL target: $Path" }
  $acl=Get-Acl -LiteralPath $Path
  if(!$aclBackup.ContainsKey($Path)) { $aclBackup[$Path]=$acl.Sddl }
  $inheritance=if($Children){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($Account,[Security.AccessControl.FileSystemRights]$Rights,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  if($acl.Access | Where-Object { $_.IdentityReference.Value -eq $Account -and $_.AccessControlType -eq 'Allow' -and $_.InheritanceFlags -eq $inheritance -and ($_.FileSystemRights -band $rule.FileSystemRights) -eq $rule.FileSystemRights }) { return }
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
}
$releaseAccounts=@{}
foreach($component in $Components) {
  $releaseConfig=[xml][IO.File]::ReadAllText("$root\services\Brixchat24-$component.xml")
  $releaseDirectory=[string]$releaseConfig.service.workingdirectory
  if($releaseDirectory -notmatch '^C:\\ProgramData\\Brixchat24\\releases\\[a-zA-Z0-9-]+$'){throw 'Unexpected release directory'}
  if(!$releaseAccounts.ContainsKey($releaseDirectory)){$releaseAccounts[$releaseDirectory]=@()}
  $releaseAccounts[$releaseDirectory]+="NT SERVICE\Brixchat24-$component"
}
foreach($releaseDirectory in $releaseAccounts.Keys) {
  $releaseAcl=Get-Acl -LiteralPath $releaseDirectory
  $aclBackup[$releaseDirectory]=$releaseAcl.Sddl
  $changed=$false
  foreach($account in $releaseAccounts[$releaseDirectory]) {
    if(!($releaseAcl.Access | Where-Object {$_.IdentityReference.Value -eq $account -and $_.InheritanceFlags -eq 'ContainerInherit,ObjectInherit' -and $_.AccessControlType -eq 'Allow'})) {
      $releaseAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($account,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
      $changed=$true
    }
  }
  if($changed) {
    [IO.File]::WriteAllText("$root\backups\service-identity-acls-$stamp.json",($aclBackup|ConvertTo-Json -Depth 3))
    Set-Acl -LiteralPath $releaseDirectory -AclObject $releaseAcl
  }
  if(!$SkipPackageFileGrant) {
    & "$PSScriptRoot\grant-package-files.ps1" -ReleaseRoot $releaseDirectory -Accounts $releaseAccounts[$releaseDirectory]
  }
}
foreach($component in $Components) {
  $id="Brixchat24-$component"
  $account="NT SERVICE\$id"
  $xmlPath="$root\services\$id.xml"
  $original=[IO.File]::ReadAllText($xmlPath)
  $config=[xml]$original
  $release=[string]$config.service.workingdirectory
  if($release -notmatch '^C:\\ProgramData\\Brixchat24\\releases\\[a-zA-Z0-9-]+$'){throw 'Unexpected release directory'}
  $serviceBefore=Get-CimInstance Win32_Service -Filter "Name='$id'"
  if($serviceBefore.StartName -notin @('LocalSystem',$account)){throw "Unexpected identity: $id"}
  [IO.File]::WriteAllText("$root\backups\$id-identity-before-$stamp.xml",$original)
  $logPath="$root\logs\$component"
  New-Item -ItemType Directory -Force $logPath | Out-Null
  foreach($directory in @($root,"$root\services","$root\releases","$root\live","$root\logs","$root\pgdata")) {
    Grant-ServicePath $directory $account 'ReadAndExecute'
  }
  Grant-ServicePath $release $account 'ReadAndExecute' $true
  Grant-ServicePath $logPath $account 'Modify' $true
  foreach($file in @("$root\services\node.exe","$root\services\$id.exe",$xmlPath,"$root\live\$($component.ToLowerInvariant()).env","$root\pgdata\server.crt")) {
    Grant-ServicePath $file $account 'ReadAndExecute'
  }
  if($component -eq 'Web') {
    $cache="$release\apps\web\.next\cache"
    New-Item -ItemType Directory -Force $cache | Out-Null
    Grant-ServicePath $cache $account 'Modify' $true
  }
  [IO.File]::WriteAllText("$root\backups\service-identity-acls-$stamp.json",($aclBackup|ConvertTo-Json -Depth 3))
  $config.service.logpath=$logPath
  if(!$config.service.serviceaccount) {
    $serviceAccount=$config.CreateElement('serviceaccount')
    $domain=$config.CreateElement('domain'); $domain.InnerText='NT SERVICE'; [void]$serviceAccount.AppendChild($domain)
    $username=$config.CreateElement('user'); $username.InnerText=$id; [void]$serviceAccount.AppendChild($username)
    [void]$config.service.AppendChild($serviceAccount)
  }
  $config.Save($xmlPath)
  try {
    & sc.exe config $id obj= $account | Out-Null
    if($LASTEXITCODE -ne 0){throw "Service identity change failed: $id"}
    Restart-Service -Name $id
    $passed=$false
    for($attempt=0;$attempt -lt 20;$attempt++) {
      try {
        if($component -eq 'Web') { $passed=(Invoke-WebRequest 'http://127.0.0.1:3310/login' -TimeoutSec 3).StatusCode -eq 200 }
        elseif($component -eq 'API') { $probe=Invoke-RestMethod 'http://127.0.0.1:4410/health/ready' -TimeoutSec 3; $passed=$probe.dependencies.postgresql -eq 'ok' -and $probe.dependencies.redis.healthy }
        else { $probe=(Invoke-WebRequest 'http://127.0.0.1:4110/health' -SkipHttpErrorCheck -TimeoutSec 3).Content|ConvertFrom-Json; $passed=$probe.dependencies.postgresql.healthy -and $probe.dependencies.redis.healthy -and $probe.dependencies.workerLoop.healthy }
        if($passed){break}
      } catch {}
      Start-Sleep -Seconds 2
    }
    if(!$passed){throw "Service health failed under new identity: $id"}
    Write-Output "$id is healthy as $account"
  } catch {
    [IO.File]::WriteAllText($xmlPath,$original)
    & sc.exe config $id obj= $serviceBefore.StartName | Out-Null
    Restart-Service -Name $id -ErrorAction Continue
    throw
  }
}
