# LESSONS

本文件记录 dsh-console-hub 开发与真机实测中发现的问题点。当前行为与配置一律以 [README.md](README.md) 为准；每条教训只在这里写一次。

## 1. 共享连接池

每个会话一个控制台池有两个缺陷，最终改为全宿主一个共享池：

1. **配额管不住设备。** 实测（`maxConsoles = 3`，三个会话依次连同一台设备）：

```
maxConsoles = 3
total consoles held by the manager: 9
TCP connections the DEVICE sees:    9      ← 同一台设备、同一个端口，9 条 TCP
```

console 端口是物理稀缺资源，按会话放大后配额形同虚设。

2. **会话死掉后没人能回收它的池。** 路由上的会话校验拒绝一切以该会话为参数的调用，那些控制台既列不出来也关不掉，只剩空闲回收器会收走它们，且不计入任何人的配额。

共享池落地后两个问题一起消失：配额是全局的；没有按会话的清理逻辑（也就没有会泄漏的清理）；生命周期只剩显式关闭或 `idleTimeoutMs` 回收（`tests/port-manager.spec.ts` 的 "leaves no console behind when a session dies mid-flight" 钉住这条）。

**再次连接同一台设备必须「附加」而不是新开。** 对同一个 console 服务器端口开第二条 TCP 会让设备拆掉第一条（实验室防火墙实测，休眠用例正依赖这一点）。"再开一条"给调用者的不是独立控制台，而是悄悄弄坏已经在用的人。返回值的 `reused: true` 就是在报告这件事。

`openedBy` 是来源信息不是权限：任何会话都可以读写、唤醒、关闭池里任何一条。按会话过滤恰恰是上面第 2 条 bug 的成因。

## 2. 工具 schema 的两套拼写（踩过两次）

同一个工具定义里 `output.schema` 与 `parameters` 是两套不同的 raw JSON Schema 拼写，混淆的后果分别是「工具静默消失」和「整场对话无法开始」：

| 字段 | 校验者 | 后果 |
| --- | --- | --- |
| `output.schema` | `register()` 会校，不过会被拒 | 工具静默消失 |
| `parameters` | `register()` **完全不校**，直接发给模型 API | 整场对话无法开始 |

`required` 的两种拼写就是陷阱本身：

- 授权 DSL（`defineTool` 的入参）：`required: true` 写在每个属性上；
- raw JSON Schema：`required: ['a','b']` 写在 object 节点上，属性里不能有 `required`。

把 DSL 写进 `parameters` 后顶层没有 `type`，厂商会整份工具列表拒掉：

```
Invalid schema for function 'console_close':
  schema must be a JSON Schema of 'type: "object"', got 'type: null'
```

对策：`parameters` 一律经 `parameterSchemaSpecToJsonSchema({...})` 编译，手写不可能写错；改完用两道闸门验——`pnpm check:tools`（拿真实校验器查全部定义）与 `pnpm test`（测试替身对 parameters 跑 assertObjectJsonSchema）。`check:tools` 存在的原因就是 `register()` 不检查 `parameters`，harness 在请求发出前也不会发现，不主动查就只能等模型 API 报错。

## 3. settings seam：`update` 是递归合并，删不掉键（静默失败）

两个写路径语义不同，选错不会报错，只会让改动"看起来成功了但没生效"：

| 方法 | 语义 | 能否删除已有键 |
| --- | --- | --- |
| `scope.update(patch)` | 递归合并（mergeLayers） | 不能——要删的键恰好就是 patch 里没有的键 |
| `scope.replace(section)` | 整体替换 | 能，缺席即删除 |

具体后果：删除一台设备时传 `{ views: nextViews }`（少了被删的那条），merge 把它原样保留——服务器返回 `removed: true`，磁盘上什么都没变，用户看到的是"点删除没反应"。所以 `applySettingsPatch` 一律走 `replace`。

