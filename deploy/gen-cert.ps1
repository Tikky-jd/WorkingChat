# =====================================================================
# 协作台 · 生成自签证书（Windows Server）
# 用途：让后端以 HTTPS 启动，前端（GitHub Pages）才能调它。
#
# ⚠️ 重要前提（务必先读）
#   自签证书浏览器「不信任」，会出现「您的连接不是私密连接」。
#   - 若前端也放在本机/同域用 IP 访问：浏览器手动点「继续」即可，之后记住。
#   - 若前端是 GitHub Pages（HTTPS）去 fetch 自签证书的后端：浏览器会
#     直接硬拦截（ERR_CERT_AUTHORITY_INVALID），不会给「继续」选项，
#     因此 GitHub Pages 正式上线前必须先换【受信任证书】
#     （阿里云/腾讯云免费 DV 证书，或 Let's Encrypt，需绑定域名）。
#   本脚本仅用于「先跑通 / 内网 / 本地验证」。正式公网请走正规证书。
#
# 用法（在服务器上用 PowerShell 运行）：
#   cd deploy
#   .\gen-cert.ps1                 # 默认给当前服务器 IP 生成
#   .\gen-cert.ps1 -SAN chat.xxx.com   # 若你已有域名，填域名
#
# 证书格式：
#   - 本机有 openssl（Git for Windows 自带）→ 产出 key.pem + cert.pem
#   - 否则（纯 Windows）→ 产出 cert.pfx（server.js 已支持直接读 PFX）
#   PFX 默认密码 officechat，可用 -PfxPass 改，并在 start.bat 设 SSL_PFX_PASS 对应。
# =====================================================================
param(
  [string]$SAN = '47.96.128.187',   # 改成你的服务器公网 IP 或域名
  [int]$Days = 3650,
  [string]$PfxPass = 'officechat'
)

$ErrorActionPreference = 'Stop'
$certDir = Join-Path $PSScriptRoot 'certs'
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$keyPath  = Join-Path $certDir 'key.pem'
$certPath = Join-Path $certDir 'cert.pem'
$pfxPath  = Join-Path $certDir 'cert.pfx'
$errLog   = Join-Path $PSScriptRoot 'certs' '_gen-err.txt'

try {
  # ---- openssl 检测（用 version 实测，避免 Get-Command 误判）----
  $useOpenssl = $false
  try { $v = & openssl version 2>$null; if ($LASTEXITCODE -eq 0 -and $v) { $useOpenssl = $true } } catch {}

  if ($useOpenssl) {
    $ext = if ($SAN -match '^[0-9.]+$') { "subjectAltName=IP:$SAN" } else { "subjectAltName=DNS:$SAN" }
    & openssl req -x509 -newkey rsa:2048 -nodes `
      -keyout $keyPath -out $certPath -days $Days `
      -subj "/CN=$SAN" -addext $ext
    Write-Host "[OK] 已用 openssl 生成 PEM 证书：`n  $keyPath`n  $certPath"
    exit 0
  }

  # ---- 纯 Windows：New-SelfSignedCertificate 产 PFX ----
  Write-Host "[info] 未检测到 openssl，改用 PowerShell 生成 PFX 证书..."
  $sanExt = if ($SAN -match '^[0-9.]+$') { "IP Address=$SAN" } else { "DNS=$SAN" }
  $cert = New-SelfSignedCertificate `
    -Subject "CN=$SAN" -DnsName $SAN `
    -CertStoreLocation 'cert:\CurrentUser\My' `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddDays($Days) `
    -TextExtension @("2.5.29.17={text}$sanExt")
  $pw = ConvertTo-SecureString -String $PfxPass -Force -AsPlainText
  Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pw -Force | Out-Null
  Write-Host "[OK] 已生成 PFX 证书：$pfxPath"
  Write-Host "[重要] PFX 密码为 '$PfxPass'，请在 start.bat / 环境变量设 SSL_PFX_PASS=$PfxPass"
  Write-Host "[提示] 证书同时存于当前用户证书库，可在 mmc → 证书 中查看/删除。"
} catch {
  "ERROR=$($_.Exception.GetType().FullName): $($_.Exception.Message)" | Out-File -FilePath $errLog -Encoding ascii
  Write-Host "[失败] 生成证书出错，详见 $errLog"
  exit 1
}
