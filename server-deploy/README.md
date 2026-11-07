# DSH iLink 无头服务器机器人（单聊）

> 目的：回答「可不可以部署到服务器上，想要关电脑也能正常使用」。
> 本包给出**能**的那一半，并把**不能**的那一半如实隔离，不冒充、不假完成。
> 本运行手册描述当前随包字节；带 sha16+字节的权威文件清单见 _goal-autochat/COMMIT-MANIFEST-r16.md（每轮重封印）。

## 一句话结论

- **能**：把「微信个人号 iLink Bot 的**单聊**机器人」做成纯 HTTP 服务，装到 Linux 服务器上，由 systemd 常驻；本机 Windows 关机、微信退出、UIA 树消失都**不影响**它。关电脑也能用。
- **不能**：把「**微信群**机器人（群桥）」搬上服务器。群桥在源码层绑死三样本机 Windows 资源（Win32 窗口消息原语、运行中微信 GUI 的 UIA 树、登录会话 + 对 Weixin.dll 的单字节进程内存写），Linux 上不存在；且微信官方 iLink 的 9 个端点**没有**任何列会话/群/成员或持久群消息面的能力，本机也拿不到真实 `xxx@chatroom` 群 ID。详见 [独立第二意见](../_goal-autochat/SERVER-FEASIBILITY-2ND.md) 与 [HEADLESS-CONSTRAINT](../HEADLESS-CONSTRAINT.md)。

**这是单聊机器人，不是群机器人。** 想「关机后群还在自动回」目前无合规技术路径，属平台能力缺口，已按 #37/#48 落待办。

## 为什么这条能脱离本机

| 资源 | 本机群桥 | 本包 iLink 单聊 |
|---|---|---|
| 微信 GUI 进程 | 必须运行 | 不需要 |
| Win32/UIA 控件树 | 必须 | 不需要 |
| 窗口/鼠标/焦点 | 会抢（已禁） | 完全不碰 |
| Weixin.dll 进程内存写 | 需要（wake gate） | 不需要 |
| 网络面 | 本地进程 | 仅 `https://ilinkai.weixin.qq.com/` 纯 fetch |
| 凭据 | 本机 DSH 宿主持有 | 服务器自有 `bot_token`（`login.mjs` 扫码一次获得，env 0600 注入） |

协议形状逐字对齐权威源 `_diag6/a/green/src/channels/weixin/weixin-api.mjs`，对照基准见 [ILINK-WIRE-CHECKLIST](../_goal-autochat/ILINK-WIRE-CHECKLIST.md)（25 形状 + 3 mutant）。

## 文件清单（随包 24 件；权威清单见 COMMIT-MANIFEST-r16.md）

