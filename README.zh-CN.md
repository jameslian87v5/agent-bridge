# Agent Bridge — Real Agent Loop Engineering

让 Codex、Claude Code、OpenCode 等多个 CLI Agent 在**同一份持久化上下文**中协作——历史不重述、状态不丢失。

没有数据库、没有云服务、没有中央服务器——只有 JSON 文件、tmux 和一个小型 Web 控制台。

```text
agent-bridge/                        # 本仓库：工具本体，安装一次
/path/to/your-project/.agent-bridge/ # 每个项目：自己的运行时数据
```

[English README](./README.md)

---

## 为什么需要它

现在让两个 CLI Agent 协作，常见做法是在一个 Agent 里把另一个当工具调用，或者用某个 Agent 的 plugin 机制包一层。这些方式有几个共同的硬伤：

| 弊端 | 说明 |
|------|------|
| **上下文有损** | 调用方必须先把需求**压缩成一段 prompt** 传给子 Agent；子 Agent 的回答再被压缩回来。两端都在摘要，细节在传递中丢失 |
| **主从结构** | 一个 Agent 是"主人"，另一个是"工具"。子 Agent 看不到全局，只能看到主人决定给它的那部分；也无法反向发起请求 |
| **过程不可见** | 子 Agent 干了什么、推理过程如何，藏在一次工具调用里，人很难审计 |
| **无状态、不可恢复** | 调用失败、超时、中断，这次协作就没了。没有队列、没有重试、没有记录 |
| **单线程阻塞** | 主人发起调用后只能干等，不能异步发多个任务，也不能暂停/审批 |
| **历史要重述** | 每次协作都是一次"新的通话"。上一轮讨论过什么、background 是什么，要么塞进 prompt 重述（占上下文、还可能摘要失真），要么干脆丢掉，对方从零开始 |

## Agent Bridge 的做法：统一上下文，历史不用重述

核心思路一句话：**所有协作状态持续落盘，双方始终活在同一个上下文里。**

```text
❌ plugin / 工具调用模式：
   每次协作都是一次"新的通话"。上一轮讨论过什么、background 是什么，
   要么塞进这次的 prompt 里重述一遍（占上下文、还可能摘要失真），
   要么干脆丢掉，对方从零开始。

✅ Agent Bridge 模式：
   事件、artifact、review、线程（threadId + replyTo）全部持久化在同一份
   workspace 里。新事件不需要重述历史——接收方顺着 threadId 就能把
   整个链条的原文读回来。上下文是累积的，不是每次重传的。
```

具体保证：

- **历史可回溯，不用重复说**：`replyTo` + `threadId` 把事件串成线程，任何一方随时可以回读这条线上每一轮的原始请求和 review 全文。第三轮不需要重述第一轮说了什么——它直接去读文件
- **接收方读事实，不听转述**：事件只带引用（文件路径、git diff、artifact），接收 Agent 被要求自己检查仓库实际状态，而不是相信发送方的描述。这避免了"传话导致信息失真"
- **review 是全文，不是回包**：review 落盘为完整 markdown 文件，对方读原文，不存在工具返回值被截断、被 JSON 转义、被长度限制的问题
- **中断不丢上下文**：进程重启、隔天继续、甚至换一台机器——磁盘上的 queue/inflight/review/done 就是完整现场，捡起来接着干。不需要"恢复会话"
- **人能随时进入同一上下文**：console 里看到的就是 Agent 看到的——同样的 queue、同样的 review、同样的 ack。审计和接管不需要额外同步，不存在"Agent 知道但人不知道"的信息差

### 一个具体例子

```
第 1 轮：codex-1 发事件给 claude-1，要求审查架构设计文档
         → claude-1 写 review（6 个 blocking 项 + 4 个 should-fix）
         → watcher 自动通知 codex-1：review_ready

第 2 轮：codex-1 读 review，决定让 claude-1 继续做 M3 迁移方案
         → send 新事件，--reply-to 指向第 1 轮事件，--thread-id 保持一致
         → claude-1 收到后不需要重读第 1 轮的 review（它自己写的），
           也不需要 codex-1 在 prompt 里复述 review 内容
         → 顺着 threadId 就能回溯整条链

第 3 轮（隔天）：机器重启了，agent 进程都没了
         → agent-bridge start，watcher 读磁盘状态
         → inflight 里的事件自动刷新超时窗口，继续等待 ack
         → 没有任何上下文丢失
```

