#!/bin/sh
# Uiable installer.
#
#   sudo ./install.sh                     # install / update from this folder
#   sudo ./install.sh --port 9090         # different port
#   sudo ./install.sh --bind 0.0.0.0      # listen on all interfaces (NOT recommended, see README)
#   sudo ./install.sh --uninstall         # stop and remove the container (keeps data volume)
#
# One-liner from a hosted tarball (set UIABLE_URL to wherever you host uiable.zip / .tar.gz):
#   curl -fsSL https://example.com/uiable/install.sh | sudo UIABLE_URL=https://example.com/uiable.tar.gz sh
#
# Installs Docker (via get.docker.com) if it is missing, copies the app to /opt/uiable and
# runs `docker compose up -d --build`.
set -eu

INSTALL_DIR="${UIABLE_DIR:-/opt/uiable}"
PORT="${UIABLE_PORT:-8080}"
BIND="${UIABLE_BIND:-127.0.0.1}"
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --bind) BIND="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then exec sudo -E sh "$0" "$@"; fi
  die "Please run as root (sudo ./install.sh)."
fi

case "$PORT" in ''|*[!0-9]*) die "--port must be a number" ;; esac

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@";
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@";
  else die "Docker Compose is not available. Install the docker-compose-plugin package."; fi
}

if [ "$UNINSTALL" = 1 ]; then
  [ -f "$INSTALL_DIR/docker-compose.yml" ] || die "Nothing installed in $INSTALL_DIR"
  cd "$INSTALL_DIR" && compose down
  say "Uiable stopped and removed. Data volume kept (remove with: docker volume rm uiable-data)."
  exit 0
fi

# ------------------------------------------------------------------ Docker
# Umbrel OS (and similar) already ship a working Docker. Never reinstall over it.
IS_UMBREL=0
if [ -f /etc/umbrel-release ] || [ -d /home/umbrel/umbrel ] || [ -d /umbrel ] || grep -qi umbrel /etc/os-release 2>/dev/null; then
  IS_UMBREL=1
  say "Umbrel OS detected - will use the existing Docker"
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  say "Docker is already running - skipping install"
elif command -v docker >/dev/null 2>&1; then
  say "Docker is installed but not running - starting it"
  (systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || rc-service docker start 2>/dev/null) || true
  sleep 2
  docker info >/dev/null 2>&1 || die "Docker is installed but not running."
elif [ "$IS_UMBREL" = 1 ]; then
  die "Umbrel was detected but Docker is not available. Start Umbrel's Docker first, then re-run this installer."
else
  say "Docker not found - installing it with get.docker.com"
  if command -v curl >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh
  elif command -v wget >/dev/null 2>&1; then wget -qO- https://get.docker.com | sh
  else die "Need curl or wget to install Docker."; fi
  (systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || rc-service docker start 2>/dev/null) || true
  sleep 2
  docker info >/dev/null 2>&1 || die "Docker installed but not running."
fi
if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  say "Installing the Docker Compose plugin"
  (apt-get install -y docker-compose-plugin || dnf install -y docker-compose-plugin || yum install -y docker-compose-plugin || apk add docker-cli-compose) >/dev/null 2>&1 || true
fi

# ------------------------------------------------------------------ app files
SRC_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /nonexistent)"
mkdir -p "$INSTALL_DIR"
if [ -f "$SRC_DIR/docker-compose.yml" ] && [ -d "$SRC_DIR/server" ]; then
  if [ "$SRC_DIR" != "$(cd "$INSTALL_DIR" && pwd)" ]; then
    say "Copying Uiable to $INSTALL_DIR"
    tar -C "$SRC_DIR" --exclude=node_modules --exclude=data --exclude=.git -cf - . | tar -C "$INSTALL_DIR" -xf -
  fi
elif [ -n "${UIABLE_URL:-}" ]; then
  say "Downloading Uiable from $UIABLE_URL"
  TMP="$(mktemp -d)"
  case "$UIABLE_URL" in
    *.zip)
      curl -fsSL "$UIABLE_URL" -o "$TMP/u.zip"
      mkdir -p "$TMP/x"
      if command -v unzip >/dev/null 2>&1; then unzip -q "$TMP/u.zip" -d "$TMP/x"
      elif command -v busybox >/dev/null 2>&1 && busybox unzip -h >/dev/null 2>&1; then busybox unzip -q "$TMP/u.zip" -d "$TMP/x"
      elif command -v python3 >/dev/null 2>&1; then python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/u.zip" "$TMP/x"
      else die "Need unzip, busybox unzip, or python3 to extract a .zip (or use a .tar.gz URL instead)."; fi
      ;;
    *) mkdir -p "$TMP/x" && curl -fsSL "$UIABLE_URL" | tar -xz -C "$TMP/x" ;;
  esac
  D="$(dirname "$(find "$TMP/x" -name docker-compose.yml | head -n1)")"
  [ -d "$D/server" ] || die "Downloaded archive does not look like Uiable"
  tar -C "$D" --exclude=node_modules -cf - . | tar -C "$INSTALL_DIR" -xf -
  rm -rf "$TMP"
else
  die "Run this script from the Uiable folder, or set UIABLE_URL to a Uiable archive."
fi

cd "$INSTALL_DIR"
DOCKER_ROOT="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
printf 'UIABLE_PORT=%s\nUIABLE_BIND=%s\nUIABLE_DOCKER_VOLUMES=%s/volumes\n' "$PORT" "$BIND" "$DOCKER_ROOT" > .env

# Data lives in the fixed-name volume "uiable-data". Older releases used a
# project-scoped name (<folder>_uiable-data). If the fixed volume does not exist
# yet but an old one does, copy it across now (the old volume is left untouched).
if ! docker volume inspect uiable-data >/dev/null 2>&1; then
  OLD="$(docker volume ls -q | grep -E '^[A-Za-z0-9._-]+_uiable-data$' | head -n1 || true)"
  if [ -n "$OLD" ]; then
    say "Migrating dashboard data from old volume $OLD to uiable-data"
    docker volume create uiable-data >/dev/null
    docker run --rm -v "$OLD":/from:ro -v uiable-data:/to busybox sh -c 'cp -a /from/. /to/' \
      || say "Copy failed; Uiable will also try to migrate automatically on first start."
  fi
fi

say "Building and starting Uiable (first build takes a few minutes)"
compose up -d --build

say "Waiting for Uiable to answer"
i=0
CHECK_HOST="$BIND"; [ "$BIND" = "0.0.0.0" ] || [ "$BIND" = "::" ] && CHECK_HOST=127.0.0.1
until (command -v curl >/dev/null && curl -fs "http://$CHECK_HOST:$PORT/api/state" >/dev/null) || (command -v wget >/dev/null && wget -qO- "http://$CHECK_HOST:$PORT/api/state" >/dev/null 2>&1); do
  i=$((i + 1)); [ $i -gt 30 ] && { echo; say "Still starting - check logs with: cd $INSTALL_DIR && docker compose logs -f"; break; }
  sleep 2
done

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<MSG

  Uiable is running on $BIND:$PORT on this server.

  From your own computer, open an SSH tunnel:
      ssh -L $PORT:localhost:$PORT ${SUDO_USER:-$(id -un)}@${HOST_IP:-your-server}
  then browse to:
      http://localhost:$PORT
  The first visit asks you to create the admin account.

  Manage:  cd $INSTALL_DIR && docker compose logs -f | restart | down
MSG
