$ErrorActionPreference='Stop'
$root='C:\ProgramData\Brixchat24'
$source=Join-Path $PSScriptRoot 'resource-runner.cs'
$runner="$root\services\Brixchat24.ResourceRunner.exe"
if(!(Test-Path -LiteralPath $source)){throw 'Resource runner source missing'}
$compiled="$root\services\Brixchat24.ResourceRunner.new.exe"
if(Test-Path -LiteralPath $compiled){Remove-Item -LiteralPath $compiled}
$compiler='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(!(Test-Path -LiteralPath $compiler)){throw 'Windows C# compiler missing'}
& $compiler /nologo /target:exe "/out:$compiled" $source
if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $compiled)){throw 'Resource runner compilation failed'}
& $compiled --run Smoke 128 50 "$root\logs\resource-smoke.json" "$root\services\node.exe" -e "process.stdout.write('resource-runner-ok')"
if($LASTEXITCODE -ne 0){throw 'Resource runner smoke test failed'}
if(Test-Path -LiteralPath $runner){Copy-Item $runner "$root\backups\Brixchat24.ResourceRunner-before-$(Get-Date -Format yyyyMMdd-HHmmss).exe"}
Move-Item -LiteralPath $compiled -Destination $runner -Force
$settings=@{
  API=@{memory=1792;cpu=30}
  Worker=@{memory=1536;cpu=25}
  Web=@{memory=2304;cpu=35}
}
$updated=@{}
try {
  foreach($component in @('API','Worker','Web')) {
    $xmlPath="$root\services\Brixchat24-$component.xml"
    $original=[IO.File]::ReadAllText($xmlPath)
    $updated[$component]=$original
    [IO.File]::WriteAllText("$root\backups\Brixchat24-$component-before-resource-limits-$(Get-Date -Format yyyyMMdd-HHmmss).xml",$original)
    $document=[xml]$original
    $node=[string]$document.service.executable
    $arguments=[string]$document.service.arguments
    if($node -ne "$root\services\node.exe" -or $arguments -notmatch 'service-entry\.mjs'){throw "Unexpected service command: $component"}
    $document.service.executable=$runner
    $document.service.arguments="--run $component $($settings[$component].memory) $($settings[$component].cpu) `"$root\logs\$component\resource-limits.json`" `"$node`" $arguments"
    $document.Save($xmlPath)
    & icacls.exe $runner /grant "NT SERVICE\Brixchat24-${component}:RX" /Q | Out-Null
    if($LASTEXITCODE -ne 0){throw "Runner ACL failed: $component"}
  }
  foreach($component in @('API','Worker','Web')){Restart-Service "Brixchat24-$component"}
  $healthy=$false
  for($attempt=0;$attempt -lt 30;$attempt++){
    try{
      $api=Invoke-RestMethod http://127.0.0.1:4410/health/ready -TimeoutSec 3
      $worker=Invoke-WebRequest http://127.0.0.1:4110/health -TimeoutSec 3
      $web=Invoke-WebRequest http://127.0.0.1:3310/login -TimeoutSec 3
      $reports=@('API','Worker','Web') | ForEach-Object {Get-Content "$root\logs\$_\resource-limits.json" | ConvertFrom-Json}
      $healthy=$api.status -eq 'ready' -and $worker.StatusCode -eq 200 -and $web.StatusCode -eq 200 -and ($reports | Where-Object {!$_.limitsApplied}).Count -eq 0
      if($healthy){break}
    }catch{}
    Start-Sleep -Seconds 2
  }
  if(!$healthy){throw 'Resource-limited services failed health checks'}
  Write-Output 'Web, API and worker started with kernel job memory and CPU limits.'
}catch{
  foreach($component in $updated.Keys){[IO.File]::WriteAllText("$root\services\Brixchat24-$component.xml",$updated[$component])}
  foreach($component in $updated.Keys){Restart-Service "Brixchat24-$component" -ErrorAction Continue}
  throw
}
