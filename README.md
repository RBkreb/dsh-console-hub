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
- **会话管理**：连接 / 关闭（普通与强制）/ 发送（可选编码；**空行合法**，等于按一次回车）
  / 读取（游标增量、可选编码、可选回显过滤）/ 等待提示符 / 唤醒（补一个回车）/ 清空本地回显，
  分页输出（`--More--` 之类）自动持续翻页或自动退出；设备空闲半关闭（休眠）**自动探测 + 自动唤醒
  + 保活**。
- **安全管理**：`config` / `restart` 等高危指令拦截；模型路径经 DSH approval（fail-closed），
  界面路径为面板内二次确认 + 会话审计。
- **模型工具**：`console_list`（**已连接**）/ `console_list_views`（**已配置**）/ `console_connect` /
  `console_send` / `console_wake` / `console_read` / `console_wait_for` / `console_close` /
  `console_describe` / `console_clear` / `console_upsert_view` / `console_remove_view`。

> **两个 list 回答两个不同的问题**，不要混用：
> `console_list` 返回**当前已连接**的控制台（它的 handle 供 send/read/close 使用）；
> `console_list_views` 返回**已配置**的设备（它的 viewId 供 connect 使用）。
> 模型要操作某台设备时，先 `console_list_views` 找到 viewId，再 `console_connect` ——
> **优先用 view 而不是 host+port**，因为只有 view 携带它存储的凭据和提示符/分页规则。
> 模型也能直接管理清单：`console_upsert_view` 新建/修改，`console_remove_view` 删除。

> `console_clear` 只丢弃**本进程**已读回显，不向设备发送任何东西、不断开连接。
> 面板上的「清空」按钮走同一条路径。

> **空 `text` 是合法发送**（不传或传 `""`）：只发一个回车，不执行任何命令。
> 这是唤醒休眠控制台、手工翻页的手段。空格等空白**原样发送不裁剪**——`--More--` 的下一页键
> 就是**一个空格**，裁剪它会发出别的东西。面板同理：输入框留空点「发送」即只发回车，
> 「回车」按钮是它的快捷方式。

## 承载面

浏览器半边通过 `ctx.betterSidebar` 在 DSH 原生右侧栏注册一个标签页
（依赖 [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) v0.19+，可选依赖：
未安装时插件照常加载，只是不出现该标签页）。宿主半边不依赖 PTY，只用 `node:net` 打开 TCP 连接，
因此不受 `node-pty` 原生依赖降级的影响。

两个半边**不互相 import**：它们只在 `/dsh-console-hub/api` 这个路由上汇合
（见 `src/hub-route.ts`）。浏览器包只允许 `require` 平台模块表里的那几个
（`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`），其余一律内联；
`@deepseek-ai/*` 的值导入会被构建期 purity 闸门直接拒绝（类型导入会被擦除，不受影响）。

### 界面构成

标签页的左侧栏**只放已连接的控制台**。设备配置是**弹窗**（`ConfigModal.tsx`），
由一个「设备配置」按钮打开——配置是低频操作，已连接的工作设备才是主体，
设备一多就不该挤占左栏。

弹窗通过 `react-dom` 的 `createPortal` 挂到 `document.body`：
标签页本身位于侧边栏自己的层叠上下文里，绝对定位的面板会被侧边栏的
`overflow` 裁掉，而不是盖在它上面。

左栏与右侧控制台之间的分隔条**可拖动**（`Splitter.tsx`），宽度存进共享 prefs
（`listWidthPx`），所以切换会话后仍然保持。拖动用 pointer capture，
光标跑出那条细线也不会中断；同时支持方向键（`Shift` 加速）——
纯指针控件对键盘用户不可达。

字体**跟随 harness**：控制台区域用 `--ds-font-family-code`（等宽，由
`dsh-client-ui-theme` 定义），界面文字用 `--dsw-font-family`。
写死 `ui-monospace` 会让插件无视用户的字体设置，与整个应用不一致。

