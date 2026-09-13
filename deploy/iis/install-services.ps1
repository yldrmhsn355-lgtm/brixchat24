param([Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9-]+$')][string]$ReleaseName)
$ErrorActionPreference = 'Stop'
$servicesRoot = 'C:\ProgramData\Brixchat24\services'
$releaseRoot = "C:\ProgramData\Brixchat24\releases\$ReleaseName"
if(!(Test-Path -LiteralPath "$releaseRoot\deploy\iis\service-entry.mjs")){throw 'Release service entry is missing'}
$nodePath = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (!(Test-Path "$servicesRoot\node.exe")) { Copy-Item -LiteralPath $nodePath -Destination "$servicesRoot\node.exe" }
foreach ($component in @('Redis','API','Worker','Web')) {
  $id = "Brixchat24-$component"
  $executable = "$servicesRoot\node.exe"
  $arguments = '"' + "$releaseRoot\deploy\iis\service-entry.mjs" + '" ' + $component.ToLowerInvariant()
  $dependencies = ''
  $argumentTag = 'arguments'
  $stopCommand = ''
  if ($component -eq 'Redis') {
    $executable = 'C:\ProgramData\Brixchat24\redis\Redis-7.4.9-Windows-x64-cygwin\redis-server.exe'
    $arguments = '/cygdrive/c/ProgramData/Brixchat24/redis.conf'
    $argumentTag = 'startarguments'
    $stopCommand = '<stopexecutable>C:\ProgramData\Brixchat24\redis\Redis-7.4.9-Windows-x64-cygwin\redis-cli.exe</stopexecutable><stoparguments>-h 127.0.0.1 -p 6381 shutdown</stoparguments>'
  } elseif ($component -ne 'Web') { $dependencies = '<depend>Brixchat24-PostgreSQL</depend><depend>Brixchat24-Redis</depend>' }
  $xml = @"
<service>
  <id>$id</id><name>$id</name><description>Brixchat24 production $component</description>
  <executable>$executable</executable><$argumentTag>$arguments</$argumentTag>
  $stopCommand
  <workingdirectory>$releaseRoot</workingdirectory>
  <startmode>Automatic</startmode><delayedAutoStart>true</delayedAutoStart>
  $dependencies
  <stoptimeout>30 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec"/><resetfailure>1 hour</resetfailure>
  <logpath>C:\ProgramData\Brixchat24\logs</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
</service>
"@
  [IO.File]::WriteAllText("$servicesRoot\$id.xml", $xml, (New-Object Text.UTF8Encoding $false))
  if (!(Test-Path "$servicesRoot\$id.exe")) { Copy-Item "$servicesRoot\WinSW-x64.exe" "$servicesRoot\$id.exe" }
  if (!(Get-Service $id -ErrorAction SilentlyContinue)) { & "$servicesRoot\$id.exe" install; if ($LASTEXITCODE -ne 0) { throw "Install failed: $id" } }
}
Write-Output 'Services installed; start only after old supervisors are stopped.'
