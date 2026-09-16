#!/bin/sh

# Every external probe has a deadline. A broken Docker socket, systemd bus or
# reverse-proxy command must not leave the Komari remote task pending forever.
if command -v timeout >/dev/null 2>&1; then
  timeout_command=timeout
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_command=gtimeout
else
  timeout_command=
fi

limited() {
  seconds=$1
  shift
  if [ -n "$timeout_command" ]; then
    "$timeout_command" -k 2 "${seconds}s" "$@"
  else
    "$@"
  fi
}

b64() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

record() {
  kind=$1
  shift
  printf '%s' "$kind"
  for value in "$@"; do
    printf '\t%s' "$(b64 "$value")"
  done
  printf '\n'
}

emit_caddy_domains() {
  source_name=$1
  awk '
    function flush_sites(    i, domain) {
      if (!active) return
      for (i = 1; i <= site_count; i++) {
        domain = sites[i]
        sub(/^https?:\/\//, "", domain)
        sub(/:.*/, "", domain)
        if (domain != "" && domain != "localhost") print domain "\t" target
      }
      delete sites
      site_count = 0
      target = ""
      active = 0
    }
    /^[^[:space:]#][^{]*\{/ {
      flush_sites()
      line = $0
      sub(/#.*/, "", line)
      sub(/\{.*/, "", line)
      gsub(/,/, " ", line)
      count = split(line, parts, /[[:space:]]+/)
      for (i = 1; i <= count; i++) {
        if (parts[i] == "" || parts[i] ~ /^\(/ || parts[i] ~ /^:/) continue
        sites[++site_count] = parts[i]
      }
      active = site_count > 0
      next
    }
    active && /^[[:space:]]*reverse_proxy[[:space:]]+/ && target == "" {
      line = $0
      sub(/#.*/, "", line)
      sub(/^[[:space:]]*reverse_proxy[[:space:]]+/, "", line)
      count = split(line, parts, /[[:space:]]+/)
      for (i = 1; i <= count; i++) {
        if (parts[i] == "" || parts[i] ~ /^\//) continue
        target = parts[i]
        break
      }
      if (target != "" && target !~ /^[[:alpha:]][[:alnum:]+.-]*:\/\// && target !~ /^unix\//) target = "http://" target
    }
    active && /^}/ { flush_sites() }
    END { flush_sites() }
  ' | head -n 400 | while IFS="$(printf '\t')" read -r domain target; do
    [ -n "$domain" ] && record DOMAIN "$source_name" "$domain" "$target"
  done
}

printf 'KOMARI_INVENTORY_V1\n'
record META "$(hostname 2>/dev/null || uname -n)" "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)"

emit_systemd_app() {
  unit=$1
  case "$unit" in
    komari-agent.service|nezha-agent.service|mmw-agent.service|rc-local.service|osbuild-*.service) return ;;
  esac
  state=$(limited 4 systemctl is-active "$unit" 2>/dev/null)
  [ "$state" = "active" ] || return
  description=$(limited 4 systemctl show -p Description --value "$unit" 2>/dev/null)
  name=${unit%.service}
  record SERVICE "systemd" "$name" "running" "$description" "" "" "systemd"
}

# Only include custom units stored directly in /etc/systemd/system plus common
# web entry points. This finds user applications without listing every OS unit.
if command -v systemctl >/dev/null 2>&1; then
  for unit_file in /etc/systemd/system/*.service; do
    [ -e "$unit_file" ] || [ -L "$unit_file" ] || continue
    if [ -L "$unit_file" ]; then
      unit_target=$(readlink -f "$unit_file" 2>/dev/null || true)
      case "$unit_target" in
        /lib/systemd/system/*|/usr/lib/systemd/system/*) continue ;;
      esac
    fi
    emit_systemd_app "$(basename "$unit_file")"
  done
  for web_unit in nginx.service caddy.service apache2.service httpd.service; do
    emit_systemd_app "$web_unit"
  done
fi

if command -v docker >/dev/null 2>&1; then
  docker_rows=$(limited 12 docker ps --format '{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}' 2>/dev/null)
  docker_status=$?
  if [ "$docker_status" -eq 0 ]; then
    printf '%s\n' "$docker_rows" | head -n 400 | while IFS='|' read -r name image state status ports project compose_service; do
      [ -z "$name" ] && continue
      extra=$status
      [ -n "$project" ] && extra="$extra; compose=$project/$compose_service"
      record SERVICE "docker" "$name" "$state" "$extra" "$image" "$ports" "docker"
    done

    # .Image can be only an image ID when the original tag is no longer present.
    # Inspect all running containers in one bounded call to find NPM reliably.
    running_ids=$(limited 6 docker ps -q 2>/dev/null)
    if [ -n "$running_ids" ]; then
      inspect_rows=$(limited 10 docker inspect $running_ids --format '{{.Name}}|{{.Config.Image}}' 2>/dev/null)
      inspect_status=$?
      if [ "$inspect_status" -eq 0 ]; then
        printf '%s\n' "$inspect_rows" | while IFS='|' read -r container_name config_image; do
          container_name=${container_name#/}
          case "$config_image" in
            *nginx-proxy-manager*)
              npm_rows=$(limited 10 docker exec "$container_name" node -e '
          try {
            const Database = require("better-sqlite3");
            const db = new Database("/data/database.sqlite", { readonly: true });
            const rows = db.prepare("select domain_names, forward_host, forward_port, forward_scheme from proxy_host where is_deleted=0 and enabled=1").all();
            for (const row of rows) {
              let domains = [];
              try { domains = JSON.parse(row.domain_names || "[]"); } catch (_) {}
              const target = String(row.forward_scheme || "http") + "://" + String(row.forward_host || "") + ":" + String(row.forward_port || "");
              for (const domain of domains) process.stdout.write(String(domain) + "\t" + target + "\n");
            }
          } catch (error) {
            process.exitCode = 1;
          }
        ' 2>/dev/null)
              npm_status=$?
              if [ "$npm_status" -eq 0 ]; then
                printf '%s\n' "$npm_rows" | while IFS="$(printf '\t')" read -r domain target; do
                  [ -n "$domain" ] && record DOMAIN "nginx-proxy-manager" "$domain" "$target"
                done
              else
                record WARNING "发现 Nginx Proxy Manager，但无法在 10 秒内只读查询其 SQLite 数据库。"
              fi
              ;;
            *[Cc]addy*)
              caddy_file=$(limited 8 docker exec "$container_name" cat /etc/caddy/Caddyfile 2>/dev/null)
              caddy_status=$?
              if [ "$caddy_status" -eq 0 ]; then
                printf '%s\n' "$caddy_file" | emit_caddy_domains "caddy:$container_name"
              else
                record WARNING "发现 Caddy 容器 $container_name，但无法在 8 秒内只读读取默认 Caddyfile。"
              fi
              ;;
          esac
        done
      elif [ "$inspect_status" -eq 124 ] || [ "$inspect_status" -eq 137 ]; then
        record WARNING "Docker 容器详情扫描超时，已跳过反向代理域名探测。"
      fi
    fi
  elif [ "$docker_status" -eq 124 ] || [ "$docker_status" -eq 137 ]; then
    record WARNING "Docker 扫描超时，已跳过。"
  else
    record WARNING "Docker 已安装，但 Komari Agent 无法读取 Docker。"
  fi
fi

if command -v podman >/dev/null 2>&1; then
  podman_rows=$(limited 12 podman ps --format '{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}' 2>/dev/null)
  podman_status=$?
  if [ "$podman_status" -eq 0 ]; then
    printf '%s\n' "$podman_rows" | head -n 400 | while IFS='|' read -r name image state status ports; do
      [ -n "$name" ] && record SERVICE "podman" "$name" "$state" "$status" "$image" "$ports" "podman"
    done
  elif [ "$podman_status" -eq 124 ] || [ "$podman_status" -eq 137 ]; then
    record WARNING "Podman 扫描超时，已跳过。"
  fi
fi

scan_nginx() {
  nginx_binary=$(command -v nginx 2>/dev/null || true)
  if [ -z "$nginx_binary" ]; then
    for candidate in /usr/sbin/nginx /usr/local/sbin/nginx; do
      if [ -x "$candidate" ]; then
        nginx_binary=$candidate
        break
      fi
    done
  fi
  if [ -n "$nginx_binary" ]; then
    nginx_output=$(limited 10 "$nginx_binary" -T 2>/dev/null)
    if [ -n "$nginx_output" ]; then
      printf '%s\n' "$nginx_output"
      return
    fi
  fi
  for file in /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/*; do
    [ -r "$file" ] && printf '\n' && sed -n '1,5000p' "$file"
  done
}

scan_nginx | awk '
  {
    sub(/#.*/, "", $0)
    if ($0 ~ /server_name[[:space:]]/) {
      line=$0
      sub(/^.*server_name[[:space:]]+/, "", line)
      sub(/;.*/, "", line)
      gsub(/[[:space:]]+/, "\n", line)
      print line
    }
  }
' | sed '/^$/d; /^_/d; /^localhost$/d' | sort -u | head -n 400 | while IFS= read -r domain; do
  record DOMAIN "nginx" "$domain" ""
done

if [ -r /etc/caddy/Caddyfile ]; then
  emit_caddy_domains "caddy" < /etc/caddy/Caddyfile
fi

printf 'KOMARI_INVENTORY_END\n'
