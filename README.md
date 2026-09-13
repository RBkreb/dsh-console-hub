# dsh-console-hub

面向网络设备 console 映射端口（串口服务器 / 终端服务器）的 DSH 插件：经 Telnet 或 Raw TCP 连接设备控制台，提供会话管理、命令交互。

- 插件类型：工具类
- 包版本：0.1.0

## 前提条件

- Node.js：`^22.19.0 || >=24.0.0`
- Harness：`@deepseek-ai/dsh^0.1.5-rc.1`、`@deepseek-ai/cordis` `^4.0.2`
- 前置插件：`dsh-better-sidebar` ≥ 0.19

## 安装

```sh
dsh plugin --profile web add github:RBkreb/dsh-console-hub
```
安装后重启 `dsh`

## 服务 API / 扩展点

### 注册的模型工具

| 工具 | 作用 | 关键参数 | 返回要点 |
| --- | --- | --- | --- |
| `console_list` | 已连接控制台（全宿主共享池） | — | `consoles[]`：handle、label、地址、state、`openedBy`、`dormant` |
| `console_list_views` | 已配置设备清单 | — | `views[]`：`viewId`、地址、凭据是否已配置 |
| `console_upsert_view` | 新建 / 更新设备配置 | `viewId?`、`name`、`host`、`port`、`kind`、`encoding`、`user`、`promptPattern`、`pagerPattern`、`pagingMode`、`tags`、`notes`、`password` | `viewId`、`created`、`secretConfigured` |
| `console_remove_view` | 删除配置及其凭据 | `viewId` | `removed`、`secretRemoved` |
| `console_connect` | 连接设备 | `viewId` 或 `host`+`port`、`kind`、`encoding`、`label`、`password` | handle、`state`、banner、prompt、`reused` |
| `console_send` | 发送 | `consoleId`、`text`、`submit`、`submitKey`、`encoding` | `state`、`written`、`pagingActive`、`dormant` |
| `console_wake` | 回车唤醒控制台 | `consoleId` | `answered`、`dormant` |
| `console_read` | 游标增量读 | `consoleId`、`after`、`encoding`、`stripEcho`、`maxBytes` | `text`、`cursor`、`truncated`、`prompt`、`dormant` |
| `console_wait_for` | 等提示符 / 模式 / 静默 | `consoleId`、`for`（prompt/pattern/idle）、`pattern`、`timeoutMs`、`after`、`idleMs` | `matched`、`reason`、`matchedText`、`cursor`、`dormantBlocked` |
| `console_close` | 关闭并释放端口 | `consoleId`、`force` | `closed` |
| `console_describe` | 控制台详情与发送审计 | `consoleId` | 字节数、prompt、分页状态、`audit[]` |
| `console_clear` | 丢弃本进程已读回显 | `consoleId` | `cursor`、`droppedBytes` |


### 事件

本插件的监听与注册全部挂在 fiber 的 effect 上（端口管理器、策略 watcher、模型闸门、HTTP 路由），fiber 释放后回收。

- `inject: ['settings']`——唯一硬依赖；
- 按需注入：`tools`、`systemPrompt`、`webServer`；
- 调用时读取：`credentials`、`approval`、`connection`、`sessions`；

## 配置项

### 插件行配置

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `requestBodyLimitBytes` | number | `1048576` | 插件 API 单次请求体上限 |
| `sessionIdleSweepMs` | number | `15000` | 空闲控制台回收的扫描间隔 |
| `trustedHosts` | string[] | `[]` | 非回环部署被访问的 `host:port`（或仅 `host`）；未声明拒绝所有请求 |

### 设置文档

