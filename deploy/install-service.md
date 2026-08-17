# 协作台 · Linux（阿里云）＋ 宝塔 部署与守护

> 部署目标：阿里云 ECS 重装为 **Linux**（Alibaba Cloud Linux 3 / Ubuntu 22.04），
> 用 **宝塔面板** 一键申请免费 Let's Encrypt 证书、Nginx 反代 Node，HTTPS 证书问题彻底消失。
> 架构：**宝塔 Nginx（443 HTTPS 终端）** → 静态页发 `public/`；**仅 `/api/`、`/uploads/` 反代到本地 node（127.0.0.1:3000，HTTP）**。
> node 不碰证书、不处理 HTTPS，证书续期全交给宝塔。前端与后端同源 → 无 CORS 问题，也不再用 GitHub Pages。

---

## 一、重装系统（阿里云控制台）

1. ECS 控制台 → 实例 → 点进实例 → **「更多」→「实例状态」→「停止」**。
2. **「更多」→「云盘和镜像」→「更换操作系统」**（或「重新初始化云盘」）。
3. 镜像选 **公共镜像 → Alibaba Cloud Linux 3（64位）**（或 Ubuntu 22.04）。
   - 设置 root 密码（记住它，SSH 登录用）。
   - 安全组：确认已放行 **22(SSH)、443、80**（80/443 用来申请证书和对外服务）。
4. 确认更换，等几分钟实例变「运行中」。

> 重装会清空原 Windows 系统盘，数据会没——反正刚起步，无损失。

---

## 二、SSH 连服务器 + 装基础环境

```bash
# 本地终端（或用阿里云「远程连接 / Workbench」）
ssh root@你的服务器公网IP
# 首次输入 yes，再输 root 密码

# 装 Node.js 18+（以 Alibaba Cloud Linux / CentOS 系为例）
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs          # 若 Ubuntu 则用：apt-get install -y nodejs
node -v                        # 应显示 v18.x 或更高
```

---

## 三、上传代码到服务器

**方式 A（推荐，以后改代码最省心）—— Git：**
```bash
# 本地先把 office-chat 推到 GitHub 私有仓库（.gitignore 加 data/ 和 deploy/certs/）
# 服务器：
yum install -y git
git clone <你的仓库> /www/wwwroot/office-chat
```
**方式 B—— 本地压缩后传：**
1. 本地把 `office-chat/` 压成 `office-chat.zip`（排除 `data/` 与 `deploy/certs/`）。
2. 用阿里云控制台「**发送文件**」（云助手）或 `scp` 传到服务器 `/www/wwwroot/`。
3. 服务器解压：`cd /www/wwwroot && unzip office-chat.zip`。

最终代码在 `/www/wwwroot/office-chat/`，结构含 `server.js`、`public/`、`data/`、`deploy/`。

---

## 四、装宝塔面板

```bash
# Alibaba Cloud Linux 3 / CentOS
curl -sSO https://download.bt.cn/install/install_panel.sh && bash install_panel.sh
# Ubuntu / Debian
# wget -O install.sh http://download.bt.cn/install/install-ubuntu_6.0.sh && sudo bash install.sh
```
装完会打印 **面板地址 / 用户名 / 密码**（形如 `http://IP:8888/xxxx`）。
- 浏览器打开面板地址，按提示绑定宝塔账号、装 **LNMP（Nginx 必装，MySQL/PHP 可不选）**。
- 阿里云安全组需放行 **8888（面板）** 入方向（用完后可在面板设置里改端口或限制 IP）。

---

## 五、宝塔建站 + 免费 HTTPS 证书

1. 宝塔 → **网站 → 添加站点**：
   - 域名：填你的域名（如 `office.example.com`）；若**还没备案/没域名**，先填服务器 **公网 IP** 也能建站（IP 方式无法申请 Let's Encrypt，见第七节的临时方案）。
   - 根目录：改成 `/www/wwwroot/office-chat/public`（前端静态页所在）。
   - PHP 版本选「纯静态」即可。提交。
2. **申请 SSL 证书**：站点 → **SSL → Let's Encrypt** → 勾选域名 → 「申请」。
   - 成功后在「SSL」页打开 **「强制 HTTPS」**。
   - 宝塔会每 90 天自动续期，无需手动。
   - （用 IP 建站时此步跳过，走第七节。）

