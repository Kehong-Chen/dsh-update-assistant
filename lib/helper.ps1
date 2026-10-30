param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [switch]$DryRun
)
$ErrorActionPreference = 'Continue'

try { $Host.UI.RawUI.WindowTitle = 'dsh-update-assistant - 正在辅助更新/重启' } catch { }

$cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
function L([string]$m) {
  try { Add-Content -LiteralPath $cfg.logFile -Value ((Get-Date -Format 'HH:mm:ss') + '  ' + $m) } catch { }
}
function P([string]$m) {
  L $m
  try { Write-Host ('[dsh-update-assistant] ' + $m) } catch { }
}
function HoldOpen([int]$seconds = 10) {
  try {
    Write-Host ''
    Write-Host ('窗口将在 ' + $seconds + ' 秒后自动关闭。')
    Start-Sleep -Seconds $seconds
  } catch { }
}
function Remove-OwnTask {
  schtasks /delete /tn 'DSHUpdateAssistant' /f 2>&1 | Out-Null
}

P ('=== 开始：mode=' + $cfg.mode + '，安装目录 ' + $cfg.installDir)
Start-Sleep -Seconds 3

if ([string]::IsNullOrWhiteSpace($cfg.installDir)) {
  P 'FATAL: installDir missing'
  Remove-OwnTask
  HoldOpen 15
  exit 1
}

# Validate the installer BEFORE taking the app down: a missing or invalid
# installer must never cost the user a restart.
if ($cfg.mode -eq 'install') {
  if (-not ($cfg.installer) -or -not (Test-Path -LiteralPath $cfg.installer)) {
    P ('FATAL: 安装包不存在：' + $cfg.installer)
    Remove-OwnTask
    HoldOpen 15
    exit 1
  }
  if ($cfg.allowUnsigned -ne $true) {
    try {
      P '正在校验安装包签名…'
      $sig = Get-AuthenticodeSignature -LiteralPath $cfg.installer
      if ($sig.Status -ne 'Valid') {
        P ('FATAL: 安装包签名无效（' + $sig.Status + '），已中止，应用未改动。')
        Remove-OwnTask
        HoldOpen 15
        exit 1
      }
      P ('签名有效：' + $sig.SignerCertificate.Subject)
    } catch {
      P ('FATAL: 签名检查失败：' + $_.Exception.Message)
      Remove-OwnTask
      HoldOpen 15
      exit 1
    }
  }
}

if ($DryRun) {
  P 'DRY RUN：跳过结束进程 / 安装 / 重启，仅演示进度输出。'
  Remove-OwnTask
  HoldOpen 5
  exit 0
}
# Take the app down hard: this is the whole point of the helper (the shell's
# graceful path can be blocked by any plugin holding a ref'd handle).
P '正在结束 DSH 进程…'
$killed = 0
for ($round = 0; $round -lt 40; $round++) {
  $procs = @(Get-CimInstance Win32_Process | Where-Object {
    $p = $_
    if ($p.ProcessId -eq $PID) { return $false }
    if ($p.ExecutablePath -and $p.ExecutablePath.StartsWith($cfg.installDir, 'OrdinalIgnoreCase')) { return $true }
    if ($p.CommandLine -and ($p.CommandLine -match 'dsh-desktop-host|dsh-subprocess-local')) { return $true }
    return $false
  })
  if ($procs.Count -eq 0) { break }
  foreach ($p in $procs) {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      $killed++
      L ('killed ' + $p.ProcessId + ' ' + $p.Name)
    } catch {
      L ('kill failed ' + $p.ProcessId + ': ' + $_.Exception.Message)
    }
  }
  Start-Sleep -Seconds 2
}
P ('DSH 已停止（结束 ' + $killed + ' 个进程）')
Start-Sleep -Seconds 2

if ($cfg.mode -eq 'install') {
  P ('正在运行安装包（静默模式），目标版本 ' + $cfg.targetVersion + ' …')
  $proc = $null
  try {
    $proc = Start-Process -FilePath $cfg.installer -ArgumentList '--updated', '/S' -PassThru
  } catch {
    P ('安装包启动失败：' + $_.Exception.Message)
  }
  if ($proc -ne $null) {
    $elapsed = 0
    while (-not $proc.HasExited -and $elapsed -lt 900) {
      Start-Sleep -Seconds 2
      $elapsed += 2
      if ($elapsed % 10 -eq 0) { Write-Host ('   安装中… ' + $elapsed + ' 秒') }
    }
    P ('安装包退出码：' + $proc.ExitCode)
  }
  if ($cfg.targetVersion) {
    P ('等待版本变为 ' + $cfg.targetVersion + ' …')
    $matched = $false
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Seconds 3
      $v = (Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
        Get-ItemProperty | Where-Object { $_.DisplayName -like 'DeepSeek Harness*' } |
        Select-Object -First 1).DisplayVersion
      if ($v -eq $cfg.targetVersion) { P ('版本已更新为 ' + $v); $matched = $true; break }
      if ($i % 5 -eq 0) { Write-Host ('   当前版本：' + $v + '，继续等待…') }
    }
    if (-not $matched) { P ('WARN: 180 秒内版本未变为 ' + $cfg.targetVersion) }
  }
} else {
  P '正在重启 DSH…'
}

if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
  if ($cfg.exe -and (Test-Path -LiteralPath $cfg.exe)) {
    try {
      Start-Process -FilePath $cfg.exe
      P 'DSH 已启动，刷新浏览器页面即可继续。'
    } catch {
      P ('启动失败：' + $_.Exception.Message)
    }
  } else {
    P ('找不到可执行文件：' + $cfg.exe)
  }
} else {
  P '检测到 DSH 已在运行。'
}

P '=== 完成 ==='
Remove-OwnTask
if ($Host.Name -eq 'ConsoleHost') { HoldOpen 8 }