控制台区域在设备半关闭时会显示一条**休眠横幅**（含设备原文与「唤醒（发送回车）」按钮），
左栏对应设备行带 **● 休眠** 标记——休眠的控制台对任何命令都不应答，只列出 `state: open`
是**主动误导**。顶部还有两个引擎开关（连接后自动唤醒 / 空闲休眠自动唤醒）和一个**保活秒数**
输入框，三者都写宿主设置文档而不是客户端偏好。

命令行输入框留空点「发送」= 只发一个回车；旁边另有「回车」按钮作为快捷方式，
因为"往空输入框里按回车"这个恢复动作本身不好发现。

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
| `sessionIdleSweepMs` | `15000` | 空闲会话回收器的扫描间隔 |
| `trustedHosts` | `[]` | 非回环部署必须声明自己被访问的 `host:port`，否则 Host 栅栏会拒绝所有请求 |

设备会话相关的引擎设置存**用户设置文档**（`dsh-console-hub` 命名空间，面板可直接改）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `wakeOnConnect` | `true` | 连接后静默时补一个回车（见下文实测） |
| `dormantAutoWake` | `true` | 检测到设备半关闭标记时自动补一个回车 |
| `dormantProbeMs` | `120000` | 空闲**输入**超过此时长就补一个回车保活；`0` 关闭。设备实测 300s 半关闭 |
| `dormantPattern` | 见源码 | 半关闭标记的正则（**非锚定搜索**，不是尾锚定） |
| `idleTimeoutMs` | `600000` | 本插件回收"没人用"的控制台；保活**不会**刷新这个时钟 |

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

### 设置写入：`update` 是**递归合并**，永远删不掉键（踩过一次，静默失败）

settings seam 的两个写路径语义不同，选错**不会报错**，只会让改动"看起来成功了但没生效"：

| 方法 | 语义 | 能否删除已有键 |
| --- | --- | --- |
| `scope.update(patch)` | **递归合并**（`mergeLayers`） | **不能**——要删的键恰好就是 patch 里没有的键 |
| `scope.replace(section)` | **整体替换** | 能，缺席即删除 |

具体后果：删除一台设备时传 `{ views: nextViews }`（其中少了被删的那条），merge 会把它
**原样保留**——服务器返回 `removed: true`，磁盘上却什么都没变。用户看到的是"点删除没反应"。

所以 `applySettingsPatch` 一律走 `replace`。这条不能用测试替身保证：替身当初写的是
`{ ...document, ...patch }`（顶层浅覆盖，"能删"），而真实的 `mergeLayers` 不能——
**替身比真东西宽松，于是 bug 全绿通过**。现在替身逐字复刻 `mergeLayers`，并且有两个
直接加载**已安装** seam 的闸门：

```sh
node scripts/verify-settings-merge.mjs   # 从 profile 里读真实 seam，证明只有 replace 能删
pnpm test settings-seam                  # 用真实 settings 服务跑整条 config.remove 路径
```

`tests/settings-seam.spec.ts` 是**唯一**不依赖替身的用例：它加载部署里那个真正的
`@deepseek-ai/dsh-settings`，把插件的真实命名空间注册上去，然后走插件的真实路由，
断言**provider 存下来的文档**里那条设备真的没了。`dsh-settings` 不是本插件的依赖
（它是宿主在运行时提供的），所以没有部署时该套件会**显式 skip 并打印原因**，
不会静默变成"通过"。

### 引擎策略：**就地生效**，不要「等会话都关掉再应用」（踩过一次）

`ManagerHolder` 曾经在有会话打开时把整个新策略**暂存**，等到最后一个控制台关闭才应用。
结果是：改一个开关后**新建连接仍然沿用旧行为**，必须先关掉全部会话、再改一次，才按预期工作。

暂存当初是有理由的——旧实现靠**替换** PortManager 来换策略，而替换必须 `dispose()` 旧的，
`dispose` 会关掉它持有的所有控制台。但那个理由站不住：`ConsoleSession` **在构造时就已经
拷贝**了它需要的每一项设置，所以已打开的会话本来就与 manager 的 options 解耦。

现在改为 `PortManager.updateOptions()` **就地替换策略**：

