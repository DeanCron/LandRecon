<#
.SYNOPSIS
  Build airport-noise.pmtiles from the local CONUS aviation noise dataset.

.DESCRIPTION
  Convenience wrapper around scripts/build-noise.Dockerfile + build_noise_pmtiles.py.
  Builds (or reuses) the landrecon-noise-builder image, then runs the pipeline
  with the source rasters mounted read-only and a host build directory mounted
  read-write for output.

.PARAMETER SrcDir
  Directory containing per-state GeoTIFFs. Defaults to the COG output for the
  2020 CONUS aviation noise dataset.

.PARAMETER OutFile
  Final PMTiles path on the host. Defaults to ./build/airport-noise.pmtiles.

.PARAMETER Rebuild
  Force a rebuild of the Docker image even if it already exists.

.PARAMETER KeepIntermediates
  Keep per-state and merged FlatGeobuf files in the work directory.

.EXAMPLE
  ./scripts/build-noise.ps1
#>
[CmdletBinding()]
param(
    [string]$SrcDir = "C:\Temp\CONUS_aviation_noise_2020\COG",
    [string]$OutFile = "",
    [switch]$Rebuild,
    [switch]$KeepIntermediates
)

$ErrorActionPreference = "Stop"

if ($PSScriptRoot) {
    $ScriptDir = $PSScriptRoot
} else {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$BuildDir = Join-Path $RepoRoot "build"
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

if ([string]::IsNullOrWhiteSpace($OutFile)) {
    $OutFile = Join-Path $BuildDir "airport-noise.pmtiles"
}

$HostOutDir = Split-Path -Parent $OutFile
if ([string]::IsNullOrWhiteSpace($HostOutDir)) {
    $HostOutDir = $BuildDir
    $OutFile = Join-Path $HostOutDir (Split-Path -Leaf $OutFile)
}
New-Item -ItemType Directory -Force -Path $HostOutDir | Out-Null
$HostOutDir = (Resolve-Path -LiteralPath $HostOutDir).Path
$OutFile = Join-Path $HostOutDir (Split-Path -Leaf $OutFile)

$Image = "landrecon-noise-builder"
$existing = docker image ls --format "{{.Repository}}" | Where-Object { $_ -eq $Image }
if ($Rebuild -or -not $existing) {
    Write-Host "Building Docker image $Image ..." -ForegroundColor Cyan
    docker build -f (Join-Path $ScriptDir "build-noise.Dockerfile") -t $Image $ScriptDir
    if ($LASTEXITCODE -ne 0) { throw "docker build failed" }
}

if (-not (Test-Path $SrcDir)) {
    throw "Source directory not found: $SrcDir"
}
$SrcDir = (Resolve-Path -LiteralPath $SrcDir).Path

$ContainerOut = "/work/" + (Split-Path -Leaf $OutFile)

Write-Host "Source : $SrcDir"     -ForegroundColor Cyan
Write-Host "Output : $OutFile"    -ForegroundColor Cyan

$dockerArgs = @(
    "run", "--rm",
    "-v", "${SrcDir}:/src:ro",
    "-v", "${HostOutDir}:/work",
    $Image,
    "--src-dir", "/src",
    "--work-dir", "/work",
    "--out", $ContainerOut
)
if ($KeepIntermediates) { $dockerArgs += "--keep-intermediates" }

& docker @dockerArgs
if ($LASTEXITCODE -ne 0) { throw "noise build failed" }

Write-Host "Done. PMTiles: $OutFile" -ForegroundColor Green