| 文件 | 作用 |
|---|---|
| `bot.mjs` | 自包含 iLink 客户端 + 长轮询 + `/_health`（零三方依赖，Node ≥18 内置）；sha `9f4138c534582e58` BYTE-FROZEN |
| `login.mjs` | 一次性 QR 扫码登录，服务器自取 `bot_token` 写入 0600 env 文件，不打印明文 |
| `gate.mjs` | 第 1 道 [2/6] 闸：21 项 + 3 负向 mutant + 无头 smoke |
| `verify_deploy.mjs` | 第 2 道 [2/6] 闸：#40 线上验证 fork 真实独立进程 + 真实 TCP `/_health`，断言运行中 codeHash == 磁盘 sha256，带错 hash 负控 |
| `stale_token_gate.mjs` | 第 3 道 [2/6] 闸（r2）：token 过期（-14）时真实服务必须**降级**为 `needs_relogin` 而非崩溃重启 |
| `verify_health.mjs` | 第 4 道 [2/6] 闸：#40 线上五判 `assertDeployHealth`（service / codeHash / `status==ok` / `needsRelogin!==true` / `lastError` 空）；`--selftest` 4/4 + 6 mutant；[6/6] 不再直接调它，改由 `provenance_gate.mjs --check` 组合同五判 |
| `unit_contract_gate.mjs` | 第 5 道 [2/6] 闸（r4）：unit 的 User/Group 真创建、state 目录 chown、node 路径对齐、就地安装保护 |
| `sendfail_gate.mjs` | 第 6 道 [2/6] 闸（r6）：`seen.add(mid)` 必须在 `await sendText` **成功之后**，否则瞬时发送失败永久吞消息 |
| `corrupt_state_gate.mjs` | 第 7 道 [2/6] 闸（r7）：断电后 `state.json` 损坏必须可观测降级 `status=corrupt_state` |
| `provenance_gate.mjs` | 第 8 道 [2/6] 闸（r16/r17）：[6/6] OS-truth 溯源 `systemctl show -p MainPID` → 读 /proc 下 MainPID 的 cmdline 精确 2-token → `/proc/net/tcp{,6}` LISTEN inode 归属 → keepAlive ESTABLISHED responder inode 归属（H1）→ freshness → 五判；`--expect-port` 为 MANDATORY 运行时断言（r17 F1，漏传抛 `--expect-port missing (mandatory)`）；`--selftest` 55/55 + 27 负控 |
| `port_gate.mjs` | 第 9 道 [2/6] 闸（r17）：managed-only 从 deploy.sh 自管两源（EnvironmentFile env + config.json）算 PORT-EXPECT（env>config>8787）；`--selftest` 31/31；另 `--validate` 为 [4/6] 第 10 闸；不枚举 glob / DefaultEnvironment / 陈旧 dropin，由 mandatory `--expect-port` 运行时兜 |
| `verify_unit.mjs` | [4/6] 第 11 闸（r4）：跑真 `systemd-analyze verify` 验装好的 unit+drop-in（`--verify <unit>`） |
| `egress_gate.mjs` | r8 [6/6] 在线出站确认（非 [2/6] 重启闸）：`--live` raw fetch 打 iLink `getconfig`，假 token 必被显式拒，黑洞/零出口/5xx/captive/空体全 fail-closed；`--selftest` 为 dev 链 |
| `deploy.sh` | #40 提交→部署→线上验证：**十一道闸全绿才允许 restart**（九道 [2/6] + 两道 [4/6]）；自动建 `dshbot` 运行账号、chown state 目录、按实装 node 生成 systemd drop-in；[4/6] 真 `systemd-analyze verify` 与 PORT-EXPECT 验算；[5/6] `systemctl enable` 硬失败 + `is-active`/`is-enabled` 双判打 `DEPLOY-BOOT-OK is-enabled=confirmed (survives reboot)`；[6/6] 20× `provenance_gate.mjs --check` + `egress_gate.mjs --live` |
| `dsh-ilink-bot.service` | systemd 常驻单元（Restart=always，hardening） |
| `config.example.json` | 配置样例（回复规则、端口、state 路径；token 不入库） |
| `package.json` | 包元数据（[3/6] 随包安装） |
| `probe_live.mjs` | 只读活体探针：假 token 打到腾讯端点，证明纯 HTTP 可达、与本机微信状态无关 |
| `independent_probe.mjs` | 独立探针（dev 链） |
| `r4_syntax_check.mjs` | r4 语法自检（[1/6] `node --check` 序列） |
| `r4_bash_check.mjs` | r4 bash 自检 |
| `state.json` | 运行时 state（服务以 RUN_USER 写，损坏可观测降级） |
| `.gitignore` / `README.md` | 仓库元信息 / 本运行手册 |

## 部署步骤（Linux 服务器，全程无头 CLI）

