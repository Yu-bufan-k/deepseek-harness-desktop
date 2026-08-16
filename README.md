# DeepSeek Harness Desktop

DeepSeek Harness Desktop 是一个面向 Windows 与 macOS 的 Electron 桌面客户端，复用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方 Web 界面，并在本机管理锁定版本的 Harness 运行时。

> **非 DeepSeek 官方产品，由社区独立维护。**

## 主要能力

- 在随机回环端口启动锁定版本的 `@deepseek-ai/dsh`，不会暴露到局域网。
- 使用安全加固的 Electron 窗口承载上游 React Web 界面。
- 提供丝滑的品牌启动动画，并在 Harness 真正就绪后进入工作台。
- 管理工作区、日志、Harness 重启与异常恢复。
- Harness 页面与桌面菜单共用 Electron 系统目录选择器，不依赖上游的原生对话框 Worker。
- 通过操作系统加密能力保存 API 凭据。
- 支持 Stable、Beta 两个 GitHub Releases 更新通道。
- 支持浅色、深色和跟随系统，外观设置与 Harness 共用同一份配置。
- 会话右侧的信息面板展示状态红绿灯、KPI（费用/Token/请求）、Token 趋势图与按模型用量明细。
- 提供 React/TypeScript 桌面工作台、任务级 Monaco Diff 审阅和带哈希保护的逐块撤销。
- 通过 `vision_understand` 工具 + 粘贴图片占位，为纯文本模型桥接图片理解能力；支持多视觉后端与免费方案预设。
- 提供 `generate_image`（文生图，多方案选择/单张确认）与 `design_review`（HTML 离屏渲染截图后视觉评审）能力。
- 会话要点记忆（记忆卡）、模型配额监控预警、按天 JSONL 事件日志与本地用量分析视图。
- 内置版本化官方价格、峰谷时段、自定义/免费价格规则，以及自动检查和手动刷新。
- 构建 Windows x64，以及 macOS Intel、Apple Silicon 安装包。

桌面端当前锁定 DeepSeek Harness `0.1.0-rc.6`。上游仍处于开发预览阶段，可能包含不兼容变更，因此只有经过兼容性验证后，才会随新的桌面版本一起升级。

## 环境要求

- Node.js 24 或更高版本
- pnpm 10.26.2
- Windows 10/11 或 macOS 12+

最终用户不需要单独安装 Node.js。打包后的应用会使用 Electron 内置运行时。

## 本地开发

### 从资源管理器打开工作区

安装后可把一个文件夹直接拖到桌面快捷方式或程序文件上。应用会自动注册该文件夹为工作区，并始终为它新建一个会话；工作区已经存在时也不会复用旧的空白会话。应用已经运行时再次拖入同样有效。

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

生成可直接运行的开发包：

```powershell
pnpm run pack
```

生成未签名的 Windows 安装包和便携版：

```powershell
pnpm dist:win
```

产物保存在项目内的 `release/windows` 目录。

