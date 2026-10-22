@echo off
cd /d "%~dp0"
rem 允许手动启动 Electron（避免被 ELECTRON_RUN_AS_NODE 影响）
set "ELECTRON_RUN_AS_NODE="
if not exist "node_modules\electron\dist\electron.exe" (
    echo [PCL-N] 未找到 Electron 依赖，正在安装...
    call pnpm install
)
if exist "node_modules\electron\dist\electron.exe" (
    start "" "node_modules\electron\dist\electron.exe" "%~dp0."
) else (
    echo [PCL-N] 依赖安装失败，请检查 Node.js / pnpm 是否可用。
    pause
)
