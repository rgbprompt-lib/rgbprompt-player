# Player 规范（Mac / Windows）

| 项 | 内容 |
| --- | --- |
| 覆盖需求 | PLY-01~21、PLW-01~09、HW-01~06、§8「Player 未响应 / 播放失败」、FBK-05（首次播放微问卷） |
| 实现 | `apps/player-core`（Rust 共用内核：QuickJS 引擎宿主、限幅、映射、OpenRGB、令牌、状态机、播放循环）+ `apps/player-mac`（Swift / SwiftUI 外壳）+ `apps/player-win`（WinUI 3 / C# 外壳）；见 ADR-0014 |
| 共享 | `packages/engine` player IIFE bundle、`packages/safety` player IIFE（实时限幅器）与向量、`packages/contracts`（协议、令牌、诊断格式）、面板文案 `packages/i18n` |
| 状态 | 草案 v0.2（2026-11-07：改为共用 Rust 内核 + 原生外壳，ADR-0014） |

## 1. 职责边界

Player 只做四件事：**接收灯效**（协议唤起 / 本地文件）→ **运行同一引擎** → **安全输出到键盘**（限幅、映射、Gamma、OpenRGB）→ **在不需要时停止输出**（停止 / 退出时发一帧全黑）。它不生成灯效、不登录账户（v1.0 播放令牌即授权），不上传音频或键位。

## 2. 进程与组件

Player = **共用 Rust 内核**（`apps/player-core`，平台无关，两端同一份代码）+ **平台外壳**（Mac：Swift / SwiftUI；Windows：WinUI 3 / C#）。外壳只做 UI 与必须调用系统 API 的输入 / 集成，通过 C ABI（§9.0.2）驱动内核；所有播放、安全与网络逻辑在内核里。见 ADR-0014。

```
┌──────────────── Player App ─────────────────────────────────────────────────────┐
│ 平台外壳（Mac: Swift/SwiftUI  ·  Win: WinUI 3/C#，不用 WebView）                   │
│  ├─ UI               Mac NSStatusItem + 面板 + 设置窗口 / Win 托盘 + 面板 + 设置窗口   │
│  ├─ ProtocolEntry    Mac CFBundleURLTypes + UTI / Win HKCU 协议与文件关联 → 转交内核    │
│  ├─ InputFeeds       SystemAudio（Core Audio tap / WASAPI loopback）→ PCM 推入内核    │
│  │                   KeyHook（CGEventTap / WH_KEYBOARD_LL）→ 键事件推入内核          │
│  ├─ HidNotify        IOHIDManager / RegisterDeviceNotification → 通知内核重新扫描     │
│  ├─ Startup          SMAppService / HKCU\…\Run                                      │
│  └─ Updater          Sparkle 2 / Windows 更新器（签名校验）                           │
│                    ▲ 状态回调、预览帧、诊断          │ C ABI（cbindgen 头文件）         │
│                    │                                ▼                                │
│ 共用内核 apps/player-core（Rust）                                                    │
│  PlayerService（状态机，见 §6）+ 25 fps 播放循环（§5）                               │
│  ├─ ProtocolParser    rgbprompt://play?t=…&v=1 ；.lep 文件读取                       │
│  ├─ TokenClient       POST /api/player/redeem, /ack, /layout                        │
│  ├─ EngineHost        rquickjs（QuickJS）载入 engine.iife.js（RGBPromptEngine）       │
│  ├─ Limiter           同一 QuickJS 中运行 @rgbprompt/safety 直通输出级（不移植）       │
│  ├─ AudioAnalyzer     PCM 环形缓冲 → FFT → engine 频段规范（analyzeAudioBands）        │
│  ├─ LayoutMapper      ansi104 → 设备布局 → LED 索引；分区/单色降级                    │
│  ├─ OutputStage       全局亮度 → Gamma 2.2 → 8 bit                                   │
│  ├─ DriverManager     下载/校验/启动 OpenRGB（无头 SDK server）                       │
│  ├─ OpenRGBClient     SDK TCP 127.0.0.1（RequestControllerData、UpdateLEDs、SetCustomMode） │
│  ├─ DeviceWatcher     收到外壳 HID 通知或周期轮询 → 重新扫描                          │
│  ├─ ConflictDetector  厂商软件进程检测（PLW-04；进程枚举用 sysinfo）                  │
│  └─ Diagnostics       诊断信息生成、本地日志（滚动 5 MB，不含键位）                    │
└──────────────────────────────────────────────────────────────────────────────────┘
        │ spawn/manage                                │ TCP 6742 (或备用端口)
        ▼                                             ▼
   OpenRGB（Player 自己的那一份，无头模式）  ───────►  USB 键盘
```

| 归属 | 组件 |
| --- | --- |
| 内核（两端共用） | PlayerService、播放循环、ProtocolParser、TokenClient、EngineHost、Limiter、AudioAnalyzer、LayoutMapper、OutputStage、DriverManager、OpenRGBClient、DeviceWatcher、ConflictDetector、Diagnostics |
| Mac 外壳 | 菜单栏与面板、设置窗口、Core Audio process tap、CGEventTap 与输入监控提示、IOHIDManager 通知、SMAppService、Sparkle、Gatekeeper 引导 UI、签名与公证 |
| Windows 外壳 | 托盘与面板、设置窗口、WASAPI loopback、WH_KEYBOARD_LL、RegisterDeviceNotification、HKCU 协议 / 文件关联 / Run 项、更新器、EV 签名 |

## 3. 唤起协议

### 3.1 URL

```
rgbprompt://play?t=<token>&v=1[&o=<origin>]
rgbprompt://open                       # just show the panel
```

- `t`：120 s、一次性的播放令牌（32 字节随机，64 位小写十六进制）；URL 中**不含**长期密钥或灯效内容。服务端只保存 `sha256(token)`，原始令牌只在创建响应和此 URL 中出现一次。
- `o`（可选）：签发该令牌的站点 origin（URL 编码）。Player 据此向 `{origin}/api` 兑换令牌，使本地开发、测试环境与正式环境互不串台；只接受 https 的白名单主机（`rgbprompt.com`、`www.rgbprompt.com`、`test.rgbprompt.com`）以及 http(s) 的本机回环地址，其他取值视为解析失败。缺省时用 Player 内置的 API 地址。服务端由 `appOrigin` 填入（`APP_ORIGIN`，否则请求自身的 origin）。
- `v`：协议版本；Player 遇到更高版本 → 提示更新（`unsupported_version`，不是解析失败）。
- 创建令牌的响应还包含独立的 `pollId`（22 位 base62）。网页用 `pollId` 轮询，不把原始令牌放进轮询 URL；访客在回放页同样可以发起。

### 3.2 时序

```
Web                         API                         Player
 │ POST /player/tokens ───────►│ issue token(120s)          │
 │◄── {token,url,pollId} ──────│                            │
 │ location = rgbprompt://… ───┼───────────────────────────►│ (OS launches/activates)
 │ poll GET /player/tokens/:pollId/status (every 500ms, max 10s)
 │                             │◄──── POST /player/redeem ──│ {token, platform, versions, protocolVersion}
 │                             │─── {lep, name, hash} ─────►│（`lep` 为 .lep 字节的 base64）
 │                             │◄──── POST /player/ack ─────│ {result, code?, keyboard?}
 │◄──── status=acked/failed ───│                            │
```

- 网页以服务端的 `redeemed` 状态判断 Player 是否响应（浏览器无法可靠得知自定义协议是否被处理）：
  - 2 s 未 redeemed：显示轻提示「正在唤起 Player…没有安装？下载」，**不判失败**（Player 未运行时系统冷启动 App 再联网兑换，常超过 2 s）；
  - 10 s 仍未 redeemed：判定「Player 未响应」，给出下载 / 重试（PRD §8）；
  - 任意时刻变为 redeemed：收起提示，等待 ack。
  - 评审 R7：PRD 写的「2 秒无回应」按「2 秒时给出引导」理解；若产品坚持 2 秒即判失败，需接受冷启动误报。