这条不能用测试替身保证：替身当初是 `{ ...document, ...patch }`（顶层浅覆盖，"能删"），真实的 mergeLayers 不能——**替身比真东西宽松，于是 bug 全绿通过**。现在替身逐字复刻 mergeLayers，另有两个直接加载已安装 seam 的闸门：

```sh
node scripts/verify-settings-merge.mjs   # 从 profile 里读真实 seam，证明只有 replace 能删
pnpm test settings-seam                  # 用真实 settings 服务跑整条 config.remove 路径
```

`tests/settings-seam.spec.ts` 是唯一不依赖替身的用例：加载部署里真正的 `@deepseek-ai/dsh-settings`，断言 provider 存下来的文档里那条设备真的没了；没有部署时该套件显式 skip 并打印原因，不会静默变成"通过"。

## 4. settings 读写返回形状必须一致

`settings.update` 曾只返回 `{ revision, settings }`，客户端声明的是 `{ revision, defaults }`：客户端读 `result.defaults` 得到 `undefined`，`setDefaults(undefined)` 把控件直接从界面上抹掉，必须手动点「刷新」才能读回来。两个响应现在形状一致（都带 defaults），`tests/routes.spec.ts` 逐字比较两次响应的 key 集合防止再次漂移——只比形状不比数值（两次读取时刻不同，刚写过的字段本就应该不同）。它抓到的正是替身抓不到的那一类：把 `applySettingsPatch` 改回 `update`，这套用例立刻红，而替身版本仍然全绿。

## 5. 引擎策略：就地生效，不要等会话清空再应用

`ManagerHolder` 曾把新策略暂存到最后一个控制台关闭才应用。结果是：改一个开关后**新建连接仍然沿用旧行为**，必须先关掉全部会话、再改一次才按预期工作。暂存的理由站不住——`ConsoleSession` 构造时已拷贝所需设置，已打开的会话本来就与 manager 的 options 解耦。改为 `PortManager.updateOptions()` 就地替换后：

- 已打开的控制台不受影响，继续用它打开时的超时/模式/唤醒行为；
- 改动立刻对下一个 connect 生效；
- `idleTimeoutMs` 每轮扫描现读，改短立即开始回收；
- `idleSweepMs` 变化时重新挂载回收器（否则按旧节奏扫描）；
- `maxConsoles` 只在 connect 时读取，调低不驱逐已打开会话。

真机用例 "applies a wake change to the next console…" 复现该场景：保持第一个控制台开着 → 关掉唤醒 → 第二个控制台确实拿不到提示符 → 再打开 → 第三个确实拿到。断言的是设备的真实反应，不是策略字段。

## 6. 会话存在性检查是 advisory，不是硬门禁

`sessionExists` 曾是硬门禁：组合的会话存储不认识面板发来的 id 时，保存设备直接报 `no session "..."`，整个面板在另一个 profile 下不可用。现在未识别的 id 只记一次日志并照常服务：隔离来自 manager 的按 owner 作用域与路由的浏览器信任栅栏，不来自这次查询。门禁的灾难性失败模式若保护不了任何东西，就不如它还能提供的诊断价值。

## 7. Cordis 服务只能在其 fiber 激活后读取

Cordis 对注入依赖的解析是异步的（fiber runner await 后才跑回调），只有提供服务的那条 fiber ACTIVE 之后 `ctx.get(...)` 才拿得到它。本插件只 inject `settings`；`credentials`、`tools`、`systemPrompt` 等是表构建之后才激活的。曾把 `credentials` 在激活前存成 `undefined`，之后每条凭据路径都抛 `Cannot read properties of undefined (reading 'deleteRecord')`。对策：每次调用时经 getter 现读，绝不捕获引用。同类捕获引用的 bug 已出过两次：settings cache 与 credential seam。

## 8. 高危指令拦截：三个真实问题

**`\b` 边界漏洞。** 旧默认规则 `config|conf|configure` 编译成 `^(?:config|conf|configure)\b`；`\b` 在 `configuration` 的 `g`、`u` 之间不存在词边界，于是：

