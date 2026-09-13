param([int]$Port = 8080)
$ErrorActionPreference = 'Stop'
$appcmd = "$env:windir/System32/inetsrv/appcmd.exe"
$siteRoot = 'C:\inetpub\Brixchat24'
function Invoke-Iis([string[]]$Arguments) {
    & $appcmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "IIS configuration failed: $Arguments" }
}
New-Item -ItemType Directory -Force $siteRoot | Out-Null
Copy-Item -LiteralPath "$PSScriptRoot/web.config" -Destination "$siteRoot/web.config" -Force
Invoke-Iis @('set', 'config', '-section:system.webServer/proxy', '/enabled:true', '/preserveHostHeader:true', '/reverseRewriteHostInResponseHeaders:false', '/includePortInXForwardedFor:false', '/responseBufferLimit:0', '/minResponseBuffer:0', '/bufferChunkedResponses:false', '/timeout:00:10:00', '/commit:apphost')
if (!(& $appcmd list apppool Brixchat24 /text:name)) {
    Invoke-Iis @('add', 'apppool', '/name:Brixchat24', '/managedRuntimeVersion:')
}
if (!(& $appcmd list site Brixchat24 /text:name)) {
    Invoke-Iis @('add', 'site', '/name:Brixchat24', "/physicalPath:$siteRoot", "/bindings:http/127.0.0.1:${Port}:,http/[::1]:${Port}:")
}
Invoke-Iis @('set', 'app', 'Brixchat24/', '/applicationPool:Brixchat24')
Invoke-Iis @('start', 'site', 'Brixchat24')
Write-Host "Brixchat24: http://localhost:$Port"