- `ack.result`：`playing` | `needs_driver`（已在面板中引导安装，安装完自动播放并再次 ack）| `no_keyboard` | `failed`。网页据此显示对应状态；`failed` 时提供「重试」与「导出 .lep」。
- `failed` 必须带 `code`：`update_required` | `decode_failed` | `link_unavailable` | `driver_declined` | `openrgb_unreachable` | `device_lost` | `internal`；非 `failed` 不允许带 `code`。
- ack 可在兑换后 30 分钟内多次到达（例如先 `needs_driver`、装好驱动后再 `playing`），每次覆盖上一次结果；超过窗口 → `NOT_FOUND`。
- 网页以服务端的 `redeemed` / `acked` 状态判断 Player 是否响应；轮询只带 `pollId`，泄露它也只暴露状态与结果。
- `redeemed` 后 30 s 内未收到 `acked` / `failed` → 网页显示「Player couldn't play this light」（code 为空），提供重试与导出 `.lep`。
- `needs_driver` 先在 Player 面板里引导安装驱动；网页在 `needsDriver` 期间每 2 s 重轮询状态（最长 10 min，之后停止轮询但仍保留该状态），Player 装好驱动后再次 ack，网页随之进入 `playing` / `no_keyboard` / `failed`。
- 访客（回放页）也可发起：令牌不绑定用户，只绑定 link。

### 3.3 本地文件（PLY-04）

`.lep` 双击（UTI / 文件关联）或拖到菜单栏图标/托盘面板 → `decodeLep` → 校验 → 播放。解码失败 → 「这个文件无法播放」。

## 4. 驱动管理（PLY-06、PLW-03、PLY-11）

| 项 | 规则 |
| --- | --- |
| 解析顺序 | ① 配置地址（`RgbpConfig.openrgb_addr`，默认 `127.0.0.1:6742`）上已有 OpenRGB SDK server 应答 `REQUEST_PROTOCOL_VERSION` 握手（≤ 500 ms）→ 直接使用，`version: "external"`。这是用户自己的 OpenRGB，内核**从不**启动、停止或重启它（用户已经开着 OpenRGB 且识别到键盘；再起一份会争抢设备）。② 否则若 Player 内置了 OpenRGB（macOS：`Contents/Helpers/OpenRGB.app`；Windows 安装布局：与 Player exe 同目录的 `OpenRGB-RGBPrompt/OpenRGB.exe`；测试可用 `RGBP_BUNDLED_OPENRGB`）→ 在「配置端口起的 8 个端口」（默认 6742–6749）中第一个空闲端口（`bind 127.0.0.1:<port>` 成功）无头启动（`--server --server-port --config`，配置写在 `data_dir` 下），等待握手（≤ 10 s，每 200 ms 轮询）；被占用但能握手的端口按情况 ① 当作外部 server。③ 否则若 `data_dir/openrgb` 下有有效安装（`installed.json` 有效且可执行文件存在）→ 同样按空闲端口无头启动。④ 否则 `Missing` → `NeedsDriver`。macOS 生产清单 `archive: "bundle"`：**不再下载** OpenRGB；若内置助手缺失，安装失败（`Unverified`）并应提示重装 Player。Windows 在安装器尚未内置之前仍走清单 zip 下载。 |
| 版本 | 两端均使用我们的补丁版 OpenRGB（`variant: tuned`，K552 / EVision 320F:5000 Direct，上游 MR !3809），来源为 github.com/rgbprompt-lib/openrgb-rgbprompt 的 GitHub Release `f81fd32-evision.1`（源码、补丁与构建脚本在同一仓库）。macOS：OpenRGB 内置于 `RGBPrompt Player.app/Contents/Helpers/OpenRGB.app`，内置清单 `openrgb-macos.json` 的 `archive` 为 `"bundle"`，无下载 URL / `sha256`；内核启动内置助手，生产路径不再下载。Windows：安装器落地前仍用内置清单 `openrgb-windows.json` 的 zip（已填实测 `size_bytes` / `sha256`）；内置后应改为 `archive: "bundle"` 并随安装包提供 `OpenRGB-RGBPrompt/OpenRGB.exe`。开发期两端都可用 Debug-only `RGBP_DEV_DRIVER_MANIFEST` 指向本地补丁包。 |
| 位置 | `install_root = <data_dir>/openrgb`。外壳传 `data_dir` = `~/.rgbprompt`（Mac）/ `%LOCALAPPDATA%\RGBPrompt`（Windows）。只写 `data_dir`，永不动「应用程序」/ Program Files 或用户已有的 OpenRGB。 |
| 同意 | `rgbp_install_driver(h)` 就是用户点「安装」：仅在 `NeedsDriver` 接受（否则 `RGBP_ERR_INVALID_ARGUMENT`），在 worker 线程执行，C 调用立即返回。逐个 URL 下载到 `<install_root>/.download/<sha256>.part`（`ureq` + rustls，connect 15 s，响应头 30 s，禁用环境代理）。按 2 MiB 一段发 HTTP `Range` 请求（每段硬期限 60 s，相当于停滞检测，约 35 KiB/s 以下才会触发），从 part 已有长度续传；断开或停滞的段带退避重试（1/2/4/8 s，连续 5 次没有新字节才换下一个 URL，有新字节就清零计数）；服务器不支持 `Range`（回 200）时改为整文件一次流式下载（期限 30 min）。不再设整次下载总超时：实测 VM 到 Codeberg / GitHub Releases 约 175–210 KB/s，22 MB 需约 125 s，旧的 30 s body / 120 s 总超时必然中途失败。下完后对整个文件算 SHA-256，超过 `size_bytes + 1 MiB` 中止。校验失败 / 过大 → 删除 part、试下一个 URL；HTTP / IO 错误 → **保留** part（文件名即 SHA-256，内容同源可续），下一个 URL 或下一次「安装」从断点续传。校验通过 → 解压到 `<install_root>/.staging-<random>`（`zip` crate，仅 deflate；拒绝绝对路径、`..`、越界符号链接；保留 Unix 执行位）→ 重命名为 `<install_root>/<variant>-<version>/` → **最后**写 `<install_root>/installed.json`（`{ schema, variant, version, sha256, executable }`），崩溃不会留下有效标记。安装完成按解析顺序 ② 继续播放并再次 ack。下载中 `rgbp_stop` 取消（每块检查原子标志）、删除 part，并 ack `failed / driver_declined`。 |
| 进度 | 状态事件 `driver_progress`：下载时 0..100（每个整百分比最多一次），解压 / 启动时 100，其余 −1。 |
| 校验失败上报 | `RgbpStateEvent.driver_error`：`0` 无、`1` 下载失败（所有 URL）、`2` 校验和不匹配（所有 URL；混合原因以最后一次为准）、`3` 启动失败、`4` 被 macOS 阻止、`5` 清单未校验。状态保持 `NeedsDriver`（`4` 为 `Blocked`），面板可再次提供「安装」。诊断错误码：`driver_download_failed`、`driver_checksum_mismatch`、`driver_launch_failed`、`driver_blocked`、`driver_unverified`、`driver_crashed`、`vendor_conflict`。 |
| 启动 / 监督 | 参数模板来自清单（`{port}`、`{config_dir}` 替换），stdout/stderr 写 `<install_root>/openrgb.log`（每次启动截断，上限 1 MiB）。supervisor 线程每 500 ms `try_wait`；意外退出 → 诊断 `driver_crashed`，同一端口按 1 s / 2 s / 4 s 退避重启；60 s 内超过 3 次 → 停止重启，状态 `BackendUnresponsive`。`rgbp_restart_backend(h)`：managed → kill、重启、重连、恢复当前灯效；external → 只重连（绝不向不是自己启动的进程发信号）。`rgbp_destroy` kill 并回收 managed 子进程。 |
| macOS 阻止 | spawn 返回 `PermissionDenied`，或子进程在启动 2 s 内被 `SIGKILL` → `Blocked` + `driver_error = 4`；`rgbp_retry` 重新启动。自行下载不设置 quarantine，不调用 `xattr` / `spctl`。 |
| 范围 | 仅 USB 键盘；Windows 不启用需要管理员的 SMBus（内存/主板灯）。 |
| 许可 | OpenRGB 为 GPL-2.0，作为**独立进程**随 Player 内置运行（macOS：`Contents/Helpers/OpenRGB.app`；此副本含 K552 / EVision Direct 补丁）。Player 自身不受传染。设置页脚「开源许可 / Licenses」打开随包的 GPL-2.0 全文、NOTICE，以及源码地址 https://github.com/rgbprompt-lib/openrgb-rgbprompt。 |
| 调优版（P1） | 清单 `variant` 为 `standard` 或 `tuned`（本任务只建模，不切换）。命中已知卡顿型号时提供调优版 OpenRGB（只改内存灯效路径，不刷固件），征得同意才下载，可切回；调优版须公开其源码修改（GPL 义务）。 |

