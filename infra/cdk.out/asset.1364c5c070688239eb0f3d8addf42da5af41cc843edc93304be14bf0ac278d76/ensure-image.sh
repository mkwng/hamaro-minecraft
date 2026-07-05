#!/usr/bin/env bash
# Guarantees the pinned itzg/minecraft-server tag exists in our private ECR.
# Docker Hub is only contacted the first time a new tag is pinned; after that,
# boots depend solely on ECR (no rate limits, no third-party availability).
set -euo pipefail
source /etc/hamaro/env

if aws ecr describe-images --repository-name "$MC_IMAGE_REPO" --image-ids "imageTag=${MC_IMAGE_TAG}" >/dev/null 2>&1; then
  exit 0
fi

echo "[ensure-image] ${MC_IMAGE_REPO}:${MC_IMAGE_TAG} not in ECR — mirroring from Docker Hub"
docker pull "docker.io/itzg/minecraft-server:${MC_IMAGE_TAG}"
aws ecr get-login-password | docker login --username AWS --password-stdin "$HAMARO_ECR" >/dev/null
docker tag "docker.io/itzg/minecraft-server:${MC_IMAGE_TAG}" "${HAMARO_ECR}/${MC_IMAGE_REPO}:${MC_IMAGE_TAG}"
docker push "${HAMARO_ECR}/${MC_IMAGE_REPO}:${MC_IMAGE_TAG}"
