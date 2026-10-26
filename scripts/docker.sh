#!/bin/sh
# Runs a command in the development image, in this folder, as you (so the
# files it makes are yours): ./scripts/docker.sh npm run package
# Without a command: a shell. The image is (re)built when the Dockerfile changes.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
image=vs-code-cmake-helper-dev
docker build -q -t "$image" "$root" >/dev/null
tty=; [ -t 0 ] && tty=-it
exec docker run --rm $tty -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$root:/workspace" -w /workspace "$image" "${@:-bash}"
