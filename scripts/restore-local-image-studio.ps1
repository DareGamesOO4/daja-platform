#Requires -Version 5.1
[CmdletBinding()]
param([ValidateSet('Worker', 'Tray', 'Studio')][string]$Launch)

$ErrorActionPreference = 'Stop'
$studioName = 'DAJA Studio.exe'
$workerName = 'DAJA Image Worker Engine'
$trayName = 'DAJA Image Worker'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$powerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

if ($Launch) {
    $runtime = Join-Path $PSScriptRoot 'runtime'
    if (Test-Path -LiteralPath (Join-Path $runtime 'node.exe')) {
        $env:Path = $runtime + ';' + $env:Path
    }
    $options = @{
        FilePath = Join-Path $PSScriptRoot $studioName
        WorkingDirectory = $PSScriptRoot
    }
    if ($Launch -eq 'Worker') {
        $options.ArgumentList = '--run-worker'
        $options.WindowStyle = 'Hidden'
    }
    if ($Launch -eq 'Tray') { $options.ArgumentList = '--background' }
    Start-Process @options
    return
}

$required = @($studioName, 'worker.mjs', 'worker-user.json', 'node_modules', 'studio')
foreach ($name in $required) {
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $name))) {
        throw "DAJA backup nije kompletan. Nedostaje $name."
    }
}
if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime\node.exe')) -and
    !(Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Nedostaje Node.js za DAJA worker.'
}

$destination = Join-Path $env:LOCALAPPDATA 'DAJA\ImageWorker'
if (Test-Path -LiteralPath (Join-Path $env:ProgramData 'DajaImageWorker\worker.mjs')) {
    throw 'Prvo ukloni postojecu DAJA sistemsku instalaciju da bi radio samo jedan worker.'
}
if ($PSScriptRoot.TrimEnd('\') -ieq $destination) {
    throw 'Pokreni vracanje iz raspakovanog backup foldera.'
}
$studio = Join-Path $destination $studioName
$worker = Join-Path $destination 'worker.mjs'
$processes = Get-CimInstance Win32_Process -Filter "Name='DAJA Studio.exe' OR Name='DAJA Worker.exe' OR Name='node.exe'"
$launchers = @($processes | Where-Object {
    $_.ExecutablePath -in @($studio, (Join-Path $destination 'DAJA Worker.exe'))
})
$workers = @($processes | Where-Object {
    $_.Name -eq 'node.exe' -and ($_.ParentProcessId -in $launchers.ProcessId -or
        ($_.CommandLine -and $_.CommandLine.Contains('"' + $worker + '"')))
})
$launchers + $workers | ForEach-Object {
    Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($name in $required + @('runtime', 'worker-pause.json', 'Rezultati', 'PROCITAJ.md')) {
    $source = Join-Path $PSScriptRoot $name
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    }
}
$launcher = Join-Path $destination (Split-Path -Leaf $PSCommandPath)
Copy-Item -LiteralPath $PSCommandPath -Destination $launcher -Force
$launchArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Launch' -f $launcher
New-Item -Path $runKey -Force | Out-Null
foreach ($legacy in @('DAJA Image Worker Backup', 'DAJA Image Worker Process')) {
    Remove-ItemProperty -Path $runKey -Name $legacy -ErrorAction SilentlyContinue
}
Set-ItemProperty -Path $runKey -Name $workerName -Value ('"{0}" {1} Worker' -f $powerShell, $launchArgs)
Set-ItemProperty -Path $runKey -Name $trayName -Value ('"{0}" {1} Tray' -f $powerShell, $launchArgs)
$approved = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
foreach ($name in @($workerName, $trayName)) {
    Remove-ItemProperty -Path $approved -Name $name -ErrorAction SilentlyContinue
}

$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $desktop 'DAJA Studio.lnk'))
$shortcut.TargetPath = $powerShell
$shortcut.Arguments = "$launchArgs Studio"
$shortcut.WorkingDirectory = $destination
$shortcut.IconLocation = "$studio,0"
$shortcut.Save()

& $launcher -Launch Worker
& $launcher -Launch Tray
Write-Host 'DAJA Studio i worker su vraceni i pokrecu se pri prijavi u Windows.'
