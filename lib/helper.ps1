param(
  [Parameter(Mandatory = $true)][string]$ConfigPath
)
$ErrorActionPreference = 'Continue'

$cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
function L([string]$m) {
  try { Add-Content -LiteralPath $cfg.logFile -Value ((Get-Date -Format 'HH:mm:ss') + '  ' + $m) } catch { }
}

function Remove-OwnTask {
  schtasks /delete /tn 'DSHUpdateAssistant' /f 2>&1 | Out-Null
}

L ('=== start mode=' + $cfg.mode + ' installDir=' + $cfg.installDir)
Start-Sleep -Seconds 3

if ([string]::IsNullOrWhiteSpace($cfg.installDir)) {
  L 'FATAL: installDir missing'
  Remove-OwnTask
  exit 1
}

# Validate the installer BEFORE taking the app down: a missing or invalid
# installer must never cost the user a restart.
if ($cfg.mode -eq 'install') {
  if (-not ($cfg.installer) -or -not (Test-Path -LiteralPath $cfg.installer)) {
    L ('FATAL: installer missing: ' + $cfg.installer)
    Remove-OwnTask
    exit 1
  }
  if ($cfg.allowUnsigned -ne $true) {
    try {
      $sig = Get-AuthenticodeSignature -LiteralPath $cfg.installer
      if ($sig.Status -ne 'Valid') {
        L ('FATAL: installer signature not valid (' + $sig.Status + '): ' + $cfg.installer)
        Remove-OwnTask
        exit 1
      }
      L ('installer signature valid: ' + $sig.SignerCertificate.Subject)
    } catch {
      L ('FATAL: signature check failed: ' + $_.Exception.Message)
      Remove-OwnTask
      exit 1
    }
  }
}

# Take the app down hard: this is the whole point of the helper (the shell's
# graceful path can be blocked by any plugin holding a ref'd handle).
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
      L ('killed ' + $p.ProcessId + ' ' + $p.Name)
    } catch {
      L ('kill failed ' + $p.ProcessId + ': ' + $_.Exception.Message)
    }
  }
  Start-Sleep -Seconds 2
}
Start-Sleep -Seconds 2

if ($cfg.mode -eq 'install') {
  L ('running installer: ' + $cfg.installer)
  try {
    $r = Start-Process -FilePath $cfg.installer -ArgumentList '--updated', '/S' -Wait -PassThru
    L ('installer exit code ' + $r.ExitCode)
  } catch {
    L ('installer launch failed: ' + $_.Exception.Message)
  }
  if ($cfg.targetVersion) {
    $matched = $false
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Seconds 3
      $v = (Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
        Get-ItemProperty | Where-Object { $_.DisplayName -like 'DeepSeek Harness*' } |
        Select-Object -First 1).DisplayVersion
      if ($v -eq $cfg.targetVersion) { L ('version now ' + $v); $matched = $true; break }
    }
    if (-not $matched) { L ('WARN: installed version did not become ' + $cfg.targetVersion + ' within 180s') }
  }
}

if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
  if ($cfg.exe -and (Test-Path -LiteralPath $cfg.exe)) {
    try {
      Start-Process -FilePath $cfg.exe
      L 'relaunched app'
    } catch {
      L ('relaunch failed: ' + $_.Exception.Message)
    }
  } else {
    L ('exe missing: ' + $cfg.exe)
  }
} else {
  L 'app already running'
}

L '=== done ==='
Remove-OwnTask