```
SAFE     "configuration"                               ← 漏了
SAFE     "configuration rollback replace BasicConfig"  ← 漏了，而它会覆盖运行配置
```

这条真的会改配置的回滚指令以前完全不触发二次确认。`tokens` 按词前缀比较后，`conf` / `config` / `configuration` 都能命中：

```
ASK   configuration rollback replace BasicConfig
ASK   conf roll replace BasicConfig           ← 省略形式同样命中
ASK   conf rollback replace BasicConfig
```

**前缀匹配是必须的。** 设备 CLI 接受任意无歧义的缩写（实测 `conf roll replace BasicConfig` 与全称同效），只认全称的规则少打几个字母就能绕过。反方向不算命中（命令词比规则词更长不匹配），`rollo` 不会命中 `rollback`——设备本身也不接受这个拼法。过度匹配是刻意的、方向安全：多拦一次只是多一次确认，绝不会静默放行。

**复合命令逐段判定。** `show version; reboot` 先拆段、各自判定、整行取最严结果。按整行匹配时一条 `allow show` 会把后面的 `reboot` 一起吞掉——那是一个绕过。

配套结论：进入配置模式（`conf`）默认不拦（改设备本来就要进配置模式，任何改动还要提交；把整个 `configuration` 前缀拦掉只会让危险的那条淹没在操作员习惯点掉的弹窗里），所以回滚规则声明两个 token，只写一个词的命令不命中它。`deny` 与 `ask` 在三条路径上分开：模型路径 deny 在询问审批**之前**就拒绝（无审批服务时报规则名，而不是指向错误修复方向的"缺少审批服务"）；面板路径 deny 不签发令牌，没有可重放的确认；工具描述写明被拒就是最终决定。

模型无法编辑自己的规则：模型没有任何写设置的工具（唯一写路径 `console_upsert_view` 走 replace 时会把当前规则原样带过去）。`tests/host.spec.ts` 钉住两点：工具名不得出现 `fence|rule|policy|settings`，且清单写入后规则逐字节不变——只看名字不够，真正的保证是第二条。

## 9. 真机实测结论

设备：DPtech 防火墙 `10.133.6.253:10003`、交换机 `10.133.5.253:10015`。

**连接后静默。** 两台设备只发 6 字节 Telnet 协商（`IAC WILL ECHO` + `IAC WILL SGA`），没有 banner 也没有提示符，直到有按键才回应。

**提示符落在不同视图，容易看错。** 防火墙回 `<DUT1>`（用户视图），交换机回 `[SWITCH]`（配置视图）——`<>` / `[]` 就是用户/配置的区别，`conf` 在两者间切换。默认 promptPattern 必须同时接受两种括号，收窄成一种就会有一台必然失配。

**wakeOnConnect 默认开启**（最初默认关闭，实测后翻转）：仅当 banner 窗口内没等到任何提示符时才补发一个回车，已经在连接时打过招呼的设备不会收到。两条配套实测：唤醒回车 ~35–45ms 就被应答（远在 open() 的 300ms 窗口之内，被唤醒的控制台能可靠拿到提示符）；不经唤醒直接发命令，命令也会完整执行——这些设备不会吃掉第一行，静默的代价是看不到提示符，不是命令丢失（早先"第一条命令会被吃掉"的结论是把"没有提示符可看"误读成了"命令没生效"）。

**`for: "idle"` 一度被写成一句无信息量的话。** 工具描述 "wait until output stops arriving" 没回答三件事：停多久算停、必须先有输出、没有输出时会怎样。旧实现把静默计时器一开始就启动，一条完全没说过话的会话第一次轮询就返回 `matched: true`，等于"输出还没开始就已经停了"。现在的定义：先有输出到达，然后连续 `idleMs`（默认 1500ms）没有任何新字节；它是启发式而非完成信号。