## 对等工作，不是主从调用

任何 Agent 都可以向任何 Agent 发任务，支持真正的协作模式：

```text
supervisor ──派活──▶ worker ──交 review──▶ supervisor ──拍板──▶ 新任务
```

- **对等**：没有"主人"和"工具"的区分。codex-1 可以给 claude-1 派活，claude-1 也可以反过来要求 codex-1 修改。每个 Agent 在自己的 tmux 终端里独立运行，互不阻塞
- **review 闭环是 one-shot**：review 不会触发更多 review。需要继续就用 `send` 发新事件（带 `replyTo` + `threadId` 串成线程）。这保证了每次协作有明确的开始和结束，不会陷入无限递归
- **防乒乓**：auto 模式下每个 Agent 有 hop 预算（默认 10 次/链），耗尽后停下来等人审批。不会两个 Agent 互相"你看看""你再看看"无限循环
- **异步 + 可靠性**：事件入队即返回，发送方不用干等。超时未 ack 自动重注入；tmux 死了或重试耗尽进 `failed/`，不丢事
- **人在回路**：manual 模式每个事件都要人点 approve 才会注入。auto 模式下 hop 预算耗尽也会停下来等人。人始终有控制权

## 工作原理（60 秒）

```text
Agent A                          Agent B
  │                                │
  ├─ send queue event ──────────▶  │ watcher 注入 B 的 tmux 终端
  │                                ├─ B 读事件、干活
  │                                ├─ B 先写 ack（防超时重注入）
  │                                ├─ B 干活，写 review
  │  ◀── review_ready（自动）──────┤ watcher 通知 A
  ├─ A 读 review                   │
  │                                │
  │  还要继续？发一个【新】事件 ──▶ │（绝不用 review 回 review）
```

全部状态就是看得见摸得着的目录：

```text
queue/      等待处理的事件
inflight/   已注入、等待 ack
reviews/    接收方写的 review（完整 markdown）
acks/       关闭事件的 JSON 标记
done/       已完成事件
failed/     投递失败的事件（可在 console 看到、可重发）
artifacts/  长上下文请求文件（不占事件正文）
logs/       watcher 日志
```

三条铁律：

- **queue 产生工作** — 需要别的 Agent 行动，就发新事件。不要把新工作藏在 review 里
- **review 只记录结果** — review 不连锁触发 review。一收一发，到此为止
- **ack 先写，review 后写** — ack 立即确认收到（防止 5 分钟超时重注入），review 完成工作后再写。watcher 检测到任一文件就把 inflight 移到 done

## 快速开始

```bash
# 1. 安装（一次）
cd /path/to/agent-bridge && npm link

# 2. 在项目里初始化
cd /path/to/your-project
agent-bridge setup --link-agent-docs --include-windsurf

# 3. 给每个 Agent 开一个 tmux session（名字要和 target 一致）
tmux new -s codex-1      # 里面：cd 项目 && codex
tmux new -s claude-1     # 里面：cd 项目 && claude

# 4. 启动
agent-bridge start       # console + 所有 watcher 后台运行
```

发任务：

```bash
agent-bridge send \
  --from codex-1 --to claude-1 \
  --subject "审查当前 diff" \
  --body "请检查当前 diff，写 review + ack。"
```

继续线程（不用重述历史）：

```bash
agent-bridge send \
  --from codex-1 --to claude-1 \
  --reply-to evt_20260804120000 \
  --thread-id "architecture-review" \
  --subject "请出 M3 线上表迁移方案" \
  --body "按你上轮 review 里的 M3 项继续。"
```

打开 console（默认 http://127.0.0.1:4088）可以看到所有事件流转、审批事件、
改 agent 配置和稳定性参数。

## 关键机制

### 超时与重试

注入后 5 分钟（`inflightTimeoutMs`）没 ack 也没 review → 自动重注入，`retryCount + 1`。
最多重试 2 次（`maxRetries`）。tmux session 死了直接进 `failed/`。
如果已有 review 或 ack，视为完成，移到 `done/`。
**长任务建议**：Agent 收到事件后先写 ack 确认收到，再慢慢干活写 review。
这样不会触发超时重注入。

### restart 一步到位

`agent-bridge restart` = 停进程 + 用最新 `control.json` 重新渲染规则文件
（`AGENT_BRIDGE.md` / `CLAUDE.md` / `AGENTS.md`）+ 启动。
改完 agent 角色或共享原则后 restart 一下，所有规则文件同步刷新。
inflight 事件获得新的超时窗口，不会被立即重注入。