#### 4.1 清单覆盖、驱动监督与外部驱动丢失

| 项 | 规则 |
| --- | --- |
| 清单覆盖（D2） | `rgbp_set_driver_manifest_json(h, json)`：与内置清单同一 schema / URL 规则（https，或 http 仅 loopback），且 `sha256` 必须非空；仅在 `Idle` / `NeedsDriver` 且没有安装进行（`driver_progress < 0`）时接受，否则 `RGBP_ERR_INVALID_ARGUMENT`。替换下一次安装 / 启动使用的清单，可在任何播放前调用；ABI 版本仍为 2。 |
| 生产 / 开发清单（D1） | macOS 生产清单 `openrgb-macos.json` 的 `archive` 为 `"bundle"`（`variant: tuned`，`f81fd32-evision.1`），无下载 URL；`install()` 在内置助手存在时直接 `Installed`，缺失时失败且不访问网络。Windows 清单在安装器内置完成前仍指向 GitHub Release zip 并带实测 `sha256` / `size_bytes`。开发构建可用 Debug-only 的 `RGBP_DEV_DRIVER_MANIFEST`（文件路径）在启动时覆盖；Release 构建没有这条代码路径。K552 的逐键 Direct 依赖上游 MR CalcProgrammer1/OpenRGB!3809。清单的 `executable` / `args` 仍保留 `{port}` / `{config_dir}` 模板，内置启动也会传入 `--config`。 |
| 驱动信息 | `rgbp_driver_info_json` 增加 `verified`（清单 `sha256` 非空）与 `supervision: { state, crashes, crashLimit, external }`。`state` = `none` / `running` / `restarting` / `gaveUp` / `externalLost`；`restarting` = managed 子进程已退出且 supervisor 正在退避或重启；`gaveUp` = supervisor 放弃；`externalLost` = 上次成功模式是外部且最近一次探测失败（探测成功后清除）；`external` = 上次成功模式是外部。 |
| 事件发布 | `DriverEvent::Crashed` / `Launched` / `GaveUp` 后也发布状态事件，外壳随事件重新读取驱动信息；`GaveUp` 且没有预编译灯效时，下一次自动重扫仍显示 `BackendUnresponsive`。 |
| 外部驱动丢失（D4） | `supervision.state == externalLost` 时，自动重扫（`watch_tick` / `devices_changed`）只探测配置地址，**不**回退到启动 managed 驱动，避免抢占用户 OpenRGB 的 6742 端口。外部服务器恢复应答后下一次 tick 自动重连并以同一灯效恢复播放（预编译灯效保留）。只有用户显式 `rgbp_retry` / `rgbp_restart_backend` 才走完整解析顺序（外部 → managed → `NeedsDriver`）。 |
| macOS 阻止（Q8 / D9） | 实测调优版以 `--server --server-port <p> --noautoconnect` 运行、ad-hoc 签名、无 quarantine xattr。我们的 `ureq` 下载不设置 quarantine，因此 Gatekeeper 通常不会评估已下载的驱动；`Blocked` 更可能来自签名损坏（AMFI SIGKILL），「仍要打开」未必能修复。§6 的三步引导仍然适用于用户把浏览器下载的 OpenRGB 放进安装目录、带 quarantine 的情况；公开版实测启动留给用户清单。 |

## 5. 播放循环

```
every 40 ms (25 fps, adaptive down to 15 fps if UpdateLEDs latency > 30 ms):
  t      = monotonic_ms - start_ms                 (paused time excluded, P1)
  inputs = { keys: KeyHook.drain(), audio: SystemAudio.bands() }
  frame  = LepAPI.frame(t, inputs)                 // 104 * RGB, linear-light-agnostic 8-bit
  frame  = Limiter.apply(frame, dt)                // FLASH-SAFETY §5, pass-through since 2026-11-12
  leds   = LayoutMapper.map(frame, device)         // per-key | zones avg | single brightness
  leds   = OutputStage.apply(leds, brightness, gamma=2.2)
  OpenRGB.UpdateLEDs(device, leds)
```

- 引擎与限幅器在内核的播放线程上运行（§9.0.5）；外壳 UI 线程只读状态快照与预览帧（小键盘预览所需的 104 色，`rgbp_preview_frame`）。
- 设备进入 `SetCustomMode`（Direct）后播放。停止 / 退出时发送一帧全黑并停止写入，不保存、不恢复原来的 `active_mode`（PLY-20/PLW-07；用户决定 2026-11-08，OPEN-QUESTIONS Q36）：K552 这类驱动把 Direct 报成当前模式，无法读回或交还键盘自带灯效，「恢复」会冻结在最后一帧。面板提示用户重新插拔键盘以恢复自带灯效。
- 失败保护与恢复（PLY-08 / PLY-10）：预编译灯效在这些失败期间保留，键盘保持当前灯光（不恢复、不清屏），内核自行恢复：
  - 播放中设备消失（packet 100 不再包含它 / 写入已移除的索引 / 通知重扫）→ 停止写入，状态 `NoKeyboard` + `error = device_lost`，窗口内 ack `failed / device_lost`；`DeviceWatcher` 每 2 s 重扫，键盘回来 → `Playing` 同一灯效（时间从 0 开始），窗口内再次 ack `playing`。
  - 播放中 OpenRGB 不可达（IO 错误 / 超时 / 连接关闭）→ 停止写入，`BackendUnresponsive`，窗口内 ack `failed / openrgb_unreachable`；每 2 s 重连（managed 由 supervisor 先重启）。重连成功后重新选择键盘 → `Playing`。
  - 首次检测没有键盘 → 同样每 2 s 重扫（不必再点「重试」；`rgbp_retry` 仍强制立即重扫）。
  - 这些状态下 `rgbp_stop` 结束播放：`Idle`、无错误、丢弃预编译灯效、不再重试；`Idle` 下永不重试。
  - 每次失败都写入诊断与本地日志（§10）。
- 全局亮度：设置项 10–100%，默认 100%，在 Gamma 前施加。

### 5.1 系统声音（PLY-07）

| 平台 | 实现 | 权限 |
| --- | --- | --- |
| Mac | Core Audio process tap（macOS 14.2+，`CATapDescription` 立体声全局 tap，排除自身、`isPrivate`、未静音）→ 私有聚合设备（`kAudioAggregateDeviceIsPrivateKey` + tap auto-start + 漂移补偿，默认输出为主设备）读 PCM；`kAudioTapPropertyFormat` 的格式转换成交错 f32（支持 f32/f64、有符号 i16/i32、交错与非交错，NaN/Inf 归零）后推入内核；IO 回调不分配、不加锁、不打日志，只写 `start` 时预分配的 scratch（8192 帧 × 8 声道，超出分块）；默认输出设备变化时重建；电平表每 0.2 s 刷新（其他进程是否在播放每秒最多查询一次） | 「系统音频录制」权限（无法事先查询，首次 `start` 触发一次系统提示）；`start` 失败 → 面板「打开系统设置」+ 路径说明；已启动但连续 3 s 推入的样本全为 0 且 `kAudioProcessPropertyIsRunningOutput`（排除自身）显示其他进程正在播放 → 判定为可能被拒，同样给出路径；非零样本到达即清除提示；未授权时照常播放但声音层不随音乐变化 |
| Win | WASAPI loopback（默认渲染设备，设备切换时重建） | 无需授权 |

