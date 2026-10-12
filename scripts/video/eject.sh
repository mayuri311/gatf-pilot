#!/usr/bin/env bash
# Stop recording, checkpoint the index, sync, and unmount the SSD safely.
#
# The common way to lose data here is not a crash — it is unplugging while the
# recorder still holds an open fd, or while SQLite's WAL has not been folded back
# into the .db. This script closes both holes and refuses to proceed if anything
# still has the drive open.
#
# Usage:  scripts/video/eject.sh <drive_uuid> [--force]
set -euo pipefail

UUID="${1:-}"
FORCE="${2:-}"
if [[ -z "$UUID" ]]; then
    echo "usage: $0 <drive_uuid> [--force]" >&2
    echo "  find it with: lsblk -o NAME,UUID,LABEL,MOUNTPOINT" >&2
    exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OS="$(uname -s)"

# --- resolve the mountpoint from the UUID -----------------------------------
if [[ "$OS" == "Linux" ]]; then
    DEV="$(readlink -f "/dev/disk/by-uuid/$UUID" 2>/dev/null || true)"
    if [[ -z "$DEV" || ! -b "$DEV" ]]; then
        echo "ERROR: no attached device with UUID $UUID" >&2
        exit 1
    fi
    MOUNT="$(findmnt -no TARGET --source "$DEV" | head -n1 || true)"
else
    MOUNT="$(python3 -c "
import plistlib, subprocess, sys
p = subprocess.run(['diskutil','info','-plist',sys.argv[1]], capture_output=True)
print(plistlib.loads(p.stdout).get('MountPoint','') if p.returncode == 0 else '')
" "$UUID")"
    DEV=""
fi

if [[ -z "$MOUNT" ]]; then
    echo "Device with UUID $UUID is not mounted — nothing to eject."
    exit 0
fi

GATF="$MOUNT/gatf"
DB="$GATF/index/segments.db"
PIDFILE="$GATF/logs/recorder.pid"
echo "Drive $UUID mounted at $MOUNT"

# --- 1. stop the recorder gracefully (EOS -> final moov atom written) --------
if [[ -f "$PIDFILE" ]]; then
    PID="$(cat "$PIDFILE")"
    if kill -0 "$PID" 2>/dev/null; then
        echo "Stopping recorder (pid $PID) and waiting for the last segment to close..."
        kill -TERM "$PID"
        for _ in $(seq 1 30); do
            kill -0 "$PID" 2>/dev/null || break
            sleep 1
        done
        if kill -0 "$PID" 2>/dev/null; then
            echo "ERROR: recorder pid $PID did not exit within 30s." >&2
            echo "       Its last segment would be truncated. Investigate before unplugging." >&2
            exit 1
        fi
        echo "Recorder stopped cleanly."
    else
        echo "Stale pid file (pid $PID not running) — removing."
        rm -f "$PIDFILE"
    fi
else
    echo "No recorder pid file; assuming nothing is recording."
fi

# --- 2. checkpoint the WAL + integrity check --------------------------------
if [[ -f "$DB" ]]; then
    if command -v sqlite3 >/dev/null 2>&1; then
        echo "Checkpointing index..."
        RESULT="$(sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA integrity_check;" | tail -n1)"
    else
        RESULT="$(python3 -c "
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
print(c.execute('PRAGMA integrity_check').fetchone()[0])
" "$DB")"
    fi
    if [[ "$RESULT" != "ok" ]]; then
        echo "ERROR: segments.db integrity_check returned: $RESULT" >&2
        [[ "$FORCE" != "--force" ]] && exit 1
    fi
    echo "Index integrity: ok"

    # --- 3. refresh the portable CSV mirror ---------------------------------
    ( cd "$REPO_ROOT" && python3 -m scripts.video.recorder --export-csv ) || \
        echo "WARN: CSV export failed (index is still intact)" >&2
else
    echo "WARN: no index at $DB" >&2
fi

# --- 4. flush the page cache to the device ----------------------------------
echo "Syncing..."
sync
[[ "$OS" == "Linux" && -n "$DEV" ]] && sync -f "$MOUNT" 2>/dev/null || true

# --- 5. refuse to unmount if anything still holds the drive open -------------
HOLDERS=""
if command -v lsof >/dev/null 2>&1; then
    HOLDERS="$(lsof +D "$MOUNT" 2>/dev/null | tail -n +2 || true)"
elif command -v fuser >/dev/null 2>&1; then
    HOLDERS="$(fuser -m "$MOUNT" 2>&1 || true)"
fi
if [[ -n "$HOLDERS" && "$FORCE" != "--force" ]]; then
    echo "ERROR: processes still have $MOUNT open:" >&2
    echo "$HOLDERS" | head -n 20 >&2
    echo "Close them (or re-run with --force) before unplugging." >&2
    exit 1
fi

# --- 6. unmount and power down ----------------------------------------------
echo "Unmounting..."
if [[ "$OS" == "Linux" ]]; then
    if command -v udisksctl >/dev/null 2>&1; then
        udisksctl unmount -b "$DEV"
        udisksctl power-off -b "$DEV" 2>/dev/null || \
            echo "(power-off not supported for this device; unmount succeeded)"
    else
        umount "$MOUNT"
    fi
else
    diskutil unmountDisk "$(diskutil info -plist "$UUID" | python3 -c "
import plistlib,sys; print(plistlib.load(sys.stdin.buffer)['ParentWholeDisk'])")"
fi

echo
echo "SAFE TO UNPLUG"
