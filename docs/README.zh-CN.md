<div align="center">

[English](../README.md) | 中文 | [日本語](README.ja.md) | [Français](README.fr.md) | [Deutsch](README.de.md)

# Analytic Claude

**Claude Code 本地分析仪表板**

跟踪所有项目的成本、令牌使用量、工具使用情况和会话活动。
零云依赖。数据完全保留在本地。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Plugin-blueviolet)]()
[![ClickHouse](https://img.shields.io/badge/ClickHouse-24.8-yellow)]()
[![Grafana](https://img.shields.io/badge/Grafana-11.4-orange)]()

[安装](#安装) · [功能](#功能) · [更新](#更新) · [团队使用](#团队使用) · [语言](#语言)

</div>

---

![仪表板概览](../images/heroshot.png)

## 安装

### 1. 启动分析服务栈

```bash
git clone https://github.com/jimkeecn/Analytic_Claude.git
cd Analytic_Claude/docker-stack
docker compose up -d --build
```

等待约 30 秒。然后返回仓库根目录并打开 Claude Code：

```bash
cd ..
claude
```

运行 `/validate-infra` 以验证所有 4 个容器、数据表和物化视图是否正常运行。

### 2. 在项目中安装插件

在 Claude Code 中打开任意项目并安装插件：

```
/install-plugin /full/path/to/Analytic_Claude/plugin
```

### 3. 初始化

```
/init-claude-analytics
```

按照提示操作 — 确认项目名称，技能会自动完成所有配置。

### 4. 重启 Claude Code 并打开仪表板

重启会话以使遥测生效，然后打开：

**http://localhost:3000** (admin / admin)

导航至：**Home > Dashboards > Claude Analytics > Claude Analytics - OTel Overview**

完成。数据会立即开始流入。

---

## 功能

### 会话时间线

在单一视图中查看每个操作 — 提示、API 调用、工具执行、子代理调度、权限请求、压缩事件 — 从 OTel 和 hooks 合并到一个按时间排列的时间线中。

![会话历史](../images/sectionHistory.png)

### 成本与令牌分析

跨会话、模型和项目跟踪支出。查看每 1K 输出令牌的成本、令牌使用量随时间的变化、缓存命中率，并识别最昂贵的会话和提示。

### 技能与子代理跟踪

监控 Claude 使用的技能和子代理、它们的成功率、持续时间和模型选择。发现低效问题 — 高重复调用率意味着首次尝试可能失败了。

<div align="center">
<img src="../images/skillUsed.png" width="320" />
<img src="../images/subAgents.png" width="640" />
</div>

### 凭证暴露检测

自动检测 Claude 何时读取了敏感文件 — `.env`、AWS 凭证、SSH 密钥、证书、数据库配置 — 涵盖 13 个类别中的 38 种模式。无需配置。由 ClickHouse 物化视图提供支持，实时进行模式匹配。

![凭证暴露](../images/credentialExposure.png)

### 文件变更追踪

Claude 编辑、写入或删除的每个文件都会被跟踪，包括操作类型、文件扩展名和目录。查看哪些文件被修改最多，发现意外的删除操作。

![最常修改的文件](../images/mostModifiedFiles.png)

### 被阻止的操作检测

通过跟踪发出了 PreToolUse 事件但从未收到 PostToolUse 响应的工具调用，自动检测被拒绝或取消的操作。适用于审计 Claude 尝试但被阻止的操作。

### 工具延迟与慢速 URL

识别性能瓶颈 — 哪些工具在 p50/p95 上最慢，哪些 URL 获取耗时最长。

![工具延迟和慢速 WebFetch](../images/slowAgentAndWebFetch.png)

### 37 个仪表板面板

| 类别 | 面板 |
|------|------|
| KPI | Sessions, events, cost/1K tokens, total tokens, per-user cost |
| 成本 | Cost over time, top expensive sessions/prompts, cost per active minute, commits vs cost |
| 工具 | Tool usage, model usage, accept/reject rates, cache hit-rate |
| 延迟 | API latency percentiles, tool execution latency, slowest WebFetch URLs |
| 时间线 | Full session event history (2000 row limit) |
| 工作流 | Skills used, websites visited, MCP server calls, subagent usage |
| 文件 | Most modified files with action breakdown |
| 代码 | Lines of code per user, prompt length distribution |
| 安全 | Blocked actions, blocked rate over time, credential exposures |
| 运维 | Config changes, compaction events/frequency, recent errors |
| 反馈 | Survey funnel |

---

## 更新

```bash
cd Analytic_Claude
git pull
cd docker-stack
docker compose up -d --build
```

增量式数据库变更（新表、新物化视图）由 hooks-server 在启动时自动应用。如果某个版本包含破坏性的数据库变更（列类型修改、重新分区），请在 Analytic_Claude 项目中运行 `/migrate-db` — 它会引导你完成安全的并行迁移，并提示备份。

然后在每个项目中重新运行 `/init-claude-analytics` 以更新 hook 脚本和配置（如果有新版本可用）。该技能只会更新落后的部分 — 已是最新版本的不会被修改。

---

## 团队使用

本项目为个人开发者设计。如需适配团队使用：

1. **部署到共享服务器** — Docker 服务栈可以在任何服务器上运行。每个开发者将 OTel 端点和 hooks URL 指向服务器地址而非 localhost
2. **添加团队名称属性** — 在 `OTEL_RESOURCE_ATTRIBUTES` 中与 `project.name` 一起添加 `team.name`
3. **更新 ClickHouse 表** — 在目标表和物化视图中添加 `team_name` 列
4. **更新 Grafana** — 添加团队下拉变量并在所有面板中进行过滤

**在部署到服务器之前，必须确保服务栈的安全性：**

- 设置 ClickHouse 密码（默认配置没有身份验证）
- 更改 Grafana 管理员密码
- 使用防火墙限制端口访问 — 仅暴露端口 4317（OTel gRPC）、4319（hooks）和 3000（Grafana）
- 添加 TLS 以加密传输

Docker Compose 文件可以直接在云服务器上使用 — 但如果不执行这些安全步骤，任何能访问这些端口的人都可以查看您的遥测数据。

---

<div align="center">

**使用 [Claude Code](https://claude.ai/code) 构建**

如果这个项目对您的工作流有帮助，请给个 star！

</div>