第二个推论是实测出来的：两台设备的长应答都经 console 服务器每 ~1000ms 推一块约 960 字节（`scripts/probe-output-gaps.mjs`），默认窗口当时是 250ms，于是 `scripts/probe-idle-falsedone.mjs` 量到了本该避免的失败：

```
idle wait (idleMs=250) matched=true in 250ms
text read at match time: 0 chars          <- 什么都没读到就"匹配"了
text that arrived AFTER the match: 5760 chars
```

窗口改为 1500ms 后，同一台设备读到 7680 字符不再中途截断；交换机上则在真正安静时才匹配。因此 `for: "prompt"` 才是"命令执行完了"的可靠信号；只有设备不打提示符时才用 idle，并把 `matched: true` 当作"大概完了"再读一遍确认。工具描述里的窗口数值取自实际生效的设置（`idleQuietMs`），调过的部署不会看到一个过期的数字，模型也不会按一个它拿不到的等待去推理。

**跨会话回显。** 串口 console 映射意味着多个连接共享设备那一条 console 线，一端键入被设备回显给所有已连接会话。用例 "sees on one console what another console writes to the same device"：WRITER 发带时间戳的唯一标记，什么都没发的 WATCHER 用 `waitFor({for:'pattern'})` 在 ~845ms 内匹配到，且匹配到的文本能被 read 真正读到（只 `matched: true` 却读不到内容对调用者毫无意义）。同一组用例覆盖超时那一半：等设备永远不会打印的模式时约 1.5s 后返回 `matched: false` / `reason: 'timeout'`，不挂住也不谎报，控制台之后仍然可用。

**空闲半关闭（休眠）。** 设备 300s 无按键后主动半关闭：TCP 连接还在、插件侧 state 仍是 open、lastError 是 null，但设备打印 `Vty connection is timed out.\r\n\r\nPlease press ENTER.`，之后不再打印任何设备事件、不响应命令，直到有人按一次回车——从外面看一切正常，最容易被误判成"设备坏了"。

| 事实 | 数值 | 探针 |
| --- | --- | --- |
| 半关闭阈值 | 恰好 300s | `scripts/probe-dormant.mjs` |
| 设备计时依据 | 只计输入（按键），不计它自己发出的输出 | `scripts/probe-idle-input.mjs` |
| 一个回车即可恢复 | 62ms 内回提示符 | `scripts/probe-dormant.mjs` |
| 恢复后是否可用 | 是，`show version` 正常返回 | 同上 |
| 有流量后重新计时 | 是（90s 内无第二次超时） | 同上 |

表里第二行是设计的关键：设备一直在输出事件却仍然超时，所以保活时钟必须由"我们最后一次写"（`lastWireAt`）驱动而不是"任何流量"——否则一台持续打印的设备永远不显得空闲、保活永不触发，而那正是最需要它的设备。插件据此做三件事：4KB 滑窗内增量搜索标记（避免自己的输出反复重新触发唤醒）、命中即记 dormant 并自动补回车（`dormantAutoWake`）；`dormantProbeMs`（默认 120s，远小于 300s）无输入时补回车保活，让设备根本不会进入半关闭（保活不算"有人在使用"，不刷新回收时钟）；`wake()` 只有看到设备新输出才认为成功，`console_list` / `console_read` 带 `dormant`（+ `dormantText` 原文），`console_wait_for` 在因休眠无法匹配时额外给 `dormantBlocked`——否则调用者分不清"设备慢"和"设备根本没在听"。`console_wake` 只按一次回车、不执行命令，因此不过高危闸门：把恢复手段锁在审批后面比它要解决的问题更难用。