```bash
# 0) 前置：Node ≥18、systemd、能访问 ilinkai.weixin.qq.com
# 1) 拷贝本目录到服务器 /opt/dsh-ilink-bot
scp -r server-deploy user@server:/opt/dsh-ilink-bot
# 2) 一次性扫码登录，拿到服务器自己的 token（唯一需要人扫一次 QR 的动作）
#    需 root 写 /etc/dsh-ilink-bot/env；login.mjs 会自建该目录，
#    deploy.sh 随后建 dshbot 账号并把 /var/lib/dsh-ilink-bot chown 给它，勿手工 chmod 0777。
ssh user@server "cd /opt/dsh-ilink-bot && sudo DSH_ILINK_ENV_OUT=/etc/dsh-ilink-bot/env node login.mjs"
#    手机微信扫屏幕上打出的 QR；confirmed 后 token 写入 0600 env 文件
# 3) 部署（十一道闸全绿才 restart：九道 [2/6] + 两道 [4/6] 含真 systemd-analyze verify 与 PORT-EXPECT 验算；[5/6] enable 硬失败保开机自启；[6/6] 20× provenance_gate.mjs --check（OS-truth /proc 溯源 + mandatory --expect-port 运行时断言，不从 config 派生拨测端点）+ egress_gate.mjs --live（真部署剥 DSH_EGRESS_HOST））
ssh user@server "cd /opt/dsh-ilink-bot && sudo ./deploy.sh"
#    期望先是： DEPLOY-BOOT-OK is-enabled=confirmed (survives reboot)
#    期望末行（真部署，逐字对应 deploy.sh:241）： DEPLOY-OK health=ok needsRelogin=false egress=confirmed provenance=confirmed expectPort=<PORT-EXPECT> (judge: service+sha+status+needsRelogin+lastError+egress+os-truth-inode+responder-bound+freshness+expect-port)
#    离线 hermetic capstone：DSH_ILINK_HERMETIC=1 时回执改为 egress=hermetic-mock、provenance=hermetic-mock（保留 DSH_EGRESS_HOST 供本地 mock）；真部署才是 egress=confirmed / provenance=confirmed。两者共用 DEPLOY-OK 令牌但回执字段可区分，绝不把 capstone 读成真部署。
#    拨测端点由 provenance_gate.mjs 从 OS-truth（systemctl MainPID → /proc socket-inode）发现；config/env 只用于算 PORT-EXPECT 并经 --expect-port 作运行时断言，不做拨测目标（deploy.sh:195-197：We do NOT derive the DIAL url from config）。
#    若判据返回 needs_relogin：部署好的 token 已过期，手机重扫一次 login.mjs 再重部署。
# 4) 验收
curl -fsS http://127.0.0.1:8787/_health
#    手机给该 Bot 发 "ping" -> 回 "pong (iLink headless bot, running on the server)"
```

## 机器闸与负向对照（#47 / #44 D8）

