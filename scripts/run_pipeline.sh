#!/usr/bin/env bash
# Start the whole edge pipeline on this Jetson, for both cameras:
#
#   per camera : recorder (10 s segments -> SSD)  +  plate reader (events -> SSD spool)
#   once       : clipper (±10 s clip per event)   +  spool uploader (-> Supabase)
#                + sysmetrics (CPU/GPU/net/SSD -> SSD + heartbeats)
#
# Every child is supervised: if one dies it's restarted with backoff, the rest
# keep running. Ctrl-C / SIGTERM shuts down in order, so nothing is cut short:
# plate readers first (they flush open tracks), then a short wait so the
# recorders capture the last events' post-roll, then the recorders (EOS ->
# playable MP4), a final clip pass, a final upload drain, and metrics last.
#
# Usage (from anywhere):
#   scripts/run_pipeline.sh --check              # preflight only
#   scripts/run_pipeline.sh                      # run until Ctrl-C
#   scripts/run_pipeline.sh --dry-run 300        # run 5 min, stop cleanly, print a summary
#   scripts/run_pipeline.sh --cameras in         # just the inbound camera (in|out|both)
#   scripts/run_pipeline.sh --no-upload          # spool locally, don't start the uploader
#
# Needs: SSD mounted at $MOUNT, scripts/video/recorder.config.json, repo-root .env
# (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CAM_IN_USER/PASS, CAM_OUT_USER/PASS),
# .venv (pip install --no-deps -r scripts/inductiverobo.txt), ffmpeg.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MOUNT="${GATF_MOUNT:-/mnt/validation}"
GATF="$MOUNT/gatf"
CAM_IFACE="${GATF_CAMERA_IFACE:-enP8p1s0}"
PY="$REPO_ROOT/.venv/bin/python"
POST_ROLL_WAIT_S=25        # clip post-roll (10 s) + one segment (10 s) + slack
STOP_TIMEOUT_S=45

# --- args --------------------------------------------------------------------
CHECK_ONLY=0
DRY_RUN=0
CAMERAS="both"
UPLOAD=1
while [[ $# -gt 0 ]]; do
    case "$1" in
        --check) CHECK_ONLY=1 ;;
        --dry-run) DRY_RUN="${2:?--dry-run needs seconds}"; shift ;;
        --cameras) CAMERAS="${2:?--cameras needs in|out|both}"; shift ;;
        --no-upload) UPLOAD=0 ;;
        -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
    shift
done

