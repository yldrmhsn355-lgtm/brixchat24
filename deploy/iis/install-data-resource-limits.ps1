$ErrorActionPreference='Stop'
$root='C:\ProgramData\Brixchat24'
$services="$root\services"
$runner="$services\Brixchat24.ResourceRunner.exe"
$winsw="$services\Brixchat24-API.exe"
if(!(Test-Path -LiteralPath $runner) -or !(Test-Path -LiteralPath $winsw)){throw 'Required service runner is missing'}
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$started=(Get-Date).ToUniversalTime()
$components=@{
  Redis=@{memory=1024;cpu=15}
  ClamAV=@{memory=2048;cpu=25}
  PostgreSQL=@{memory=3072;cpu=35}
}
$originalXml=@{}
foreach($component in @('Redis','ClamAV')) {
  $xmlPath="$services\Brixchat24-$component.xml"
  $originalXml[$component]=[IO.File]::ReadAllText($xmlPath)
  [IO.File]::WriteAllText("$root\backups\Brixchat24-$component-before-resource-limits-$stamp.xml",$originalXml[$component])
}
$postgresService=Get-CimInstance Win32_Service -Filter "Name='Brixchat24-PostgreSQL'"
$originalPostgresPath=[string]$postgresService.PathName
if($originalPostgresPath -notmatch 'pg_ctl\.exe.+runservice'){throw 'Unexpected PostgreSQL service command'}
@{path=$originalPostgresPath;identity=$postgresService.StartName;capturedAt=$started.ToString('o')}|ConvertTo-Json|Set-Content "$root\backups\Brixchat24-PostgreSQL-before-resource-limits-$stamp.json"
$running=@(Get-Service Brixchat24-API,Brixchat24-Worker | Where-Object Status -eq Running | Select-Object -ExpandProperty Name)
foreach($component in @('PostgreSQL','Redis','ClamAV')) {
  $resourceLog="$root\logs\$component"
  New-Item -ItemType Directory -Force $resourceLog|Out-Null
  & icacls.exe $resourceLog /grant "NT SERVICE\Brixchat24-${component}:(OI)(CI)M" /T /L /Q|Out-Null
  if($LASTEXITCODE -ne 0){throw "Resource report ACL failed: $component"}
}
if(![Diagnostics.EventLog]::SourceExists('Brixchat24-PostgreSQL')){New-EventLog -LogName Application -Source Brixchat24-PostgreSQL}
function RunnerArguments([string]$component,[string]$executable,[string]$arguments) {
  return "--run $component $($components[$component].memory) $($components[$component].cpu) `"$root\logs\$component\resource-limits.json`" `"$executable`" $arguments"
}
try {
  foreach($dependent in $running){Stop-Service $dependent}
  foreach($component in @('Redis','ClamAV')) {
    Stop-Service "Brixchat24-$component"
    $xmlPath="$services\Brixchat24-$component.xml"
    $document=[xml]$originalXml[$component]
    $executable=[string]$document.service.executable
    $arguments=if($document.service.arguments){[string]$document.service.arguments}else{[string]$document.service.startarguments}
    if(!$executable -or !$arguments){throw "Unexpected service configuration: $component"}
    $document.service.executable=$runner
    if(!$document.service.arguments){$entry=$document.CreateElement('arguments');[void]$document.service.AppendChild($entry)}
    $document.service.arguments=RunnerArguments $component $executable $arguments
    $startArgumentsNode=$document.service.SelectSingleNode('startarguments')
    if($startArgumentsNode){[void]$document.service.RemoveChild($startArgumentsNode)}
    $document.Save($xmlPath)
    & icacls.exe $runner /grant "NT SERVICE\Brixchat24-${component}:RX" /Q | Out-Null
    if($LASTEXITCODE -ne 0){throw "Runner ACL failed: $component"}
  }
  Stop-Service Brixchat24-PostgreSQL
  $postgresWrapper="$services\Brixchat24-PostgreSQL.exe"
  Copy-Item -LiteralPath $winsw -Destination $postgresWrapper -Force
  $postgresXml=@"
<service>
  <id>Brixchat24-PostgreSQL</id><name>Brixchat24-PostgreSQL</name><description>Brixchat24 production PostgreSQL</description>
  <executable>$runner</executable>
  <arguments>$(RunnerArguments 'PostgreSQL' "$root\postgres\pgsql\bin\postgres.exe" "-D `"$root\pgdata`"")</arguments>
  <workingdirectory>$root\postgres\pgsql\bin</workingdirectory>
  <startmode>Automatic</startmode><delayedAutoStart>false</delayedAutoStart>
  <stopexecutable>$root\postgres\pgsql\bin\pg_ctl.exe</stopexecutable><stoparguments>-D "$root\pgdata" stop -m fast -w</stoparguments><stoptimeout>60 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec"/><onfailure action="restart" delay="30 sec"/><onfailure action="restart" delay="60 sec"/><resetfailure>1 day</resetfailure>
  <logpath>$root\logs\PostgreSQL-Service</logpath><log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
  <serviceaccount><domain>NT SERVICE</domain><user>Brixchat24-PostgreSQL</user></serviceaccount>
</service>
"@
  New-Item -ItemType Directory -Force "$root\logs\PostgreSQL-Service"|Out-Null
  [IO.File]::WriteAllText("$services\Brixchat24-PostgreSQL.xml",$postgresXml)
  foreach($path in @($runner,$postgresWrapper,"$services\Brixchat24-PostgreSQL.xml")){& icacls.exe $path /grant 'NT SERVICE\Brixchat24-PostgreSQL:RX' /Q|Out-Null;if($LASTEXITCODE -ne 0){throw 'PostgreSQL service ACL failed'}}
  & icacls.exe "$root\logs\PostgreSQL-Service" /grant 'NT SERVICE\Brixchat24-PostgreSQL:(OI)(CI)M' /T /L /Q|Out-Null
  & sc.exe config Brixchat24-PostgreSQL binPath= "`"$postgresWrapper`"" | Out-Null
  if($LASTEXITCODE -ne 0){throw 'PostgreSQL service command update failed'}
  foreach($component in @('PostgreSQL','Redis','ClamAV')){Start-Service "Brixchat24-$component"}
  $healthy=$false
  for($attempt=0;$attempt -lt 30;$attempt++) {
    & "$root\postgres\pgsql\bin\pg_isready.exe" -h 127.0.0.1 -p 5434 -q
    $pg=$LASTEXITCODE -eq 0
    $redis=(& "$root\redis\Redis-7.4.9-Windows-x64-cygwin\redis-cli.exe" -h 127.0.0.1 -p 6381 ping) -eq 'PONG'
    $clam=(Test-NetConnection 127.0.0.1 -Port 3311 -InformationLevel Quiet -WarningAction SilentlyContinue)
    $reports=@('PostgreSQL','Redis','ClamAV')|ForEach-Object {try{Get-Content "$root\logs\$_\resource-limits.json"|ConvertFrom-Json}catch{$null}}
    $healthy=$pg -and $redis -and $clam -and $reports.Count -eq 3 -and @($reports|Where-Object {!$_.limitsApplied -or ([datetime]$_.appliedAt).ToUniversalTime() -lt $started}).Count -eq 0
    if($healthy){break};Start-Sleep -Seconds 2
  }
  if(!$healthy){throw 'Data services failed resource-limited health checks'}
  foreach($dependent in $running){Start-Service $dependent}
  Write-Output 'PostgreSQL, Redis and ClamAV started with kernel job memory and CPU limits.'
} catch {
  $failure=$_
  foreach($name in @('Brixchat24-API','Brixchat24-Worker','Brixchat24-PostgreSQL','Brixchat24-Redis','Brixchat24-ClamAV')){Stop-Service $name -ErrorAction SilentlyContinue}
  foreach($component in $originalXml.Keys){[IO.File]::WriteAllText("$services\Brixchat24-$component.xml",$originalXml[$component])}
  & sc.exe config Brixchat24-PostgreSQL binPath= $originalPostgresPath | Out-Null
  Start-Service Brixchat24-PostgreSQL;Start-Service Brixchat24-Redis;Start-Service Brixchat24-ClamAV
  foreach($dependent in $running){Start-Service $dependent}
  throw $failure
}
