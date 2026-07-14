# Agent Bridge 收口阶段技术方案

## 背景

当前 Agent Bridge 已经完成独立化和多项目基础能力：

- `setup` 可初始化目标项目、安装规则、注册项目、绑定 agent 到 tmux target。
- registry 已落在 `~/.agent-bridge/projects.json`，支持多项目登记。
- `start` / `stop` / `status --run` 已支持在已注册项目目录内省略 project id。
- watcher、console、review、ack、`review_ready` 回灌链路已经可用。

剩余问题不是核心协议缺失，而是日常使用时还不够一眼看清：

- 多个项目同时跑时，不方便知道哪个项目正在运行。
- 用户仍要从 registry 或 README 里找 console 端口和 URL。
- `setup` 完成后的输出偏底层，不够像“一键完成后的操作提示”。

本阶段目标是做最后一层可用性收口，完成后暂停功能扩展。

## 目标

实现两个小功能：

1. `agent-bridge projects --status`
   - 列出所有已注册项目。
   - 显示每个项目的 path、console port、console URL、watchAll/console 是否运行。
   - 让用户不用记 project id 和端口。

2. 优化 `setup` 完成输出
   - 明确打印 project id、project path、console URL。
   - 明确打印可直接执行的下一步命令。
   - 如果用户选择立即启动，打印后台进程状态。

## 非目标

本阶段明确不做：

- 不做新的前端总控 dashboard。
- 不做 GitHub Issue / PR / CI 集成。
- 不做 Orca 风格 worktree 任务视图。
- 不做完整 worktree 生命周期管理。
- 不做复杂 daemon 健康探针或自动重启。
- 不改变 queue / inflight / review / ack 协议。

## 方案

### 1. `projects --status`

复用现有 registry 和 process-manager：

- `readRegistry()` 读取所有项目。
- 对每个项目调用 `statusProject(project.id)`。
- 输出保持 CLI 文本格式，不引入表格依赖。

示例输出：

```text
simple-chatapp-a1b2c3 running
  path=/Users/jameslian/Work/projects/simple-chatapp
  console=http://127.0.0.1:4088
  watchAll=running pid:12345
  console=running pid:12346
  agents=codex-1=tmux:codex-1, claude-main=tmux:claude-main

agent-bridge-d4e5f6 stopped
  path=/Users/jameslian/Work/projects/agent-bridge
  console=http://127.0.0.1:4089
  watchAll=stopped
  console=stopped
  agents=codex-1=tmux:codex-1
```

状态判断：

- `running`：`watchAll.running === true` 或 `console.running === true`。
- `stopped`：没有 run 文件，或两个进程都不是 running。
- 如果 run 文件存在但只有一个进程运行，显示 `partial`。

这样用户能快速判断：

- 哪个项目开着。
- console 地址是什么。
- 哪个后台进程异常退出了。

### 2. setup 输出优化

当前 setup 已经完成初始化和 registry 注册。只调整输出，不改变行为。

建议输出：

```text
projectId=simple-chatapp-a1b2c3
project=/Users/jameslian/Work/projects/simple-chatapp
bridgeDir=/Users/jameslian/Work/projects/simple-chatapp/.agent-bridge/workspaces/simple-chatapp-a1b2c3
config=/Users/jameslian/Work/projects/simple-chatapp/agent-bridge.workspace.json
console=http://127.0.0.1:4088
agents=codex-1=tmux:codex-1, claude-main=tmux:claude-main

next:
  cd /Users/jameslian/Work/projects/simple-chatapp
  agent-bridge start
  agent-bridge status --run
```

如果 interactive setup 里选择立即启动：

```text
started simple-chatapp-a1b2c3
  console=http://127.0.0.1:4088
  watchAll=pid:12345 running:true
  console=pid:12346 running:true
```

### 3. README 收口说明

README 增加一个最短路径小节：

```text
New project quick start
1. cd /path/to/project
2. agent-bridge setup
3. agent-bridge start
4. agent-bridge projects --status
```

同时说明：

- `projects` 看注册信息。
- `projects --status` 看运行状态和 console URL。
- 项目目录内可省略 project id。
- 跨目录控制时仍可使用 `<project-id>`。

## 测试计划

新增或调整测试：

1. `projects --status` 无项目
   - 输出 `projects: none` 或等价空状态。

2. `projects --status` 有已注册但未启动项目
   - 显示项目 id、path、console URL。
   - 状态为 `stopped`。

3. `projects --status` 有已启动项目
   - 显示 `running` 或受限沙箱下可接受的 `partial`。
   - 显示 watchAll / console 的 pid 与 running 状态。

4. `setup` 输出
   - 包含 `projectId=...`。
   - 包含 `console=http://127.0.0.1:<port>`。
   - 包含项目目录内可直接执行的 `agent-bridge start` 和 `agent-bridge status --run`。

继续保留现有验证：

```bash
npm run check
npm test
```

## 验收标准

本阶段完成后，用户可以按下面方式使用：

```bash
cd /path/to/project
agent-bridge setup
agent-bridge start
agent-bridge projects --status
```

并且能从输出中直接看到：

- project id
- project path
- console URL
- watcher 是否运行
- console 是否运行
- agent 到 tmux target 的绑定

满足以上标准后，Agent Bridge 当前版本收口，不继续扩展功能，除非后续真实使用暴露 bug。

## 风险与处理

1. 本地沙箱可能禁止 Node 监听 `127.0.0.1`
   - 测试中已存在 `canListenLocalhost()` 适配。
   - `projects --status` 只读取 pid/run 文件，不主动创建监听。

2. pid 复用仍是低概率风险
   - 当前只用 `process.kill(pid, 0)` 判断存活。
   - 本阶段不处理，保留为后续真实问题。

3. console 进程启动后立即退出
   - `projects --status` 会显示 `partial` 或 console stopped。
   - 用户可根据输出找到日志路径。

## 结论

推荐按本方案实施。它只补齐最后一层操作可见性，不改变核心协议，也不引入新系统。完成后 Agent Bridge 进入可日常使用状态，后续以 bugfix 为主。
