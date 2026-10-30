#!/bin/sh
# InboxJoy installer: runs InboxJoy on one Linux server with Docker.
#
#   curl -fsSL https://raw.githubusercontent.com/inboxjoy/inboxjoy/main/deploy/install.sh | sudo sh
#
# What it does: checks the server, installs Docker if you agree, asks for your
# domain and an admin email, creates /opt/inboxjoy with fresh secrets, starts
# InboxJoy with automatic HTTPS, and prints the link to open (it carries a
# one-time setup token, so only you can create the first account). Running it
# again is safe: it keeps your existing settings, secrets and token, and only
# refreshes the stack files. It never changes the installed version; use
# `inboxjoy upgrade` for that.
#
# Questions can be answered up front with environment variables (for scripted
# installs). Nothing is asked when they are all set:
#   INBOXJOY_DOMAIN           domain name, for example inboxjoy.example.com
#   INBOXJOY_EMAIL            admin email (certificate notices)
#   INBOXJOY_VERSION          release to install, for example 1.2.3 or v1.2.3 (default: latest release)
#   INBOXJOY_INSTALL_DOCKER   yes or no: install Docker if it is missing
#   INBOXJOY_SWAP             yes or no: add a 2 GB swap file on a small server
#   INBOXJOY_FORCE            yes: carry on despite a failed requirement check
#   MAIL_SMTP_URL, MAIL_FROM, MAIL_REPLY_TO   system email (optional)
#   AI_API_KEY, AI_MODEL, AI_BASE_URL         AI drafting (optional)
#   INBOXJOY_DIR              install folder (default /opt/inboxjoy)
#   INBOXJOY_REPO             GitHub repository (default inboxjoy/inboxjoy)
#   INBOXJOY_NONINTERACTIVE   1: never ask questions
#
# Everything lives inside main() so a download that stops halfway runs nothing.

set -eu

INBOXJOY_DIR="${INBOXJOY_DIR:-/opt/inboxjoy}"
INBOXJOY_REPO="${INBOXJOY_REPO:-inboxjoy/inboxjoy}"
RAW_BASE="${INBOXJOY_RAW_BASE:-https://raw.githubusercontent.com/$INBOXJOY_REPO}"
API_BASE="${INBOXJOY_API_BASE:-https://api.github.com/repos/$INBOXJOY_REPO}"
BIN_DIR="${INBOXJOY_BIN_DIR:-/usr/local/bin}"

if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; RED="$(printf '\033[31m')"; YELLOW="$(printf '\033[33m')"; GREEN="$(printf '\033[32m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; RED=""; YELLOW=""; GREEN=""; RESET=""
fi

say() { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok() { printf '%s%s%s\n' "$GREEN" "$*" "$RESET"; }
warn() { printf '%s%s%s\n' "$YELLOW" "$*" "$RESET" >&2; }
die() { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Questions. They read from the terminal, because stdin is the script itself
# when it arrives through `curl | sh`.
# ---------------------------------------------------------------------------

can_ask() {
  [ "${INBOXJOY_NONINTERACTIVE:-}" != "1" ] && ( : </dev/tty ) 2>/dev/null
}

# prompt "Question" "default" -> REPLY
prompt() {
  if can_ask; then
    if [ -n "${2:-}" ]; then printf '%s [%s]: ' "$1" "$2" >/dev/tty; else printf '%s: ' "$1" >/dev/tty; fi
    IFS= read -r REPLY </dev/tty || REPLY=""
    [ -n "$REPLY" ] || REPLY="${2:-}"
  else
    REPLY="${2:-}"
  fi
}

# prompt_secret "Question" -> REPLY (not shown while typing)
prompt_secret() {
  if can_ask; then
    printf '%s: ' "$1" >/dev/tty
    stty -echo </dev/tty 2>/dev/null || true
    IFS= read -r REPLY </dev/tty || REPLY=""
    stty echo </dev/tty 2>/dev/null || true
    printf '\n' >/dev/tty
  else
    REPLY=""
  fi
}

# confirm "Question" default(y|n) ENV_VAR -> 0 for yes. The environment
# variable (yes/no) answers without asking; with no terminal the default is no.
confirm() {
  eval "_preset=\${$3:-}"
  case "$_preset" in
    yes|YES|y|Y|1|true) return 0 ;;
    no|NO|n|N|0|false) return 1 ;;
  esac
  can_ask || return 1
  if [ "$2" = "y" ]; then _hint="Y/n"; else _hint="y/N"; fi
  printf '%s [%s]: ' "$1" "$_hint" >/dev/tty
  IFS= read -r _answer </dev/tty || _answer=""
  case "${_answer:-$2}" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------------------
# Small tools
# ---------------------------------------------------------------------------

rand_hex() { # bytes
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

rand_base64_32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n'
  fi
}

# env_set FILE KEY VALUE: fill in "KEY=" (or an uncommented "#KEY=") in the
# template, or add the line at the end. The value never touches a command line.
env_set() {
  _tmp="$1.tmp.$$"
  ( umask 077; KEY="$2" VAL="$3" awk '
      BEGIN { done = 0; k = ENVIRON["KEY"]; v = ENVIRON["VAL"] }
      !done && (index($0, k "=") == 1 || index($0, "#" k "=") == 1) { print k "=" v; done = 1; next }
      { print }
      END { if (!done) print k "=" v }
    ' "$1" > "$_tmp" )
  mv -f "$_tmp" "$1"
}

env_get() { # FILE KEY
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1 | sed "s/^['\"]//; s/['\"]\$//"
}

fetch() { # url dest
  curl -fsSL --retry 3 --retry-delay 2 --max-time 120 -o "$2" "$1" && [ -s "$2" ]
}

compose_version_ok() {
  _v="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
  [ -n "$_v" ] || return 1
  _major="${_v%%.*}"; _rest="${_v#*.}"; _minor="${_rest%%.*}"
  case "$_major$_minor" in *[!0-9]*) return 1 ;; esac
  [ "$_major" -gt 2 ] || { [ "$_major" -eq 2 ] && [ "$_minor" -ge 20 ]; }
}

# docker compose with the release pinned to VERSION. Compose lets a variable in
# the caller's shell win over .env, so a stray INBOXJOY_VERSION (for example
# "v1.2.3", or a newer version asked for on a re-run) would otherwise pull a
# different release than the one this installer recorded in .env. Stdin is
# closed so a command can never swallow input meant for something else.
dc() { INBOXJOY_VERSION="$VERSION" docker compose "$@" </dev/null; }

wait_healthy() { # service seconds
  _svc="$1"; _limit="$2"; _waited=0
  while [ "$_waited" -lt "$_limit" ]; do
    _ids="$(dc ps -q "$_svc" 2>/dev/null || true)"
    if [ -n "$_ids" ]; then
      _all=1
      for _id in $_ids; do
        _state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$_id" 2>/dev/null </dev/null || echo unknown)"
        case "$_state" in
          healthy|running) ;;
          unhealthy|exited|dead) return 1 ;;
          *) _all=0 ;;
        esac
      done
      [ "$_all" -eq 1 ] && return 0
    fi
    sleep 2
    _waited=$((_waited + 2))
  done
  return 1
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

