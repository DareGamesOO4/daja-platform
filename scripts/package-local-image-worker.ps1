#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputFile)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$archive = [System.IO.Path]::GetFullPath($OutputFile)
if ([System.IO.Path]::GetExtension($archive) -ne '.zip') { throw 'Izlaz mora biti .zip fajl.' }
$temporaryRoot = Join-Path $repo 'tmp'
$stage = Join-Path $temporaryRoot ('local-image-worker-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Push-Location $repo
try {
    $program = Join-Path $stage 'worker.mjs'
    node .\node_modules\esbuild\bin\esbuild scripts/local-image-worker.ts --bundle --platform=node --format=esm --external:sharp --external:playwright-core --alias:@daja/security=./packages/security/src/index.ts --outfile=$program
    if ($LASTEXITCODE -ne 0) { throw 'Pakovanje workera nije uspelo.' }

    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $ui = Join-Path $stage 'DAJA Studio.exe'
    $uiSource = Join-Path $PSScriptRoot 'local-image-worker-ui.cs'
    & $compiler /nologo /target:winexe /optimize+ /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "/out:$ui" $uiSource
    if ($LASTEXITCODE -ne 0) { throw 'Pakovanje Windows prozora nije uspelo.' }

    foreach ($dependency in @('sharp', '@img/colour', '@img/sharp-win32-x64', 'detect-libc', 'semver', 'playwright-core')) {
        $source = Join-Path $repo "node_modules/$dependency"
        $destination = Join-Path $stage "node_modules/$dependency"
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Recurse
    }

    $node = Get-Command node.exe -CommandType Application | Select-Object -First 1
    $runtime = New-Item -ItemType Directory -Path (Join-Path $stage 'runtime')
    Copy-Item -LiteralPath $node.Source -Destination $runtime.FullName

    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-local-image-worker.ps1') -Destination $stage
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'restore-local-image-studio.ps1') -Destination $stage
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'update-local-stilius.ps1') -Destination $stage
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Instaliraj Stilius.cmd') -Destination $stage
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Instaliraj DAJA Studio.cmd') -Destination $stage
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'local-image-worker.md') -Destination (Join-Path $stage 'PROCITAJ.md')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'local-image-studio') -Destination (Join-Path $stage 'studio') -Recurse
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force
} finally {
    Pop-Location
    $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
    $resolvedRoot = (Resolve-Path -LiteralPath $temporaryRoot).Path.TrimEnd('\') + '\'
    if ($resolvedStage.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
