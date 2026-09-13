$ErrorActionPreference = 'Stop'
Add-Type -Path "$env:windir\System32\inetsrv\Microsoft.Web.Administration.dll"
$certificate = Get-ChildItem Cert:\LocalMachine\WebHosting |
    Where-Object { $_.Subject -eq 'CN=brixchat24.com' -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
if (!$certificate) { throw 'No valid brixchat24.com certificate in WebHosting store.' }
$manager = New-Object Microsoft.Web.Administration.ServerManager
try {
    $site = $manager.Sites['Brixchat24-Public']
    if (!$site) { throw 'Brixchat24-Public IIS site is missing.' }
    foreach ($domain in @('brixchat24.com', 'www.brixchat24.com')) {
        $bindingInfo = "*:443:$domain"
        $binding = $site.Bindings | Where-Object { $_.Protocol -eq 'https' -and $_.BindingInformation -eq $bindingInfo }
        if (!$binding) { $binding = $site.Bindings.Add($bindingInfo, $certificate.GetCertHash(), 'WebHosting') }
        $binding.CertificateHash = $certificate.GetCertHash()
        $binding.CertificateStoreName = 'WebHosting'
        $binding.SslFlags = [Microsoft.Web.Administration.SslFlags]::Sni
    }
    $manager.CommitChanges()
    Write-Output "IIS certificate synchronized; expires $($certificate.NotAfter.ToString('yyyy-MM-dd'))"
} finally { $manager.Dispose() }

$apiCertificate = Get-ChildItem Cert:\LocalMachine\WebHosting |
    Where-Object { $_.Subject -eq 'CN=api.brixchat24.com' -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
if ($apiCertificate) {
    $apiManager = New-Object Microsoft.Web.Administration.ServerManager
    try {
        $apiSite = $apiManager.Sites['Brixchat24-API']
        if (!$apiSite) { throw 'API IIS site missing' }
        $apiBinding = $apiSite.Bindings | Where-Object { $_.Protocol -eq 'https' -and $_.BindingInformation -eq '*:443:api.brixchat24.com' }
        if (!$apiBinding) { $apiBinding = $apiSite.Bindings.Add('*:443:api.brixchat24.com', $apiCertificate.GetCertHash(), 'WebHosting') }
        $apiBinding.CertificateHash = $apiCertificate.GetCertHash()
        $apiBinding.CertificateStoreName = 'WebHosting'
        $apiBinding.SslFlags = [Microsoft.Web.Administration.SslFlags]::Sni
        $apiManager.CommitChanges()
        Write-Output "API certificate synchronized; expires $($apiCertificate.NotAfter.ToString('yyyy-MM-dd'))"
    } finally { $apiManager.Dispose() }
}
