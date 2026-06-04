<#
.SYNOPSIS
    Uploads server/data/broadband.db to Azure Blob Storage so the prod
    container can pull it on startup instead of baking a multi-GB SQLite
    file into the image.

.DESCRIPTION
    Modeled on deploy-noise-pmtiles.ps1. Performs four idempotent steps:

      1. Ensure the target container exists with anonymous blob read access.
      2. Set CORS on the blob service (not strictly needed for the
         container-side curl, but lets us debug from a browser too).
      3. Upload the .db file with the proper Content-Type and a short
         Cache-Control (the file refreshes monthly when the FCC issues a
         new BDC filing, so we don't want long browser/CDN cache life).
      4. Print the public HTTPS URL to wire into BROADBAND_DB_URL on the
         Container Apps environment.

    Requires the Azure CLI (`az`) and an authenticated session.

.PARAMETER StorageAccount
    Storage account name (defaults to landreconstorage to match the
    PMTiles deployment).

.PARAMETER Container
    Blob container name. Created if missing. Defaults to 'data'.

.PARAMETER File
    Path to the local broadband.db. Defaults to server/data/broadband.db
    relative to the repo root.

.PARAMETER BlobName
    Optional name to use for the uploaded blob. Defaults to broadband.db.

.PARAMETER AllowedOrigins
    CORS allowed origins, comma-separated. Use `*` for public access.

.EXAMPLE
    .\deploy-broadband-db.ps1
    # Uploads server/data/broadband.db to
    # https://landreconstorage.blob.core.windows.net/data/broadband.db
#>
[CmdletBinding()]
param(
    [string]$StorageAccount = 'landreconstorage',
    [string]$Container = 'data',
    [string]$File,
    [string]$BlobName = 'broadband.db',
    [string]$AllowedOrigins = '*'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI not found. Install from https://aka.ms/installazurecli and run 'az login'."
}

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $File) {
    $File = Join-Path (Split-Path -Parent $scriptDir) 'server\data\broadband.db'
}
$File = (Resolve-Path $File).Path
if (-not (Test-Path $File)) { throw "broadband.db not found: $File" }

$sizeMB = [int]((Get-Item $File).Length / 1MB)

Write-Host "Uploading $File ($sizeMB MB)" -ForegroundColor Cyan
Write-Host "  -> storage account: $StorageAccount"
Write-Host "  -> container      : $Container"
Write-Host "  -> blob name      : $BlobName"
Write-Host "  -> allowed origins: $AllowedOrigins"
Write-Host ""

$cs = az storage account show-connection-string `
    --name $StorageAccount `
    --query connectionString -o tsv 2>$null
if (-not $cs) {
    throw "Could not fetch connection string for storage account '$StorageAccount'. Check the name and your subscription context (`az account show`)."
}

# 1. Container with anonymous blob read.
Write-Host "[1/4] Ensuring container '$Container' exists..." -ForegroundColor Yellow
az storage container create `
    --name $Container `
    --connection-string $cs `
    --public-access blob `
    --only-show-errors | Out-Null

# 2. CORS — mostly for debugging from a browser; the production container
#    downloads with curl which doesn't enforce CORS.
Write-Host "[2/4] Applying CORS rule for blob service..." -ForegroundColor Yellow
$origins = ($AllowedOrigins -split ',') | ForEach-Object { $_.Trim() }
az storage cors add `
    --services b `
    --methods GET HEAD OPTIONS `
    --origins @origins `
    --allowed-headers 'Range' 'If-None-Match' 'If-Range' 'If-Modified-Since' 'Content-Type' `
    --exposed-headers 'Content-Length' 'Content-Range' 'Content-Type' 'ETag' 'Last-Modified' 'Accept-Ranges' `
    --max-age 3600 `
    --connection-string $cs `
    --only-show-errors | Out-Null

# 3. Upload. az storage blob upload handles multi-GB files by chunking
#    into block uploads automatically; the default block size (4 MB)
#    keeps memory bounded.
#
#    Cache-Control is 12h: short enough that the container picks up a
#    fresh DB within half a day of a new FCC filing, long enough that
#    repeated cold starts on the same DB don't re-download.
#
#    --max-connections=8 parallelizes block uploads — moves a 4 GB file
#    in 2-5 min on a fast residential uplink.
Write-Host "[3/4] Uploading blob (this can take several minutes for multi-GB files)..." -ForegroundColor Yellow
$uploadStart = Get-Date
az storage blob upload `
    --connection-string $cs `
    --container-name $Container `
    --file $File `
    --name $BlobName `
    --content-type 'application/x-sqlite3' `
    --content-cache-control 'public, max-age=43200, must-revalidate' `
    --max-connections 8 `
    --overwrite `
    --only-show-errors | Out-Null
$uploadElapsed = [int]((Get-Date) - $uploadStart).TotalSeconds
Write-Host "  uploaded in ${uploadElapsed}s" -ForegroundColor Gray

# 4. Print the URL.
Write-Host "[4/4] Done." -ForegroundColor Green
$url = "https://$StorageAccount.blob.core.windows.net/$Container/$BlobName"
Write-Host ""
Write-Host "Broadband DB URL:" -ForegroundColor Cyan
Write-Host "  $url"
Write-Host ""
Write-Host "Wire this up on the Container App:" -ForegroundColor Cyan
Write-Host "  az containerapp update -n <appName> -g <rg> --set-env-vars BROADBAND_DB_URL=$url"