```bash
# 九道 [2/6] 重启前闸（deploy.sh:57-66 精确序列）+ 两道 [4/6] 闸（:127 port --validate 第 10、:139 verify_unit --verify 真解析器 第 11），共十一道闸全绿才 restart。
# 闸演进（如实）：r1–r8 为 7 道 [2/6]；r12 仍 7 道（不新增 [2/6] 闸，改 [5/6] enable 硬失败 + [6/6] is-enabled 判据）；r14 仍 7 道（[6/6] 端口耦合修法落在 dev 链静态闸 + 真 Linux capstone）；r16 新增 1 道 [2/6]（provenance --selftest，第 8 道）；r17 新增 2 道（port --selftest 第 9 道 [2/6] + port --validate 第 10 道 [4/6]）——真正新增合计 3 道（deploy.sh:65、:66 两道 [2/6] 与 :127 一道 [4/6]）。第 11 道 [4/6]（verify_unit.mjs --verify 真 systemd-analyze 解析器）是 r1 起就存在的旧闸，r17 仅把它的编号由「第 8 道」重编号为「第 11 道」，不是新增。r12/r14 当时「不新增 [2/6] 闸 / 冻结 r1 起计数链」的历史口径已随 r16/r17 作废，不再适用。注：r17 只是功能标签，不是计数证据已推进到 r17 —— deploy.sh:26 仍写 r8..r16、provenance_gate.mjs 头注仍写 r1..r15。
node gate.mjs                                  # GATE-OK checks=21/21 negatives=3/3 exit 0
node verify_deploy.mjs                          # DEPLOY-VERIFY-OK sha=… received=1 replied=1 exit 0
node stale_token_gate.mjs                       # STALE-GATE-OK 7/7 + 3 mutant exit 0
node verify_health.mjs --selftest               # VERIFY-HEALTH-SELFTEST-OK 4/4 + 6 mutant exit 0
node unit_contract_gate.mjs --verify            # R4-UNIT-GATE-OK 14/14 + 8 mutant exit 0
node sendfail_gate.mjs                          # SENDFAIL-GATE-OK 5/5 teeth=5/5 exit 0
node corrupt_state_gate.mjs                     # CORRUPT-STATE-GATE-OK 8/8 teeth=5/5 exit 0
node provenance_gate.mjs --selftest             # PROVENANCE-SELFTEST-OK 55/55 negatives=27/27 exit 0（r16）
node port_gate.mjs --selftest                   # PORT-GATE-SELFTEST-OK 31/31 exit 0（r17）
# [4/6] 第 10 闸：node port_gate.mjs --validate --env <env> --config <cfg> --unit <unit> --dropin <dir>  → PORT-EXPECT=<n>
# [4/6] 第 11 闸：node verify_unit.mjs --verify <unit>  → 真 systemd-analyze verify
# [6/6] 在线信号（非 [2/6] 重启闸）：20× provenance_gate.mjs --check ... --since-ts <ts> --expect-port <n>（OS-truth /proc）+ egress_gate.mjs --live（独立 raw-fetch 出站确认）

# 负向对照（判据故意改恒绿，必须报 FAIL，证明有牙）
GATE_INJECT_GREENWASH=1 node gate.mjs                                   # GATE-FAIL
STALE_GATE_GREENWASH=1 node stale_token_gate.mjs                        # STALE-GATE-FAIL
VERIFY_HEALTH_GREENWASH=1 node verify_health.mjs --selftest             # VERIFY-HEALTH-SELFTEST-FAIL
R4_UNIT_GATE_GREENWASH=1 node unit_contract_gate.mjs --verify           # R4-UNIT-GATE-FAIL
SENDFAIL_GATE_GREENWASH=1 node sendfail_gate.mjs                        # SENDFAIL-GATE-FAIL
CORRUPT_GATE_GREENWASH=1 node corrupt_state_gate.mjs                    # CORRUPT-STATE-GATE-FAIL
PROVENANCE_GATE_GREENWASH=1 node provenance_gate.mjs --selftest         # PROVENANCE-SELFTEST-FAIL greenwash=on exit 1（r16）
PORT_GATE_GREENWASH=1 node port_gate.mjs --selftest                     # PORT-GATE-SELFTEST-FAIL greenwash=on exit 1（r17）
EGRESS_GATE_GREENWASH=1 node egress_gate.mjs --selftest                 # EGRESS-GATE-FAIL
```

判据不是恒真：把判据故意改成恒绿，闸门必须因此报 FAIL。`gate.mjs` 的 3 mutant = 漏 `AuthorizationType` / `from_user_id` 非空 / `message_type=1`；`stale_token_gate.mjs` 的 3 mutant = 崩溃重启循环 / 空转狂打轮询 / 无重新登录信号；`verify_health.mjs --selftest` 的 6 mutant = 错 hash / `needs_relogin` / 错 service / `status!=ok` / `lastError` 非空 / `corrupt_state`；`egress_gate.mjs --selftest` 的 7 mutant = 假 token 被接受 / 5xx / 无 provider 拒码 / 黑洞超时 / captive 门户 / 零出口 / 空体，全 fail-closed。`../_goal-autochat/r18_runbook_drift_gate.mjs` 另以负控守住本运行手册与随包字节的一致性。