外壳只负责采集 PCM 并推入内核（`rgbp_push_audio_pcm`）；内核 `AudioAnalyzer` 做 FFT（2048 点，与网页 AnalyserNode 同参数），再调用 `@rgbprompt/engine` 的频段规范（22 段、平滑、峰值保持、节拍）→ `FrameInputs.audio`。不录音、不落盘、不上传。

### 5.2 按键反应（PLY-21、PLW-05）

| 平台 | 实现 | 权限 / 开关 |
| --- | --- | --- |
| Mac | 会话级 `CGEventTap`（listen-only、`headInsertEventTap`，keyDown/keyUp/flagsChanged）→ 键码映射到布局键名；跳过自动重复的 keyDown；`flagsChanged` 用设备相关位区分左右修饰键，Caps Lock 按下即发一次 down + up；Mac 键码特例：Delete→`BACKSPACE`、Forward Delete→`DELETE`、Help→`INSERT`、F13/F14/F15→`PRINTSCREEN`/`SCROLLLOCK`/`PAUSE`、Keypad Clear→`NUMLOCK`、Contextual Menu(110)→`APPLICATION`；`tapDisabledByTimeout`/`tapDisabledByUserInput` 时重新启用；仅当 `rgbp_input_wanted` 的按键位为 1 且状态为 Playing 时安装，其余状态或停止即卸载 | 「输入监控」：首次播放按键类灯效时先说明「只读取键位用于亮灯，不记录、不上传」，再引导到系统设置；已有说明后仍未授权 → 紧凑横幅 + 系统设置路径；说明中「继续」会请求权限，tap 创建失败 → 「退出并重新打开 Player」；未授权 → 按键层静止，其余层照常；提示期间每 2 s 及面板打开时复查授权 |
| Win | `SetWindowsHookEx(WH_KEYBOARD_LL)`，回调中只入队「键名 + 按下/抬起」，不调用其他 API | 首次说明；设置中可关闭 |

键事件只存在于内存队列，被引擎消费后丢弃；日志与诊断中**禁止**出现键名序列。只有当前灯效含按键原语时才安装钩子，停止播放即卸载。

## 6. 状态机与面板（PLY-12~15、PLW-02）

```
                ┌────────────┐ redeem/open .lep  ┌─────────────┐
   launch ────► │   Idle     │ ────────────────► │  Preparing  │
                │ (drop zone)│ ◄──── stop ────── └──────┬──────┘
                └─────▲──────┘                          │ driver missing ─► NeedsDriver ─(install ok)─┐
                      │                                 │ no keyboard ────► NoKeyboard ─(found)───────┤
                      │                                 │ audio perm needed (non-blocking banner)     │
                      │                                 ▼                                            │
                      │   error/unplug   ┌───────────────────────┐ ◄──────────────────────────────────┘
                      └───────────────── │       Playing         │
                                         └──────────┬────────────┘
                                                    │ OpenRGB unresponsive
                                                    ▼
                                         BackendUnresponsive（重启后台 / 复制诊断）
```

状态数值（`PlayerState` / C enum `RgbpState`，自 M6-C3 固定）：`Idle = 0`、`Preparing = 1`、`NeedsDriver = 2`、`NoKeyboard = 3`、`Playing = 4`、`BackendUnresponsive = 5`、`VendorConflict = 6`、`Blocked = 7`。M6-C4 起产生 `VendorConflict`（§8）与 `Blocked`（macOS 阻止启动，`driver_error = 4`）。设备拔出显示为 `NoKeyboard` + `device_lost`（不是独立状态）；`BackendUnresponsive` 用于 OpenRGB 不可达或 driver 连续崩溃。其余播放失败不是独立状态：内核回到 `Idle` 并在状态事件里带失败码（面板据此显示错误卡）。音频权限与输入监控由外壳横幅处理，不是内核状态；内核只用 `rgbp_input_wanted` 报告当前灯效想要的输入（bit 0 音频、bit 1 按键）。失败码与 C 状态码一一对应，见 §9.0.2。

面板（340 宽）：标题与连接状态 → 状态卡 → 主操作 → 底部菜单（打开 Studio、播放 .lep 文件、设置、退出）。

| 状态 | 状态卡内容 | 主操作 |
| --- | --- | --- |
| Playing | 小键盘预览、灯效名、键盘型号与帧率、声音来源与电平 | 停止（之后提示：重新插拔键盘即可恢复它自带的灯效） |
| Idle | 拖放区；（P1）最近 3 个 | 打开 Studio |
| Idle 且失败（非 `driverDeclined`，PLY-10） | 「这个灯效暂时播不了」+「键盘保持当前灯光，问题已记录」+ 具体失败文案 | 打开 Studio / 复制诊断信息 |
| NeedsDriver | 官方 OpenRGB 版本与体积、SHA-256 校验、安装位置；未校验版本显示警告与外部 OpenRGB 提示；进度条 + 百分比；失败码 1/2/3 的文案 | 安装并播放 / 稍后（未校验：稍后 / 重试） |
| AudioPermission | 用途说明 | 打开系统设置 |
| InputMonitoring（Mac） | 用途说明 | 打开系统设置 |
| NoKeyboard | 副标题 + 3 条排查（直连、关厂商软件、重插）+「支持的键盘」+ 底部「插上键盘后会自动继续」 | 重新查找 / 支持的键盘 |
| VendorConflict | 标题「<软件名> 正在运行」（无名字用「厂商灯光软件」）+ 说明「它也在控制键盘灯，所以 RGBPrompt 连不上键盘」+ 3 条编号步骤（退出该软件 / 关掉后键盘会自动重连 / 退出 Player 后可再打开它）+ 底部「复制诊断信息」链接 | 我已关闭，重试 / 打开活动监视器（找不到时不显示；外壳不结束、不枚举其他进程） |
| BackendUnresponsive | 按 `supervision` 分 4 种卡：重启中（第 n/limit 次 + 不确定进度）/ 放弃 / 外部丢失（端口 + 等待行）/ 未响应；都说明键盘保持当前灯光 | 立即重试 / 重启后台 / 复制诊断信息 |
| Blocked（Mac Gatekeeper） | 标题 +「按 3 步放行一次就好」 | 查看步骤（打开设置窗口）/ 我已放行，再试一次 |

首次设置窗口（400 × 560，不可调整，标题「RGBPrompt Player · 首次设置」）由播放请求导致的 `NeedsDriver` / `Blocked` 自动打开，也可从面板按钮打开；`Preparing → Playing` 或 `Idle` 时自动关闭。步骤 1 是驱动安装（内容 / 大小 / 位置 / 校验表、下载进度与 ETA、未校验与失败变体）；步骤 2 是 Gatekeeper 三步引导（在访达中显示、打开隐私与安全性、复制驱动 `.app` 路径、放行后重试）。打开期间临时切到 `.regular` activation policy，关闭后恢复。

图标：单色模板图标；播放中实心 + 绿点；需要处理时橙点。面板底部「退出 Player」在本次会话见过厂商冲突时，额外显示一行 11 pt 次要提示「退出后可以重新打开 <名字>」，退出仍然立即执行（一帧黑，不弹窗）。

