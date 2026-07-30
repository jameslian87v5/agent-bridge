# Agent Role & Spec Design

## 目标

在 Agent Bridge 中为每个 agent 定义角色（role）和共同准则（shared principles），让 agent 在收到事件时不仅知道"做什么"，还知道"我是谁、与谁协作、遵循什么准则"。

## 背景

当前问题：
- 所有 agent 收到相同的 inject template，都被告知"你是 bridge receiver"
- 没有区分谁负责实现、谁负责审查
- 没有项目级的共同准则（如对抗式审查、第一性原理）

## 设计

### 两层 Spec

1. **共同准则（Shared Principles）** — 项目级，所有 agent 共享
2. **Agent Role** — per-agent，个体级

### 共同准则

写入 `AGENT_BRIDGE.md` 的 `## 共同准则` 区块。内容示例：

```markdown
## 共同准则
- 对抗式审查：完成后主动找破口，不只复述方案为什么对
- 第一性原理：复杂问题先问最底层事实和不变量，不按既有代码类比修补
- 不 over-engineering
- review 写具体发现，不写空话
```

预设模板（用户可多选或自定义）：
- 对抗式审查
- 第一性原理
- TDD / 测试先行
- 不 over-engineering
- 最小改动原则
- 自定义

### Agent Role

写入 `AGENT_BRIDGE.md` 的 `## Agent Roles` 区块，同时存入 `control.json`。

`control.json` 结构：
```json
{
  "agents": {
    "codex-1": {
      "target": "tmux:codex-1",
      "role": "实现者。负责后端实现、跑测试。不做架构决策，不碰前端。收到 claude-1 的审查结果后修复问题。"
    },
    "claude-1": {
      "target": "tmux:claude-1",
      "role": "审查者。负责审查代码质量和架构合理性。不写实现代码。发现问题退回给实现者。"
    }
  }
}
```

`AGENT_BRIDGE.md` 渲染结果：
```markdown
## Agent Roles

### codex-1
- 角色：实现者。负责后端实现、跑测试。不做架构决策，不碰前端。收到 claude-1 的审查结果后修复问题。

### claude-1
- 角色：审查者。负责审查代码质量和架构合理性。不写实现代码。发现问题退回给实现者。
```

### Setup 交互流程

1. 配置每个 agent 时，问完 name 和 tmux target 后：
   ```
   Role description for codex-1? (optional, press Enter to skip)
   ```
   用户可写一句话或多行，也可跳过。跳过则默认 "bridge receiver"。

2. 所有 agent 配置完后，提示选择共同准则：
   ```
   Select shared principles (comma-separated numbers, or type your own):
   1. 对抗式审查
   2. 第一性原理
   3. TDD / 测试先行
   4. 不 over-engineering
   5. 最小改动原则
   ```
   用户可多选、自定义、或跳过。

3. 渲染 `AGENT_BRIDGE.md`，将共同准则和 agent roles 写入对应区块。

4. 将 role 存入 `control.json` 的 `agents[name].role`。

### 用户手动编辑

用户之后可随时：
- 编辑 `control.json` 修改 role
- 编辑 `AGENT_BRIDGE.md` 修改共同准则
- 重新运行 `agent-bridge setup --force` 重新生成

## 改动范围

1. `bridge.mjs` — `commandInteractiveSetup` 加 role 输入和准则选择
2. `bridge.mjs` — `commandInstallRules` / `linkAgentDocs` 渲染时注入 role 和准则区块
3. `templates/AGENT_BRIDGE.md` — 加 `## 共同准则` 和 `## Agent Roles` 占位区块
4. `lib/config.mjs` — `control.json` 的 agent 配置支持可选 `role` 字段
5. `bridge-watch.mjs` — inject template 渲染时，如 `{{role}}` 占位符存在则替换为 agent 的 role

## 不做

- 不做 EARS 语法
- 不做 Zod contract 验证
- 不做 9 阶段 pipeline
- 不做 spec 覆盖率追踪
- 不做自动 spec 生成
- role 只是自由文本，不做结构化解析

## 测试

- setup 交互流程：填入 role 和准则 → 检查 `control.json` 和 `AGENT_BRIDGE.md` 正确
- setup 跳过 role 和准则 → 检查默认值正确
- inject template 含 `{{role}}` → 检查渲染后替换正确
- 已有 `control.json` 不含 role → 不报错，向后兼容
