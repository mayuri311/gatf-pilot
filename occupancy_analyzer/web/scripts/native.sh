#!/bin/sh
# Run a command natively on Apple Silicon even when the calling shell is under Rosetta
# (e.g. an Intel Anaconda terminal). Native deps (lightningcss, SWC, Tailwind oxide) are
# installed for arm64, so an x86_64 Node fails with "Cannot find module
# '../lightningcss.darwin-x64.node'". No-op on Intel Macs, Linux (Vercel) and native shells.
TARGET_ARCH="$(uname -m)"
PREFIX=""
if [ "$(uname -s)" = "Darwin" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
  TARGET_ARCH="arm64"
  PREFIX="arch -arm64"
fi

# Turbopack's persistent dev cache (.next/dev) remembers failed transforms. If it was
# written by a Node of another architecture, drop it once so the error is not replayed.
if [ "$1" = "next" ] && [ "$2" = "dev" ]; then
  MARKER=".next/dev/.native-arch"
  if [ -d .next/dev ] && [ "$(cat "$MARKER" 2>/dev/null)" != "$TARGET_ARCH" ]; then
    echo "[native] clearing .next/dev (built for another CPU architecture)"
    rm -rf .next/dev
  fi
  mkdir -p .next/dev && echo "$TARGET_ARCH" > "$MARKER"
fi

exec $PREFIX "$@"
