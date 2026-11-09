#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][uri]$ApiBaseUrl, [switch]$CheckLinkel)

$ErrorActionPreference = 'Stop'
if ($ApiBaseUrl.Scheme -ne 'https' -or $ApiBaseUrl.UserInfo -or $ApiBaseUrl.Query -or $ApiBaseUrl.Fragment) {
    throw 'DAJA API mora da koristi HTTPS adresu.'
}

$taskName = 'DAJA Local Image Worker'
$installDir = Join-Path $env:ProgramData 'DajaImageWorker'
$node = (Get-Command node.exe -CommandType Application).Source
$program = Join-Path $PSScriptRoot 'worker.mjs'
$dependencies = Join-Path $PSScriptRoot 'node_modules'
if (!(Test-Path -LiteralPath $program -PathType Leaf) -or !(Test-Path -LiteralPath $dependencies -PathType Container)) {
    throw 'Pokreni instalaciju iz raspakovanog DAJA paketa.'
}
if ((Test-Path -LiteralPath $installDir) -or (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    throw 'DAJA worker je već instaliran ili postoji folder od prethodne instalacije.'
}

$secret = Read-Host 'Unesi ključ za DAJA worker' -AsSecureString
$token = [System.Net.NetworkCredential]::new('', $secret).Password
if ($token -cnotmatch '^[A-Za-z0-9._~-]{32,}$') {
    throw 'Ključ za DAJA worker nije ispravan.'
}

$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
foreach ($entry in @(
    @{ Sid = 'S-1-5-18'; Rights = 'FullControl' },
    @{ Sid = 'S-1-5-32-544'; Rights = 'FullControl' },
    @{ Sid = 'S-1-5-19'; Rights = 'ReadAndExecute' }
)) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($entry.Sid)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity, $entry.Rights, $inheritance, 'None', 'Allow'
    )
    $acl.AddAccessRule($rule)
}

New-Item -ItemType Directory -Path $installDir | Out-Null
Set-Acl -LiteralPath $installDir -AclObject $acl
Copy-Item -LiteralPath $program -Destination $installDir
Copy-Item -LiteralPath $dependencies -Destination $installDir -Recurse
$configPath = Join-Path $installDir 'worker.json'
@{ apiBaseUrl = $ApiBaseUrl.AbsoluteUri; token = $token; checkLinkel = $CheckLinkel.IsPresent } | ConvertTo-Json |
    Set-Content -LiteralPath $configPath -Encoding ASCII
$token = $null

$statusDir = Join-Path $installDir 'status'
New-Item -ItemType Directory -Path $statusDir | Out-Null
$statusAcl = Get-Acl -LiteralPath $statusDir
foreach ($entry in @(
    @{ Sid = 'S-1-5-19'; Rights = 'Modify' },
    @{ Sid = 'S-1-5-32-545'; Rights = 'ReadAndExecute' }
)) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($entry.Sid)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity, $entry.Rights, $inheritance, 'None', 'Allow'
    )
    $statusAcl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $statusDir -AclObject $statusAcl
$statusPath = Join-Path $statusDir 'worker-status.json'

$installedProgram = Join-Path $installDir 'worker.mjs'
$arguments = '"{0}" run "{1}" "{2}"' -f $installedProgram, $configPath, $statusPath
$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $installDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settingsOptions = @{
    ExecutionTimeLimit = [TimeSpan]::Zero
    MultipleInstances = 'IgnoreNew'
    RestartCount = 3
    RestartInterval = New-TimeSpan -Minutes 1
    AllowStartIfOnBatteries = $true
    DontStopIfGoingOnBatteries = $true
}
$settings = New-ScheduledTaskSettingsSet @settingsOptions
$serviceSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-19')
$service = $serviceSid.Translate([System.Security.Principal.NTAccount]).Value
$principal = New-ScheduledTaskPrincipal -UserId $service -LogonType ServiceAccount
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host 'DAJA worker je pokrenut i Windows će ga pokretati pri paljenju.'
