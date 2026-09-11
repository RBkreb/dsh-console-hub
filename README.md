# dsh-console-hub

面向 **网络设备 console 映射端口**（串口服务器 / 终端服务器）的 DSH 插件：
用 Telnet 或 Raw TCP 连上设备的 console，做会话管理、命令交互与分页输出处理，
并把配置管理放进侧边栏标签页，把模型侧能力收敛成 `console_*` 工具。

> 状态：**Phase 0 完成**。宿主半与浏览器半均已落地，单元/集成用例与真机验收用例全部通过。
> 真机验收（`pnpm test:live`）已在 DPtech 防火墙 `10.133.6.253:10003` 与交换机
> `10.133.5.253:10015` 上跑通。

## 能力范围

- **配置管理**：设备视图（名称 / 主机 / 端口 / 协议 / 编码 / 提示符与分页规则）的增删改查；
  非敏感字段存插件自有设置，**凭据只进 credentials seam**，任何读路径都不回传密码。
- **会话管理**：连接 / 关闭（普通与强制）/ 发送（可选编码）/ 读取（游标增量、可选编码、可选回显过滤）
  / 等待提示符，分页输出（`--More--` 之类）自动持续翻页或自动退出。
- **安全管理**：`config` / `restart` 等高危指令拦截；模型路径经 DSH approval（fail-closed），
  界面路径为面板内二次确认 + 会话审计。
- **模型工具**：`console_list` / `console_connect` / `console_send` / `console_read` /
  `console_wait_for` / `console_close` / `console_describe`。

## 承载面

浏览器半边通过 `ctx.betterSidebar` 在 DSH 原生右侧栏注册一个标签页
（依赖 [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) v0.19+，可选依赖：
未安装时插件照常加载，只是不出现该标签页）。宿主半边不依赖 PTY，只用 `node:net` 打开 TCP 连接，
因此不受 `node-pty` 原生依赖降级的影响。

两个半边**不互相 import**：它们只在 `/dsh-console-hub/api` 这个路由上汇合
（见 `src/hub-route.ts`）。浏览器包只允许 `require` `react` 与 `react/jsx-runtime`。

## 安装

```sh
dsh plugin --profile <profile> add link:D:\dsh-hub\dsh-console-hub
```

host 半改动需要重启 Host；client 半由 `/plugins` 通道下发，刷新页面即可。

### 插件行配置

`cordis.yml` 的该插件行可配 `dsh-console-hub` 自己的宿主级参数：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `requestBodyLimitBytes` | `1048576` | 插件 API 单次请求体上限 |
| `sessionIdleSweepMs` | `15000` | 空闲会话回收器与「延迟策略生效」检查的间隔 |
| `trustedHosts` | `[]` | 非回环部署必须声明自己被访问的 `host:port`，否则 Host 栅栏会拒绝所有请求 |

## 开发

```sh
pnpm install
pnpm test        # vitest（宿主半 + 浏览器半），不含真机用例
pnpm test:live   # 连真实设备验收（需 lab 网络可达）
pnpm typecheck   # 两份 tsconfig：全量 + 纯浏览器声明面
pnpm build       # lib/index.js + lib/client.js + lib/types
```

> `pnpm test` 通过 `scripts/test-preload.mjs` 预载：Vite 在 Windows 上会探测一次
> `net use` 来优化 realpath，受限环境里该子进程会被拒（EPERM）并让测试直接起不来。
> 预载把这个纯环境探测短路掉，不影响任何被测逻辑。

### 实时联调

`tests/live/` 下的用例会连真实设备，默认**不参与** `pnpm test`：

```sh
pnpm test:live
```

`vitest.config.ts` 里对 `tests/live/**` 的排除是**有条件**的：vitest 无法把已被配置排除的
文件再从命令行加回来，所以写死排除会让这套用例永远跑不了。`scripts/test-live.mjs` 在 vitest
读取配置**之前**设置 `DSH_CONSOLE_LIVE=1`（Windows 上 shell 的 `VAR=1 cmd` 写法不可用）。

### 工具 schema：两种写法，极易混淆（踩过两次）

同一个工具定义里有**两套不同的 schema 写法**，混淆的后果分别是「工具静默消失」和
「整场对话无法开始」：

| 字段 | 写法 | 谁校验 |
| --- | --- | --- |
| `output.schema` | **raw JSON Schema** | `register()` 会校，不过会被拒 |
| `parameters` | **raw JSON Schema** | `register()` **完全不校**，直接发给模型 API |

而 `required` 的两种拼写就是陷阱本身：

- **授权 DSL**（`defineTool` 的入参）：`required: true` 写在**每个属性上**。
- **raw JSON Schema**：`required: ['a','b']` 写在 **object 节点上**，属性里**不能**有 `required`。

`register()` 走的是 raw 路径，它只校 `output.schema`。`parameters` 经 `schemaOf()`
**原样透传**给模型，所以若写成 DSL，顶层就没有 `type`，厂商会整份工具列表拒掉：

```
Invalid schema for function 'console_close':
  schema must be a JSON Schema of 'type: "object"', got 'type: null'
```

所以本仓库的 `parameters` 一律交给 harness 自己的编译器：

```ts
parameters: parameterSchemaSpecToJsonSchema({ /* 可读的 DSL */ })
```

这样手写不可能写错。改完用两个闸门验：

```sh
pnpm check:tools   # 拿真实校验器查全部定义（parameters + output.schema）
pnpm test          # 测试替身会对 parameters 跑 assertObjectJsonSchema
```

`pnpm check:tools` 存在的原因：`register()` 不检查 `parameters`，harness 在请求发出前
也不会发现——不主动查就只能等模型 API 报错。

## 真机实测结论（重要）

实验室两台设备（DPtech 防火墙 / 交换机）**连接后只发 Telnet 协商字节，然后完全静默**：
6 个字节 `IAC WILL ECHO` + `IAC WILL SGA`，没有 banner，也没有提示符，直到有按键才回应。
按一次回车才会出现提示符（防火墙 `<DUT1>`、交换机 `<SWITCH>`）。

因此插件提供了 `wakeOnConnect`（**默认关闭**）：仅当 banner 窗口内没等到任何提示符时，
才补发一个回车。已经在连接时打过招呼的设备**不会**收到这个多余的按键
（在某些 CLI 上回车是真实按键，会有副作用）。

排查同类设备时可用：

```sh
node scripts/probe-console.mjs 10.133.6.253:10003 4   # 裸看字节
node --import ./scripts/test-preload.mjs scripts/probe-live.mjs 10.133.6.253:10003 "show version"
```

## 目录

```
src/                  宿主半（配置、凭据、编解码、会话、路由、模型工具）
src/client/           浏览器半（侧边栏标签页、配置面板、控制台视图）
tests/                与 src 镜像的用例；tests/live/ 为真实设备验收
scripts/              构建/测试辅助脚本（含真机探针）
```

## 安全说明

- 设备凭据以 credentials **GrantRecord** 形式存储（`dsh-console-hub/<recordId>`），
  也可用环境变量引用（`DSH_CONSOLE_<RECORDID>`）覆盖；两者都不进入设置文档、HTTP 响应或工具返回值。
- 高危指令拦截是**防护栏**而非沙箱：设备侧通常接受缩写（如 `conf`、`reboot`），
  建议同时在设备上限制权限。完整的指令正则与审批模式可在插件设置里调整。
- 插件 API 与内置 `/api` 享受同一套 Host/Origin 栅栏；部署若组合了 connection seam，
  其浏览器鉴权也会叠加在本插件路由之上。

## License

MIT
