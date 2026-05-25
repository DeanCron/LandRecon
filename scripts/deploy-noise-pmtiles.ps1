<#
.SYNOPSIS
    Uploads airport-noise.pmtiles to an Azure Blob Storage container with
    CORS, byte-range, and cache headers wired up for static tile serving.

.DESCRIPTION
    Performs four idempotent steps:

      1. Ensure the target container exists with anonymous blob read access.
      2. Set CORS on the storage account so the browser PMTiles client can
         issue cross-origin GETs with `Range` headers.
      3. Upload the PMTiles file with the proper Content-Type and
         Cache-Control headers (overwrite on each run).
      4. Print the public HTTPS URL to use as VITE_NOISE_PMTILES_URL.

    Requires the Azure CLI (`az`) to be installed and `az login` already
    completed.

.PARAMETER StorageAccount
    Storage account name (no dots, lowercase, 3-24 chars).

.PARAMETER Container
    Blob container name. Created if missing.

.PARAMETER File
    Path to the local PMTiles file to upload.

.PARAMETER BlobName
    Optional name to use for the uploaded blob. Defaults to the file name.

.PARAMETER AllowedOrigins
    CORS allowed origins, comma-separated. Use `*` for public access.
    Tighten this once a production domain is known.

.EXAMPLE
    .\deploy-noise-pmtiles.ps1 -StorageAccount landreconstorage `
        -Container tiles -File ..\build\airport-noise.pmtiles
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$StorageAccount,
    [string]$Container = 'tiles',
    [string]$File,
    [string]$BlobName,
    [string]$AllowedOrigins = '*'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI not found. Install from https://aka.ms/installazurecli and run 'az login'."
}

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $File) {
    $File = Join-Path (Split-Path -Parent $scriptDir) 'build\airport-noise.pmtiles'
}
$File = (Resolve-Path $File).Path
if (-not (Test-Path $File)) { throw "PMTiles file not found: $File" }

if (-not $BlobName) { $BlobName = [System.IO.Path]::GetFileName($File) }

Write-Host "Uploading $File" -ForegroundColor Cyan
Write-Host "  -> storage account: $StorageAccount"
Write-Host "  -> container      : $Container"
Write-Host "  -> blob name      : $BlobName"
Write-Host "  -> allowed origins: $AllowedOrigins"
Write-Host ""

# 1. Ensure the container exists with anonymous read access on blobs only.
#    Block-level public access lets the PMTiles client read directly without
#    SAS tokens. The container is not listable (anon access = `blob`, not
#    `container`), so the archive URL has to be known/guessed by name.
Write-Host "[1/4] Ensuring container '$Container' exists..." -ForegroundColor Yellow
az storage container create `
    --name $Container `
    --account-name $StorageAccount `
    --public-access blob `
    --auth-mode login `
    --only-show-errors | Out-Null

# 2. Configure CORS at the storage-account (blob service) level. PMTiles is
#    fetched with Range requests, so the browser must be allowed to send
#    `Range` and to read `Content-Range` / `Content-Length` back.
Write-Host "[2/4] Applying CORS rule for blob service..." -ForegroundColor Yellow
$origins = ($AllowedOrigins -split ',') | ForEach-Object { $_.Trim() }
az storage cors clear --services b --account-name $StorageAccount --auth-mode login --only-show-errors | Out-Null
az storage cors add `
    --services b `
    --methods GET HEAD OPTIONS `
    --origins @origins `
    --allowed-headers 'Range' 'If-None-Match' 'If-Range' 'If-Modified-Since' 'Content-Type' `
    --exposed-headers 'Content-Length' 'Content-Range' 'Content-Type' 'ETag' 'Last-Modified' 'Accept-Ranges' `
    --max-age 3600 `
    --account-name $StorageAccount `
    --auth-mode login `
    --only-show-errors | Out-Null

# 3. Upload (overwrite). The PMTiles client treats the archive as opaque
#    bytes, so Content-Type is mostly documentation. Cache-Control trades off
#    update propagation latency vs CDN/browser cache hit rate.
#    `must-revalidate` keeps stale caches honest if the upstream file moves.
Write-Host "[3/4] Uploading blob..." -ForegroundColor Yellow
az storage blob upload `
    --account-name $StorageAccount `
    --auth-mode login `
    --container-name $Container `
    --file $File `
    --name $BlobName `
    --content-type 'application/vnd.pmtiles' `
    --content-cache-control 'public, max-age=86400, must-revalidate' `
    --overwrite `
    --only-show-errors | Out-Null

# 4. Print the URL. Use this as VITE_NOISE_PMTILES_URL in production builds.
Write-Host "[4/4] Done." -ForegroundColor Green
$url = "https://$StorageAccount.blob.core.windows.net/$Container/$BlobName"
Write-Host ""
Write-Host "PMTiles URL:" -ForegroundColor Cyan
Write-Host "  $url"
Write-Host ""
Write-Host "Set this on the production build:" -ForegroundColor Cyan
Write-Host "  VITE_NOISE_PMTILES_URL=$url"
