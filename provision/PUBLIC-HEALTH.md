# provision/PUBLIC-HEALTH.md — 公网 /_health 的绑定与反代规格（Round 6 软件侧补齐）

> 结论先行：P10「G5 公网 /_health 结构性不成立」的准确成因是 **默认配置 + 无公网路由**，
> 不是代码不支持。`server-deploy/bot.mjs:281` 的 `healthHost` 完全由 `config.json` 的
> `file.healthHost` 驱动，`:417` 原样传给 `health.listen()`；全文件 `0.0.0.0` 零命中、
> 无 `HEALTH_HOST` env、无 loopback 白名单。把 `config.json` 写成 `"healthHost":"0.0.0.0"`
> 即绑全网卡，**代码零改动、24 件 BYTE-FROZEN 封印不动**（子代理 P12 审计 + Lead 独立复算）。

## 1. 本机已做实（可复跑）
- `provision/render_config.mjs`：从冻结的 `config.example.json` 渲染 `config.json`，只覆盖
  `healthHost` 一个字段、递归剔除凭据键、校验绑定字面合法性、默认 dry-run 不写盘。
  `node provision/render_config.mjs --selftest` → `RENDER-CONFIG-SELFTEST-OK cases=9 teeth=5`。
- `provision/lan_health_probe.mjs`：fork 真 OS 子进程跑 `runService`（mock fetch、零 WAN），
  绑 `0.0.0.0`/LAN IP，从非回环 LAN IP fetch `/_health`，喂既有 `check_health.mjs` 的
  `judgeHealth` 判 `codeHash==sha256(bot.mjs)`。
  `node provision/lan_health_probe.mjs` → `LAN-HEALTH-PROBE-OK pos=3 neg=3 teeth=3`。
  负控：绑回 `127.0.0.1` 时 LAN 地址 `ECONNREFUSED`；`codeHash` 漂移与错服务名翻红。
- `provision/acceptance_drill.mjs`：把真 `/_health` 喂 `collect_acceptance.mjs` 的 `collect()`
  → `judge()`，证明同源代码身份可被采集、缺 reboot/PC-off 时 `NOT_PROVEN` 不假绿，
  并如实展示 gate 的证据包自洽局限（喂齐伪造声明可 PASS）。

## 2. 部署期绑定动作（软件侧，真机 step4 之前）
```bash
# 在目标主机的 /etc/dsh-ilink-bot/ 预置 config.json（healthHost 绑全网卡）
node provision/render_config.mjs --health-host 0.0.0.0 --out /etc/dsh-ilink-bot/config.json
chmod 0644 /etc/dsh-ilink-bot/config.json
# deploy.sh:89 是 [ -f "$ENV_DIR/config.json" ] || install config.example.json
# 已存在则不覆盖 —— 预置后 systemd（service:15 / deploy.sh:109 的 DSH_ILINK_CONFIG）
# 会读到这份绑 0.0.0.0 的配置，bot 监听所有网卡。
```
注意：`config.example.json` 是冻结件（`MANIFEST.sha256:4`），**不得改**，只能另生成 `config.json`。
另注意 `bot.mjs:264` 有端口 env `DSH_ILINK_HEALTH_PORT`、`:281` **无** host env override，
故不能靠往 systemd drop-in 加 `Environment=` 解决（那要改冻结的 bot.mjs），只能走 `file.healthHost`。

## 3. 反代 / TLS / 公网路由规格（需真常开主机权限，本机给不了）
绑 `0.0.0.0` 只监听本机所有网卡，不等于有公网地址或入站放行。`bot.mjs:377-390` 是裸
`http.createServer`，不终止 TLS；公网验收标准要求 `https://<域名>/_health` 返回同一份
`codeHash`。推荐用 nginx/caddy 在 443 终止 TLS、反代到本机 8787：
```nginx
server {
    listen 443 ssl;
    server_name bot.example.com;
    ssl_certificate     /etc/letsencrypt/live/bot.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.example.com/privkey.pem;
    location /_health {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 5s;
    }
}
```
配套外部条件（缺一不可，全部属外部凭据/物理能力）：
- 公网可路由 IP 或域名 + DNS A 记录；
- 云安全组 / `iptables` / `firewalld` 放行 443（不要把 8787 直曝公网）；
- TLS 证书（ACME / Let us Encrypt 一类）与反代进程常驻；
- 反代**不得改写** `/_health` 响应体：`codeHash` 必须由运行体 `bot.mjs:318-320` 自算，
  `collect_acceptance.mjs` / `check_health.mjs` 的判据靠它做同源绑定（P11 三判据同源约束）。

## 4. 诚实边界（#36 不假报）
- **LAN 可达 ≠ 公网可达 ≠ 关电脑还能用**：LAN 是 RFC1918 私网、无公网路由；本机 LAN IP
  绑在这台 Windows 网卡上，PC 关机/睡眠/断网即连同进程消失。
- `reboot_acceptance_gate.mjs` 的 `PASS` 只裁决**证据包自洽**，不裁决物理事实：子代理 P13
  回放证明喂齐伪造 reboot 戳 + `pcOffAttested=1` + `pcOffEvidence` 即回 `PASS`。
  故达标不能只看 gate 绿，仍须 `DEPLOY-SERVER.md:122` 真机 `egress=confirmed` /
  `provenance=confirmed` + 真手机往返 + 真 reboot 自起往返。
- 真 VPS + SYSTEM systemd + 真人 QR 真 token + 真 reboot + 带外 PC 断电证据，本机全给不了；
  达标闸缺证据一律 `ACCEPTANCE=NOT_PROVEN`(rc=2)，goal 保持 `active`。
- 不推翻既有裁定：iLink 单聊可迁常开 Linux VPS+systemd；微信群 on-server 永久平台阻塞。

## 5. 可复跑判据（本机，系统 node v24.16.0）
```bash
cd /d/dsh-im-robot
node provision/render_config.mjs --selftest          # RENDER-CONFIG-SELFTEST-OK cases=9 teeth=5
node provision/lan_health_probe.mjs                 # LAN-HEALTH-PROBE-OK pos=3 neg=3 teeth=3
node provision/acceptance_drill.mjs                 # ACCEPTANCE-DRILL-OK gate_limit_shown=true
node _goal-server/reboot_acceptance_gate.mjs        # ACCEPTANCE=NOT_PROVEN rc=2（缺真机证据）
```
