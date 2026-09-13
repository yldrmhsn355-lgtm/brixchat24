param([Parameter(Mandatory=$true)][string]$ReleaseRoot,[string[]]$Accounts=@('NT SERVICE\Brixchat24-API','NT SERVICE\Brixchat24-Worker','NT SERVICE\Brixchat24-Web'))
$ErrorActionPreference='Stop'
$resolved=(Resolve-Path -LiteralPath $ReleaseRoot).Path
if($resolved -notmatch '^C:\\ProgramData\\Brixchat24\\releases\\[a-zA-Z0-9-]+$'){throw 'Unexpected release root'}
$options=New-Object IO.EnumerationOptions
$options.RecurseSubdirectories=$true
$options.AttributesToSkip=[IO.FileAttributes]::ReparsePoint
$options.IgnoreInaccessible=$false
$directory=New-Object IO.DirectoryInfo("$resolved\node_modules\.pnpm")
$rules=@($Accounts | ForEach-Object {New-Object Security.AccessControl.FileSystemAccessRule($_,'ReadAndExecute','Allow')})
$checked=0; $changed=0
foreach($file in $directory.EnumerateFiles('*',$options)) {
  $acl=[IO.FileSystemAclExtensions]::GetAccessControl($file)
  $update=$false
  foreach($rule in $rules) {
    if(!($acl.Access | Where-Object {$_.IdentityReference.Value -eq $rule.IdentityReference.Value -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $rule.FileSystemRights) -eq $rule.FileSystemRights})) {
      $acl.AddAccessRule($rule); $update=$true
    }
  }
  if($update){[IO.FileSystemAclExtensions]::SetAccessControl($file,$acl); $changed++}
  $checked++
}
Write-Output "Real package files checked: $checked; ACLs updated: $changed; directory links not followed."