## token 过期时的行为（r2 修复的缺口）

服务器长期无人值守，`bot_token` 必然过期（iLink 返回 `errcode:-14 / session timeout`）。修复前 `runService` 把 `stale-token` 异常冒泡到 `process.exit(1)`，配合 systemd `Restart=always`+`RestartSec=5` 会**每 5 秒无限崩溃重启、空转打 iLink**，且 `/_health` 因进程反复退出没有可观测信号。

修复后：命中 `-14` 时循环进入可观测降级态 —— `status=needs_relogin`、`needsRelogin=true`、`/_health` 仍在线可查、只打一次 `NEEDS_RELOGIN` 日志、停止打 iLink（idle 可被 SIGTERM 立即唤醒），不退出进程。此时 `verify_health.mjs` 会**拒绝**把它判成 health=ok（线上验证不假绿），`deploy.sh [6/6]` 会打印 `DEPLOY-VERIFY-FAIL after 20 provenance polls` 并提示「token expired — run login.mjs once, then redeploy」。恢复动作 = 手机重扫一次 QR（`login.mjs` 写回 0600 env）再走 `deploy.sh`。

真实服务端到端证据：`_goal-autochat/health_e2e_r2.mjs` 把真实 `runService` 的健康态与降级态 `/_health` 分别灌进 `checkUrl`，得 `HEALTH-E2E-OK checks=2/2`（健康被收、降级被拒）。

## 本地已验证 / 未验证（如实）