# --- secrets: repo-root .env, exported to every child --------------------------
if [[ -f "$REPO_ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$REPO_ROOT/.env"
    set +a
fi

# camera_id -> ip from recorder.config.json; direction from config/config.yaml
declare -A CAM_IP=()
while read -r cam ip; do CAM_IP[$cam]="$ip"; done < <(python3 -m scripts.video.config --list)
mapfile -t SELECTED < <(python3 - "$CAMERAS" <<'EOF'
import sys
from scripts.contract_v2 import load_config, config_cameras
want = sys.argv[1]
for c in config_cameras(load_config()):
    if want == "both" or c.get("direction") == want or c.get("camera_id") == want:
        print(c["camera_id"])
EOF
)
if [[ ${#SELECTED[@]} -eq 0 ]]; then
    echo "ERROR: --cameras $CAMERAS matches nothing in config/config.yaml" >&2
    exit 2
fi

# --- preflight -----------------------------------------------------------------
FAILS=0
ok()   { printf '  \033[32mOK\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILS=$((FAILS + 1)); }

preflight() {
    echo "Preflight (cameras: ${SELECTED[*]})"
    local uuid want_uuid
    want_uuid="$(python3 -m scripts.video.config --drive-uuid)"
    uuid="$(findmnt -no UUID --mountpoint "$MOUNT" 2>/dev/null || true)"
    if [[ "$uuid" == "$want_uuid" ]]; then
        ok "SSD $want_uuid mounted at $MOUNT ($(df -h --output=avail "$MOUNT" | tail -1 | tr -d ' ') free)"
        if mkdir -p "$GATF" 2>/dev/null && touch "$GATF/.write_test" 2>/dev/null; then
            rm -f "$GATF/.write_test"
            ok "SSD writable"
            if [[ ! -f "$GATF/drive.json" ]]; then
                python3 -m scripts.video.recorder --init-drive --label valid-a >/dev/null
                ok "initialised $GATF (drive.json, index, logs)"
            fi
        else
            fail "$MOUNT not writable by $USER - run: sudo chown -R $USER: $MOUNT"
        fi
    else
        fail "SSD $want_uuid is not mounted at $MOUNT${uuid:+ (found $uuid)} - run: sudo mount $MOUNT"
    fi

    if [[ -x "$PY" ]] && "$PY" -c "import cv2, fast_alpr, ultralytics, dotenv, psutil, gi" 2>/dev/null; then
        ok ".venv has the inference stack"
    else
        fail ".venv missing or incomplete - python3 -m venv --system-site-packages .venv && .venv/bin/pip install --no-deps -r scripts/inductiverobo.txt"
    fi
    # Build (first time only, a few minutes) or confirm the GPU detector engine here, so
    # the readers never stall on it at startup. Not fatal: they fall back to the CPU.
    local trt_out
    if [[ -x "$PY" ]] && trt_out="$("$PY" -W ignore scripts/trt_backend.py --build 2>&1)"; then
        ok "TensorRT detector engine ready - plate detection on the GPU"
    else
        warn "TensorRT unavailable - plate detection will run on the CPU ($(echo "${trt_out:-no venv}" | tail -1))"
    fi
    command -v ffmpeg >/dev/null && ok "ffmpeg $(ffmpeg -version | head -1 | cut -d' ' -f3)" \
        || fail "ffmpeg missing (clips need it) - sudo apt install ffmpeg"
    command -v gst-launch-1.0 >/dev/null && ok "gst-launch-1.0 (clip join)" \
        || fail "gst-launch-1.0 missing (clips need it) - sudo apt install gstreamer1.0-tools"

    if [[ $UPLOAD -eq 1 ]]; then
        [[ -n "${SUPABASE_URL:-}" && -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]] \
            && ok "Supabase credentials set (${SUPABASE_URL})" \
            || fail "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env (or pass --no-upload)"
    fi

    if [[ "$(cat "/sys/class/net/$CAM_IFACE/carrier" 2>/dev/null || echo 0)" == "1" ]]; then
        ok "$CAM_IFACE link up ($(ip -br -4 addr show "$CAM_IFACE" | awk '{print $3}'))"
    else
        fail "$CAM_IFACE has no link - is the PoE switch cabled and powered?"
    fi

    local cam ip dev
    for cam in "${SELECTED[@]}"; do
        ip="${CAM_IP[$cam]:-}"
        if [[ -z "$ip" ]]; then
            fail "$cam is in config.yaml but not in scripts/video/recorder.config.json"
            continue
        fi
        if ! python3 -m scripts.video.config --print-url "$cam" >/dev/null 2>&1; then
            fail "$cam: no credentials ($(python3 -m scripts.video.config --print-url "$cam" 2>&1 | sed 's/^error: //'))"
        fi
        dev="$(ip route get "$ip" 2>/dev/null | grep -o 'dev [^ ]*' | cut -d' ' -f2 || true)"
        [[ "$dev" == "$CAM_IFACE" ]] || warn "$cam $ip routes via ${dev:-nothing}, not $CAM_IFACE (add a /32 route)"
        if ping -c 1 -W 2 -I "$CAM_IFACE" "$ip" >/dev/null 2>&1; then
            ok "$cam reachable at $ip"
        else
            fail "$cam not answering ping at $ip on $CAM_IFACE"
        fi
    done

    local avail_mb
    avail_mb=$(( $(awk '/MemAvailable/ {print $2}' /proc/meminfo) / 1024 ))
    if (( avail_mb >= 2000 )); then ok "RAM available ${avail_mb} MB"
    else warn "only ${avail_mb} MB RAM available - close Firefox / update-manager before a two-camera run"; fi
    [[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" == "yes" ]] \
        && ok "system clock NTP-synchronized" \
        || warn "system clock not NTP-synchronized (event times and clip windows use it)"

    echo
    if (( FAILS > 0 )); then
        echo "$FAILS check(s) failed."
        return 1
    fi
    echo "All checks passed."
}

if ! preflight; then exit 1; fi
[[ $CHECK_ONLY -eq 1 ]] && exit 0

# --- supervision -----------------------------------------------------------------
LOGS="$GATF/logs"
SPOOL="$GATF/events"
STATE="$GATF/state"
mkdir -p "$LOGS" "$SPOOL" "$STATE"
RUN_MARK="$STATE/run-$(date -u +%Y%m%dT%H%M%SZ).start"
touch "$RUN_MARK"
echo $$ > "$LOGS/pipeline.pid"

declare -A CMD=() PID=() RESTARTS=() NEXT_START=()
ORDER=()
STOPPING=0

add_child() {   # add_child <name> <command...>
    local name="$1"; shift
    CMD[$name]="$(printf '%q ' "$@")"
    RESTARTS[$name]=0
    NEXT_START[$name]=0
    ORDER+=("$name")
}

start_child() {
    local name="$1"
    echo "=== $(date -u +%FT%TZ) start: ${CMD[$name]}" >> "$LOGS/$name.log"
    # shellcheck disable=SC2086
    eval "exec_child ${CMD[$name]}" >> "$LOGS/$name.log" 2>&1 &
    PID[$name]=$!
    echo "  started $name (pid ${PID[$name]}) -> $LOGS/$name.log"
}
# Each child gets its own session/process group, so a terminal Ctrl-C reaches only
# this script and the ordered shutdown below runs - instead of every child being
# interrupted at once (recorders would stop before the readers' post-roll).
# setsid doesn't fork here (we're not a group leader), so $! stays the child's pid.
exec_child() { exec setsid "$@"; }

stop_child() {  # stop_child <name> : SIGTERM, wait, SIGKILL as a last resort
    local name="$1" pid="${PID[$1]:-}"
    [[ -z "$pid" ]] && return 0
    if kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null || true
        for _ in $(seq 1 "$STOP_TIMEOUT_S"); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 1
        done
        if kill -0 "$pid" 2>/dev/null; then
            echo "  $name did not stop within ${STOP_TIMEOUT_S}s - killing"
            kill -KILL "$pid" 2>/dev/null || true
        fi
    fi
    wait "$pid" 2>/dev/null || true
    unset "PID[$name]"
    echo "  stopped $name"
}

supervise_once() {
    local name pid now delay
    now=$(date +%s)
    for name in "${ORDER[@]}"; do
        pid="${PID[$name]:-}"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then continue; fi
        if [[ -n "$pid" ]]; then
            wait "$pid" 2>/dev/null && rc=0 || rc=$?
            unset "PID[$name]"
            RESTARTS[$name]=$(( RESTARTS[$name] + 1 ))
            delay=$(( 2 ** (RESTARTS[$name] < 6 ? RESTARTS[$name] : 6) ))
            NEXT_START[$name]=$(( now + delay ))
            echo "  $(date +%T) $name exited (rc=$rc) - restart #${RESTARTS[$name]} in ${delay}s (tail $LOGS/$name.log)"
        fi
        if (( now >= NEXT_START[$name] )); then start_child "$name"; fi
    done
}

summary() {
    echo
    echo "=== Run summary (since $(basename "$RUN_MARK" .start | sed 's/^run-//')) ==="
    local cam n_ev n_rej n_clip n_up
    for cam in "${SELECTED[@]}"; do
        n_ev=$(find "$SPOOL/$cam" -mindepth 1 -maxdepth 1 -type d -newer "$RUN_MARK" 2>/dev/null | wc -l)
        n_rej=$(find "$SPOOL/${cam}_rejected" -mindepth 1 -maxdepth 1 -type d -newer "$RUN_MARK" 2>/dev/null | wc -l)
        n_clip=$(find "$SPOOL/$cam" "$SPOOL/${cam}_rejected" -name clip.json -newer "$RUN_MARK" 2>/dev/null | wc -l)
        n_up=$(find "$SPOOL/$cam" -name .uploaded -newer "$RUN_MARK" 2>/dev/null | wc -l)
        printf '  %-18s events %-4s rejected %-4s clips %-4s uploaded %s\n' "$cam" "$n_ev" "$n_rej" "$n_clip" "$n_up"
    done
    python3 - "$GATF/index/segments.db" "$(date -u -r "$RUN_MARK" +%FT%T)" <<'EOF' || true
import sqlite3, sys
db, since = sys.argv[1], sys.argv[2]
c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
for cam, n, secs, gb in c.execute(
        "SELECT camera_id, count(*), round(sum(duration_s)), round(sum(size_bytes)/1e9, 3)"
        " FROM segments WHERE start_utc >= ? GROUP BY camera_id", (since,)):
    print(f"  {cam:<18} segments {n:<5} {secs:.0f} s recorded, {gb} GB")
EOF
    local partial
    partial=$(grep -l '"status": "\(partial\|no_footage\|error\)"' $(find "$SPOOL" -name clip.json -newer "$RUN_MARK" 2>/dev/null) /dev/null 2>/dev/null | wc -l)
    (( partial > 0 )) && echo "  $partial clip(s) partial / no footage - see clip.json in those event folders"
    [[ -f "$STATE/uploader.json" ]] && echo "  uploader: $(python3 -c "import json,sys; s=json.load(open(sys.argv[1])); print(f\"backlog {s.get('backlog')}, last error: {s.get('last_error') or 'none'}\")" "$STATE/uploader.json")"
    echo "  logs: $LOGS   clips: $GATF/clips"
}

shutdown() {
    (( STOPPING )) && { echo "Second interrupt - killing everything now."; kill -KILL "${PID[@]}" 2>/dev/null; exit 130; }
    STOPPING=1
    trap 'shutdown' INT TERM
    echo
    echo "Stopping (Ctrl-C again to force)..."
    stop_parallel reader
    echo "  waiting ${POST_ROLL_WAIT_S}s so the recorders capture the last events' post-roll..."
    sleep "$POST_ROLL_WAIT_S"
    stop_parallel recorder
    stop_child clipper
    "$PY" -m scripts.video.clipper --once --max-wait 0 >> "$LOGS/clipper.log" 2>&1 || true
    if [[ -n "${PID[uploader]:-}" ]]; then
        echo "  letting the uploader drain (up to 60 s)..."
        for _ in $(seq 1 30); do
            [[ "$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('backlog'))" "$STATE/uploader.json" 2>/dev/null)" == "0" ]] && break
            sleep 2
        done
        stop_child uploader
    fi
    stop_child metrics
    rm -f "$LOGS/pipeline.pid"
    summary
    exit 0
}
# Stop <kind>-<camera> for every camera at once (each camera's own timeout runs in
# parallel). Waits only on those stoppers - never on the children still running.
stop_parallel() {
    local kind="$1" cam stoppers=()
    for cam in "${SELECTED[@]}"; do
        stop_child "$kind-$cam" &
        stoppers+=($!)
    done
    wait "${stoppers[@]}" 2>/dev/null || true
    for cam in "${SELECTED[@]}"; do unset "PID[$kind-$cam]"; done
}

# --- children ----------------------------------------------------------------------
for cam in "${SELECTED[@]}"; do
    var="RTSP_${cam^^}"
    export "$var=$(python3 -m scripts.video.config --print-url "$cam" --inference)"
    add_child "recorder-$cam" "$PY" -m scripts.video.recorder --camera "$cam"
    add_child "reader-$cam" "$PY" scripts/plate_ocr_reader.py --camera-id "$cam" \
        --source-env "$var" --headless --no-upload \
        --events-dir "$SPOOL/$cam" --metrics-path "$STATE/metrics_latest.json"
done
add_child clipper "$PY" -m scripts.video.clipper
[[ $UPLOAD -eq 1 ]] && add_child uploader nice -n 10 ionice -c3 "$PY" scripts/spool_uploader.py --spool "$SPOOL"
add_child metrics "$PY" scripts/sysmetrics.py --gatf "$GATF" --camera-iface "$CAM_IFACE"

trap 'shutdown' INT TERM
echo
echo "Starting pipeline$( (( DRY_RUN > 0 )) && echo " (dry run, ${DRY_RUN}s)")  -  live metrics: $PY scripts/sysmetrics.py --watch"
START=$(date +%s)
while true; do
    supervise_once
    if (( DRY_RUN > 0 && $(date +%s) - START >= DRY_RUN )); then
        echo "Dry run time reached."
        shutdown
    fi
    sleep 2 &
    wait $! || true
done
