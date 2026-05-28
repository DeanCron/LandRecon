#!/usr/bin/env bash
# One-time setup: persist Dev Todos across container restarts/redeploys.
#
# Creates a Standard_LRS storage account + Azure Files share, links it to
# the Container Apps environment, and patches the container app to mount
# it at /var/lib/landrecon (where the dev-todos sidecar writes its JSON).
#
# Idempotent — safe to re-run. The az containerapp update --yaml call
# only adjusts the volumes/volumeMounts blocks, leaving the rest of the
# spec (including the image tag set by your GitHub Actions deploy) alone.
#
# Usage (Azure Cloud Shell or local az):
#     bash scripts/setup-dev-todos-storage.sh
#
# Overrides via env vars: RG, APP, ENV_NAME, LOC, STORAGE_ACCT, SHARE,
# ENV_STORAGE_NAME, VOLUME_NAME, MOUNT_PATH.

set -euo pipefail

RG="${RG:-LandRecon-RG}"
APP="${APP:-landrecon}"
ENV_NAME="${ENV_NAME:-landrecon-env}"
LOC="${LOC:-eastus}"
# Storage account names: 3–24 chars, lowercase alphanumeric, globally unique.
STORAGE_ACCT="${STORAGE_ACCT:-landreconstate$(date +%s | tail -c 6)}"
SHARE="${SHARE:-landrecon-data}"
ENV_STORAGE_NAME="${ENV_STORAGE_NAME:-landrecon-data-storage}"
VOLUME_NAME="${VOLUME_NAME:-dev-todos-vol}"
MOUNT_PATH="${MOUNT_PATH:-/var/lib/landrecon}"

echo "Resource group:        $RG"
echo "Container app:         $APP"
echo "Env:                   $ENV_NAME"
echo "Location:              $LOC"
echo "Storage account:       $STORAGE_ACCT"
echo "File share:            $SHARE"
echo "Env storage name:      $ENV_STORAGE_NAME"
echo "Volume name:           $VOLUME_NAME"
echo "Mount path:            $MOUNT_PATH"
echo

if ! az account show -o none >/dev/null 2>&1; then
  echo "ERROR: az is not logged in. Run 'az login' first." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required (preinstalled in Azure Cloud Shell)." >&2
  exit 1
fi

echo "[1/5] Ensuring storage account '$STORAGE_ACCT' exists..."
if ! az storage account show -g "$RG" -n "$STORAGE_ACCT" -o none 2>/dev/null; then
  az storage account create \
    -g "$RG" -n "$STORAGE_ACCT" -l "$LOC" \
    --sku Standard_LRS --kind StorageV2 \
    --allow-shared-key-access true \
    -o none
else
  echo "       already exists, skipping create."
fi

echo "[2/5] Ensuring file share '$SHARE' exists..."
if ! az storage share-rm show \
       --resource-group "$RG" --storage-account "$STORAGE_ACCT" --name "$SHARE" -o none 2>/dev/null; then
  az storage share-rm create \
    --resource-group "$RG" --storage-account "$STORAGE_ACCT" \
    --name "$SHARE" --quota 1 -o none
else
  echo "       already exists, skipping create."
fi

echo "[3/5] Linking storage to Container Apps env as '$ENV_STORAGE_NAME'..."
KEY=$(az storage account keys list -g "$RG" -n "$STORAGE_ACCT" --query "[0].value" -o tsv)
az containerapp env storage set \
  --resource-group "$RG" --name "$ENV_NAME" \
  --storage-name "$ENV_STORAGE_NAME" \
  --azure-file-account-name "$STORAGE_ACCT" \
  --azure-file-account-key "$KEY" \
  --azure-file-share-name "$SHARE" \
  --access-mode ReadWrite -o none

echo "[4/5] Patching container app to mount $MOUNT_PATH..."
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
az containerapp show -n "$APP" -g "$RG" -o json > "$WORKDIR/app.json"

jq --arg vol "$VOLUME_NAME" --arg storage "$ENV_STORAGE_NAME" --arg mount "$MOUNT_PATH" '
  .properties.template.volumes =
    ((.properties.template.volumes // []) | map(select(.name != $vol))) + [{
      name: $vol,
      storageType: "AzureFile",
      storageName: $storage
    }] |
  .properties.template.containers[0].volumeMounts =
    ((.properties.template.containers[0].volumeMounts // []) | map(select(.volumeName != $vol))) + [{
      volumeName: $vol,
      mountPath: $mount
    }]
' "$WORKDIR/app.json" > "$WORKDIR/app.patched.json"

az containerapp update -n "$APP" -g "$RG" --yaml "$WORKDIR/app.patched.json" -o none

echo "[5/5] Done."
echo
echo "The container app now mounts '$SHARE' at $MOUNT_PATH via volume '$VOLUME_NAME'."
echo "The dev-todos sidecar writes its JSON to that mount, so the data now"
echo "survives container restarts and redeploys."
