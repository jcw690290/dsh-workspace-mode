# dsh-workspace-mode

给 **每个工作区** 配置各自的 **初始权限模式**（permission preset）的 DSH 插件。

DSH 原生只提供一个全局的「默认权限预设」：所有新会话都从同一个预设开始，需要手动切换。
这个插件按会话所在目录匹配规则，在会话刚创建时把权限预设自动设为规则指定的值——对经常在不同项目
目录之间切换、且各目录需要不同信任级别的人很有用。

```text
~\work\client      -> danger-full-access   （客户项目，全权限）
~\work\oss         -> workspace-write      （开源项目，默认）
D:\scratch          -> danger-full-access   （临时目录）
其他目录             -> 不干预，沿用全局默认
```

## 工作原理

1. 插件在 profile 中注册一个 Host 插件行，`inject: ['permissionPresets']` 依赖权限预设服务。
2. 用 `ctx.on('session/created', handler, { prepend: true })` 注册监听器。`prepend` 让它在
   `@deepseek-ai/dsh-permission-presets` 自己的 `session/created` 监听器 **之前** 执行。
3. 会话确实是「全新的」（权限投影里 preset / sandbox / approval 都为空且未 seeded）时，
   按 `header.cwd` 匹配规则，命中就调用 `ctx.permissionPresets.set(session, preset)`。
4. 权限服务随后执行默认的初始固定逻辑，看到权限状态已非空，只补齐缺失字段，不会覆盖本插件选定的预设。
5. 恢复的会话、fork 的会话、已 seed 的会话都带着持久化的权限事实，插件不会改动它们。

只使用 `ctx.on` 注册资源，插件随 fiber 生命周期自动释放；不引入任何 `@deepseek-ai/*` 依赖。

## 安装

要求 DSH 桌面端（Host 插件，无需构建步骤），Node.js >= 20 仅用于跑测试。

### 方式 A：Web 插件页

1. 打开 DSH 侧边栏「插件」页。
2. 安装 bundle，目标填写本仓库的 **绝对路径**（例如 `D:\Agent_Workspace\dsh-workspace-mode`），
   或用 git/tarball 地址。
3. 重启 DSH。

### 方式 B：plugin_manager 工具

在 Creator 预设（或已临时批准该工具）的会话里：

```text
plugin_manager install_bundle target=D:\Agent_Workspace\dsh-workspace-mode
```

然后重启 DSH。

> 安装后 bundle 的 `cordis.patch.yml` 会插入一行 `workspace-mode` 插件，
> 默认配置为空（`rules: []`），因此安装本身不会改变任何会话行为，需要下一步再加规则。

## 配置

在 profile 的 `cordis.patch.yml`（用户补丁层）里覆盖 `workspace-mode` 这一行的 config，
无需改动本仓库文件。补丁层会整体替换该行 config：

```yaml
- id: workspace-mode
  config:
    rules:
      - path: 'D:/Agent_Workspace/client'
        preset: danger-full-access
        label: 客户项目
      - path: 'D:/Agent_Workspace/oss'
        preset: workspace-write
      - path: '~/scratch'
        preset: danger-full-access
    includeSubagents: false
    caseSensitive: false
```

Windows 路径请用正斜杠或单引号包裹，避免 YAML 转义问题。`~/…` 会展开为当前用户主目录。

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `rules` | 数组 | `[]` | 工作区规则；按 **最长路径前缀** 优先匹配，同长度按声明顺序 |
| `rules[].path` | 字符串 | 必填 | 绝对目录路径，前缀匹配且尊重路径边界（`/work/client` 不匹配 `/work/client-other`），可写 `~/` |
| `rules[].preset` | 字符串 | 必填 | 权限预设名，必须是当前 profile 已配置的预设（默认 `workspace-write`、`danger-full-access`） |
| `rules[].label` | 字符串 | `''` | 仅用于日志/备注 |
| `includeSubagents` | 布尔 | `false` | 是否也对子代理会话生效；默认只作用于用户打开的工作区会话 |
| `caseSensitive` | 布尔 | Windows/macOS 为 `false`，Linux 为 `true` | 路径匹配是否区分大小写 |

配置在插件激活时校验：未知预设、相对路径、类型错误都会直接让插件激活失败并给出
`workspace-mode: ...` 错误信息，而不是静默跳过。

## 行为与限制

- **只影响新会话**：安装/改配置后，已存在的会话权限不变；新开会话才会套用。
- **只设置权限预设**，不改动 agent 预设（agent preset 在会话创建时由创建流程决定，插件无法改）。
- **子代理默认跳过**，因为它们继承父会话的信任边界；确需覆盖时打开 `includeSubagents`。
- 规则只作用于 `header.cwd` 有值且与规则目录存在祖先关系的会话；webhook 等以其他 cwd 创建的会话同样适用。
- 若权限投影尚未就绪，插件会跳过该会话并交给默认逻辑处理，不会阻塞会话创建。

## 验证

1. 打开一个命中规则的目录作为工作区，新建会话，查看会话日志/侧边栏权限徽标，应为规则指定预设。
2. 插件在命中时输出：
   ```text
   [workspace-mode] session <id> in <cwd> -> permission preset "danger-full-access" (客户项目)
   ```
   激活时输出 `[workspace-mode] N workspace rule(s) active`。
3. 打开不匹配的目录，应保持全局默认预设。

## 卸载

在「插件」页移除 bundle，或删除 profile 中的 `workspace-mode` 行，重启 DSH。
卸载后新会话回到全局默认权限预设。

## 开发 / 测试

```bash
npm test        # node test/match.test.mjs && node test/plugin.test.mjs
```

测试不依赖 DSH 运行时：用最小 fake context 模拟 cordis 事件顺序与权限投影的持久化语义，
覆盖新鲜会话、恢复会话、子代理、最长前缀、未知预设、非法配置等 20 个用例。

## License

MIT © 2026 jcw690290
