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
#    暂用 IP 访问（未买域名、未备案）：填 http://服务器IP（无证书所以是 http）
export FRONTEND_ORIGIN='http://47.96.128.187'

# ↑↑↑ 改完以上两项再启动 ↑↑↑

# 注册开关（本项目注册本来就强制要邀请码，这里控制「邀请码通道」是否开放）：
#   '0' = 管理员发放的邀请码可注册（私人办公室推荐，员工凭码自助加入）
#   '1' = 完全关闭注册（连邀请码也不行，只剩预置管理员能登录，慎用）
export DISABLE_REGISTER='0'

# 监听端口（宝塔反代时固定 3000，HTTP，不对外暴露）
export PORT=3000

cd "$(dirname "$0")/.."   # 切到 office-chat 根目录
exec node server.js
