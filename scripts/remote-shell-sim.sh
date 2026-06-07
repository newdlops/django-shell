# Starts a local captain Django shell that mimics remote kubectl bootstrap behavior.
set -euo pipefail

target="${1:-alpha}"
if [[ "$target" == "alpha" || "$target" == "production" ]]; then
  shift || true
else
  printf 'Usage: bash scripts/remote-shell-sim.sh [alpha|production] [shell_plus args...]\n' >&2
  exit 2
fi

captain_root="${CAPTAIN_ROOT:-/Users/lky/project/captain}"
if [[ ! -x "$captain_root/zz" ]]; then
  printf 'CAPTAIN_ROOT does not contain an executable ./zz: %s\n' "$captain_root" >&2
  exit 2
fi

tmp_root="${TMPDIR:-/tmp}"
ipython_dir="$(mktemp -d "$tmp_root/django-shell-remote-sim.XXXXXX")"
startup_dir="$ipython_dir/profile_default/startup"
mkdir -p "$startup_dir"

cleanup() {
  rm -rf "$ipython_dir"
}
trap cleanup EXIT

cat > "$startup_dir/00-django-shell-remote-sim.py" <<'PY'
"""Make the extension's local backend file look absent inside this shell."""
import os

_djs_remote_sim_original_exists = os.path.exists

def _djs_remote_sim_exists(path):
    try:
        text = os.fspath(path)
    except TypeError:
        return _djs_remote_sim_original_exists(path)
    if text.endswith("/python/django_shell_backend.py"):
        return False
    return _djs_remote_sim_original_exists(path)

os.path.exists = _djs_remote_sim_exists
print("__DJANGO_SHELL_REMOTE_SIM_READY__")
PY

export IPYTHONDIR="$ipython_dir"
export UV_ENV_FILE="${UV_ENV_FILE:-.env}"
export ZUZU_ENV="${ZUZU_ENV:-development}"
export DJANGO_SHELL_REMOTE_SIM_TARGET="$target"
unset DJANGO_SHELL_BACKEND_B64
unset DJANGO_SHELL_AUTOIMPORT_MODELS

printf 'Django Shell remote simulation: %s (ZUZU_ENV=%s, PTY/inline bootstrap path)\n' "$target" "$ZUZU_ENV"
cd "$captain_root"
./zz django shell "$@"
