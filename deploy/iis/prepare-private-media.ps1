$ErrorActionPreference='Stop'
$root='C:\ProgramData\Brixchat24\media'
if(Test-Path -LiteralPath $root) {
  $item=Get-Item -LiteralPath $root
  if(!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unexpected media root'}
  if((Get-ChildItem -LiteralPath $root -Force | Measure-Object).Count -ne 0){throw 'Existing media data requires ACL review'}
} else { New-Item -ItemType Directory -Path $root | Out-Null }
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner((New-Object Security.Principal.NTAccount('BUILTIN\Administrators')))
foreach($entry in @(@('NT AUTHORITY\SYSTEM','FullControl'),@('BUILTIN\Administrators','FullControl'),@('NT SERVICE\Brixchat24-API','Modify'),@('NT SERVICE\Brixchat24-Worker','Modify'))) {
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($entry[0],$entry[1],[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $root -AclObject $acl
Write-Output 'Private media directory prepared for API and worker service accounts.'