check_system() {
  [ "$(uname -s)" = "Linux" ] || die "This installer is for Linux servers (Ubuntu or Debian recommended). On other systems, follow docs/self-hosting/README.md."

  if [ "$(id -u)" -ne 0 ]; then
    die "Run the installer as root: curl -fsSL $RAW_BASE/main/deploy/install.sh | sudo sh"
  fi

  case "$(uname -m)" in
    x86_64|amd64|aarch64|arm64) ;;
    *) die "Unsupported CPU type $(uname -m). InboxJoy images exist for amd64 and arm64." ;;
  esac

  command -v curl >/dev/null 2>&1 || die "curl is required. Install it first: apt-get update && apt-get install -y curl"

  _os_release="${INBOXJOY_OS_RELEASE:-/etc/os-release}"
  _distro="$( . "$_os_release" 2>/dev/null; printf '%s %s' "${ID:-linux}" "${ID_LIKE:-}" )" || _distro="linux"
  case "$_distro" in
    *ubuntu*|*debian*) ;;
    *) warn "This looks like $_distro. The installer is tested on Ubuntu and Debian; other Linux systems with Docker usually work too." ;;
  esac

  [ "${INBOXJOY_SKIP_CHECKS:-}" = "1" ] && return 0

  _meminfo="${INBOXJOY_MEMINFO:-/proc/meminfo}"
  MEM_KB="$(awk '/^MemTotal:/ { print $2 }' "$_meminfo" 2>/dev/null || echo 0)"
  SWAP_KB="$(awk '/^SwapTotal:/ { print $2 }' "$_meminfo" 2>/dev/null || echo 0)"
  MEM_KB="${MEM_KB:-0}"; SWAP_KB="${SWAP_KB:-0}"
  if [ "$MEM_KB" -gt 0 ] && [ "$MEM_KB" -lt 1700000 ]; then
    warn "This server has $((MEM_KB / 1024)) MB of memory. InboxJoy needs 2 GB (a 1 GB server will run out of memory)."
    confirm "Install anyway?" n INBOXJOY_FORCE || die "Stopped. Use a server with at least 2 GB of memory, or set INBOXJOY_FORCE=yes."
  fi

  _parent="$(dirname "$INBOXJOY_DIR")"
  [ -d "$_parent" ] || _parent="/"
  _free_kb="$(df -Pk "$_parent" 2>/dev/null | awk 'NR == 2 { print $4 }')"
  # Only on a first install: a running stack has already used up its share.
  if [ ! -f "$INBOXJOY_DIR/.env" ] && [ -n "${_free_kb:-}" ] && [ "$_free_kb" -lt 5000000 ]; then
    warn "Only $((_free_kb / 1024 / 1024)) GB of disk space is free. InboxJoy needs about 5 GB for images and data."
    confirm "Install anyway?" n INBOXJOY_FORCE || die "Stopped. Free up disk space, or set INBOXJOY_FORCE=yes."
  fi

  # A re-run finds our own web server on ports 80 and 443; anything else there is a conflict.
  if command -v ss >/dev/null 2>&1 && ! ( command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null </dev/null | grep -q '^inboxjoy-caddy-' ); then
    for _port in 80 443; do
      if ss -ltn 2>/dev/null | awk '{ print $4 }' | grep -Eq "[:.]${_port}\$"; then
        warn "Port $_port is already in use by another program (a web server such as nginx or Apache?)."
        confirm "Install anyway? (InboxJoy's HTTPS will not start until the port is free)" n INBOXJOY_FORCE || die "Stopped. Stop the program using port $_port, then run the installer again."
      fi
    done
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    compose_version_ok || die "Docker Compose is too old ($(docker compose version --short 2>/dev/null)). Update Docker (version 2.20 or newer of the Compose plugin) and run the installer again."
    return 0
  fi

  if command -v docker >/dev/null 2>&1; then
    say "Docker is installed, but its Compose plugin is missing."
  else
    say "Docker is not installed on this server."
  fi
  say "The installer can set it up with Docker's official script (https://get.docker.com)."
  confirm "Install Docker now?" y INBOXJOY_INSTALL_DOCKER \
    || die "Docker is required. Install it (https://docs.docker.com/engine/install/) and run this installer again, or set INBOXJOY_INSTALL_DOCKER=yes."
  step "Installing Docker"
  curl -fsSL https://get.docker.com | sh || die "Docker's installer failed. Install Docker by hand (https://docs.docker.com/engine/install/) and run this installer again."
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  docker compose version >/dev/null 2>&1 || die "Docker is installed but the Compose plugin is missing. Install docker-compose-plugin and run this installer again."
  compose_version_ok || die "Docker Compose is too old. Update the Compose plugin to 2.20 or newer and run this installer again."
}

# A swap file lets a 2 GB server ride out short memory spikes (migrations,
# image pulls) instead of killing a service.
offer_swap() {
  [ "${INBOXJOY_SKIP_CHECKS:-}" = "1" ] && return 0
  [ "${MEM_KB:-0}" -gt 0 ] && [ "${MEM_KB:-0}" -lt 2621440 ] && [ "${SWAP_KB:-0}" -eq 0 ] || return 0
  [ ! -e /swapfile ] || return 0
  confirm "This server has little memory and no swap. Add a 2 GB swap file so it does not run out of memory?" y INBOXJOY_SWAP || return 0
  step "Adding a 2 GB swap file"
  if { fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 2>/dev/null; } \
    && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab 2>/dev/null || printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
    ok "Swap file ready."
  else
    rm -f /swapfile
    warn "Could not create the swap file. Continuing without it."
  fi
}

