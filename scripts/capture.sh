#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="/Users/mayurimurugan/research26/IR/.camera_config"

# --- reset config if requested ---
if [[ "${1:-}" == "--reset-config" ]]; then
    rm -f "$CONFIG_FILE"
    echo "Config cleared. Run the script again to re-enter camera details."
    exit 0
fi

# --- load config, or prompt + save if it doesn't exist yet ---
if [[ -f "$CONFIG_FILE" ]]; then
    source "$CONFIG_FILE"
else
    echo "No config found at $CONFIG_FILE — let's set it up once."
    read -rp "Camera IP: " CAM_IP
    read -rp "Username: " CAM_USER
    read -rsp "Password: " CAM_PASS
    echo
    mkdir -p "$(dirname "$CONFIG_FILE")"
    cat > "$CONFIG_FILE" <<EOF
CAM_IP="$CAM_IP"
CAM_USER="$CAM_USER"
CAM_PASS="$CAM_PASS"
EOF
    chmod 600 "$CONFIG_FILE"
    echo "Saved to $CONFIG_FILE (readable only by you)."
fi

# --- settings ---
OUT_DIR="$HOME/research26/IR/camera_captures"
mkdir -p "$OUT_DIR"
DURATION="${1:-180}"   # seconds; pass as first arg, default 3 min
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUT_FILE="$OUT_DIR/capture_${TIMESTAMP}.mp4"
 
# --- URL-encode user/pass so special characters ($, %, @, etc.) don't break RTSP URL parsing ---
urlencode() {
    python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"
}
ENC_USER=$(urlencode "$CAM_USER")
ENC_PASS=$(urlencode "$CAM_PASS")
 
# H.264 stream, no codec-switch param — this camera's firmware doesn't reliably
# honor videocodec=jpeg on this profile, so we capture the native H.264 stream
# (lossless, no re-encode) and extract still frames locally afterward instead.
RTSP_URL="rtsp://${ENC_USER}:${ENC_PASS}@${CAM_IP}/axis-media/media.amp"
 
# --- reachability check before burning time on a dead connection ---
echo "Checking connectivity to $CAM_IP ..."
if ! ping -c 1 -t 2 "$CAM_IP" &>/dev/null && ! ping -c 1 -W 2 "$CAM_IP" &>/dev/null; then
    echo "ERROR: camera not reachable at $CAM_IP." >&2
    echo "Check: PoE injector/switch powered, cable seated, laptop IP in same subnet." >&2
    exit 1
fi
 
echo "Capturing ${DURATION}s -> $OUT_FILE"
ffmpeg -rtsp_transport tcp -i "$RTSP_URL" -t "$DURATION" -c copy "$OUT_FILE"
 
echo "Done: $OUT_FILE"
 