连接与读取：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `defaultKind` | `'telnet' \| 'raw'` | `telnet` | telnet 剥离协商字节 |
| `defaultEncoding` | encoding 枚举 | `utf-8` | utf-8 / gbk / gb18030 / big5 / shift_jis / euc-kr / latin1 |
| `connectTimeoutMs` | number | `8000` | socket 连接预算 |
| `readTimeoutMs` | number | `15000` | 单次 read 等待新字节的时长 |
| `idleTimeoutMs` | number | `600000` | 空闲控制台回收时长（不记保活） |
| `maxConsoles` | number | `16` | 并发控制台上限 |
| `outputLimitBytes` | number | `65536` | 单次 read/wait 携带的字节上限 |
| `scrollbackLimitBytes` | number | `262144` | 会话为游标保留的原字节数 |
| `idleQuietMs` | number | `1500` | `for: "idle"` 的静默窗口 |
| `views` | 对象 | `{}` | 设备清单，字段同 `console_upsert_view` |

分页、提示与休眠：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `pagingMode` | pagingMode 枚举 | `auto-more` | 缺省分页反应：auto-more 发空格 / auto-quit 发 q / auto-interrupt 发 Ctrl+C / manual 无处理 |
| `pagingMaxPages` | number | `50` | 自动分页上限 |
| `pagingQuietMs` | number | `120` | 分页命中后等待静默窗口 |
| `promptPattern` | string（正则） | 同时接受 `<...>` / `[...]` | 缺省提示符模式，大小写不敏感 |
| `pagerPattern` | string（正则） | `--More--` / `more:` / 按任意键等 | 缺省分页正则 |
| `dormantPattern` | string（正则） | `Vty connection is timed out. … Please press ENTER.` | 设备半关闭标记 |
| `dormantAutoWake` | boolean | `true` | 检测到半关闭标记时自动唤醒 |
| `dormantProbeMs` | number | `120000` | 无输入保活间隔 |
| `wakeOnConnect` | boolean | `true` | 连接自动输入回车 |

拦截与模型：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `approvalMode` | `'always' \| 'high-risk'` | `high-risk` | `always` 每条提问；`high-risk` 未命中规则放行 |
| `fenceRules` | 规则数组 | 回滚 + 重启两条 `ask` | 有序规则表，第一条命中即定；每条 `{ id, action, tokens, pattern, note }`，tokens 与 pattern 二选一 |
| `highRiskPatterns` | string[] | `[]` | 遗留字段，仅保留旧式已声明的拦截 |
| `agentConsoleTools` | boolean | `true` | 是否注册 `console_*` 工具与 systemPrompt 段落 |
| `agentInstructions` | string | `''` | 进模型提示段落的约定 |

### 拦截规则格式

动作：`deny`直接拒绝| `ask`人工确认| `allow`放行。

### 配置示例

```yaml
# cordis.yml
- id: dsh-console-hub
  name: dsh-console-hub
  config:
    trustedHosts: [console.example.com:43120]
```

```yaml
# 设置文档 
dsh-console-hub:
  fenceRules:
    - id: config-rollback
      action: ask
      tokens: configuration rollback
      note: 用保存的配置覆盖运行配置
    - id: no-erase
      action: deny
      pattern: erase\s+startup-config
      note: 抹掉已保存的配置
    - id: show-config
      action: allow
      tokens: show configuration
  approvalMode: high-risk
```

### 凭据

- 存储：credentials seam 的 GrantRecord，key 为 `dsh-console-hub/<recordId>`
- 覆盖：环境变量 `DSH_CONSOLE_<RECORDID>`（`user:pass` 或裸密码）优先于存储记录

## 已知限制

- 仅 Telnet / Raw TCP；不支持 SSH 或串口直连
- 提示符 / 分页 / 休眠靠正则识别，部分 CLI 需要调整
- 控制台池全宿主共享、无会话隔离
- 高危拦截只是防护栏不是沙箱，建议同时在设备侧限制权限

## 安全说明

- 权限范围：对已配置设备发起出站 TCP；不执行 shell；无 PTY
- 网络：插件 API 与内置 `/api` 共享 Host/Origin 