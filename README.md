# 协作台 · 企业私有协作平台（私人制 · v2）

一个给办公室内部用的**任务协作**平台：AI 对话式界面，左侧是「任务一 / 任务二…」任务协作室；支持**邮箱登录 + 邀请码注册（管理员发放）**、**按房间的在线绿点**、**文字 + 图片消息（≤100MB，每月自动清理）**，以及可定制的界面（背景图 + 配色）。

零第三方依赖，只用 Node 内置模块，可在内网或公网服务器部署。

## 启动

```bash
cd office-chat
node server.js              # 默认 3000 端口
PORT=8080 node server.js   # 自定义端口
DISABLE_REGISTER=1 node server.js   # 关闭开放注册（仅已有账号可登）
```

需要 Node.js 16+（用了 `crypto.randomUUID()`）。

## 账号体系

- **管理员**（种子账号，首次启动自动创建）：`admin@office.chat` / `admin123`
  - 管理员可在应用内点「🛡 管理」→「生成邀请码」发放邀请码。
- **邀请码规则**：管理员随机生成；**一次性**（被注册使用后失效）；未使用则永久有效。
- **注册字段**：昵称、邮箱、邀请码、密码、确认密码。
  - 昵称会被强制转换为「X包」格式：取输入**最后一个字 + 包**。例如输入「二郎」→ 昵称「郎包」；输入「咸鱼」→「鱼包」。
- **登录**：用邮箱 + 密码。

## 功能与使用

- 登录后点左上角「+ 新建任务」在弹窗中输入任务名，或在左侧栏选择已有任务进入（任务 = 协作室）。
- 进入任务后，右上角显示**在线绿点**：
  - 1 人在线 → 1 个绿点；n 人在线 → n 个绿点；
  - **n > 3** 时显示 3 个绿点 + 数字 `n`。
  - 在线状态按房间统计，约 5 秒刷新一次（离开房间/关闭页面即离线）。
- 消息支持**文字和图片**（仅图片，不支持其他文件格式），单次发送 ≤ **100MB**。
- 消息留存，**每隔一个月自动清理一次**（超过 30 天的消息及其图片会被删除）。

## 输入栏

- 📎 **添加文件**：发送图片（选中即随发送一起发出，可附文字说明）。
- 🤖 **选择模型**：下拉菜单含 GPT-4o / Claude 3.5 / Gemini / Qwen / DeepSeek 等常见大模型——**仅为前端展示（假），不影响协作**。
- 🎤 **语音输入**：调用浏览器 Web Speech API 把语音转文字（Chrome / Edge 支持；不支持的浏览器按钮自动禁用）。

## 外观定制

点右上角「🎨 外观」：切换 5 套配色模板（商务蓝 / 暗夜 / 清新绿 / 暖橙 / 简约灰），并可上传背景图（≤5MB）。设置全局生效。

## 数据存哪

全部在 `office-chat/data/`：`users.json`、`rooms.json`、`messages.json`、`invites.json`、`theme.json`、`sessions.json`、`uploads/`。
备份只需复制整个 `data/` 目录。

## 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/register` | 邀请码注册（昵称→X包） |
| POST | `/api/login` | 邮箱 + 密码登录 |
| POST | `/api/logout` | 退出 |
| GET  | `/api/me` | 当前用户（含角色） |
| GET/POST | `/api/admin/invites` | 管理员查看/生成邀请码 |
| GET  | `/api/rooms` | 任务室列表 |
| POST | `/api/rooms` | 新建任务室 `{name}` |
| GET/POST | `/api/rooms/:id/messages` | 读取/发送消息（text / image） |
| POST | `/api/presence` | 上报/查询某房间在线名单 `{roomId}` |
| GET/POST | `/api/theme` | 读取/设置配色 |
| POST/DELETE | `/api/theme/background` | 上传/移除背景图 |

## 认证方式

登录/注册成功后，后端返回 `token`，前端存到浏览器 `localStorage`，之后每次请求在 `Authorization: Bearer <token>` 头里带上。无 Cookie、无跨域坑，天然适配「前端 GitHub Pages + 后端云服务器」的分离部署。

## 安全说明（上线前必读）

- **改默认管理员密码**：首次启动若未设置 `ADMIN_PASS`，会用默认 `admin123` 并在日志打印警告。上线务必 `ADMIN_PASS=强密码 node server.js`，否则任何人都能用 admin123 登管理员、自行发邀请码。
- **后端必须 HTTPS**：token 存于浏览器 `localStorage`，且前端是 HTTPS 页面，HTTP 后端既会被浏览器拦截，也容易被中间人窃取 token。务必按下方方式上 HTTPS。
- **CORS 必须锁源**：生产设置 `FRONTEND_ORIGIN` 为你的前端域名；留空会放行任意源（仅本地调试用）。
- **邀请制准入**：注册必须有效邀请码（一次性、未用长期有效）；用 `DISABLE_REGISTER=1` 可彻底关闭自助注册，只发固定邀请码给同事。
- **已内置防护**：登录/注册接口内存滑动窗口限速（防爆破）；token 7 天过期；消息文字 ≤50KB、请求体 ≤140MB（防大包打满内存）；邀请码 48 位熵；响应带 `Content-Security-Policy` / `X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff`；上传图片仅接受位图（png/jpg/gif/webp，拒收 SVG，杜绝图片型 XSS）；所有用户文本渲染前经 HTML 转义。
- **局限（需你侧补足）**：限速/在线状态为单进程内存态，多实例部署需换 Redis 等集中存储；token 无服务端吊销列表（管理员改密后旧 token 7 天内仍有效，必要时重启服务清空 `data/sessions.json`）；数据明文存 `data/`，建议服务器磁盘加密并对 `data/` 做定期备份。