### Agent 角色

每个 agent 可配 `role`（如 "supervisor, no coding just design"），
自动注入到它的任务模板里。接收方知道自己的角色定位。

### 共享原则

项目级的协作原则写进规则文件，所有 Agent 共同遵守。默认五条：
系统思维、架构思维、第一性原理、对抗式审查、奥卡姆剃刀。
可在 console 里自定义。

### 统一注入模板

内置一份通用模板（`{{agentName}}` 自动替换），新 agent 零配置可用。
也可在 console 给特定 agent 自定义模板（如加入项目特定的上下文引用）。

### Loop Budget（auto 模式防乒乓）

auto 模式下每个事件携带 `autoHops` 计数器，按 agent 分别累计：

```json
{ "replyTo": "evt_1", "autoHops": { "codex-1": 4, "claude-1": 3 } }
```

- 每次注入时该 agent 的计数 +1
- `--reply-to` 和 `review_ready` 事件继承计数
- 达到 `maxAutoHopsPerAgent`（默认 10）后停止自动注入，等人 approve
- `send` 不带 `--reply-to` 开始新链，预算重置
- 超时重试不消耗预算

### Worktree 隔离

需要隔离的实现工作可以加 `--worktree`，接收方在独立 git worktree 里改代码，
review 和 ack 仍写到原始 bridge 路径。

## Console

`agent-bridge start` 自动启动 console，或手动：

```bash
agent-bridge-console --port 4088   # http://127.0.0.1:4088
```

一个项目一个 console，端口从 4088 自动分配。

Console 能看到 queue / inflight / failed / done / reviews / logs，
还能直接编辑 `control.json`：

- **Agent 配置** — tmux target、注入模板、role
- **稳定性参数** — `maxInflight`、`inflightTimeoutMs`、`maxRetries`、`maxAutoHopsPerAgent`、`verifyInject`

Watcher 每次轮询都重读 `control.json`，改完即时生效不用重启。
**例外**：role 和 principles 的修改需要 `restart` 才会同步到规则文件。

## 适用场景

- **双 Agent 结对**：Codex 写码、Claude Code 审查（或反过来），互相挑刺直到收敛。比 plugin 调用多了完整的过程记录和可中断恢复
- **supervisor / worker**：一个 Agent 只做设计和验收，另一个只做实现。role 配置让双方知道自己的边界
- **长链路任务**：跨多轮、跨小时甚至跨天的协作。中断了从磁盘状态完整恢复，不用重述历史
- **需要审计的团队**：每一次 Agent 间的请求和结论都有文件记录，可回溯。人通过 console 进入同一上下文，不存在信息差
- **多 Agent 编排**：3+ 个 Agent 协作（如架构师 → 前端实现 → 后端实现 → 审查），每个 Agent 独立终端、独立 watcher，通过 queue 路由

## 与 plugin / 工具调用模式对比

| 维度 | plugin / 工具调用 | Agent Bridge |
|------|-------------------|--------------|
| 上下文 | 每次压缩成 prompt，历史要重述 | 持久化落盘，threadId 回溯全文 |
| 结构 | 主从，子 Agent 无法反向发起 | 对等，任何 Agent 可向任何 Agent 发任务 |
| 过程 | 黑盒，藏在工具调用里 | 全部是文件，人随时可审计 |
| 可恢复 | 失败即丢失 | 磁盘状态完整，重启即恢复 |
| 并发 | 阻塞，干等返回 | 异步，入队即返回 |
| 控制 | 无 | manual/auto + approve + hop budget |
| 可靠性 | 无 | 超时重试 + failed 目录 + verifyInject |
| Agent 独立性 | 子 Agent 被宿主约束 | 每个 Agent 在自己终端里，完全独立 |

## 项目结构

```text
本仓库（版本化工具）：
  bridge.mjs            CLI 入口
  bridge-watch.mjs      单 agent watcher
  bridge-watch-all.mjs  为每个配置的 agent 启动 watcher
  bridge-console.mjs    Web 控制台
  lib/config.mjs        默认值、control.json 处理
  lib/registry.mjs      项目注册表
  lib/process-manager.mjs  进程管理
  templates/AGENT_BRIDGE.md  agent 规则模板

你的项目（只有运行时数据）：
  agent-bridge.workspace.json
  .agent-bridge/
```

不要把工具源码复制到每个项目里。

## License

MIT