**一个真实的 telnet 协商死循环。** `negotiationReply` 早期对每一个协商字节都回包，包括对 `WONT` 回 `DONT`：真机上这是一条无限循环，设备对我们的 DONT 再回 WONT，两边以 ~1.4KB/s（还在涨）互刷协商帧、没有任何应用数据——"空闲"的控制台从来不空闲。RFC 854 / 1143 的正解：只有 DO / WILL 是请求，DONT / WONT 是声明，声明不需要回应。修好后同一台设备 rx/tx 在连接后冻结在 20/6 字节。这条 bug 是排查保活为什么不触发时顺带挖出来的：保活没触发的原因（设备一直在输出）和它（协商刷流）看起来像同一件事，但根因不同。

排查同类设备：

```sh
node scripts/probe-console.mjs 10.133.6.253:10003 4                                   # 裸看字节
node scripts/probe-wake.mjs 10.133.5.253:10015 3 600                                  # 量唤醒延时
node scripts/probe-dormant.mjs 10.133.5.253:10015                                     # 等一次真实的半关闭
node scripts/probe-idle-input.mjs 10.133.6.253:10003                                  # 判定设备计时依据
node --import ./scripts/test-preload.mjs scripts/probe-output-gaps.mjs 10.133.6.253:10003   # 量应答块间隔
node --import ./scripts/test-preload.mjs scripts/probe-idle-falsedone.mjs 10.133.6.253:10003 250  # 复现 idle 误判
node --import ./scripts/test-preload.mjs scripts/probe-keepalive.mjs 10.133.6.253:10003 3000 10000
node --import ./scripts/test-preload.mjs scripts/probe-live.mjs 10.133.6.253:10003 "show version"
pnpm test:live
```

## 10. 浏览器半的 UI 教训

- `settings.render` 是**追加**在行列表之后的：在里面再画一遍那四个既有控件就会出现两份（早期实现正是这么错的）。规则编辑器只渲染一个。
- 弹窗必须 `createPortal` 到 `document.body`：标签页位于侧边栏自己的层叠上下文里，绝对定位的面板会被侧边栏的 `overflow` 裁掉，而不是盖在它上面。
- 字体跟随 harness：控制台区用 `--ds-font-family-code`（等宽）、界面用 `--dsw-font-family`。写死 `ui-monospace` 会无视用户的字体设置，与整个应用不一致。
- 分隔条用 pointer capture（光标跑出那条细线也不中断）同时支持方向键（Shift 加速）：纯指针控件对键盘用户不可达。
- 命令行输入框留空点「发送」= 只发一个回车，旁边另设「回车」按钮——"往空输入框里按回车"这个恢复动作本身不好发现。
- 高危规则只出现在设置弹窗一处，标签页里刻意不再列第二份：同一个安全设置出现在两处就会各自漂移。
- 规则编辑器的三个取舍：未改动的行保留原有 id（id 出现在审批提示和审计里，每次保存都重新生成等于把所有历史引用指向不存在的名字）；保存后按宿主返回的内容回填（显示"宿主实际存下的样子"才证明写入按预期落地）；本地解析失败时不发请求、不动输入文字，并指出是第几行。
- 规则写宿主设置文档而不是浏览器 blob：拦截由宿主进程执行，写进浏览器偏好的规则不会生效。

## 11. 模型工具路径的零散教训

- `console_list` 的 renderer 曾按 `ConsoleEntry` 的 `lastError` 字段读投影：投影不带该字段，结果任何控制台开着时 console_list 直接抛 `Cannot read properties of undefined (reading 'code')`。renderer 的类型改为对投影本身声明，字段错配变成编译错误而不是运行时崩溃。
- handle 渲染加引号：真机对话里模型曾把句尾标点复制进 handle，重试报 "not found for this session"。引号比那次重试便宜。
- `resolveSecret` 曾被写好但从未调用，而工具描述已先行宣称"Prefer a stored credential"：带已存密码的设备仍要求调用者传密码。显式 password 优先于存储凭据（ad-hoc 覆盖过期存储值的路径）。
- 连接失败也是结果不是异常：返回 `state: "error"` 与带码的 `lastError`，handle 留在列表里供关闭或重试。