- 已打开的控制台**不受影响**，继续用它打开时的超时/模式/唤醒行为；
- 改动**立刻**对**下一个** connect 生效——这正是用户对"开关"的预期；
- `idleTimeoutMs` 每轮扫描现读，所以改短会立刻开始回收；
- `idleSweepMs` 变化时会**重新挂载**回收器（否则仍按旧节奏扫描）；
- `maxConsoles` 只在 connect 时读取，所以调低不会驱逐已打开的会话。

真机用例 `tests/live/lab.spec.ts` 的 "applies a wake change to the next console…"
复现的就是这个场景：保持第一个控制台开着 → 关掉唤醒 → 第二个控制台**确实拿不到提示符**
→ 再打开 → 第三个控制台**确实拿到提示符**。断言的是**设备的真实反应**，不是策略字段。

### 设置读写的返回形状必须与 `settings.get` 一致（踩过一次）

`settings.update` 曾经只返回 `{ revision, settings }`，而客户端那边声明的是
`{ revision, defaults }`。客户端读 `result.defaults` 得到 `undefined`，
`setDefaults(undefined)` 直接把控件**从界面上抹掉**——必须手动点「刷新」才能重新读回来。

两个响应现在形状一致（都带 `defaults`），并且 `tests/routes.spec.ts` 会**逐字比较两次
响应的 key 集合**，防止再次漂移：只比形状、不比数值（两次读取时刻不同，刚写过的字段本就应该不同）。

它抓到的正是替身抓不到的那一类：把 `applySettingsPatch` 改回 `update`，这套用例立刻
红——而 `tests/routes.spec.ts` 里的替身版本仍然全绿。

## 真机实测结论（重要）

实验室两台设备（DPtech 防火墙 / 交换机）**连接后只发 Telnet 协商字节，然后完全静默**：
6 个字节 `IAC WILL ECHO` + `IAC WILL SGA`，没有 banner，也没有提示符，直到有按键才回应。

**两台设备的提示符落在不同视图**（这一点容易看错）：防火墙回 `<DUT1>`（**用户视图**），
交换机回 `[SWITCH]`（**配置视图**）。`<>` / `[]` 就是用户/配置的区别，`conf-mode` 在两者间切换。
默认 `promptPattern` 同时接受两种括号（`[<\[]…[>\]]`），**不要收窄成一种**，否则其中一台必然失配。

`wakeOnConnect` **默认开启**（最初默认关闭，实测后翻转）：仅当 banner 窗口内没等到任何
提示符时才补发一个回车；已经在连接时打过招呼的设备**不会**收到这个按键。

配套的两条实测数字（`scripts/probe-wake.mjs` 可复现）：

- 唤醒回车 **~35–45ms** 就被应答，远在 `open()` 的 300ms 窗口之内，所以被唤醒的控制台
  能可靠拿到提示符。
- **不经唤醒直接发命令，命令也会完整执行**——这些设备**不会**吃掉第一行。
  静默的代价是**看不到提示符**，不是命令丢失。（早先这里写的是"第一条命令会被吃掉"，
  后续实测推翻了它：那是把"没有提示符可看"误读成了"命令没生效"。）

若你的场景中回车有破坏性（比如任何键都会生效的启动菜单），可以关掉唤醒；
界面「设备配置」栏有开关，写的是宿主设置文档（不是客户端偏好）。

**`console_wait_for` 的跨会话实测**（同一台交换机上开两个会话，一端输入、一端等待）：

串口 console 映射意味着**多个连接共享设备那一条 console 线**，所以一端键入的命令会被设备
回显给**所有**已连接会话。用例 "sees on one console what another console writes to the same
device" 断言的就是这一点：WRITER 发一条带时间戳的唯一标记，**什么都没发的 WATCHER** 用
`waitFor({for:'pattern'})` 在 **~845ms** 内匹配到它，并且匹配到的文本能被 `read` 真正读到
（只 `matched: true` 却读不到内容，对调用者毫无意义）。

同一组用例还覆盖了超时那一半：等待一个设备永远不会打印的模式时，`waitFor` 在约 1.5s 后返回
`matched: false` / `reason: 'timeout'`，**既不会挂住、也不会谎报匹配**，且之后控制台仍然可用
（超时是结果，不是坏掉的连接）。

### 空闲半关闭（休眠）与保活