> 域名需提前把 DNS A 记录指向服务器 IP；国内服务器绑域名**必须 ICP 备案**，否则 80/443 会被运营商拦。
> 备案在阿里云「ICP 代备案系统」免费提交（约 1–2 周）。备案前可先用 IP + 自签/临时方式验证。

---

## 六、Nginx 反代（关键）

把 node 的 `/api/`、`/uploads/` 反代到本地 3000，静态页仍由 Nginx 直接发。

**推荐：直接改站点配置。** 宝塔 → 站点 → **配置文件**，确认顶部 `root` 已指向 `.../public`，
然后在原有的 `location / {` **之前**插入 `deploy/baota-site.conf` 里标好的两段 `location`（/api/、/uploads/），并加 `client_max_body_size 140m;`。
保存后「重载配置」。

> 要点：
> - `location /` 保持原样（托管 public/ 静态文件），**不要**给它加 `proxy_pass`。
> - `/.well-known/` 由宝塔自建用于证书验证，保持从 root 读取，不要代理。
> - node 跑在 127.0.0.1:3000（仅本机），**不要在安全组/防火墙对外暴露 3000**。

---

## 七、启动 Node（systemd 守护）

```bash
# 先改启动配置里的域名（与宝塔站点一致）
vi /www/wwwroot/office-chat/deploy/start.sh
#   把 FRONTEND_ORIGIN='https://你的域名' 改成真实域名（或 https://服务器IP）

# 注册为系统服务（开机自启 + 崩溃自拉起）
bash /www/wwwroot/office-chat/deploy/install-service.sh
# 看日志确认起来：
journalctl -u office-chat -f
# 应看到：Office chat started.
```

**临时方案（用 IP、未备案、无 Let's Encrypt 时）：**
node 自己起 HTTPS 不方便，最简是让 `server.js` 在 443 自签证书 + 同域托管前端：
- 服务器装 openssl，或用 `deploy/gen-cert.ps1`（那是 Windows 版，Linux 用 `openssl req` 生成 `deploy/certs/key.pem`+`cert.pem`）。
- 改 `start.sh` 里 `PORT=443`，`server.js` 检测到证书自动走 HTTPS。
- 浏览器访问 `https://服务器IP/` 首次手动信任一次自签证书即可。
- 此方式**不需要宝塔、不需要域名、不需要备案**，适合先跑通。正式域名备案后切回第六节的反代即可。

> 想用宝塔自带 PM2 管 node 也行：宝塔 → 软件商店 → 安装 PM2 → 「Node 项目」添加 `server.js`，
> 但 systemd 更稳、不依赖宝塔版本，推荐 systemd。

---

## 八、验证上线

浏览器打开宝塔站点的域名（或 IP）：
- 首页应显示「协作台」企业落地页（无「聊天」字样）。
- 点登录，用管理员 `admin@office.chat` / `admin0820` 登录。
- 进协作台发一条图文消息、建一条代办、写一条备注，确认都正常。
- 服务器 `journalctl -u office-chat -f` 无报错。

---

## 九、日常运维

- **改管理员密码**：登录后在「🛡 管理」里改；或清空 `data/users.json` 重启，用 `ADMIN_PASS` 重新播种。
- **备份**：定期复制整个 `data/`（`users/rooms/messages/invites/todos/notes/theme`）。
- **看日志**：`journalctl -u office-chat -f`。
- **重启服务**：`systemctl restart office-chat`。
- **证书续期**：宝塔自动续，无需管；若手动，站点 → SSL → 续期。
- **改代码后**：`git pull`（或重新传文件）→ `systemctl restart office-chat`；前端静态改了宝塔会自动生效（Nginx 读 public/）。
- **端口冲突**：node 固定 3000（本机），对外只 443；若 3000 被占改 `start.sh` 的 `PORT` + 同步 `baota-site.conf` 的 `proxy_pass`。

---

## 附：与旧 Windows 方案的区别

- 旧方案（Windows + NSSM + 自签证书）已不再需要；本目录仍保留 `start.bat`、`install-service.bat`、`gen-cert.ps1` 供参考，但**首选 Linux + 宝塔**路线。
- 证书：Windows 方案要自己搞自签/win-acme；Linux + 宝塔由面板一键免费证书 + 自动续期。
- 跨域：Windows 方案前端在 GitHub Pages 需 CORS + 受信任证书；Linux + 宝塔同源托管，CORS 消失。
