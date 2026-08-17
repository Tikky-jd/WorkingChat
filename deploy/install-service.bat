@echo off
chcp 65001 >nul
REM =====================================================================
REM 协作台 后端 → 注册为 Windows 服务（开机自启 + 崩溃自动重启）
REM 前置：把 nssm.exe 放到本目录（下载：https://nssm.cc/download ）
REM 运行：右键本文件「以管理员身份运行」
REM =====================================================================
setlocal
set APP_DIR=%~dp0\..
set SVC=OfficeChat
set NODE=node

if not exist "%~dp0nssm.exe" (
  echo [错误] 请先把 nssm.exe 放到 deploy 目录再运行。
  echo         下载：https://nssm.cc/download
  pause & exit /b 1
)

REM 确认 node 在 PATH 中
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 18+ 并确认 node 在系统 PATH。
  pause & exit /b 1
)

"%~dp0nssm.exe" install %SVC% %NODE% "%APP_DIR%\server.js"
"%~dp0nssm.exe" set %SVC% AppDirectory "%APP_DIR%"
"%~dp0nssm.exe" set %SVC% AppEnvironmentExtra ADMIN_PASS=admin0820 FRONTEND_ORIGIN=https://你的用户名.github.io DISABLE_REGISTER=1 PORT=3000 SSL_PFX_PASS=officechat
"%~dp0nssm.exe" set %SVC% DisplayName "协作台后端"
"%~dp0nssm.exe" set %SVC% Description "办公室协作后端 Node 服务（协作台 / OfficeChat）"
"%~dp0nssm.exe" set %SVC% Start SERVICE_AUTO_START
"%~dp0nssm.exe" set %SVC% AppExit Default Restart

net start %SVC%
echo.
echo [完成] 服务 %SVC% 已安装并启动。可在 services.msc 查看/启停。
echo         日志：nssm 会把输出写入 Windows 事件日志（事件查看器 → Windows 日志 → 应用程序，来源 OfficeChat）
pause
