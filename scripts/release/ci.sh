#!/bin/sh
# Job-private DinD only; test/build tooling has no Docker socket or privileged mode.
set -eu
operation="${1:?Use build, compliance or publish}"
case "$operation" in build|compliance|publish) ;; *) exit 2 ;; esac
# Release jobs run only for a protected version tag (v1.0.0, v1.0.1 or their -rc.N), independent of the
# CI rules; the version is always taken from that tag.
tag="${CI_COMMIT_TAG:-}"
{ [ "$tag" = v1.0.0 ] || [ "$tag" = v1.0.1 ] || expr "x$tag" : 'xv1\.0\.[01]-rc\.[1-9][0-9]*$' >/dev/null; } && [ "${CI_COMMIT_REF_PROTECTED:-}" = true ] \
  || { echo "Release jobs run only for a protected v1.0.0, v1.0.1 or matching -rc.N tag." >&2; exit 2; }
prefix="unifi-release-ci-${CI_JOB_ID:?}"
runner="${prefix}-runner"
volume="${prefix}-workspace"
image="${prefix}-tools"
cleanup() {
  docker rm -f "$runner" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker build -f tests/docker/Dockerfile.ci -t "$image" .
docker volume create "$volume" >/dev/null
workspace=$(docker volume inspect --format '{{.Mountpoint}}' "$volume")
# Large archives travel through this project's private Generic Package Registry, not job artifacts
# (scripts/release/transfer.mts). Only this short-lived container sees CI_JOB_TOKEN.
transfer() {
  docker run --rm --network host -v "$volume:$workspace" -w "$workspace" \
    -e CI_SERVER_URL -e CI_PROJECT_ID -e CI_JOB_ID -e CI_JOB_TOKEN \
    "$image" node scripts/release/transfer.mts "$@"
}
if [ "$operation" = build ]; then
  candidate_version="${tag#v}"
  case "${NATIVE_SOURCE_DIRECTORY:-}" in /*|../*|*/../*) echo "Native sources must be a reviewed directory inside the CI workspace." >&2; exit 2 ;; esac
  docker create --name "$runner" --network host \
    -e DOCKER_HOST=tcp://127.0.0.1:2375 -e RELEASE_VERSION="$candidate_version" \
    -e PUBLIC_SOURCE_REVISION -e PUBLIC_SOURCE_DOWNLOAD_URL \
    -e DOCKER_TEST_ARCHIVE_PROPAGATION=rslave -e RUN_DOCKER_E2E=1 -e REQUIRE_DOCKER_SECURITY=1 \
    -v "$volume:$workspace" -w "$workspace" "$image" sh -ec '
      npm ci --no-audit --no-fund
      node scripts/release/build.mts
      npx playwright install --with-deps chromium
      export DOCKER_TEST_IMAGE="unifi-protect-archive-ui:$RELEASE_VERSION"
      export DOCKER_TEST_RESULT_FILE="$PWD/.cache/release/validation.json"
      npm run test:docker
    ' >/dev/null
elif [ "$operation" = compliance ]; then
  docker create --name "$runner" --network host \
    -e DOCKER_HOST=tcp://127.0.0.1:2375 -e RELEASE_OUTPUT=.cache/release \
    -e NATIVE_SOURCE_INPUT_URL -e NATIVE_SOURCE_INPUT_SHA256 -e CI_SERVER_URL -e CI_PROJECT_ID -e CI_JOB_TOKEN \
    -e NATIVE_SOURCE_DIRECTORY=.cache/native-input/source -e NATIVE_BUNDLE_DIRECTORY=.cache/native-bundle \
    -e NATIVE_EXTRACTION_EVIDENCE=.cache/native-input/source/source-extraction.json \
    -e NATIVE_SIGNATURE_EVIDENCE=.cache/native-input/source/dsc-signatures.json \
    -v "$volume:$workspace" -w "$workspace" "$image" sh -ec '
      node scripts/release/fetch-native-input.mts
      node scripts/release/load-image.mts .cache/release
      node scripts/release/source.mts restore .cache/release
      node scripts/release/native-bundle.mts
      node scripts/release/validate-native.mts
    ' >/dev/null
else
  docker create --name "$runner" --network host \
    -e DOCKER_HOST=tcp://127.0.0.1:2375 -e CI_COMMIT_REF_PROTECTED -e CI_COMMIT_TAG -e CI_JOB_MANUAL \
    -e GHCR_APPROVED_IMAGE_ID -e GHCR_USERNAME -e GHCR_TOKEN -e NATIVE_SOURCE_DOWNLOAD_URL \
    -v "$volume:$workspace" -w "$workspace" "$image" node scripts/release/publish.mts >/dev/null
fi
docker cp . "$runner:$workspace"
mkdir -p .cache/release
# Fetch the exact archives earlier jobs produced; each is checked against its ledger SHA-256.
case "$operation" in
  compliance) transfer download image.tar.gz .cache/release ;;
  publish) transfer download image.tar.gz .cache/release && transfer download native-source.tar.gz .cache/release ;;
esac
set +e
docker start -a "$runner" > ".cache/release/$operation.log" 2>&1
result=$?
set -e
# Hand the produced archive on only after the job's own checks passed.
if [ "$result" -eq 0 ]; then
  case "$operation" in
    build) transfer upload .cache/release/image.tar.gz || result=$? ;;
    compliance) transfer upload .cache/release/native-source.tar.gz || result=$? ;;
  esac
fi
docker cp "$runner:$workspace/.cache/release/." .cache/release/ 2>/dev/null || true
cat ".cache/release/$operation.log"
exit "$result"
