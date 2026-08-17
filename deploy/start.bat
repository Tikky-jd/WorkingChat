@echo off
chcp 65001 >nul
REM =====================================================================
REM 协作台 后端启动脚本（Windows Server）
REM 直接双击或命令行运行即可；若监听 443，请「以管理员身份运行」。
REM （生产环境建议用 install-service.bat 注册成 Windows 服务，开机自启）
REM =====================================================================

REM ↓↓↓ 启动前必须改的 4 项 ↓↓↓

REM 1) 管理员密码（务必强密码；空库首启时以此播种，改密码需清 data/users.json 重启）
set ADMIN_PASS=admin0820

REM 2) 前端来源白名单（填 GitHub Pages 真实地址；留空会放行任意源，仅调试用）
set FRONTEND_ORIGIN=https://你的用户名.github.io

REM 3) 仅允许已发邀请码的人注册（推荐 1；开放注册改 0）
set DISABLE_REGISTER=1

REM 4) 监听端口：3000 普通权限即可；443 需管理员身份（生产推荐，URL 更干净）
set PORT=3000

REM 5) HTTPS 证书密码：gen-cert.ps1 在「纯 Windows 无 openssl」时产出 deploy/certs/cert.pfx
REM    下方密码须与 gen-cert.ps1 的 -PfxPass 一致（默认 officechat）。
REM    若证书是 cert.pem+key.pem（有 openssl 时），此变量无效，server.js 自动识别。
set SSL_PFX_PASS=officechat

REM ↑↑↑ 改完以上五项再启动 ↑↑↑

cd /d "%~dp0\.."
node server.js
pause