设置窗口（400 × 560，不可调整，标题「RGBPrompt Player · 设置」）从面板底部的「设置…」（⌘,）打开，再次打开只把已有窗口提到前面：

- **状态**卡（3 行，16 pt 圆点、绿色 ✓ 表示正常，灰色表示缺失）：灯光驱动（已安装 → `OpenRGB <version> · 已就绪`；外部 OpenRGB → `OpenRGB · 端口 <port> 运行中`；未安装 → 未安装）、键盘（Playing / Idle 时显示最近一次看到的名字，否则未找到）、网页连接（`rgbprompt:// 已注册`，否则灰色「未注册」+「设为默认」按钮）。
- **偏好**卡：语言（`中文 | EN` 分段；存 `UserDefaults language`，缺省跟随系统，切换即时生效并调用 `rgbp_set_language`）、声音来源（`系统声音 | 关闭`；关闭时 `rgbp_set_audio_enabled(false)` 且外壳停掉进程 tap、不显示音频权限横幅；存 `audioEnabled`，默认开）、亮度（10–100%，步长 5，调用 `rgbp_set_brightness`，存 `brightness`，默认 100）、开机时启动（`SMAppService.mainApp`，默认关，从不自动注册；`requiresApproval` / `notFound` 各有提示）、停止或退出说明（静态行，无恢复开关）。
- 底部：`Player v<版本>`；「检查更新」（Sparkle 落地前打开 `<site>/player` 下载页）与「复制诊断信息」（复制内核 `rgbp_diagnostics_json` 的美化 JSON，标签 2 秒内显示「已复制」）。

语言由单一 `LanguageStore` 持有；`L10n` 从所选 `en` / `zh-Hans` 子 bundle 取字符串，并用对应 `Locale` 格式化数字。面板、设置窗口、首次设置窗口和状态栏提示都随语言即时刷新。

## 7. 布局检测与降级（HW-02/03/06）

1. OpenRGB 控制器数据 → 控制器名、`location` 字符串、zones（`ZONE_TYPE_MATRIX` 带 matrix map 或 LED 名称列表）。SDK **不带** VID:PID 字段；厂商的 `vid:pid` 只能从 `location` 字符串中提取。
2. 布局识别：优先用内置设备表（`device-db.json`：按控制器名（大小写不敏感的精确匹配）和/或 `location` 中出现的 `vid:pid` 十六进制对匹配 → 布局与 LED 名覆盖表）；否则按 LED 名称（`Key: Escape` 等 OpenRGB 命名）匹配 ansi104 键名，推断布局（是否有小键盘、ISO Enter 等）。
3. 支持等级：`per_key`（逐键）/ `zones`（分区）/ `single`（单色）；首次检测时面板显示等级与可用效果（HW-06）。
4. 回传：`POST /api/player/layout {token, layout, support}`（网页预览提示；令牌与 ack 同一规则，不再用 Cookie）；播放中每 60 s `POST /api/player/heartbeat {compiledHash, seconds, platform, playerVersion}`（`seconds` 1–120）；用户同意后 `POST /api/player/device-report {platform, playerVersion, vendorId?, productId?, openrgbName?, layout?, support, result}`（补充设备矩阵 HW-01）。`GET /api/devices?q=` 供网页搜索种子矩阵。

## 8. 厂商软件冲突（PLW-04）

进程名表在 `crates/core/data/vendor-conflicts.json`（`include_str!`，可后续远程更新）：

```json
{ "schema": 1, "apps": [
  { "name": "Corsair iCUE", "platforms": ["windows"], "process": ["iCUE.exe"] },
  { "name": "Logitech G HUB", "platforms": ["windows", "macos"], "process": ["lghub*"] }
] }
```

匹配大小写不敏感；结尾的 `*` 是前缀匹配。检测只在失败路径上运行：进入 `NoKeyboard`、`BackendUnresponsive` 或 device lost 时（`ConflictDetector`，进程枚举用 `sysinfo`，在 worker 线程）。命中 → 状态 `VendorConflict`，`conflict_name` 为显示名（多个用 `", "` 连接），诊断 `vendor_conflict`；`rgbp_retry` 重新检测，没有冲突就继续正常流程。`VendorConflict` 期间 watcher 继续重扫，键盘出现 → `Playing`。

macOS 外壳把 `conflict_name` 原样显示；面板卡片按「没找到键盘」的结构给出 3 条编号步骤（退出厂商软件 / 2 秒 watcher 会自动重连 / 退出 Player 后可再打开它），主按钮 `rgbp_retry`，次按钮只在 `NSWorkspace.urlForApplication(withBundleIdentifier: "com.apple.ActivityMonitor")` 解析成功时显示。外壳**不**结束、不发送信号、不枚举其他进程；检测始终在内核。本次会话见到的冲突名（按 `", "` 拆分去重）记在 `PanelModel`，非空时退出行的第二行提示「退出后可以重新打开 <名字>」。退出保持立即（一帧黑，无确认框）。

## 9. 平台工程细节

### 9.0 共用内核（apps/player-core）

#### 9.0.1 Crate 布局

Cargo workspace，`rust-toolchain.toml` 固定版本；不进 pnpm workspace，但根目录 `package.json` 提供 `pnpm player:parity` 等脚本包装。

| Crate | 类型 | 内容 |
| --- | --- | --- |
| `crates/core`（`rgbprompt-player-core`） | lib | `engine_host`、`limiter`、`audio`、`layout`、`output`、`openrgb`、`driver`、`watcher`、`token`、`lep`、`service`（状态机）、`playback`（播放循环）、`diagnostics`；纯 Rust，不含 FFI |
| `crates/ffi`（`rgbprompt-player`） | `staticlib` + `cdylib` | C ABI 薄层：句柄管理、`catch_unwind`、字符串 / 缓冲区转换、回调转发；`cbindgen` 生成 `include/rgbprompt_player.h` |
| `crates/parity` | bin | `parity` CLI：金样与限幅向量对拍（§11） |
| `crates/openrgb-stub` | bin + lib | 测试用 OpenRGB SDK server 桩：模拟控制器（逐键 / 分区 / 单色、协议版本 0/3/4），记录 `UpdateLEDs`、`SetCustomMode`、`UpdateMode` |

`crates/core/data/` 存放两份嵌入数据（`include_str!` 解析一次）：`device-db.json`（初始 `devices: []`，M6-C4 记录真实设备）与 `openrgb-key-names.json`（每个 ANSI104 键 → OpenRGB LED 名列表，含常见别名）。

依赖原则：`rquickjs`（静态链接 QuickJS）、TLS 用 `rustls`（两端一致，不依赖系统 TLS 差异）、HTTP 用阻塞客户端（如 `ureq`），不引入异步运行时；SHA-256 用 `sha2`；FFT 用 `rustfft`。不得引入 GPL 依赖。

#### 9.0.2 C ABI

- 前缀 `rgbp_`；所有函数返回 `int32_t` 状态码（0 = 成功，负数 = 错误码）；`rgbp_abi_version()` 返回 ABI 版本（M6-C4 起为 2；v2 在状态事件末尾新增 `driver_error` / `conflict_name`，并新增 `rgbp_notify_devices_changed` / `rgbp_driver_info_json`），外壳启动时校验。
- 只传 POD、UTF-8 `const char*`（内核复制，不持有调用方指针）与调用方分配的缓冲区；不跨边界传 Rust / Swift / C# 对象。状态事件里的字符串（`effect_name`、`keyboard_name`）只在回调期间有效，回调在控制线程上发出。
- 每个入口 `catch_unwind`，panic 转为 `RGBP_ERR_INTERNAL`，绝不跨 FFI 展开。

