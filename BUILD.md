# 打包 / 分发说明

## 先说清楚：这个项目没有 `gradlew`，也产不出 `jar`

PCL-N 是 **Electron + Node.js** 项目（`src/main` 是 Node 主进程，`src/renderer` 是原生 HTML/CSS/JS 界面），
不是 Java 工程，所以：

- 没有 `build.gradle` / `gradlew`，`./gradlew build` 不适用；
- **`.jar` 是 Java 的产物**，Electron 应用无法打成 jar（除非用 Java 把整个启动器重写一遍）。

对应的分发形态是：

| 平台 | 产物 | 说明 |
| --- | --- | --- |
| Windows x64 | `PCL-N-1.0.0-win-x64-portable.exe` | 单文件绿色版，双击即用，不需要安装 |
| Windows x64 | `PCL-N-1.0.0-win-x64-setup.exe` | NSIS 安装包（可选安装目录、开始菜单） |
| macOS | `PCL-N-1.0.0-mac-universal.dmg` / `.zip` | 内含 `.app`，Intel + Apple Silicon 通用 |
| Linux | `PCL-N-1.0.0-linux-x64.AppImage` | 单文件可执行 |

打包由 **electron-builder** 完成（配置在 `package.json` 的 `build` 字段）。

---

## Windows x64

```bash
pnpm install
pnpm dist:win            # 便携单文件 exe
pnpm dist:win-installer  # NSIS 安装包
```

产物在 `dist/`：

```
dist/PCL-N-1.0.0-win-x64-portable.exe     ← 单文件绿色版，直接发给别人就能用
dist/PCL-N-1.0.0-win-x64-setup.exe        ← NSIS 安装包
dist/win-unpacked/                         ← 解包目录，便于排查
```

**绿色版的数据位置**：便携 exe 运行时会在自己旁边建一个 `PCL-N-Data` 文件夹，
配置、账号、缓存、日志全在里面，整个文件夹拷走就能换电脑继续用（真正的绿色版）。
安装版则使用 `%APPDATA%\PlainCraftLauncher`。

> 国内网络如果卡在下载 Electron 二进制的步骤，可以先设置镜像：
> ```bash
> set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
> ```

---

## macOS

**macOS 的包必须在 macOS 上打**（需要 `lipo`、`hdiutil`、代码签名等系统工具，Windows 上无法交叉编译出可用的 `.app/.dmg`）。

在 Mac 上：

```bash
pnpm install
pnpm dist:mac        # 会生成 universal（x64 + arm64）的 dmg 与 zip
```

产物：

```
dist/PCL-N-1.0.0-mac-universal.dmg
dist/PCL-N-1.0.0-mac-universal.zip
```

没有 Apple 开发者证书时打包出来是**未签名**的，首次打开会被 Gatekeeper 拦：

- 右键 → 打开，或在「系统设置 - 隐私与安全性」里点「仍要打开」；
- 或者在终端执行 `xattr -cr "/Applications/Plain Craft Launcher N.app"` 去掉隔离属性。

如果要在 GitHub 上出包，仓库里已经带了工作流：

```
.github/workflows/build.yml
```

推一个 tag（例如 `v1.0.0`）或手动触发 workflow，就会在 GitHub 的
**windows-latest / macos-14 / ubuntu-latest** 三个 runner 上分别出
`PCL-N-windows-x64`、`PCL-N-macos-universal`、`PCL-N-linux-x64` 三个 artifact。

### 从 Actions 下载产物

run id 在 Actions 页面链接末尾（`.../actions/runs/<run-id>`）。命令行下载要**显式指定仓库**，
否则在非 git 目录执行会报 `failed to run git: fatal: not a git repository`：

```bash
# 指定仓库 + 绝对路径（-D 后面不能只写一个点，容易被 shell 吃掉）
gh run download <run-id> -R CsOH-Lawrence/PCL-N -n PCL-N-macos-universal -D "D:/downloads/macos"

# 一次拉全部
gh run download <run-id> -R CsOH-Lawrence/PCL-N -D "D:/downloads/pcln"
```

也可以在 Actions 页面底部直接点 Artifacts 下载（浏览器支持断点续传，比命令行稳）。

---

## 打包后的数据目录

打包不会改变运行时的目录规则：

| 平台 | 启动器数据（配置 / 账号 / 日志） | 游戏目录 |
| --- | --- | --- |
| Windows | `%APPDATA%\PlainCraftLauncher` | `%APPDATA%\.minecraft` |
| macOS | `~/Library/Application Support/PlainCraftLauncher` | `~/.minecraft` |
| Linux | `~/.config/PlainCraftLauncher` | `~/.minecraft` |

游戏目录可以在「设置 - 下载设置」里改成任意位置。

---

## 图标

`assets/icon.png`（512×512）会被 electron-builder 自动转换成：

- Windows：多尺寸 `.ico`
- macOS：`.icns`
- Linux：多尺寸 png

想换图标直接替换这个 png（保持 512×512 及以上）再重新打包即可。

---

## 其他说明

- `asar: true`，源码打包进 `app.asar`，但仍可被解包查看（Electron 应用的通病，不要往里面放密钥）。
- 未做自动更新（`electron-updater`）。需要的话可以加 `publish` 配置 + `autoUpdater`。
- 未做代码签名；正式分发建议购买 Windows 代码签名证书 / Apple Developer ID，否则 SmartScreen 与 Gatekeeper 会提示未知开发者。
