# dsh-workspace-mode

[![npm version](https://img.shields.io/npm/v/dsh-workspace-mode)](https://www.npmjs.com/package/dsh-workspace-mode)
[![tests](https://github.com/jcw690290/dsh-workspace-mode/actions/workflows/test.yml/badge.svg)](https://github.com/jcw690290/dsh-workspace-mode/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/dsh-workspace-mode)](https://github.com/jcw690290/dsh-workspace-mode/blob/main/LICENSE)

给 **每个工作区** 配置各自的 **初始权限预设**（permission preset）和 **初始模式**（agent preset，
即界面上的「模式」：标准模式、ptc 模式、以及你自己创建的模式）的 DSH 插件：图形界面在
**设置 → 工作区模式** 里为每个目录分配，也支持在 profile 里用 YAML 声明规则。

DSH 原生只提供一个全局的「默认权限预设」和一个全局的「默认模式」：所有新会话都从同一个组合开始，
需要手动切换。这个插件按会话所在目录匹配规则，在会话刚创建时把权限预设和模式自动设成规则指定的值——
对经常在不同项目目录之间切换、且各目录需要不同信任级别/不同模式的人很有用。

```text
D:\work\client      -> danger-full-access + ptc 模式     （客户项目，全权限）
D:\work\oss         -> workspace-write + 标准模式        （开源项目，默认）
D:\scratch           -> danger-full-access + 标准模式     （临时目录）
其他目录             -> 不干预，沿用全局默认
```

两个维度 **互相独立**：只给某个目录配了模式，它就只改模式，权限继续沿用全局默认；反之亦然。

## 两种配置方式

| 方式 | 适合 | 生效 |
| --- | --- | --- |
| **设置 → 工作区模式**（GUI） | 日常增删工作区、临时调整 | 保存即生效，无需重启 |
| profile 的 `cordis.patch.yml`（`rules`） | 配置即代码、批量维护、团队共享 | 重启 DSH 后生效 |

两者可以共存：同一个目录既有 GUI 条目又有 yml 规则时，**以 GUI 条目为准**。

## 工作原理

插件注册一个 Host 插件行，并在两个不同的时机各做一半：

### 权限预设：`session/created`

1. `inject: ['permissionPresets']` 依赖权限预设服务。
2. 用 `ctx.on('session/created', handler, { prepend: true })` 注册监听器。`prepend` 让它在
   `@deepseek-ai/dsh-permission-presets` 自己的 `session/created` 监听器 **之前** 执行。
3. 会话确实是「全新的」（权限投影里 preset / sandbox / approval 都为空且未 seeded）时，
   按 `header.cwd` 匹配规则，命中就调用 `ctx.permissionPresets.set(session, preset)`。
4. 权限服务随后执行默认的初始固定逻辑，看到权限状态已非空，只补齐缺失字段，不会覆盖本插件选定的预设。
5. 恢复的会话、fork 的会话、已 seed 的会话都带着持久化的权限事实，插件不会改动它们。

### 模式（agent preset）：`agent/created`

会话创建时总会先按注册表的全局默认模式组成 agent（创建请求必须解析出一个模式），所以插件没法在
「组成之前」插手。但 `agent/created` 在会话还是空白的时候就已触发，且允许异步监听器，于是：

6. 插件用 `ctx.on('agent/created', async ({ agent }) => …)` 监听，用 `ctx.get('agentPresets')`
   解析注册表（可选依赖，profile 里没有这一行时权限那一半照常工作）。
7. 只有当会话当前模式 **等于注册表默认模式** 时才切换：`await registry.select(agent, id)`。
   用户在「模式」菜单里自己选过的、或 `startSession(..., { agentPreset })` 明确指定的会话，
   投影里记录的值与默认值不同，插件一律保留、不覆盖。
8. 会话已经开始第一轮对话时，注册表本身会拒绝切换（`agent-preset/locked`），插件捕获后只记一条告警日志。
9. 模式名先对着 `registry.list()` 校验：不存在的名字、以及 `broken`（无法组成会话）的预设都会跳过并告警，
   不会让新会话失败。

### 设置表单

设置页之所以能改配置：插件导出一个 schemastery `Config`，字段全部标记为 `.volatile()`。
DSH 的 settings 服务把「profile 中 id 为 `workspace-mode` 的条目」的这些字段渲染成表单，
表单写入会就地改写这些引用；插件每次会话事件都重新读取（`get()`），所以改完立刻生效、不用重启。

只使用 `ctx.on` 注册资源，插件随 fiber 生命周期自动释放。唯一的运行时依赖是
`@deepseek-ai/schemastery`（用于声明设置表单）；缺失时插件会退化为「只读 YAML 配置」模式并给出警告日志，
不影响已有规则工作。

## 安装

要求 DSH 桌面端，Node.js >= 20 仅用于跑测试。

### 方式 A：Web 插件页

1. 打开 DSH 侧边栏「插件」页。
2. 安装 bundle，目标填包名 `dsh-workspace-mode`（已发布到 npm：https://www.npmjs.com/package/dsh-workspace-mode ），
   或本仓库的绝对路径、git 地址。
3. 重启 DSH。

### 方式 B：plugin_manager 工具

在 Creator 预设（或已临时批准该工具）的会话里：

```text
plugin_manager install_bundle target=dsh-workspace-mode
```

然后重启 DSH。

> 安装后 bundle 的 `cordis.patch.yml` 会插入一行 `workspace-mode` 插件，默认配置为空
> （`workspaces: {}`、`agentPresets: {}`、`rules: []`），因此安装本身不会改变任何会话行为，
> 需要下一步再加规则。

## 设置页：设置 → 工作区模式

打开 DSH 的「设置」对话框，左侧选「工作区模式」（位于「预设」之后）：

- **已分配的工作区**：每行一个目录，后面两个下拉框分别切换 **权限预设** 和 **模式**，
  「不指定（沿用默认）」表示该维度不干预；点「移除」删除整行。
- **添加工作区**：输入绝对路径（如 `D:\work\client` 或 `/home/me/client`），分别选权限预设
  和/或模式，点「添加」；路径不必存在，但必须是绝对路径。两个下拉框都不选时按钮不会写入任何东西。
- **同时作用于子代理会话**：默认关闭，子代理继承父会话的信任边界与模式。

说明：

- 目录按 **前缀** 匹配，`D:\work\client` 下的会话都会命中，`D:\work\client-other` 不会；
  多条命中时取前缀最长的规则。
- 权限和模式分开匹配：某个目录只配了模式时，权限那一维继续向上找更短的匹配，或落到全局默认。
- 如果某个 profile 没有 agent preset 注册表，模式一栏会显示提示并保持为空，权限部分照常存在。
- 写入落在当前 profile 的补丁层（与手改 `cordis.patch.yml` 等价），随 profile 保存。
- 如果页面显示「无法编辑」：说明当前值来自更高优先级的配置层（home 补丁或命令行覆盖），
  或者插件没装全依赖（缺少 `@deepseek-ai/schemastery`）。

## 配置（cordis.patch.yml）

不经过 GUI 时，在 profile 的 `cordis.patch.yml`（用户补丁层）里覆盖 `workspace-mode` 这一行的 config，
无需改动本仓库文件。补丁层会整体替换该行 config：

```yaml
- id: workspace-mode
  config:
    workspaces:
      'D:/work/client': danger-full-access
      'D:/work/oss': workspace-write
    agentPresets:
      'D:/work/client': ptc
      'D:/work/oss': standard
    rules:
      - path: '~/scratch'
        preset: danger-full-access
        agentPreset: standard
        label: 临时目录
      - path: '~/research'
        agentPreset: reverse      # 只改模式，不动权限
    includeSubagents: false
    caseSensitive: false
```

Windows 路径请用正斜杠或单引号包裹，避免 YAML 转义问题。`~/…` 会展开为当前用户主目录。
`agentPresets` 的值是模式的 **id**（注册表里那一行的 id，例如 `standard`、`ptc`、`reverse`），
不是显示名。

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `workspaces` | 对象 | `{}` | `{ "绝对目录": "权限预设名" }`，设置页写入的就是它；优先级高于 `rules` |
| `agentPresets` | 对象 | `{}` | `{ "绝对目录": "模式 id" }`，设置页写入的「模式」一列；优先级高于 `rules` |
| `rules` | 数组 | `[]` | 工作区规则；按 **最长路径前缀** 优先匹配，同长度按声明顺序；可只写其中一个维度 |
| `rules[].path` | 字符串 | 必填 | 绝对目录路径，前缀匹配且尊重路径边界（`/work/client` 不匹配 `/work/client-other`），可写 `~/` |
| `rules[].preset` | 字符串 | `''` | 权限预设名，必须是当前 profile 已配置的预设（默认 `workspace-write`、`danger-full-access`） |
| `rules[].agentPreset` | 字符串 | `''` | 模式 id，必须是当前 profile 的 agent preset 注册表里存在的 id |
| `rules[].label` | 字符串 | `''` | 仅用于日志/备注 |
| `includeSubagents` | 布尔 | `false` | 是否也对子代理会话生效；默认只作用于用户打开的工作区会话 |
| `caseSensitive` | 布尔 | Windows/macOS 为 `false`，Linux 为 `true` | 路径匹配是否区分大小写 |

`rules[i].preset` 和 `rules[i].agentPreset` 至少要写一个。配置在插件激活时校验：
未知权限预设、相对路径、类型错误都会直接让插件激活失败并给出 `workspace-mode: ...` 错误信息，
而不是静默跳过。**设置页的写入走宽松模式**：写错的权限预设名只会在会话事件里告警并跳过那一条规则的
权限维度（模式维度仍可用），不会让插件或新会话失败。模式名在切换前才对着注册表校验。

## 行为与限制

- **只影响新会话**：安装/改配置后，已存在的会话权限和模式都不变；新开会话才会套用（设置页的修改同理）。
- **模式只切换「仍在默认模式」的会话**：用户自己选过模式、或会话已经开始对话的，一律不动。
- **子代理默认跳过**，因为它们继承父会话的信任边界；确需覆盖时打开 `includeSubagents`。
- 规则只作用于 `header.cwd` 有值且与规则目录存在祖先关系的会话；webhook 等以其他 cwd 创建的会话同样适用。
- 若权限投影尚未就绪，插件会跳过该会话并交给默认逻辑处理，不会阻塞会话创建。
- profile 没有 agent preset 注册表（`ctx.get('agentPresets')` 解析不到）时，模式维度整体跳过并告警一次，
  权限维度不受影响。
- 设置页是「设置」里的独立一栏，而不是嵌在「预设」页内部：DSH 的预设页没有暴露子插槽。

## 验证

1. 打开一个命中规则的目录作为工作区，新建会话，查看侧边栏的权限徽标和「模式」选择器，
   应分别是规则指定的权限预设和模式。
2. 插件在命中时输出：
   ```text
   [workspace-mode] session <id> in <cwd> -> permission preset "danger-full-access" (临时目录)
   [workspace-mode] session <id> in <cwd> -> agent preset "ptc" (客户项目)
   ```
   激活时输出 `[workspace-mode] N workspace rule(s) active`。
3. 打开不匹配的目录，应保持全局默认权限预设和默认模式。
4. 在设置页给当前工作区加一条规则，立刻新建会话：应当直接命中，无需重启。
5. 在会话里手动把模式切成别的预设，然后在该目录再开一个新会话：新的会切回规则指定的模式。

## 卸载

在「插件」页移除 bundle，或删除 profile 中的 `workspace-mode` 行，重启 DSH。
卸载后新会话回到全局默认权限预设和默认模式。

## 开发 / 测试

```bash
npm install     # 只为 @deepseek-ai/schemastery
npm test        # match + plugin + settings + client 四组用例
```

浏览器端 `lib/client.js` 是手写的预构建 bundle（`window.__ModuleLoader__.load` + `react.createElement`），
没有打包步骤：改完直接读文件即可，DSH 重启后生效。测试不依赖 DSH 运行时：用最小 fake context 模拟
cordis 事件顺序、agent preset 注册表的 `list`/`select`、schemastery 的 volatile 引用、settings 表单和
浏览器插槽，共 43 个用例。

## License

MIT © 2026 jcw690290