状态码：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `RGBP_OK` | 0 | 成功 |
| `RGBP_ERR_INTERNAL` | -1 | `internal` |
| `RGBP_ERR_UPDATE_REQUIRED` | -2 | `update_required` |
| `RGBP_ERR_DECODE_FAILED` | -3 | `decode_failed` |
| `RGBP_ERR_LINK_UNAVAILABLE` | -4 | `link_unavailable` |
| `RGBP_ERR_DRIVER_DECLINED` | -5 | `driver_declined` |
| `RGBP_ERR_OPENRGB_UNREACHABLE` | -6 | `openrgb_unreachable` |
| `RGBP_ERR_DEVICE_LOST` | -7 | `device_lost` |
| `RGBP_ERR_INVALID_ARGUMENT` | -100 | 参数 / UTF-8 / 缓冲区指针非法 |
| `RGBP_ERR_BUFFER_TOO_SMALL` | -101 | 诊断 JSON 缓冲区不足（不写入） |
| `RGBP_ERR_NOT_SUPPORTED` | -102 | 清单没有 SHA-256 时安装失败关闭（`driver_unverified`）；保留给未实现功能 |
| `RGBP_ERR_BAD_URL` | -103 | 保留给外壳的 URL 预检 |

| 分组 | 函数 |
| --- | --- |
| 生命周期 | `rgbp_abi_version(void) -> uint32_t`；`rgbp_create(const RgbpConfig*) -> RgbpHandle*`（数据目录、API 基址、平台、语言、App 版本、OS 版本、OpenRGB 地址）；`rgbp_destroy(h)`（阻塞直到控制线程停止） |
| 回调 | `rgbp_set_state_callback(h, fn(const RgbpStateEvent*, void* user), user)`：`state`（§6 数值）、`error`（0 或上面的失败码）、灯效名、键盘名与支持等级（`-1`/`0`/`1`/`2` = 未知 / per_key / zones / single）、帧率、`driver_progress`（0..100 或 -1）、`driver_error`（0 / 1..5，见 §4）、`conflict_name`（无冲突为 NULL，仅回调期间有效）；在控制线程上调用 |
| 载入 / 播放 | `rgbp_open_url(h, url)`、`rgbp_open_lep_file(h, path)`、`rgbp_stop(h)`、`rgbp_install_driver(h)`（仅在 `NeedsDriver` 接受，否则 `RGBP_ERR_INVALID_ARGUMENT`）、`rgbp_retry(h)`、`rgbp_restart_backend(h)`（`BackendUnresponsive` / `Playing` / `NoKeyboard` / `VendorConflict` 接受）、`rgbp_notify_devices_changed(h)`（外壳 HID 插拔通知，去抖 500 ms） |
| 驱动清单 | `rgbp_set_driver_manifest_json(h, const char *json)`：替换下一次安装 / 启动使用的清单，规则见 §4.1；仅在 `Idle` / `NeedsDriver` 且无安装进行时接受，否则 `RGBP_ERR_INVALID_ARGUMENT`；`sha256: null` 或非 loopback 的 http URL 也返回 `RGBP_ERR_INVALID_ARGUMENT` |
| 预览 | `rgbp_preview_frame(h, uint8_t out[312]) -> seq`（`int64_t`）：最近一帧限幅后的 104 × RGB，外壳按自己的刷新节奏拉取（≤ 25 fps），seq 未变则不重绘 |
| 输入注入 | `rgbp_push_audio_pcm(h, const float* interleaved, frames, channels, sample_rate)`；`rgbp_push_key(h, key_name, down)`（键名用 ansi104 名称；未知键名只计数、不记录）；`rgbp_input_wanted(h) -> flags`（bit 0 音频、bit 1 按键，外壳据此安装 / 卸载 tap 与钩子，§5.2） |
| 设置 | `rgbp_set_brightness(h, 10..100)`（越界 → `RGBP_ERR_INVALID_ARGUMENT`）、`rgbp_set_language(h, language)`、`rgbp_set_audio_enabled(h, enabled)`、`rgbp_set_key_reactive_enabled(h, enabled)`、`rgbp_set_protocol_registered(h, registered)` |
| 诊断 | `rgbp_diagnostics_json(h, char* out, cap) -> len`：`PlayerDiagnosticsSchema`（`schema: 1`）JSON，NUL 结尾；容量不足返回 `RGBP_ERR_BUFFER_TOO_SMALL` 且不写入。`rgbp_driver_info_json(h, char* out, cap) -> len`：`{ variant, version, sizeBytes, installDir, source, license, installed, mode, port, executable, verified, supervision }`，同样缓冲区规则（面板同意文案、驱动监督与 Gatekeeper 引导使用） |

头文件由 `cbindgen` 从 `crates/ffi` 生成并入库到 `include/rgbprompt_player.h`；`cargo test` 检查无漂移（`pnpm player:header` 重新生成）。

#### 9.0.3 构建产物

| 目标 | 产物 | 消费方 |
| --- | --- | --- |
| `aarch64-apple-darwin` | `librgbprompt_player.a` + `rgbprompt_player.h`（M6 后期可打包为 XCFramework） | `apps/player-mac` 通过 module map 链接 |
| `x86_64-pc-windows-msvc` | `rgbprompt_player.dll`（+ `.pdb`）+ 同一头文件 | `apps/player-win` 通过 P/Invoke（`LibraryImport`）调用 |
| 宿主平台 | `parity`、`openrgb-stub` 可执行文件 | CI 与本机验收 |

在 macOS 上用 `x86_64-pc-windows-gnu` + mingw-w64 交叉检查 Windows 目标（`cargo xwin` 需要接受 MSVC 许可，不默认使用），尽早发现平台条件编译错误；真正的 MSVC `.dll` 链接与运行测试在用户的 Windows VM 中由 `tools/win/build.ps1` 完成（§9.2）。

#### 9.0.4 引擎与限幅器的载入

1. 构建前置：`pnpm --filter @rgbprompt/engine build` 产出 `packages/engine/dist/player/engine.iife.js`（全局 `RGBPromptEngine`，ES2020，无 `console` / `TextEncoder`）；`pnpm --filter @rgbprompt/safety build` 产出 `packages/safety/dist/player/safety.iife.js`（全局 `RGBPromptSafety`，导出实时限幅器、常量与 `frameToKeyRgb`；限幅器定义在 `KEY_NAMES` 顺序的 104 键上，6 × 22 → 104 的映射随 bundle 一起发布）。engine 的 player 入口补充导出 `audio/bands.ts`（频段规范）。
2. `crates/core/build.rs` 读取这两个 bundle，用 `include_str!` 嵌入二进制，并把其 SHA-256 写进常量（`ENGINE_BUNDLE_SHA256` / `SAFETY_BUNDLE_SHA256`）；`Diagnostics` 报告 bundle 哈希与 `engine_version`。bundle 缺失时构建失败并分别提示先跑 engine / safety build。
3. `EngineHost` 启动时创建一个 QuickJS `Runtime` + `Context`，依次 `eval` 两个 bundle，取得 `RGBPromptEngine.decode`、`Renderer`、`frameToBytes`、`analyzeAudioBands` 与 `RGBPromptSafety` 的 `createLimiter`、`frameToKeyRgb`、`KEY_NAMES`、`KEY_CENTRES_QUARTER`；设内存上限与每次调用的中断预算（超时视为 `internal`，防止坏数据卡死）。
4. 每帧：Rust 把 `t`、键事件与频段写成 JS 值调用 `renderer.step` → 用 `frameToKeyRgb` 得到 312 字节（104 × RGB，`KEY_NAMES` 顺序）→ 交给同一 Context 中的限幅器 → 取回限幅后帧。帧数据用 `Uint8Array` / ArrayBuffer 传递，避免逐元素转换。
5. `.lep` 解码只调用引擎的 `decode`；Rust 只负责读文件与大小上限，不实现 `.lep` 格式（硬规则 1）。

#### 9.0.5 线程模型

