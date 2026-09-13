$ErrorActionPreference='Stop'
$root='C:\ProgramData\Brixchat24'
$source=Join-Path $PSScriptRoot 'verify-after-reboot.ps1'
$target="$root\services\verify-after-reboot.ps1"
Copy-Item -LiteralPath $source -Destination $target -Force
$action=New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File $target"
$trigger=New-ScheduledTaskTrigger -AtStartup
$trigger.Delay='PT1M'
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal=New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName Brixchat24-Post-Reboot-Verification -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Output 'Post-reboot verification task installed.'
