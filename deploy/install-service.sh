#!/usr/bin/env bash
# =====================================================================
# 协作台 · 注册为 Linux systemd 服务（开机自启 + 崩溃自拉起）
# 在服务器上以 root 运行：
#   bash /www/wwwroot/office-chat/deploy/install-service.sh
# 卸载：
#   systemctl disable office-chat && systemctl stop office-chat
#   rm /etc/systemd/system/office-chat.service && systemctl daemon-reload
# =====================================================================
set -e

APP_DIR=/www/wwwroot/office-chat
SERVICE_SRC="$APP_DIR/deploy/office-chat.service"
SERVICE_DST=/etc/systemd/system/office-chat.service

if [ ! -f "$SERVICE_SRC" ]; then
  echo "找不到 $SERVICE_SRC，请确认代码已上传到 $APP_DIR"
  exit 1
fi

# 1. 目录归属改为 www（宝塔站点用户），否则 node 无法写 data/ 与 uploads/
chown -R www:www "$APP_DIR"
chmod -R 755 "$APP_DIR"

# 2. 安装并启用服务
cp "$SERVICE_SRC" "$SERVICE_DST"
systemctl daemon-reload
systemctl enable office-chat.service
systemctl restart office-chat.service

echo "✅ 服务已安装并启动"
echo "查看日志：  journalctl -u office-chat -f"
echo "启停命令：  systemctl start|stop|restart office-chat"
