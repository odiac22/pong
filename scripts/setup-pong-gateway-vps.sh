#!/usr/bin/env bash
set -euo pipefail

domain="${PONG_GATEWAY_DOMAIN:-pong.217-77-13-143.sslip.io}"
backend_port="${PONG_GATEWAY_BACKEND_PORT:-18787}"
env_file=/etc/pong-gateway.env
password_file=/etc/nginx/.pong-gateway.htpasswd
site_file=/etc/nginx/sites-available/pong-gateway.conf

if [[ ! -s "$env_file" ]]; then
  umask 077
  gateway_token="$(openssl rand -hex 32)"
  printf 'PONG_GATEWAY_DOMAIN=%q\nPONG_GATEWAY_TOKEN=%q\n' "$domain" "$gateway_token" > "$env_file"
fi

# shellcheck disable=SC1090
source "$env_file"
if ! command -v htpasswd >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq apache2-utils
fi
printf '%s\n' "$PONG_GATEWAY_TOKEN" | htpasswd -i -B -c "$password_file" pong >/dev/null
chown root:www-data "$password_file"
chmod 600 "$env_file"
chmod 640 "$password_file"

printf '%s\n' \
  'server {' \
  '    listen 80;' \
  '    listen [::]:80;' \
  "    server_name $PONG_GATEWAY_DOMAIN;" \
  '    client_max_body_size 100m;' \
  '    location / {' \
  '        auth_basic "Pong";' \
  "        auth_basic_user_file $password_file;" \
  "        proxy_pass http://127.0.0.1:$backend_port;" \
  '        proxy_http_version 1.1;' \
  '        proxy_set_header Host $host;' \
  '        proxy_set_header X-Real-IP $remote_addr;' \
  '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' \
  '        proxy_set_header X-Forwarded-Proto $scheme;' \
  '        proxy_set_header Upgrade $http_upgrade;' \
  '        proxy_set_header Connection "upgrade";' \
  '        proxy_buffering off;' \
  '        proxy_request_buffering off;' \
  '        proxy_read_timeout 86400s;' \
  '        proxy_send_timeout 86400s;' \
  '    }' \
  '}' > "$site_file"

ln -sfn "$site_file" /etc/nginx/sites-enabled/pong-gateway.conf
nginx -t
systemctl reload nginx

certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email \
  --redirect -d "$PONG_GATEWAY_DOMAIN"
nginx -t
systemctl reload nginx