normalize_domain() {
  printf '%s' "$1" | tr 'A-Z' 'a-z' | sed 's#^[a-z]*://##; s#/.*$##; s#:[0-9]*$##; s#\.$##'
}

valid_domain() {
  case "$1" in
    *.*) ;;
    *) return 1 ;;
  esac
  # Not an IP address: HTTPS certificates need a real name.
  case "$1" in
    *[!0-9.]*) ;;
    *) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
}

valid_email() {
  printf '%s' "$1" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
}

ask_settings() {
  DOMAIN="$(normalize_domain "${INBOXJOY_DOMAIN:-}")"
  while ! valid_domain "$DOMAIN"; do
    [ -z "$DOMAIN" ] || warn "\"$DOMAIN\" is not a usable domain name."
    can_ask || die "Set INBOXJOY_DOMAIN to your domain name (for example inboxjoy.example.com)."
    say ""
    say "Which domain will InboxJoy run on? Its DNS A record must point at this server."
    prompt "Domain (for example inboxjoy.example.com)" ""
    DOMAIN="$(normalize_domain "$REPLY")"
  done

  ADMIN_EMAIL="${INBOXJOY_EMAIL:-}"
  while ! valid_email "$ADMIN_EMAIL"; do
    [ -z "$ADMIN_EMAIL" ] || warn "\"$ADMIN_EMAIL\" is not a valid email address."
    can_ask || die "Set INBOXJOY_EMAIL to your email address."
    say ""
    say "Your email address is used by Let's Encrypt for certificate notices."
    prompt "Admin email" ""
    ADMIN_EMAIL="$REPLY"
  done

  SMTP_URL="${MAIL_SMTP_URL:-}"
  SMTP_FROM="${MAIL_FROM:-}"
  if [ -z "$SMTP_URL" ] && can_ask; then
    say ""
    say "InboxJoy sends its own emails (password resets, invitations, alerts) through an SMTP service"
    say "such as Resend, Postmark, Amazon SES or Mailgun (see docs/self-hosting/system-email.md)."
    say "Paste the SMTP URL now, for example smtps://user:password@smtp.example.com:465,"
    say "or press Enter to add it later in $INBOXJOY_DIR/.env."
    prompt_secret "SMTP URL (hidden, optional)"
    SMTP_URL="$REPLY"
  fi
  if [ -n "$SMTP_URL" ] && [ -z "$SMTP_FROM" ]; then
    prompt "Send system emails from" "noreply@$DOMAIN"
    SMTP_FROM="$REPLY"
  fi
}

write_env() {
  _env="$INBOXJOY_DIR/.env"
  if [ -f "$_env" ]; then
    ok "Found an existing configuration in $_env. Keeping it, including all secrets."
    DOMAIN="$(env_get "$_env" APP_DOMAIN)"
    env_set "$_env" INBOXJOY_VERSION "$VERSION"
    return 0
  fi

  ask_settings
  cp "$INBOXJOY_DIR/env.example" "$_env.new"
  chmod 600 "$_env.new"
  env_set "$_env.new" INBOXJOY_VERSION "$VERSION"
  env_set "$_env.new" APP_DOMAIN "$DOMAIN"
  env_set "$_env.new" ACME_EMAIL "$ADMIN_EMAIL"
  env_set "$_env.new" INBOXJOY_EDITION selfhost
  env_set "$_env.new" SIGNUP_MODE invite
  env_set "$_env.new" API_BASE_URL "https://$DOMAIN/api"
  env_set "$_env.new" WEB_BASE_URL "https://$DOMAIN"
  env_set "$_env.new" CORS_ORIGINS "https://$DOMAIN"
  env_set "$_env.new" BETTER_AUTH_URL "https://$DOMAIN/api"
  env_set "$_env.new" AUTH_SECRET "$(rand_hex 32)"
  env_set "$_env.new" POSTGRES_PASSWORD "$(rand_hex 24)"
  env_set "$_env.new" SMTP_MAILBOXES_ENABLED true
  env_set "$_env.new" MAILBOX_CREDENTIALS_KEY "$(rand_base64_32)"
  # One-time token for creating the first account (the owner). It is printed
  # once, in the setup link at the end, and nowhere else; a re-run keeps it.
  env_set "$_env.new" SETUP_TOKEN "$(rand_hex 24)"
  # Values that may hold a "$" are single-quoted so Docker Compose keeps them literally.
  [ -z "$SMTP_URL" ] || env_set "$_env.new" MAIL_SMTP_URL "'$SMTP_URL'"
  [ -z "$SMTP_FROM" ] || env_set "$_env.new" MAIL_FROM "$SMTP_FROM"
  [ -z "${MAIL_REPLY_TO:-}" ] || env_set "$_env.new" MAIL_REPLY_TO "$MAIL_REPLY_TO"
  if [ -n "${AI_API_KEY:-}" ]; then
    env_set "$_env.new" AI_API_KEY "'$AI_API_KEY'"
    [ -z "${AI_MODEL:-}" ] || env_set "$_env.new" AI_MODEL "$AI_MODEL"
    [ -z "${AI_BASE_URL:-}" ] || env_set "$_env.new" AI_BASE_URL "$AI_BASE_URL"
  fi
  mv -f "$_env.new" "$_env"
  ok "Wrote $_env with new secrets (mode 600)."
  [ -n "$SMTP_URL" ] || warn "System email is not set up yet. Add MAIL_SMTP_URL and MAIL_FROM to $_env (docs/self-hosting/system-email.md), then run: inboxjoy restart"
}

