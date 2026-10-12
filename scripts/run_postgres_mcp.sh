#!/usr/bin/env bash
#
# Runs the postgres-mcp sidecar that the chat endpoint talks to.
#
# Reads DATABASE_URI from frontend/.env.local so the connection string (which
# contains the gatf_readonly password) never lands in shell history or in the
# process list of an interactive shell.
#
# Usage:
#   ./scripts/run_postgres_mcp.sh
#
# Leave it running in its own terminal; the Next.js route handler connects to it
# over SSE on localhost. Verify with:
#   curl -N http://localhost:8000/sse
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/frontend/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found." >&2
  echo "       cp frontend/.env.local.example frontend/.env.local and fill it in." >&2
  exit 1
fi

# Pull DATABASE_URI out without sourcing the whole file (avoids executing
# arbitrary shell if the env file ever picks up odd values).
# The `|| true` matters: under `set -o pipefail` a non-matching grep fails the
# whole pipeline and `set -e` would kill the script before the friendly error
# below ever prints.
DATABASE_URI="$(grep -E '^DATABASE_URI=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true)"

if [[ -z "${DATABASE_URI:-}" ]]; then
  echo "error: DATABASE_URI is not set in $ENV_FILE" >&2
  exit 1
fi

if [[ "$DATABASE_URI" == *"CHANGE_ME"* ]]; then
  echo "error: DATABASE_URI still contains a placeholder. Run scripts/readonly_role.sql" >&2
  echo "       first, then put the real gatf_readonly connection string in $ENV_FILE." >&2
  exit 1
fi

# Guard against pointing the sidecar at a privileged role. The whole read-only
# guarantee rests on connecting as gatf_readonly, so fail loudly rather than
# silently running the chat endpoint with write access.
if [[ "$DATABASE_URI" != *"gatf_readonly"* ]]; then
  echo "error: DATABASE_URI does not connect as 'gatf_readonly'." >&2
  echo "       The read-only guarantee depends on that role's grants - refusing to start." >&2
  echo "       Set GATF_MCP_ALLOW_ANY_ROLE=1 to override (not recommended)." >&2
  [[ "${GATF_MCP_ALLOW_ANY_ROLE:-}" == "1" ]] || exit 1
fi

SSE_HOST="${GATF_MCP_HOST:-localhost}"
SSE_PORT="${GATF_MCP_PORT:-8000}"

echo "starting postgres-mcp (restricted, sse) on ${SSE_HOST}:${SSE_PORT}"

# --access-mode=restricted    read-only transactions + pglast SQL parsing
# mcp[cli]<2                  postgres-mcp 0.3.0 imports mcp.server.fastmcp,
#                             which moved in mcp 2.0.0. Without this pin uvx
#                             resolves mcp 2.x and the server dies at import
#                             with ModuleNotFoundError.
exec env DATABASE_URI="$DATABASE_URI" \
  uvx --with 'mcp[cli]<2' postgres-mcp \
    --access-mode=restricted \
    --transport=sse \
    --sse-host="$SSE_HOST" \
    --sse-port="$SSE_PORT"
