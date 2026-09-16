# Komari Inventory

Komari 管理端插件，用于按节点维护服务、域名、端口和备注，并通过 Komari 自带的敏感远程任务接口执行一次性只读扫描。

要求 Komari `>1.4.3`（或包含 v2 `agent.taskResult` 处理逻辑的开发版本）。Komari 1.4.3 无法接收新版 Agent 的远程任务结果，会导致任务一直停留在运行中。

## 安全边界

- 插件仅启用 Node.js 兼容模块，用于读写自己的持久化目录。
- 插件不申请系统 RPC、命令执行、全盘文件、HTTP hook 或端口监听权限。
- 扫描由管理页面直接调用 `admin:exec`，因此复用 Komari 的管理员鉴权、2FA 和审计记录。
- 扫描结果只作为候选项，必须由管理员确认后导入台账。

## 当前扫描范围（应用视角）

- 当前正在运行的 Docker / Podman 容器（取决于 Agent 账户权限）
- `/etc/systemd/system` 中正在运行的自建服务，以及 Nginx / Caddy / Apache Web 入口（过滤探针 Agent 和系统服务）
- Docker / Podman 对外映射端口
- Nginx `server_name`
- Nginx 配置中的 `listen` 端口（归到 Nginx 服务，不扫描整机监听列表）
- Caddyfile 顶层站点地址
- Docker 中使用默认 `/etc/caddy/Caddyfile` 的 Caddy 站点及反向代理目标
- Nginx Proxy Manager 中已启用的代理域名（通过容器内置 Node.js 只读查询 SQLite）

默认不展示 SSH、cron、dbus、apt 等操作系统组件，避免把几十上百个系统单元误当成业务服务。不扫描整个文件系统，不读取环境变量，不收集访问活跃度，也不判断云安全组或公网可达性。未被识别的业务服务可以手工加入台账。

所有外部探测命令均设置短超时；单个组件异常不会让整次扫描永久挂起。扫描候选默认勾选应用服务、域名和容器映射端口，由管理员确认后导入。

扫描依赖 Komari Agent 的远程控制通道。若 Agent 使用 `--disable-web-ssh` 或 `AGENT_DISABLE_WEB_SSH=true`，页面会提示先临时启用；扫描完成后可以立即恢复禁用，扫描结果仍会保留在台账插件中。