check_dns() {
  command -v getent >/dev/null 2>&1 || return 0
  _resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR == 1 { print $1 }')"
  if [ -z "$_resolved" ]; then
    warn "DNS: $DOMAIN does not resolve yet. Create an A record for $DOMAIN pointing at this server's public IP address."
    warn "     The site will come up as soon as the record exists; HTTPS can take a minute after that."
    return 0
  fi
  _mine="$(hostname -I 2>/dev/null || true)"
  case " $_mine " in
    *" $_resolved "*) ok "DNS: $DOMAIN points at this server ($_resolved)." ;;
    *) say "DNS: $DOMAIN points at $_resolved. If that is this server's public IP (some clouds hide it behind a private address), you are set." ;;
  esac
}

main() {
  say "${BOLD}InboxJoy installer${RESET}"

  # When run from a file by a regular user, retry through sudo.
  if [ "$(id -u)" -ne 0 ] && [ -f "$0" ] && command -v sudo >/dev/null 2>&1; then
    exec sudo -E sh "$0" "$@"
  fi

  step "Checking this server"
  check_system
  install_docker

  step "Preparing $INBOXJOY_DIR"
  ( umask 077; mkdir -p "$INBOXJOY_DIR/backups" )
  chmod 700 "$INBOXJOY_DIR" "$INBOXJOY_DIR/backups"
  _existing="$INBOXJOY_DIR/.env"

  # Which release: the one already installed (upgrades go through `inboxjoy
  # upgrade`), else the one requested, else the newest.
  VERSION="$(env_get "$_existing" INBOXJOY_VERSION)"
  if [ -n "$VERSION" ] && [ "$VERSION" != "latest" ]; then
    if [ -n "${INBOXJOY_VERSION:-}" ] && [ "${INBOXJOY_VERSION#v}" != "${VERSION#v}" ]; then
      warn "InboxJoy $VERSION is already installed here. To change versions run: inboxjoy upgrade ${INBOXJOY_VERSION#v}"
    fi
  else
    VERSION="${INBOXJOY_VERSION:-}"
  fi
  if [ -z "$VERSION" ] || [ "$VERSION" = "latest" ]; then
    _tag="$(curl -fsSL --max-time 20 "$API_BASE/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    if [ -n "$_tag" ]; then
      VERSION="${_tag#v}"
    else
      die "Could not find the latest InboxJoy release on GitHub. Check the server's internet access, or name a version: INBOXJOY_VERSION=1.2.3"
    fi
  fi
  VERSION="${VERSION#v}"
  # Anything below that runs `docker compose` must see this release, not the
  # caller's INBOXJOY_VERSION (see dc).
  INBOXJOY_VERSION="$VERSION"
  export INBOXJOY_VERSION
  _ref="v$VERSION"
  say "Installing InboxJoy $VERSION"

  for _name in compose.yml Caddyfile env.example bin/inboxjoy; do
    mkdir -p "$INBOXJOY_DIR/.dl/$(dirname "$_name")"
    fetch "$RAW_BASE/$_ref/deploy/$_name" "$INBOXJOY_DIR/.dl/$_name" \
      || die "Could not download deploy/$_name for $_ref from $RAW_BASE. Is $VERSION a real release?"
  done
  grep -q '^services:' "$INBOXJOY_DIR/.dl/compose.yml" || die "The downloaded compose.yml looks wrong."
  mv -f "$INBOXJOY_DIR/.dl/compose.yml" "$INBOXJOY_DIR/compose.yml"
  mv -f "$INBOXJOY_DIR/.dl/Caddyfile" "$INBOXJOY_DIR/Caddyfile"
  mv -f "$INBOXJOY_DIR/.dl/env.example" "$INBOXJOY_DIR/env.example"
  mkdir -p "$BIN_DIR"
  cp "$INBOXJOY_DIR/.dl/bin/inboxjoy" "$BIN_DIR/inboxjoy.new"
  chmod 755 "$BIN_DIR/inboxjoy.new"
  mv -f "$BIN_DIR/inboxjoy.new" "$BIN_DIR/inboxjoy"
  rm -rf "$INBOXJOY_DIR/.dl"

  write_env
  offer_swap

  cd "$INBOXJOY_DIR"
  dc config -q || die "The configuration is not valid. Check $INBOXJOY_DIR/.env."

  step "Downloading InboxJoy (a few minutes on the first run)"
  dc pull || die "Could not download the InboxJoy images for version $VERSION. Check the server's internet access."

  step "Starting the database and applying migrations"
  dc up -d postgres
  wait_healthy postgres 120 || die "The database did not start. Check: docker compose -f $INBOXJOY_DIR/compose.yml logs postgres"
  dc run --rm -T migrate || die "Database migrations failed. See the output above."

  step "Starting InboxJoy"
  dc up -d --remove-orphans
  for _svc in api worker web caddy; do
    printf 'Waiting for %s... ' "$_svc"
    if wait_healthy "$_svc" 240; then
      say "ok"
    else
      say "failed"
      dc logs --tail=40 "$_svc" >&2 || true
      die "$_svc did not start. Fix the problem shown above, then run the installer again; it is safe to re-run."
    fi
  done

  check_dns

  _tries=0
  _code=""
  while [ "$_tries" -lt 15 ]; do
    _code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/api/ready" 2>/dev/null || true)"
    [ "$_code" = "200" ] && break
    _tries=$((_tries + 1))
    sleep 4
  done

  # The only place the setup token is ever printed.
  SETUP_TOKEN="$(env_get "$INBOXJOY_DIR/.env" SETUP_TOKEN)"
  _link="https://$DOMAIN/app/setup"
  [ -z "$SETUP_TOKEN" ] || _link="$_link?token=$SETUP_TOKEN"

  say ""
  ok "InboxJoy is running."
  say ""
  if [ "$_code" = "200" ]; then
    say "  Open:      ${BOLD}$_link${RESET}"
  else
    say "  Open:      ${BOLD}$_link${RESET}   (not reachable yet; see the DNS note below)"
  fi
  say "  The first account you create becomes the owner. Do this right away."
  if [ -n "$SETUP_TOKEN" ]; then
    say "  The link carries a one-time setup token, so only whoever has the link can"
    say "  create that account. Keep it private until you have used it."
  else
    say "  Until then, anyone who finds the address could claim it."
  fi
  say ""
  say "  DNS:       $DOMAIN must have an A record pointing at this server, and ports"
  say "             80 and 443 must be open in your firewall. HTTPS is automatic once they are."
  say "  Commands:  inboxjoy status | logs | backup | restore | upgrade | restart"
  say "  Settings:  $INBOXJOY_DIR/.env (private; back it up with your database backups)"
  say "  Backups:   nightly into $INBOXJOY_DIR/backups, newest 14 kept. Copy them off this server."
  say "  Help:      https://github.com/$INBOXJOY_REPO/tree/main/docs/self-hosting"
}

main "$@"
