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
- 构建 Windows x64，以及 macOS Intel、Apple Silicon 安装包。

桌面端当前锁定 DeepSeek Harness `0.1.0-rc.6`。上游仍处于开发预览阶段，可能包含不兼容变更，因此只有经过兼容性验证后，才会随新的桌面版本一起升级。

## 环境要求

- Node.js 24 或更高版本
- pnpm 10.26.2
- Windows 10/11 或 macOS 12+

最终用户不需要单独安装 Node.js。打包后的应用会使用 Electron 内置运行时。

## 本地开发

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

在 macOS 上生成未签名的 DMG 与 ZIP：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist:mac
```

源码依赖由 `pnpm-lock.yaml` 锁定。打包阶段使用独立的 `packaging/package-lock.json` 创建 electron-builder 所需的平铺生产依赖。升级 dsh 后，需要执行 `pnpm package:sync-peers`、重新生成打包锁文件，并通过启动及重启冒烟测试。

## 在线更新

开发环境可设置 `GITHUB_REPOSITORY=所有者/仓库名` 以启用更新检查。发布流水线会自动读取 GitHub 仓库信息，并生成更新清单。

未配置更新源的开发构建不会发起网络请求；从菜单选择“应用 → 检查更新”时，会明确提示当前状态。公开发行前应完成 Windows 代码签名及 macOS Developer ID 签名与公证。

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