| 线程 | 职责 |
| --- | --- |
| 播放线程（唯一持有 QuickJS `Runtime`，`!Send`） | 40 ms 节拍（单调时钟，按截止时间补偿漂移；§5 的自适应降帧）、调用引擎与限幅器、LayoutMapper / OutputStage、`UpdateLEDs`（带超时） |
| 控制线程 | `PlayerService` 状态机：接收 C ABI 命令（通道传递，C ABI 调用立即返回）、编排兑换 / 驱动 / 设备检测，向播放线程发指令 |
| 工作线程（少量） | HTTPS（TokenClient）、OpenRGB 下载与校验、启动 / 监控 OpenRGB 进程、厂商软件检测 |
| 外壳线程（不属于内核） | 音频回调与键盘钩子只把数据写入内核的无锁环形缓冲 / 队列（`rgbp_push_*` 不阻塞、不分配）；UI 线程只读快照与预览帧 |

状态回调在控制线程上发出；外壳必须切回主线程（Mac `DispatchQueue.main`，Windows `DispatcherQueue.TryEnqueue`）再更新 UI。

### 9.1 Mac 外壳（apps/player-mac）

| 项 | 方案 |
| --- | --- |
| 结构 | Swift / SwiftUI App（Xcode 工程，菜单栏 App）+ 链接 `librgbprompt_player.a`；Swift 侧薄封装 `PlayerCoreBridge`（C ABI → Swift `ObservableObject`）。原型 `player-app-swift` 0.2.x 只作参考，不在其上演进；不再使用 JavaScriptCore |
| 工程 | XcodeGen `apps/player-mac/project.yml` 为真源（生成 `RGBPromptPlayer.xcodeproj`，不入库）；`CoreBridge/module.modulemap` 以模块 `RGBPromptPlayerCore` 引用 `apps/player-core/include/rgbprompt_player.h`（不复制头文件）；`PlayerKit` 静态库（C ABI 桥接、状态映射、URL / argv 路由、布局表、本地化）、`RGBPrompt Player` 应用、`PlayerKitTests`。bundle id `com.rgbprompt.player`，版本 `0.3.0` |
| 构建 | `pnpm player:core:mac`（engine / safety player IIFE + `cargo build --release --target aarch64-apple-darwin -p rgbprompt-player`）；`pnpm player:mac:build`（XcodeGen + `xcodebuild` Release，可 `--debug`，产物在 `apps/player-mac/build/`）；`pnpm player:mac:test`（`PlayerKitTests` + `openrgb-stub` 集成）；`pnpm player:mac:layout`（从 `@rgbprompt/layouts` 生成 `KeyLayout.swift`，`--check` 检查漂移） |
| 配置 | `data_dir = ~/.rgbprompt`；`api_base` 顺序 env `RGBP_API_BASE` > `UserDefaults.apiBase` > Info.plist `RGBPAPIBase`（默认 `https://rgbprompt.com/api`）；`openrgb_addr` env `RGBP_OPENRGB_ADDR` > `UserDefaults.openrgbAddr` > 内核默认 `127.0.0.1:6742`；语言映射为 `en` / `zh-CN`：`UserDefaults language`（缺省跟随系统）决定 UI 与 `rgbp_set_language`；`os_version` 归一化为 `major.minor.patch`；日志只写 API 主机名与脱敏后的 URL |
| Swift 只做 | 菜单栏 `NSStatusItem` 与面板、设置窗口、输入采集与权限提示（全部在 `Sources/PlayerKit/Input/`：`InputCoordinator`、`ProcessTapAudioCapture`（PCM → `rgbp_push_audio_pcm`）、`EventTapKeyCapture`（键码 → ansi104 键名 → `rgbp_push_key`）、`KeyNameMap`、`ModifierDecoder`、`PCMConverter`、`LevelMeter`）、IOKit `IOServiceAddMatchingNotification` 插拔通知、400 × 560 首次设置窗口（驱动安装 + Gatekeeper 三步引导）、400 × 560 设置窗口（状态 / 偏好 / 页脚）、`.lep` 文件关联与拖放、URL scheme 转交 |
| 设备插拔 | `IOServiceAddMatchingNotification`（`IOHIDDevice`，首次匹配 + 终止）：① `kIOHIDPrimaryUsagePageKey = 1` / `kIOHIDPrimaryUsageKey = 6`（键盘），② 无 usage 过滤但 `kIOHIDTransportKey = "USB"`（厂商自定义灯控接口）。不调用 `IOHIDManagerOpen`，因此不触发输入监控；启动时排空初始迭代器且不通知；事件合并 300 ms 后在主线程调用 `rgbp_notify_devices_changed`；日志只记 `hid_change added=<n> removed=<n>`。 |
| 首次设置窗口 | 400 × 560 不可调整的 `NSWindow`，标题「RGBPrompt Player · 首次设置」；仅在播放请求导致 `NeedsDriver` / `Blocked` 时自动弹出，也可从面板打开；`Preparing → Playing` 或 `Idle` 自动关闭；只在状态种类变化（进入 `NeedsDriver` / `Blocked`）时自动弹出，用户关掉后安装进度事件不会再把它弹回来 |
| 设置窗口 | 单个 400 × 560 不可调整的 `NSWindow`，标题「RGBPrompt Player · 设置」；`SettingsWindowController` 持有唯一窗口，再次打开只提到前面；从面板「设置…」（⌘,）打开（先隐藏面板），打开时刷新 `DefaultHandlerCoordinator` 与登录项状态；`SettingsModel` 派生 3 行状态（灯光驱动 / 键盘 / 网页连接）并持久化声音开关与亮度；`LanguageStore` 让面板、两个窗口和状态栏即时换语言；页脚「检查更新」在 Sparkle 落地前打开 `<site>/player`，「复制诊断信息」走共享 `DiagnosticsCopier` |
| Activation policy | `LSUIElement=YES`；首次设置窗口与设置窗口共用一个引用计数的 `ActivationPolicyCoordinator`：第一个窗口打开 → `.regular`，最后一个关闭 → `.accessory`，关闭其一不会在另一窗口仍开着时降级 |
| 开机启动 | `SMAppService.mainApp` 包在 `LoginItemControlling` 协议后；`LoginItemModel` 把 `.enabled` / `.requiresApproval` 视为开，`.notFound` 禁用开关，注册失败回滚并显示错误；默认关，从不自动注册；每次打开设置窗口重读状态；`requiresApproval` 提供 `SMAppService.openSystemSettingsLoginItems()` 链接 |
| 签名 | Developer ID Application + Hardened Runtime + 公证（`notarytool`）+ staple；entitlements 最小化（QuickJS 是解释器，不需要 JIT entitlement） |
| 更新 | Sparkle 2（EdDSA 签名的 appcast，托管在 R2） |
| 体积 | 目标约 40–50 MB 安装包 / 约 110 MB 已安装 .app（内核 + QuickJS + 两个 bundle + 内置已签名的 OpenRGB；Apple 芯片） |
| 最低系统 | macOS 14.2（系统音频 tap）；Apple 芯片 |

### 9.2 Windows 外壳（apps/player-win）

