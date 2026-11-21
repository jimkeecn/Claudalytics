#!/usr/bin/env bash
# Claudalytics hook capture - SessionStart health check (runs synchronously).
# Prints nothing when the stack is healthy. Otherwise prints one JSON object with only
# systemMessage: the user sees it, and nothing is added to Claude's context.
# CLAUDALYTICS_CONTAINER_PREFIX picks the container names (default claudalytics),
# CLAUDALYTICS_HOOKS_URL picks the hooks server (default http://localhost:4319).
# It never holds up a session: one docker call runs in the background next to curl,
# and the script stops waiting for it after DOCKER_WAIT_MICROSECONDS (no `timeout` needed).

CONTAINER_PREFIX="${CLAUDALYTICS_CONTAINER_PREFIX:-claudalytics}"
DOCKER_CONTAINERS=("$CONTAINER_PREFIX-clickhouse" "$CONTAINER_PREFIX-otel" "$CONTAINER_PREFIX-grafana" "$CONTAINER_PREFIX-hooks")
HOOKS_SERVER_URL="${CLAUDALYTICS_HOOKS_URL:-http://localhost:4319}/health"
DOCKER_WAIT_MICROSECONDS=2500000

# Sets clock_now in microseconds. EPOCHREALTIME needs bash 5; older bash counts whole seconds.
read_clock() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    clock_now="${EPOCHREALTIME/[.,]/}"
  else
    clock_now=$((SECONDS * 1000000))
  fi
}

docker_healthy=true
hooks_healthy=true
docker_answered=true
down_containers=()

read_clock
docker_deadline=$((clock_now + DOCKER_WAIT_MICROSECONDS))
docker_output_file=$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/claudalytics-health-$$")
docker inspect -f '{{.Name}} {{.State.Running}}' "${DOCKER_CONTAINERS[@]}" </dev/null >"$docker_output_file" 2>/dev/null &
docker_pid=$!
disown "$docker_pid" 2>/dev/null

hooks_status=$(curl -sf --max-time 1 -o /dev/null -w "%{http_code}" "$HOOKS_SERVER_URL" 2>/dev/null)
if [ "$hooks_status" != "200" ]; then
  hooks_healthy=false
fi

while kill -0 "$docker_pid" 2>/dev/null; do
  read_clock
  [ "$clock_now" -ge "$docker_deadline" ] && break
  sleep 0.1
done

if kill -0 "$docker_pid" 2>/dev/null; then
  kill "$docker_pid" 2>/dev/null
  docker_healthy=false
  docker_answered=false
else
  for container in "${DOCKER_CONTAINERS[@]}"; do
    if ! grep -qx "/$container true" "$docker_output_file" 2>/dev/null; then
      docker_healthy=false
      down_containers+=("$container")
    fi
  done
fi
rm -f "$docker_output_file" 2>/dev/null

if [ "$docker_healthy" = true ] && [ "$hooks_healthy" = true ]; then
  exit 0
fi

escape_for_json() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

sysmsg="[claudalytics] WARNING: Monitoring services are NOT fully operational."
if [ "$docker_answered" = false ]; then
  sysmsg="$sysmsg Docker did not answer in time. Check that Docker is running."
elif [ "$docker_healthy" = false ]; then
  sysmsg="$sysmsg Containers down: ${down_containers[*]}. Run: docker compose up -d from Claudalytics/docker-stack."
fi
if [ "$hooks_healthy" = false ]; then
  sysmsg="$sysmsg Hooks server not responding at $HOOKS_SERVER_URL. Run: docker compose up -d from Claudalytics/docker-stack."
fi

printf '{"systemMessage": "%s"}\n' "$(escape_for_json "$sysmsg")"

exit 0
