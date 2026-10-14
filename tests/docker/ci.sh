#!/bin/sh
# Runs inside a job-private DinD daemon. No host socket, production daemon or registry push.
# A job-private volume is mounted at its daemon path in the test runner: generated bind mount
# sources are then visible to BOTH the runner and DinD (ordinary job paths are not).
# Archive binds below the daemon root require rslave; only this CI runner opts in.
set -eu
prefix="unifi-archive-ci-${CI_JOB_ID:?}"
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
docker create --name "$runner" --network host \
  -e DOCKER_HOST=tcp://127.0.0.1:2375 -e RUN_DOCKER_E2E=1 -e REQUIRE_DOCKER_SECURITY=1 \
  -e DOCKER_TEST_ARCHIVE_PROPAGATION=rslave \
  -v "$volume:$workspace" -w "$workspace" "$image" \
  sh -ec 'npm ci --no-audit --no-fund; npx playwright install --with-deps chromium; npm run test:docker' >/dev/null
docker cp . "$runner:$workspace"
set +e
docker start -a "$runner" > .cache/docker-ci.log 2>&1
result=$?
set -e
cat .cache/docker-ci.log
docker cp "$runner:$workspace/.cache/docker-e2e-results" .cache/docker-browser-results 2>/dev/null || true
exit "$result"