| 项 | 方案 |
| --- | --- |
| 结构 | C# / WinUI 3（Windows App SDK），.NET 8；`WindowsPackageType=None`（unpackaged）+ `WindowsAppSDKSelfContained=true` + `SelfContained=true`；`RGBPrompt.Player.Interop` 用 `LibraryImport` 声明 C ABI，`rgbprompt_player.dll` 与 exe 同目录。**不用 WebView** |
| C# 只做 | 托盘图标与菜单（Shell_NotifyIcon 或 H.NotifyIcon.WinUI）、340 宽无边框面板窗口（贴近托盘弹出、失焦隐藏）、设置窗口（400×560）、WASAPI loopback（NAudio 或 CsWin32 直调，默认渲染设备切换时重建 → `rgbp_push_audio_pcm`）、`SetWindowsHookEx(WH_KEYBOARD_LL)`（回调只做 VK → ansi104 键名并入队）、`RegisterDeviceNotification` 插拔通知 |
| 面板 | XAML 实现 §6 全部状态，文案用与 Mac 同源的 `packages/i18n` 键（构建时生成 `.resw`）；深浅色与高 DPI 跟随系统；托盘图标按任务栏主题切换 |
| 安装 | 用户级（`%LOCALAPPDATA%\Programs\RGBPrompt`），无需管理员；安装与更新默认用 Velopack（unpackaged 应用的安装 / 增量更新 / 签名校验），M6-W5 定稿；约 30–50 MB（self-contained 运行时 + Windows App SDK + 内核）；内置 OpenRGB 后安装包再增加约 22 MB，布局为 exe 旁的 `OpenRGB-RGBPrompt/OpenRGB.exe` |
| 协议/启动项 | `HKCU\Software\Classes\rgbprompt`、`.lep` 文件关联（`HKCU\Software\Classes\.lep`）、`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`；单实例：第二个进程把参数转交已运行实例后退出 |
| 签名 | EV 代码签名（安装包、exe、内核 `.dll`；Q28，发布时才需要）；每个版本提交 Microsoft Defender 白名单，发布前多引擎扫描（PLW-08） |
| 更新 | 后台检查签名清单 → 下载 → 校验签名与哈希 → 下次启动替换（静默） |
| 最低系统 | Windows 10 22H2 x64 / Windows 11 |
| 构建环境 | WinUI 3 只能在 Windows 上编译与运行。开发期在用户本机 Mac 上的 Windows 虚拟机中构建（Q29），见下方「VM 构建」 |

#### VM 构建（tools/win/build.ps1）

开发期 Windows 构建在用户本机 Mac 上的 Windows 虚拟机中进行，仓库以共享文件夹挂进 VM（Q29）。用户在 VM 的 PowerShell 中、于共享仓库根目录运行一条命令：`powershell -ExecutionPolicy Bypass -File tools\win\build.ps1`。

| 项 | 规则 |
| --- | --- |
| 前置（脚本头部注明并逐项检查） | rustup + `x86_64-pc-windows-msvc` 工具链；Visual Studio 2022 Build Tools 的「使用 C++ 的桌面开发」工作负载（QuickJS 经 `cc` 编译需要 MSVC）；.NET 8 SDK；Windows App SDK 通过 NuGet restore 获取（不单独安装）。缺失项打印安装指引并退出 |
| Node 侧产物 | **VM 内绝不运行 `pnpm install` 或 pnpm 构建**：共享的 `node_modules` 属于 macOS。`engine.iife.js`、safety player IIFE 与 `player:fixtures` 都在 Mac 上生成；缺失时脚本失败并提示要在 Mac 上运行的命令 |
| 输出目录 | `CARGO_TARGET_DIR` 与 dotnet `obj` / `bin`（`--artifacts-path` 或 `BaseIntermediateOutputPath` / `OutputPath`）指向 VM 本地 `%LOCALAPPDATA%\rgbprompt-build`，不写共享目录（避免共享文件夹 IO 慢与文件锁，也不让 Windows 产物进入 Mac 工作树） |
| 步骤 | 前置检查 → bundle / fixtures 检查 → `cargo test` → 构建 `rgbprompt_player.dll` → `parity golden` / `parity limiter` → MSVC C 冒烟测试 →（`apps/player-win` 存在时）`dotnet restore` + `dotnet build` / 单测 |
| 输出 | 末尾打印 `.dll`、exe 的绝对路径与 parity 汇总（通过 / 失败用例数）；任一步失败则非零退出并打印失败步骤，便于用户把输出贴回给评审 |
| 真机 | VM 中测试 USB 键盘需在虚拟化软件中把键盘 USB 直通给 VM（直通期间 Mac 侧无法控制该键盘灯光） |

## 10. 隐私与日志

- 本地日志：`<data_dir>/logs/player.log`，每个事件一行：`unix_ms state=<name> code=<code> fps=<n> device=<controller name> support=<s>`；驱动事件如 `driver_install_start`、`driver_install_ok`、`driver_launch port=<p>`、`driver_crashed`。达到 5 MiB 滚动一次到 `player.log.1`（只保留一代）。**绝不**包含键名、音频、令牌、带令牌的 URL、提示词或邮箱。
- 诊断信息（复制或随反馈提交，用户逐项确认）：Player 版本、系统版本、OpenRGB 版本与端口、设备列表与支持等级、最近 20 条错误、协议注册状态。线上格式为 `packages/contracts` 的 `PlayerDiagnosticsSchema`（`schema: 1`，`.strict()`：拒绝键名、音频、提示词等未知字段）。

## 11. 测试

| 测试 | 内容 |
| --- | --- |
| 金样对拍 | 内核 `parity golden`：Node 侧脚本（`pnpm player:fixtures`）用完整引擎把 `tools/golden` 全部用例编码为 `.lep` + 输入脚本 + 期望 CRC32 / sha256 链（编码只在服务端，ADR-0013），写入 `apps/player-core/fixtures/golden/`（gitignored）；`parity` 在 QuickJS 中用嵌入的 player IIFE 解码并逐帧渲染，报告第一处不一致帧。只在 Rust 里实现一次，在本机 Mac 与用户的 Windows VM（`tools/win/build.ps1`）上各跑一次（本机 Mac 即可完整验收） |
| 限幅向量 | 内核 `parity limiter`：`@rgbprompt/safety/vectors` 全部向量经嵌入的 safety IIFE 限幅后 `output_sha256` 一致 |
| 内核单测 | `cargo test`：PlayerService 状态迁移（全部 §6 状态与 `ack` 结果码）、LayoutMapper 降级、OutputStage Gamma 表、TokenClient（本地 HTTP 桩）、DriverManager 校验失败路径、播放循环节拍与自适应降帧（假时钟） |
| OpenRGB 模拟 | `openrgb-stub`（SDK server 桩，记录 UpdateLEDs）驱动内核端到端：映射、降级、停止时一帧全黑且不改模式、断线重连 |
| 驱动管理 | `driver_e2e`（loopback HTTP 文件桩）：清单解析、`sha256: null` 失败关闭、非 https/loopback URL 拒绝、安装 happy path（进度 → 解压 → 启动 → Playing，`installed.json` 最后写）、official 校验失败走 mirror、两个都坏 / 404 的错误码、下载中取消、zip slip、端口回退、外部 server 优先、崩溃重启与 4 次崩溃放弃、managed/external 的 `restart_backend`。`pnpm player:driver:e2e` 跑安装 happy path。 |
| 设备保护 / 恢复 | `service_recovery`：跨设备选择最佳支持（mouse / zones / per-key）、只有鼠标 → `NoKeyboard`、device lost 保持灯光并恢复、BackendUnresponsive 重连、stop 后不再重扫、通知去抖、Idle/Playing 无 watcher tick、厂商冲突与 retry、日志不含键名/令牌 |
| 真机探针 | `parity openrgb-probe` 对手册外的真实 OpenRGB 只读采样（协议、控制器、模式、分区、LED、布局）；`--play` 写入后以一帧全黑结束。测试对 stub 跑两种模式。`pnpm player:probe:openrgb` |
| C ABI | 头文件由 cbindgen 生成并入库，CI 检查无漂移（`cargo test` / `pnpm player:header`）；C 冒烟测试（Mac clang / Windows MSVC，`pnpm player:smoke`）走一遍 create → open_lep → preview → stop → destroy；内核单测覆盖 URL 表、TokenClient 本地 HTTP 桩、PlayerService 全部状态与 ack、播放节拍 / 自适应降帧、packet 100、诊断 JSON（`pnpm player:diagnostics:check`）；外壳侧 Swift XCTest / C# 单测只测桥接与 UI 状态映射 |
| 真机矩阵 | ≥ 30 款键盘 × 两平台的手测清单（HW-01），记录到设备矩阵 |
| 崩溃率 | 播放会话崩溃率 ≤ 1%（Beta 门槛），崩溃日志随诊断提交 |