在 macOS 上生成未签名的 DMG 与 ZIP：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist:mac
```

产物保存在项目内的 `release/macos` 目录。两个平台的产物相互独立，后构建的平台不会清除先前平台的安装包；如需全部清空，可执行 `pnpm clean:release`。

源码依赖由 `pnpm-lock.yaml` 锁定。打包阶段使用独立的 `packaging/package-lock.json` 创建 electron-builder 所需的平铺生产依赖。升级 dsh 后，需要执行 `pnpm package:sync-peers`、重新生成打包锁文件，并通过启动及重启冒烟测试。

## 在线更新

开发环境可设置 `GITHUB_REPOSITORY=所有者/仓库名` 以启用更新检查。发布流水线会自动读取 GitHub 仓库信息，并生成更新清单。

未配置更新源的开发构建不会发起网络请求；从菜单选择“应用 → 检查更新”时，会明确提示当前状态。公开发行前应完成 Windows 代码签名及 macOS Developer ID 签名与公证。

## 用量与费用

费用功能读取 Harness 持久化的每次模型请求用量，并按 `供应商路由 + 模型 ID + 请求发生时间` 匹配价格。因此官方 DeepSeek、Fireworks、Hugging Face 等同名模型不会混用单价，切换模型后的历史用量也能分别计算。宽窗口会在会话右侧展示用量侧栏，分别列出当前模型和本会话曾用模型的请求数、Token 与费用；小窗口下自动收为右上角金额图标。完整价格管理位于独立的“用量与费用”窗口。金额仅为本地估算，最终以服务商账单为准。

应用内置 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 当前公布的价格，以及 2026 年 8 月 17 日开始生效的北京时间峰谷价格。设置页支持：

- 每 24 小时自动拉取仓库中的已审核价格清单，或手动点击“立即获取最新价格”。
- 为任意供应商路由和模型添加自定义价格，或标记为免费/仅统计 Token。
- 多币种分别展示，不进行未经配置的汇率换算。
- 未知第三方价格显示“未配置单价”，不会套用 DeepSeek 官方价。
- 用量总览会集中列出待配置模型；自定义 Harness 路由可显式绑定签名清单中的 DeepSeek 官方价格，不根据任意 Base URL 猜测或外发密钥。
- 价格来源可在官方、自定义和免费之间切换；恢复官方价格会结束当前覆盖并保留历史计价，未来计划的覆盖会被取消。
- 自定义规则可分别设置未缓存输入、缓存读取、缓存写入和输出单价，并可指定明确的开始、结束时间。
- 金额在主进程中以整数纳币单位计算、汇总并格式化，不会在展示层转回浮点数；会话侧栏与完整用量窗口只展示同一份计价结果。
- 用量按会话修订号增量同步，未变化的会话复用已验证汇总；价格规则变化时自动使相关缓存失效。

在 Harness 模型设置或桌面系统凭据中保存 `DEEPSEEK_API_KEY` 后，用量总览会通过 DeepSeek 官方固定地址 `GET https://api.deepseek.com/user/balance` 展示总余额、未过期赠送余额和充值余额。可分别设置 CNY、USD 低余额预警值；达到阈值时会在对话右侧费用栏提示。密钥只在 Electron 主进程读取，不会传给页面或自定义提供方；余额缓存五分钟，密钥变化会立即清空旧账户缓存，并支持手动刷新。本地预估费用与官方账户余额是两套数据，不将余额差额当作历史消费。

峰谷计划使用规则指定的 IANA 时区和当天分钟数。起止分钟相同属于无效窗口，不表示全天高峰；全天使用同一价格时应直接设置规则的标准单价。

## 代码变更工作台

从菜单“应用 → 打开工作台”或按 `Ctrl/Cmd+Shift+E` 打开桌面工作台。Harness 发送任务时会自动尝试建立变更基线，也可在“变更”页手动开始和结束批次。任务结束后可使用 Monaco 并排或行内 Diff 审阅文件、标记代码块，或在文件哈希校验通过后撤销单个代码块/整个文件。任务开始前已有的脏文件会单独列出，不会被当成本次任务的新修改。工作台为单任务界面，顶部工具头展示工作区路径与 Harness 状态灯。

## 视觉解析（纯文本模型的看图能力）

宿主对纯文本模型（如 DeepSeek）有图片门禁，桌面端通过三层架构桥接图片理解：

1. **composer 图片占位**：粘贴图片被拦截后存盘，输入框插入 `[已保存图片: <id>]` 纯文本占位，消息以文本发出，宿主门禁不会触发。
2. **`vision_understand` 工具**：agent 看到占位后调用，主进程按 imageId 读图并交给视觉后端解析，返回文字结果。
3. **auto 分流**：当前模型支持图片（多模态）时放行，走宿主原生附件路径。

Harness 设置 →“视觉”分区可配置多个后端（单选启用）：

- Direct API 使用 OpenAI-compatible 视觉请求（如智谱 GLM-4V-Flash 永久免费、阿里百炼 qwen-vl）；内置免费方案预设，一键填入。
- API Key 经系统加密存储，绝不写入配置 JSON。
- 图片存盘目录可自定义（默认 `userData/vision`），支持一键清理。

## 生图与设计评审

- **`generate_image`**：按描述生成图片（默认智谱 CogView3-Flash，永久免费，可用同一 ZHIPU_API_KEY）。同一主题的多个变体用一次 `variants` 调用（1-6，用户指定数量优先）；生成后统一弹出应用内预览/选择窗口——多张供选择、单张确认，关闭窗口或取消即放弃，agent 会停下询问而不是替用户做主。
- **`design_review`**：把 HTML 离屏渲染成页面截图，再经视觉模型评审布局、配色、对齐、信息层级，返回改进意见——适合“生成 UI → 评审 → 迭代”的闭环。
- 生成的图片存盘目录可配置（默认 `userData/images`），生成图也可被 `vision_understand` 解析。

## 会话信息面板

会话标题栏右侧的信息面板（Grafana 风格仪表盘）：状态红绿灯（黄=处理中、绿=就绪、红=最近出错）、KPI 网格（预估费用/Token/请求数/模型数）、Token 消耗面积图、模型用量排行、余额状态灯、工具/MCP/技能三色分组。面板整体滚动，头部常驻。

