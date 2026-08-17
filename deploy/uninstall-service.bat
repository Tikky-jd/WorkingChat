@echo off
chcp 65001 >nul
REM =====================================================================
REM 卸载协作台后端 Windows 服务
REM 运行：右键本文件「以管理员身份运行」
REM =====================================================================
setlocal
set SVC=OfficeChat

if not exist "%~dp0nssm.exe" (
  echo [错误] 找不到 nssm.exe，无法卸载。
  pause & exit /b 1
)

"%~dp0nssm.exe" stop %SVC% 2>nul
"%~dp0nssm.exe" remove %SVC% confirm
echo.
echo [完成] 服务 %SVC% 已卸载。
pause
