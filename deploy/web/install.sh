#!/usr/bin/env bash
# Prepare the host. Release selection and service startup belong to release.py.
set -euo pipefail
umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stage=""
phase="preflight"

die() { printf 'web install: %s\n' "$*" >&2; exit 1; }
cleanup() {
  local result=$?
  if [[ -n "$stage" ]]; then rm -rf -- "$stage"; fi
  if (( result != 0 )); then
    printf 'web install: failed during %s; correct that input and rerun installation\n' "$phase" >&2
  fi
  exit "$result"
}
trap cleanup EXIT

(( $# == 0 )) || die 'usage: sudo deploy/web/install.sh'
(( EUID == 0 )) || die 'host installation requires root'
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || die 'host must be linux/x64'
for executable in curl tar xz unzip openssl sha256sum python3 systemctl groupadd useradd getent nologin cmp; do
  command -v "$executable" >/dev/null || die "install required host command: $executable"
done
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' || die 'python 3.12 or newer is required'
for file in artifact.py release.py nexus-web.service nexus-web-tunnel.service; do
  [[ -f "$script_dir/$file" ]] || die "missing installer input: $script_dir/$file"
done

phase="pinned tool downloads"
install -d -o root -g root -m 0755 /opt/nexus-web
stage="$(mktemp -d /opt/nexus-web/.install.XXXXXX)"
# Checksums are from each pinned upstream release's published asset metadata.
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 300 \
  https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz -o "$stage/node.tar.xz"
printf '%s  %s\n' d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307 "$stage/node.tar.xz" | sha256sum --check --status
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 300 \
  https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip -o "$stage/bun.zip"
printf '%s  %s\n' 951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f "$stage/bun.zip" | sha256sum --check --status
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 300 \
  https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-linux-amd64 -o "$stage/cloudflared"
printf '%s  %s\n' ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42 "$stage/cloudflared" | sha256sum --check --status
tar -xJf "$stage/node.tar.xz" -C "$stage" node-v22.23.2-linux-x64/bin/node
unzip -q "$stage/bun.zip" -d "$stage"
chmod 0755 "$stage/cloudflared"
[[ "$("$stage/node-v22.23.2-linux-x64/bin/node" --version)" == v22.23.2 ]] || die 'node distribution version differs'
[[ "$("$stage/bun-linux-x64/bun" --version)" == 1.3.14 ]] || die 'bun distribution version differs'
[[ "$("$stage/cloudflared" --version)" == 'cloudflared version 2026.10.4 '* ]] || die 'cloudflared distribution version differs'

phase="service accounts and directories"
for account in nexus-web nexus-web-tunnel; do
  if ! getent group "$account" >/dev/null; then groupadd --system "$account"; fi
  if ! getent passwd "$account" >/dev/null; then
    useradd --system --gid "$account" --no-create-home --home-dir /nonexistent \
      --shell "$(command -v nologin)" "$account"
  fi
  [[ "$(id -u "$account")" != 0 && "$(id -Gn "$account")" == "$account" ]] || die "$account must have only its own unprivileged group"
  account_shell="$(getent passwd "$account")"
  [[ "${account_shell##*:}" == */nologin ]] || die "$account must use a nologin shell"
done
install -d -o root -g root -m 0755 \
  /opt/nexus-web/node/bin /opt/nexus-web/bun/bin /opt/nexus-web/control \
  /srv/nexus-web /srv/nexus-web/releases /var/cache/nexus-web
install -d -o root -g root -m 0700 /srv/nexus-web/incoming
# Both users can traverse to their own files; neither can list private inputs.
install -d -o root -g root -m 0711 /etc/nexus-web
install -d -o root -g root -m 0755 /etc/nexus-web/tls

phase="origin certificate"
cert=/etc/nexus-web/tls/cert.pem
key=/etc/nexus-web/tls/key.pem
if [[ -e "$cert" || -e "$key" ]]; then
  [[ -f "$cert" && -f "$key" ]] || die 'incomplete origin certificate pair; restore both original files before retrying'
else
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -nodes -days 365 \
    -subj /CN=nexus.nielseriknandal.com \
    -addext 'subjectAltName=DNS:nexus.nielseriknandal.com,IP:127.0.0.1' \
    -addext 'basicConstraints=critical,CA:FALSE' -addext 'extendedKeyUsage=serverAuth' \
    -keyout "$stage/key.pem" -out "$stage/cert.pem" >/dev/null 2>&1
  install -o root -g root -m 0644 "$stage/cert.pem" "$cert"
  install -o root -g nexus-web -m 0640 "$stage/key.pem" "$key"
fi
openssl verify -CAfile "$cert" -verify_hostname nexus.nielseriknandal.com "$cert" >/dev/null
openssl verify -CAfile "$cert" -verify_ip 127.0.0.1 "$cert" >/dev/null
cert_public="$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)"
key_public="$(openssl pkey -in "$key" -pubout -outform DER | sha256sum)"
[[ "$cert_public" == "$key_public" ]] || die 'origin certificate and private key do not match; restore the original pair'
chown root:root "$cert"
chmod 0644 "$cert"
chown root:nexus-web "$key"
chmod 0640 "$key"
if [[ -e /etc/nexus-web/cloudflared-token ]]; then
  chown root:nexus-web-tunnel /etc/nexus-web/cloudflared-token
  chmod 0640 /etc/nexus-web/cloudflared-token
fi

phase="tool and service installation"
# Same-filesystem renames preserve running executables; identical bytes stay put.
install_binary() {
  local source=$1 target=$2
  chown root:root "$source"
  chmod 0755 "$source"
  if ! cmp --silent "$source" "$target"; then mv -f "$source" "$target"; fi
}
install_binary "$stage/node-v22.23.2-linux-x64/bin/node" /opt/nexus-web/node/bin/node
install_binary "$stage/bun-linux-x64/bun" /opt/nexus-web/bun/bin/bun
install_binary "$stage/cloudflared" /opt/nexus-web/cloudflared
install -o root -g root -m 0644 "$script_dir/artifact.py" "$script_dir/release.py" /opt/nexus-web/control/
install -o root -g root -m 0644 "$script_dir/nexus-web.service" "$script_dir/nexus-web-tunnel.service" /etc/systemd/system/
systemctl daemon-reload
printf 'web install: host prerequisites configured; prepare a candidate and publish the tunnel token before starting services\n'
