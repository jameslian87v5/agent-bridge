# Agent Bridge（中文说明）

让 Codex、Claude Code、OpenCode 等多个 CLI Agent 在**同一份持久化上下文**中协作——历史不重述、状态不丢失。

没有数据库、没有云服务、没有中央服务器——只有 JSON 文件、tmux 和一个小型 Web 控制台。

```text
agent-bridge/                        # 本仓库：工具本体，安装一次
/path/to/your-project/.agent-bridge/ # 每个项目：自己的运行时数据
```

[English README](./README.md)

## 为什么需要它

现在让两个 CLI Agent 协作，常见做法是：

- 在 Claude Code 里把 Codex 当工具调用（或反过来）
- 用某个 Agent 的 plugin 机制包一层

这些方式有几个共同的硬伤：

| 弊端 | 说明 |
|------|------|
| **上下文有损** | 调用方必须先把需求**压缩成一段 prompt** 传给子 Agent；子 Agent 的回答再被压缩回来。两端都在摘要，细节在传递中丢失 |
| **主从结构** | 一个 Agent 是"主人"，另一个是"工具"。子 Agent 看不到全局，只能看到主人决定给它的那部分；也无法反向发起请求 |
| **过程不可见** | 子 Agent 干了什么、推理过程如何，藏在一次工具调用里，人很难审计 |
| **无状态、不可恢复** | 调用失败、超时、中断，这次协作就没了。没有队列、没有重试、没有记录 |
| **单线程阻塞** | 主人发起调用后只能干等，不能异步发多个任务，也不能暂停/审批 |

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

- **历史可回溯，不用重复说**：`replyTo` + `threadId` 把事件串成线程，任何一方随时可以回读这条线上每一轮的原始请求和 review 全文
- **接收方读事实，不听转述**：事件只带引用（文件路径、git diff、artifact），接收 Agent 被要求自己检查仓库实际状态，而不是相信发送方的描述
- **review 是全文，不是回包**：review 落盘为完整 markdown，对方读原文，不存在工具返回值被截断的问题
- **中断不丢上下文**：进程重启、隔天继续，磁盘上的 queue/inflight/review 就是完整现场，捡起来接着干
- **人能随时进入同一上下文**：console 里看到的就是 Agent 看到的，审计和接管不需要额外同步

## 对等工作，不是主从调用

任何 Agent 都可以向任何 Agent 发任务，支持真正的协作模式：

```text
supervisor ──派活──▶ worker ──交 review──▶ supervisor ──拍板──▶ 新任务
```

- **review 闭环是 one-shot**：review 不会触发更多 review，需要继续就用 `send` 发新事件（带 `replyTo` + `threadId` 串成线程）
- **防乒乓**：auto 模式下每个 Agent 有 hop 预算（默认 10 次/链），耗尽后停下来等人审批，不会两个 Agent 无限互相回
- **异步 + 可靠性**：事件入队即返回；超时未 ack 自动重注入；tmux 死了或重试耗尽进 `failed/`，不丢事
- **人在回路**：manual 模式每个事件都要人点 approve；console 里能看到全部 queue/inflight/failed/review

## 工作原理（60 秒）

```text
Agent A                          Agent B
  │                                │
  ├─ send queue event ──────────▶  │ watcher 注入 B 的 tmux 终端
  │                                ├─ B 读事件、干活
  │                                ├─ B 写 review + ack
  │  ◀── review_ready（自动）──────┤ watcher 通知 A
  ├─ A 读 review，ack 关闭         │
  │                                │
  │  还要继续？发一个【新】事件 ──▶ │（绝不用 review 回 review）
```

全部状态就是看得见摸得着的目录：

```text
queue/      等待处理的事件
inflight/   已注入、等待 ack
reviews/    接收方写的 review
acks/       关闭事件的 JSON 标记
done/       已完成事件
failed/     投递失败的事件（可在 console 看到、可重发）
artifacts/  长上下文请求文件
logs/       watcher 日志
```

三条铁律：

- **queue 产生工作** — 需要别的 Agent 行动，就发新事件
- **review 只记录结果** — review 不连锁触发 review
- **ack 关闭事件** — watcher 把 inflight 移到 done

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
agent-bridge start       # console + 所有 watcher
```

发任务：

```bash
agent-bridge send \
  --from codex-1 --to claude-1 \
  --subject "审查当前 diff" \
  --body "请检查当前 diff，写 review + ack。"
```

打开 console（默认 http://127.0.0.1:4088）可以看到所有事件流转、审批事件、
改 agent 配置和稳定性参数。

## 关键机制

- **超时重试**：注入后 5 分钟没 ack 自动重发，最多重试 2 次；tmux session 死了直接进 `failed/`
- **restart 一步刷新**：`agent-bridge restart` = 停进程 + 用最新 `control.json` 重新渲染规则文件（`AGENT_BRIDGE.md`/`CLAUDE.md`/`AGENTS.md`）+ 启动
- **Agent 角色**：每个 agent 可配 `role`（如 "supervisor, no coding"），自动注入到它的任务模板里
- **共享原则**：项目级的协作原则（系统思维、对抗式审查等）写进规则文件，所有 Agent 共同遵守
- **统一注入模板**：内置一份通用模板（`{{agentName}}` 自动替换），新 agent 零配置可用；也可在 console 给特定 agent 自定义

完整命令、模式（manual/auto）、loop budget、worktree 隔离等细节见
[English README](./README.md)。

## 适用场景

- **双 Agent 结对**：Codex 写码、Claude Code 审查（或反过来），互相挑刺直到收敛
- **supervisor/worker**：一个 Agent 只做设计和验收，另一个只做实现
- **长链路任务**：跨多轮、跨小时的协作，中断了能从磁盘状态完整恢复
- **需要审计的团队**：每一次 Agent 间的请求和结论都有文件记录，可回溯
