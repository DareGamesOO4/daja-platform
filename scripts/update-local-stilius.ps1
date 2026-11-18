#Requires -Version 5.1
[CmdletBinding()]
param([switch]$StudioOnly)

$ErrorActionPreference = 'Stop'
$taskName = 'DAJA Local Image Worker'
$systemDir = Join-Path $env:ProgramData 'DajaImageWorker'
$userDir = Join-Path $env:LOCALAPPDATA 'DAJA\ImageWorker'
$studio = Join-Path $userDir 'DAJA Studio.exe'
$newStudio = Join-Path $PSScriptRoot 'DAJA Studio.exe'
$newProgram = Join-Path $PSScriptRoot 'worker.mjs'
$browserLibrary = Join-Path $PSScriptRoot 'node_modules\playwright-core'

if (!(Test-Path -LiteralPath $studio -PathType Leaf)) {
    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DAJA Studio.lnk'
    if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
        $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
        if ((Split-Path -Leaf $shortcut.TargetPath) -ieq 'DAJA Studio.exe') { $studio = $shortcut.TargetPath }
    }
}

function Update-DajaStudio([switch]$ShowWindow) {
    if (!(Test-Path -LiteralPath $newStudio -PathType Leaf) -or !(Test-Path -LiteralPath $studio -PathType Leaf)) {
        throw 'Nedostaje DAJA Studio.exe u paketu ili postojecoj instalaciji.'
    }
    $replace = [IO.Path]::GetFullPath($newStudio) -ine [IO.Path]::GetFullPath($studio)
    $suffix = [guid]::NewGuid().ToString('N')
    $stagedStudio = "$studio.$suffix.new"
    $backupStudio = "$studio.$suffix.bak"
    if ($replace) { Copy-Item -LiteralPath $newStudio -Destination $stagedStudio }
    $tray = @(Get-CimInstance Win32_Process -Filter "Name='DAJA Studio.exe'" | Where-Object {
        $_.ExecutablePath -ieq $studio -and $_.CommandLine -notmatch '(?:^|\s)--run-worker(?:\s|$)'
    })
    $tray | ForEach-Object {
        Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        Wait-Process -Id $_.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
    $launch = @{ FilePath=$studio; WorkingDirectory=(Split-Path -Parent $studio) }
    if (!$ShowWindow) {
        $launch.ArgumentList = '--background'
        $launch.WindowStyle = 'Hidden'
    }
    try {
        if ($replace) {
            for ($attempt = 1; $attempt -le 5; $attempt++) {
                try {
                    [IO.File]::Replace($stagedStudio, $studio, $backupStudio, $true)
                    break
                } catch [IO.IOException] {
                    if ($attempt -eq 5) { throw }
                    Start-Sleep -Milliseconds 400
                }
            }
        }
        Start-Process @launch
    } catch {
        if (Test-Path -LiteralPath $backupStudio -PathType Leaf) {
            [IO.File]::Replace($backupStudio, $studio, $null, $true)
        }
        if ($tray.Count -gt 0) { Start-Process @launch -ErrorAction SilentlyContinue }
        throw
    } finally {
        Remove-Item -LiteralPath $stagedStudio -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $backupStudio -ErrorAction SilentlyContinue
}

if ($StudioOnly) {
    Update-DajaStudio -ShowWindow
    Write-Host 'DAJA Studio je azuriran i otvoren.'
    return
}

$systemInstall = (Test-Path -LiteralPath (Join-Path $systemDir 'status') -PathType Container -ErrorAction SilentlyContinue) -or
    (Test-Path -LiteralPath (Join-Path $systemDir 'worker.json') -PathType Leaf -ErrorAction SilentlyContinue)
if ($systemInstall) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Ovaj worker radi kao sistemski zadatak. Desni klik na Instaliraj Stilius.cmd pa Run as administrator.'
    }
    Get-ScheduledTask -TaskName $taskName | Out-Null
}
$destination = if ($systemInstall) { $systemDir } else { $userDir }
$configName = if ($systemInstall) { 'worker.json' } else { 'worker-user.json' }
$configPath = Join-Path $destination $configName
$program = Join-Path $destination 'worker.mjs'

if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'DAJA Studio nije instaliran. Za prvu instalaciju pogledaj PROCITAJ.md u paketu.'
}
if (!(Test-Path -LiteralPath $program -PathType Leaf) -or
    !(Test-Path -LiteralPath $newProgram -PathType Leaf) -or
    !(Test-Path -LiteralPath $browserLibrary -PathType Container)) {
    throw 'Raspakuj ceo DAJA paket u poseban folder pa ponovo pokreni instalaciju.'
}
if ([IO.Path]::GetFullPath($newProgram) -ieq [IO.Path]::GetFullPath($program)) {
    throw 'Pokreni instalaciju iz posebno raspakovanog foldera.'
}

if (!$systemInstall -and !(Test-Path -LiteralPath $studio -PathType Leaf)) {
    throw 'U postojecom DAJA Studio folderu nedostaje DAJA Studio.exe.'
}

$nodeRuntime = Join-Path $destination 'runtime'
if (!$systemInstall -and (Test-Path -LiteralPath (Join-Path $nodeRuntime 'node.exe'))) {
    $env:Path = $nodeRuntime + ';' + $env:Path
}
if (!$systemInstall -and !(Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Potreban je Node.js 22.12 ili noviji.'
}

$originalConfig = [IO.File]::ReadAllText($configPath)
$config = $originalConfig | ConvertFrom-Json
$config | Add-Member -NotePropertyName checkStilius -NotePropertyValue $true -Force
$originalProgram = [IO.File]::ReadAllBytes($program)
$utf8 = [Text.UTF8Encoding]::new($false)

function Start-DajaWorker {
    if ($systemInstall) { Start-ScheduledTask -TaskName $taskName }
    else { Start-Process -FilePath $studio -ArgumentList '--run-worker' -WorkingDirectory $destination -WindowStyle Hidden }
}

if ($systemInstall) {
    Stop-ScheduledTask -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 300
    }
    if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') { throw 'DAJA worker se jos uvek zaustavlja.' }
} else {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='DAJA Studio.exe' OR Name='node.exe'")
    $launchers = @($processes | Where-Object { $_.ExecutablePath -ieq $studio -and $_.CommandLine -match '(?i)(?:^|\s)--run-worker(?:\s|$)' })
    $workers = @($processes | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and
        ($_.ParentProcessId -in $launchers.ProcessId -or $_.CommandLine.Contains('"' + $program + '"')) })
    $launchers + $workers | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
}

try {
    $modules = Join-Path $destination 'node_modules'
    New-Item -ItemType Directory -Path $modules -Force | Out-Null
    Copy-Item -LiteralPath $browserLibrary -Destination $modules -Recurse -Force
    Copy-Item -LiteralPath $newProgram -Destination $program -Force
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 12), $utf8)
    if (Test-Path -LiteralPath $studio -PathType Leaf) { Update-DajaStudio }
    Start-DajaWorker
} catch {
    [IO.File]::WriteAllBytes($program, $originalProgram)
    [IO.File]::WriteAllText($configPath, $originalConfig, $utf8)
    Start-DajaWorker
    throw
}
Write-Host 'Stilius je ukljucen. DAJA worker je pokrenut sa postojecim podesavanjima.'