## 部署：前端 GitHub Pages + 后端云服务器（推荐拆分方式）

因为你要外网也能访问，把**静态前端挂 GitHub Pages**、**后端 API 跑在云服务器**即可。两者是不同源，需两步配置：

### 1. 后端（云服务器）
```bash
# 在云服务器上
cd office-chat
PORT=3000 FRONTEND_ORIGIN=https://你的用户名.github.io node server.js
# 守护：pm2 start server.js -- --port 3000  （需先 npm i -g pm2）
```
- `FRONTEND_ORIGIN`：填你 GitHub Pages 的站点地址（含 https），后端只允许这个源跨域调用；可逗号分隔多个。留空则放行任意源（仅开发用）。
- 监听 `0.0.0.0`，记得在云厂商安全组放行该端口。
- **后端必须走 HTTPS**：GitHub Pages 是 HTTPS，浏览器会拦截「HTTPS 页面向 HTTP 接口」的混合内容请求。做法任选：
  1. **（推荐，零依赖）本仓库 `server.js` 已内置原生 HTTPS**：只要 `deploy/certs/key.pem` + `cert.pem` 存在（或设 `SSL_KEY` / `SSL_CERT` 环境变量指向证书），启动即自动走 HTTPS，无需装 nginx。用 `deploy/gen-cert.ps1` 可一键生成自签证书。
  2. 用 Cloudflare 代理你的域名（橙云），免费自动证书；
  3. `nginx` 反代 + Let's Encrypt 证书（参考 `deploy/nginx.conf.example`）；
  4. 直接用云厂商提供的 HTTPS 负载均衡/网关。
- 数据全在 `data/`，备份即复制该目录。

### 2. 前端（GitHub Pages）
1. 把 `office-chat/public/` 整个目录内容推到仓库（仓库根或 `/docs`，在仓库 Settings → Pages 选对应分支/目录）。
2. **改 `public/config.js` 里的 `window.API_BASE`**，填你的后端地址（必须 https）：
   ```js
   window.API_BASE = 'https://chat-api.yourdomain.com';  // 例
   ```
   留空 `''` 表示同源（仅 `node server.js` 顺带托管前端时本地调试用）。
3. 推送后等 GitHub Pages 构建完成，访问 `https://你的用户名.github.io/仓库名/` 即可。
4. 资源用相对路径（`./styles.css` 等），项目页（`github.io/仓库名/`）也能正常加载。

> 注意：GitHub Pages 每次改 `config.js` 后需重新提交并等构建（通常几十秒到 1 分钟）。若换了后端域名，只改这一行重新提交即可。

### 3. 关闭开放注册（更私人）
`DISABLE_REGISTER=1 node server.js` 启动后，未持邀请码者无法自助注册；管理员登录后在「🛡 管理」里生成邀请码发给同事。

## 云服务器实操（阿里云 ECS · Linux ＋ 宝塔，首选方案）

> 当前实例已**重装为 Linux**（Alibaba Cloud Linux 3 / Ubuntu 22.04）。采用 **宝塔面板**：一键申请免费 Let's Encrypt 证书（自动续期）、Nginx 反代 Node，HTTPS 证书问题消失；前后端同源托管，`config.js` 的 `API_BASE` 留空即可，无 CORS 问题，也不必再挂 GitHub Pages。
>
> 完整脚本与逐条命令见 **`deploy/install-service.md`**（第一节到第九节）。部署件：`deploy/start.sh`（启动配置）、`deploy/office-chat.service` + `deploy/install-service.sh`（systemd 守护）、`deploy/baota-site.conf`（Nginx 反代片段）。

架构：**宝塔 Nginx（443 HTTPS 终端）** → 静态页发 `public/`；仅 `/api/`、`/uploads/` 反代到本地 node（`127.0.0.1:3000`，HTTP）。node 不碰证书、不处理 HTTPS。

要点速览：重装 Linux → SSH 装 Node18+ → 上传代码到 `/www/wwwroot/office-chat` → 装宝塔 → 建站（根目录指向 `public`）+ 申请 SSL 强制 HTTPS → 按 `baota-site.conf` 加 `/api/`、`/uploads/` 反代 → `bash deploy/install-service.sh` 注册 systemd 守护 → 浏览器开域名验证。

### 备选：Windows Server 2022 直接跑（旧方案，已不推荐）

若保留 Windows 实例，可不装面板、用 NSSM 把 `server.js` 跑成服务（`deploy/install-service.bat` + `gen-cert.ps1`）。但 Windows 版宝塔已停更、无免费证书，自签证书会被 GitHub Pages 前端硬拦截，故不如 Linux + 宝塔省心。细节见 `deploy/install-service.md` 末尾「附：与旧 Windows 方案的区别」。

## 接口一览（均需在 Header 带 `Authorization: Bearer <token>`，除登录/注册外）
