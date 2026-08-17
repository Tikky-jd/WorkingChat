#!/usr/bin/env bash
# =====================================================================
# 协作台 后端启动脚本（Linux + 宝塔 环境）
# 架构：node 跑在 127.0.0.1:3000（HTTP），由宝塔 Nginx 反代到 443 HTTPS。
#       node 不需要证书、不需要 nginx 配置——证书和 HTTPS 全交给宝塔。
# 用法：
#   chmod +x start.sh
#   ./start.sh              # 前台运行（调试）
#   nohup ./start.sh &      # 后台常驻
#   推荐用 systemd 守护：见 install-service.sh（开机自启 + 崩溃自拉起）
# =====================================================================

# ↓↓↓ 启动前必须改的 2 项 ↓↓↓

# 1) 管理员密码（务必改成强密码，否则默认 admin123 谁都能登）
export ADMIN_PASS='admin0820'

# 2) 前端来源白名单（宝塔站点域名，必须和 Nginx 反代同源，否则浏览器 CORS 拦截）
#    例：你的宝塔站点绑定 office.example.com，则填 https://office.example.com
#    若暂用 IP 访问（未备案），填 https://你的服务器IP
export FRONTEND_ORIGIN='https://你的域名'

# ↑↑↑ 改完以上两项再启动 ↑↑↑

# 仅允许已发邀请码的人注册（推荐 1；要开放注册改成 0）
export DISABLE_REGISTER='1'

# 监听端口（宝塔反代时固定 3000，HTTP，不对外暴露）
export PORT=3000

cd "$(dirname "$0")/.."   # 切到 office-chat 根目录
exec node server.js
