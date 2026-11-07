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
    node .\node_modules\esbuild\bin\esbuild scripts/local-image-worker.ts --bundle --platform=node --format=esm --external:sharp --alias:@daja/security=./packages/security/src/index.ts --outfile=$program
    if ($LASTEXITCODE -ne 0) { throw 'Pakovanje workera nije uspelo.' }

    foreach ($dependency in @('sharp', '@img/colour', '@img/sharp-win32-x64', 'detect-libc', 'semver')) {
        $source = Join-Path $repo "node_modules/$dependency"
        $destination = Join-Path $stage "node_modules/$dependency"
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Recurse
    }

    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-local-image-worker.ps1') -Destination $stage
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'local-image-worker.md') -Destination (Join-Path $stage 'PROCITAJ.md')
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force
} finally {
    Pop-Location
    $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
    $resolvedRoot = (Resolve-Path -LiteralPath $temporaryRoot).Path.TrimEnd('\') + '\'
    if ($resolvedStage.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
