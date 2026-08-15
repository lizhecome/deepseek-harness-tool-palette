# DeepSeek Harness Tool Palette

面向 DeepSeek Harness 的渐进式工具发现插件。该 bundle 为每个 Agent 维护精简工具面板，并提供 `tool_search`；搜索可以只预览，也可以解锁最匹配的已安装工具，供后续步骤使用。

[English](README.md)

## 为什么需要它

安装大量插件和 MCP 后，每次模型请求都可能携带很多工具 schema。Tool Palette 让每个 Agent 初始只看到 `tool_search` 和部署指定的基础工具，需要其他能力时再搜索解锁。ToolRuntime 仍然是唯一权威，因此模型展示、工具查找、Code Mode binding 与实际执行会同步变化。

## 安装

仓库是私有仓库，请使用已登录的 GitHub CLI 克隆，再把 checkout 安装到 DSH profile：

```sh
gh repo clone lizhecome/deepseek-harness-tool-palette
cd deepseek-harness-tool-palette
dsh plugin --profile web add --ignore-workspace-root-check .
```

可以把 `web` 替换为 `headless` 或其他 profile 名称。该 bundle 会追加到 profile 已有 bundle 之后。

## 模型工具

`tool_search` 接收：

- `query`：非空的能力、操作、工具名或参数关键词。
- `unlock`：默认是 `true`；传入 `false` 时只返回匹配结果，不改变工具面板。

精确工具名优先，其后依次考虑工具名片段、完整描述、参数文本和查询词。排序是确定性的，同分时按精确工具名排序。

示例请求：

```text
查找能够写入文件的工具，然后创建 notes.txt。
```

```text
搜索已安装工具中与 subagent 委派有关的能力，但先不要解锁。
```

成功解锁后，结果会返回匹配的工具名，下一次模型步骤即可看到这些工具。可以反复调用 `tool_search` 逐步增加能力；已经可见的匹配项不会产生重复 restriction。

## Bundle 默认配置

随仓库提供的 `cordis.patch.yml` 会让以下标准 DSH 工具在搜索前保持可见：

```yaml
alwaysVisible:
  - read
  - glob
  - grep
  - exit_plan_mode
  - todo_write
maxResults: 8
maxQueryChars: 400
descriptionMaxChars: 240
```

`tool_search` 永远可见，不能重复写进 `alwaysVisible`。插件采用现有 Agent 时会验证基础工具的精确名称；配置引用了不存在的工具会明确失败，不会静默削弱面板配置。

若需要最小面板，可以在 profile patch 中覆盖 bundle 行：

```yaml
- id: tool-palette
  config:
    alwaysVisible: []
    maxResults: 6
    maxQueryChars: 300
    descriptionMaxChars: 180
```

## 作用域与生命周期

每个活跃 Agent 拥有一份可回滚的 allow-list restriction。两个根 Agent 独立解锁。子 Agent 也有自己的 restriction；当它解锁隐藏的全局工具时，Tool Palette 会同步放宽使该工具可达所必需的运行时祖先 restriction。兄弟 Agent 仍然保留自己的限制，不会自动获得该工具。直接注册在 Agent 自身作用域的工具不受该作用域 restriction 影响，因为 Harness 会在限制之后合并本地工具。

插件加载时会采用已经存在的 Agent，并监听后续 `agent/created`。Agent 销毁会清除自身状态。插件卸载或热重载时，会在注销 `tool_search` 前解除所有 restriction，恢复普通 Harness 工具表面。

解锁状态有意保持为进程内的提示性状态，不写入 Session 日志；Agent 或插件重新构造后会重置。每次模型请求的实际工具集合仍由 Harness 的可重建请求路径正常记录。

## Code Mode

在 Code Mode 下，保留的 `run_code` transport 位于能力 restriction 之外，因此始终可见。生成的 `tools` SDK 初始只声明 `tool_search` 与配置的基础工具。通过嵌套调用 `tool_search` 解锁后，下一步生成的 SDK 会包含新工具。原生 function calling 使用同一套面板，只是以普通 schema 展示。

## 安全与策略

隐藏工具是渐进式披露，不是权限边界。解锁不会绕过 `tools/pre-execute`、只向前收紧的 guard、审批、沙箱、文件观察、超时或工具自身校验。部署仍必须使用这些机制做安全决策。

插件不会发起网络请求，不读取文件，不启动子进程，也不保存凭据。目录搜索只检查 ToolRuntime 提供的脱离执行函数的全局 schema。搜索输出由 `maxResults` 和 `descriptionMaxChars` 限制。

## 模型体验

搜索前，隐藏的全局 schema 不进入该 Agent 的请求，从而降低每次请求重复携带的工具前缀成本。搜索会增加一组保留的工具调用与结果；解锁的 schema 从下一步开始贡献 token。可见 schema 集合发生变化时，该步骤的模型请求前缀也会变化，供应商 KV cache 只能复用此前相同的公共前缀。

## 限制

- 搜索覆盖全局 ToolRuntime schema；Agent 本地工具原本就可见，不作为目录匹配结果。
- 匹配使用确定性的词法搜索，不调用 embedding 或 LLM。
- 解锁只在当前活跃 Agent 生命周期内有效，不是持久化偏好设置。
- 子 Agent 解锁需要放宽相交的祖先 restriction，因此祖先 Agent 随后也能看到该工具；另有独立 restriction 的兄弟 Agent仍然看不到。
- 隐藏能力不能约束可信的同进程代码；安全策略应由 guard、审批和 capability provider 承担。

## 开发

需要 Node.js 24 和 pnpm 10.15.0。

```sh
pnpm install --frozen-lockfile
pnpm run check
npm pack --dry-run
```

单元测试使用已发布的 Harness 服务，覆盖原生展示、Code Mode SDK 重生成、确定性搜索、输入和输出边界、晚注册工具、根与兄弟 Agent 隔离、子 Agent 祖先继承、已有 Agent 采用、错误配置和插件完整卸载。

## 许可证

MIT