- ✅ 已验证（r1+r2）：`node --check` 全绿；`gate.mjs` 21/21 + greenwash FAIL；`verify_deploy.mjs` 真独立进程 received=1 replied=1；`stale_token_gate.mjs` 7/7 + 3 mutant + greenwash FAIL；`verify_health.mjs --selftest` 4/4 + 6 mutant + 真实 HTTP 集成 + greenwash FAIL；`restart_gate_r2.mjs` 6/6（跨重启 cursor + 去重集延续）；`r2_import_scan.mjs` IMPORT-SCAN-OK（零三方依赖 / 零本机绝对路径）；`probe_live.mjs` 纯 HTTP 真达腾讯端点且假 token 被拒（-14）；`health_e2e_r2.mjs` 真实服务健康/降级双态灌判据 2/2。以上所列 r1+r2 各项为本地无头实测、带负控。
- ✅ 已验证（r3/r4/r9/r12）：WSL2 真 Linux 内核 + 原生 Linux node + `systemctl --user` / 随包 `deploy.sh` 真 systemd 语义托管、SIGKILL 后自动重启、真解析器 `systemd-analyze verify`、组装态 `deploy.sh` 在真 Linux 上拒网络黑洞（`r9_deploy_egress_e2e.out` 四场景 + 判据 11/11）；r12 开机自启 fail-open（enable `|| true` + 缺 `is-enabled`）修前 RED 真 Linux 复现（6/6）+ 修后四态 capstone（`r12_boot_e2e.out`，14/14 + 10 mutant + greenwash）。均为本机 WSL2 + 假 token + 边界 mock，无 WAN 依赖。
- ✅ 已验证（r14）：修前真 Linux RED 复现两类 fail-open（Face A：ambient DSH_EGRESS_HOST 漏剥，本地冒充器回 {errcode:-14} → EGRESS-OK 假绿；Face D：[6/6] 硬编码 8787，config healthPort=18888 → DEPLOY-HEALTH-FAIL 假红）；修后静态 SOURCE SENTINEL 闸 10/10 + 11 mutant、真 Linux 四态 GREEN 行为 E2E capstone 14/14 + 15 mutant、全新全链 verify_r14_final.sh 12/12。**注意**：r14 的 [6/6] 拨测端点取自 config（`--url`）的做法已被 r16/r17 废除（见下）。
- ✅ 已验证（r16/r17，WSL2 shim 仿真 MainPID + 假 token + 边界 mock）：`provenance_gate.mjs --selftest` 55/55 + 27 负控、mandatory `--expect-port`、20× `--check` OS-truth /proc 溯源（MainPID → LISTEN inode → keepAlive ESTABLISHED responder-bound H1 → freshness → 五判）；`port_gate.mjs --selftest` 31/31 + `--validate` managed-only PORT-EXPECT；r16 capstone 绿 3 态 / 红 6 态，`r16_capstone_judge.mjs` 61/61 + 12 mutant、`r16_red_judge.mjs` 24/24 + 21 mutant；`verify_r16_final.sh` 36 检查 R16-FRESH-ALL-GREEN；`COMMIT-MANIFEST-r16.md` MANIFEST-SHA-OK；r14/r15 冻 sha 链标 SUPERSEDED。r17 两负场景：`--expect-port 19999` → `untracked port source`、裸 `--check` → `expect-port missing`。
- ✅ 已验证（r18，本轮）：HOLE 3 真产品 fail-open 修复 —— `provenance_gate.mjs` 内 `systemBusEnv()` 浅拷贝 env 并删 `DBUS_SYSTEM_BUS_ADDRESS`/`DBUS_SESSION_BUS_ADDRESS` 两键（缺该变量 systemctl 才回落编译内建 SYSTEM bus），`readMainPid()` 用洗净 env 调 `execFileSync`；`deploy.sh:209` 再 `-u` 两键作防御纵深。新增 N9 自证组把 selftest 推到 **55/55 negatives=27/27**，`_r18_hole3_teeth.sh` 两个 gutted mutant（删两 delete / 传未洗 env）必被拒；`PROVENANCE_GATE_GREENWASH=1` 仍让 selftest 报 FAIL。README 16 处文档漂移（R18-RUNBOOK-DRIFT.md / R18-DRIFT-VERIFY-2ND.md：15 CONFIRMED + 1 PARTIAL 已收窄）全部对齐随包字节，并由 `r18_runbook_drift_gate.mjs` 机器闸锁住（带 selftest mutant + greenwash 负控）。H1 ESTABLISHED responder 集成负控（fork-after-listen SPLIT OWNERSHIP）机制已由 R18-REALINTEGRATION-AUDIT.md 真 /proc 证可行，但 HOLE 3 修后其夹具依赖被剥的 DBUS 重定向且本机无 root SYSTEM 单元 ⇒ 永久 capstone 接线**诚实 DEFERRED**，不宣称 CLOSED。
- ⏳ 未验证（外部凭据缺口 / 运行时 / 平台缺口，非代码缺陷）：**远程/云** Linux 主机上的系统级 `sudo ./deploy.sh`、真实 `bot_token` 扫码、真实手机往返消息、token 过期后真机重扫码恢复闭环、**真机一次 reboot 后 systemd 自动拉起服务**（WSL2 无真 boot，r12 用 `is-enabled` symlink 契约 + 可控 shim 证明判据有牙）、**真远端主机上的 `provenance_gate --check` 与 `port_gate --validate`**（当前只在 WSL2 shim 仿真面证过）、**群-on-server 平台能力缺口（永久）**。需要一台常开服务器 + 一次扫码 + 一次真重启；本会话无此凭据与目标主机，按 #48 落待办，不假称完成。r18 新增审计发现与残留见 _goal-autochat/ 目录的 DELIVERY-R18 报告与三处落账（07 分卷 / upgrade_suggestions.md / defect_tracking.json）；未独立复核前不写进本运行手册。

## 约束遵守

- 不碰鼠标/焦点、无 GUI、无键鼠、无窗口操作（#45 / 仓内最高约束）。
- 不改微信进程/二进制/内存、不重启微信、不重启 DSH 宿主。
- 不读/不打印任何真实 token 明文；env 0600 注入。
- 全部改动为本会话产出，落在 `server-deploy/` 新目录（工作区非 git 仓库，#40 的「提交」以可交付文件包 + 显式清单 + sha 自证体现）。