远端设备在**长时间没有收到按键**后会主动把这条 console 会话半关闭：TCP 连接还在、插件侧
`state` 仍是 `open`、`lastError` 是 `null`，但设备会打印

```
Vty connection is timed out.

Please press ENTER.
```

**之后不再打印任何设备事件**，也不再响应命令，直到有人按一次回车。这是最容易被误判成
"设备坏了"的状态，因为从外面看它一切正常。

实测（`scripts/probe-*` 可复现，全部来自实验室真机）：

| 事实 | 数值 | 探针 |
|---|---|---|
| 半关闭阈值 | **恰好 300s** | `probe-dormant.mjs` |
| 设备计时依据 | **只计输入（按键）**，不计它自己发出的输出 | `probe-idle-input.mjs` |
| 一个回车即可恢复 | **62ms** 内回提示符 | `probe-dormant.mjs` |
| 恢复后是否可用 | 是，`show version` 正常返回 | 同上 |
| 有流量后重新计时 | 是（90s 内无第二次超时） | 同上 |

第三行是设计的关键：**设备一直在输出事件，却仍然超时**。所以保活时钟必须由
"我们最后一次写"驱动（`lastWireAt`），而不是"任何流量"——否则一台持续打印的设备
永远不显得空闲，保活永远不会触发，而这正是最需要它的设备。

插件据此做三件事：

1. **探测**：在 4KB 滑窗内增量搜索该标记（增量是为了避免"自己的输出"反复重新触发唤醒；
   滑窗是为了让很久以前、已被挤出的标记无法复活一个过期判断）。命中即记 `dormant` 状态，
   并在数据路径上**自动补一个回车**（`dormantAutoWake`，默认开）。
2. **保活**：`dormantProbeMs`（默认 120s，远小于 300s）内没有**输入**时补一个回车，
   让设备根本不会进入半关闭。保活**不算"有人在使用"**：它不刷新回收器读取的空闲时钟，
   否则一个被遗忘的标签页会永远不被回收。
3. **如实上报**：`wake()` 只有在**看到设备新输出**时才认为恢复成功；设备不应答就保持
   `dormant: true`。`console_list` / `console_read` 带 `dormant`（外加 `dormantText` 原文），
   `console_wait_for` 在因休眠而无法匹配时额外给 `dormantBlocked`——否则调用者分不清
   "设备慢"和"设备根本没在听"。面板则显示休眠横幅、「唤醒（发送回车）」按钮和列表里的 **● 休眠** 标记。

`console_wake`（或 `console_send` 传空 `text`）就是"按一次回车"，不执行任何命令，
因此**不过高危闸门**：把恢复手段锁在审批后面，会比它要解决的问题更难用。

### 一个真实的 telnet 协商死循环

`negotiationReply` 早期对**每一个**协商字节都回包，包括对 `WONT` 回 `DONT`。
真机上这是一条**无限循环**：设备对我们的 `DONT` 再回 `WONT`，两边以
**~1.4KB/s（还在涨）** 的速度互刷协商帧、没有任何应用数据——"空闲"的控制台从来不空闲。

RFC 854 / 1143 的正解是：只有 `DO` / `WILL` 是**请求**，`DONT` / `WONT` 是**声明**，
声明不需要回应。修好后同一台设备的 rx/tx 在连接后**冻结在 20/6 字节**
（`scripts/probe-rfc.mjs` 复现对比）。这条 bug 是排查保活为什么不触发时顺带挖出来的：
保活没触发的原因（设备一直在输出）和它（协商刷流）看起来像同一件事，但根因不同。

排查同类设备时可用：

```sh
node scripts/probe-console.mjs 10.133.6.253:10003 4   # 裸看字节
node scripts/probe-wake.mjs 10.133.5.253:10015 3 600  # 量唤醒延时
node scripts/probe-dormant.mjs 10.133.5.253:10015     # 等一次真实的半关闭（默认最多 25 分钟）
node scripts/probe-idle-input.mjs 10.133.6.253:10003  # 判定设备计时依据（输入 or 双向）
node --import ./scripts/test-preload.mjs scripts/probe-keepalive.mjs 10.133.6.253:10003 3000 10000
pnpm test:live                                        # 14 条真机用例
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