## 本地用量分析

菜单“应用 → 本地用量分析”（`Ctrl/Cmd+Shift+A`）打开分析弹窗：范围切换（今日/近 7 天/近 30 天/全部）、KPI、Token 与费用双轴趋势图、模型用量排行、视觉解析健康度（缓存命中率/平均耗时/后端错误）、工具使用 Top 与错误记录。数据全部来自本地（用量投影 + 事件日志）。

## 事件日志

所有用户操作、视觉/生图/评审请求、会话用量上报与错误，按天写入 JSONL 日志（默认 `userData/logs/events-YYYY-MM-DD.jsonl`，保留 30 天）。日志目录可自定义，设置 →“日志”分区可打开目录或恢复默认。日志用于问题定位与统计分析。

## 记忆与配额

- 记忆卡（Harness 设置 →“记忆”）：把会话要点保存到本地记忆库，agent 可通过工具读写，跨会话保留上下文。
- 配额监控：跟踪各提供方的窗口配额，接近或耗尽时桌面通知预警。

### 价格清单信任与回退

远程清单不是 DeepSeek 官方 API，而是本项目维护者根据官方价格页人工复核后发布的社区清单。应用依次尝试 GitHub Contents API、jsDelivr 镜像和 GitHub Raw，但不会因为来源可访问就直接信任内容：`prices.signed.json` 必须通过应用内置 Ed25519 公钥验证，并通过 schema、有效期和 append-only 历史保护后才会被接受。所有远程来源失败或签名无效时，应用继续使用已缓存清单或安装包内置清单，并在页面内提示而不抛出 IPC 异常；用户自定义规则不会被远程更新覆盖。

维护者修改 `pricing/prices.json` 后，`Sign pricing catalog` 工作流使用仓库 Secret `PRICING_SIGNING_PRIVATE_KEY` 生成签名信封。私钥不得提交到仓库；轮换密钥需要随桌面应用发布新的公钥。PR 和本地构建通过 `pnpm pricing:verify` 检查明文清单与签名信封完全一致。

`.github/workflows/check-pricing.yml` 每天检查官方页面的关键价格值。检测到变化时会创建一次去重的 GitHub Issue，维护者核对并签署 `pricing/prices.json` 后，桌面端才会自动或手动接受新清单。页面改版、镜像污染或未经签名的提交都不会直接改变用户账本。公开仓库使用标准 GitHub-hosted runner 时，这类轻量定时任务通常不产生 Actions 费用。

## 启动过程

应用启动后会完整播放一次约 3.6 秒的品牌动画，同时在后台启动 Harness：

1. Harness 与动画都完成后，进入工作台。
2. 动画完成但 Harness 仍在启动时，继续显示加载状态。
3. Harness 启动失败时，保留错误信息，并提供重新启动和打开日志入口。

这种方式保证启动体验完整，同时不会用动画掩盖真实运行状态。

## 安全设计

- Harness 服务只监听 `127.0.0.1`。
- Renderer 不启用 Node.js，并使用上下文隔离和白名单 preload 接口。
- 拦截非预期页面跳转；HTTPS 和邮件链接交由系统浏览器打开。
- 凭据通过 Electron `safeStorage` 加密，在 Windows 上使用 DPAPI，在 macOS 上使用 Keychain 支持的加密能力。
- 日志会脱敏常见 API Key、Token、密码和 Bearer Token。
- 目录选择通过 Harness 官方 capability 扩展点接入 Electron 主进程；桥接服务仅监听随机回环端口，每次启动生成独立随机令牌。

桌面端在启动 Harness 时加载独立的 `desktop.cordis.patch.yml` overlay，将 `host.pickDirectory` 绑定到桌面 capability。该 overlay 位于桌面运行数据目录，不修改上游包，也不覆盖用户的 Harness 配置；升级 Harness 时可通过协议兼容测试独立验证。

桌面会话令牌会传递给内嵌界面，以便兼容后续协议。DeepSeek Harness rc.6 尚未强制校验该令牌，因此回环地址监听仍是当前本地传输的主要安全边界。

## Logo 与商标

应用内 DeepSeek 图形标识取自 [DeepSeek Harness 官网](https://www.deepseek.com/harness/) 的官方矢量资源，仅用于标识其所承载的上游项目。

桌面壳源码使用 MIT License。DeepSeek Harness 及随附依赖保留各自许可证。“DeepSeek”及相关标识归其权利人所有。本项目不代表 DeepSeek 官方授权或背书。
