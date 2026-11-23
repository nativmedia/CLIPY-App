# CLIPY.ID launcher for Windows: update, (re)start the local servers, open the app.
#
# 1. Pulls a newer version from GitHub when one exists and it does not clash with
#    local, uncommitted changes (a clash is reported and skipped, nothing is lost).
# 2. Installs missing dependencies and updates them when their inputs change.
# 3. Restarts the API (port 4748) and the web server (port 4747) when their code
#    changed since they were started, unless a project is still being processed.
# 4. Opens CLIPY.ID in a Google Chrome app window.
#
# Messages stay ASCII so Windows PowerShell 5.1 shows them correctly.

param([string]$Repo = $env:CLIPY_LAUNCH_DIR)

$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
if (-not $Repo) { $Repo = Split-Path -Parent $PSScriptRoot }
$Repo = (Resolve-Path -LiteralPath $Repo).Path

$ApiPort = 4748
$WebPort = 4747
$ApiUrl = "http://127.0.0.1:$ApiPort"
$WebUrl = "http://127.0.0.1:$WebPort"
$StateFile = Join-Path $Repo 'server\data\launcher-state.json'
$Python = Join-Path $Repo 'server\.venv\Scripts\python.exe'
$Vite = Join-Path $Repo 'node_modules\vite\bin\vite.js'

$script:Warned = $false
$LogFile = Join-Path $Repo 'server\data\launcher.log'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile) | Out-Null
Set-Content -LiteralPath $LogFile -Value ("launcher " + (Get-Date).ToString('s')) -Encoding UTF8
function Log([string]$Text) { Add-Content -LiteralPath $LogFile -Value $Text -Encoding UTF8 }
function Say([string]$Text, [string]$Color = 'Gray') {
  if ($Color -eq 'Yellow') { $script:Warned = $true }
  Write-Host "> $Text" -ForegroundColor $Color
  Log "> $Text"
}

function Responds([string]$Url) {
  try { return (Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}

# Run git without letting its progress output on stderr stop the script.
function Invoke-Git([string[]]$GitArgs) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & git -C $Repo -c core.quotepath=false @GitArgs 2>$null
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = @($out | Where-Object { $_ -ne $null }) }
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Invoke-Npm([string[]]$NpmArgs) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location -LiteralPath $Repo
  try {
    & npm.cmd @NpmArgs
    if ($LASTEXITCODE -ne 0) { throw "npm $($NpmArgs -join ' ') gagal (kode $LASTEXITCODE)." }
  } finally {
    Pop-Location
    $ErrorActionPreference = $previous
  }
}

# A fingerprint of the files a running server has loaded: path, size and time.
function Get-Fingerprint([string[]]$Patterns) {
  $lines = foreach ($pattern in $Patterns) {
    Get-ChildItem -Path (Join-Path $Repo $pattern) -File -ErrorAction SilentlyContinue |
      ForEach-Object { '{0}|{1}|{2}' -f $_.FullName.Substring($Repo.Length), $_.Length, $_.LastWriteTimeUtc.Ticks }
  }
  $text = (@($lines) | Sort-Object) -join "`n"
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))) -replace '-', '' }
  finally { $sha.Dispose() }
}

$ApiFiles = @('server\app.py', 'server\clipy\*.py', 'web\public\fonts\*', 'server\requirements.txt')
$WebFiles = @('package.json', 'package-lock.json', 'web\package.json', 'web\vite.config.ts')

function Read-State {
  try { return Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-State($Api, $Web) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StateFile) | Out-Null
  [pscustomobject]@{ api = $Api; web = $Web; updated = (Get-Date).ToString('s') } |
    ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

function Stop-Port([int]$Port) {
  $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
  # Also match the server processes by command line: a listener's owner can be a
  # parent that has already gone, while its python/node child keeps the port.
  $pattern = if ($Port -eq $ApiPort) { 'uvicorn app:app*--port ' + $Port } else { 'vite*--port ' + $Port }
  $owners += @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$pattern*" } | Select-Object -ExpandProperty ProcessId)
  foreach ($id in ($owners | Where-Object { $_ -gt 4 } | Select-Object -Unique)) {
    Log "stop port $Port pid $id"
    try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { Log "  gagal: $($_.Exception.Message)" }
  }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline -and (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 300
  }
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Server lama di port $Port tidak bisa dihentikan. Tutup lewat Task Manager (python.exe / node.exe) lalu jalankan CLIPY.ID.cmd lagi."
  }
}

# True while the API is clipping, rendering or transcribing: never restart then.
function Test-ApiBusy {
  try {
    # Windows PowerShell returns a JSON array as one object; unroll it explicitly.
    $projects = @(Invoke-RestMethod -Uri "$ApiUrl/api/projects" -TimeoutSec 3) | ForEach-Object { $_ }
    $running = @($projects | Where-Object { $_ -and $_.status -and $_.status -notin @('done', 'error', 'cancelled') })
    Log ("busy check: " + (@($running | ForEach-Object { "$($_.id)=$($_.status)" }) -join ', '))
    return $running.Count -gt 0
  } catch {
    return $false
  }
}

# ---------- 1. update from GitHub ----------

function Update-FromGitHub {
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue) -or -not (Test-Path -LiteralPath (Join-Path $Repo '.git'))) {
    Say 'cek pembaruan GitHub ...... dilewati (git tidak tersedia)' 'DarkGray'
    return @()
  }
  # A lock left by an interrupted git command blocks every later one.
  $lock = Join-Path $Repo '.git\index.lock'
  if ((Test-Path -LiteralPath $lock) -and -not (Get-Process git -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
  }
  $env:GIT_TERMINAL_PROMPT = '0'
  $fetch = Invoke-Git @('-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=15', 'fetch', '--quiet')
  if ($fetch.Code -ne 0) {
    Say 'cek pembaruan GitHub ...... tidak bisa terhubung, memakai versi lokal' 'Yellow'
    return @()
  }
  if ((Invoke-Git @('rev-parse', '--abbrev-ref', '@{u}')).Code -ne 0) {
    Say 'cek pembaruan GitHub ...... branch ini tidak terhubung ke GitHub, dilewati' 'DarkGray'
    return @()
  }
  $behind = [int]((Invoke-Git @('rev-list', '--count', 'HEAD..@{u}')).Out | Select-Object -First 1)
  $ahead = [int]((Invoke-Git @('rev-list', '--count', '@{u}..HEAD')).Out | Select-Object -First 1)
  if ($behind -eq 0) {
    Say 'cek pembaruan GitHub ...... sudah versi terbaru' 'Green'
    return @()
  }
  if ($ahead -gt 0) {
    Say "cek pembaruan GitHub ...... ada $behind commit baru, tapi riwayat lokal berbeda; update dilewati" 'Yellow'
    return @()
  }
  $incoming = @((Invoke-Git @('diff', '--name-only', 'HEAD', '@{u}')).Out)
  $local = @((Invoke-Git @('status', '--porcelain', '--untracked-files=all')).Out | ForEach-Object {
    ($_.Substring(3) -split ' -> ')[-1].Trim('"')
  })
  $clash = @($incoming | Where-Object { $local -contains $_ })
  if ($clash.Count -gt 0) {
    Say "cek pembaruan GitHub ...... ada $behind commit baru, tapi bentrok dengan perubahan lokal:" 'Yellow'
    $clash | Select-Object -First 8 | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    Say 'update dilewati; app tetap dibuka dengan kode lokal' 'Yellow'
    return @()
  }
  Say "cek pembaruan GitHub ...... ada $behind commit baru, mengambil" 'Cyan'
  if ((Invoke-Git @('merge', '--ff-only', '--quiet', '@{u}')).Code -ne 0) {
    Say 'update gagal diterapkan; app tetap dibuka dengan kode lokal' 'Yellow'
    return @()
  }
  Say 'pembaruan GitHub .......... terpasang' 'Green'
  return $incoming
}

try {
  Write-Host 'CLIPY.ID' -ForegroundColor White
  $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
              "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
              "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $chrome) { throw 'Google Chrome belum ditemukan.' }

  $apiUp = Responds "$ApiUrl/api/options"
  $busy = $apiUp -and (Test-ApiBusy)
  $changed = @()
  if ($busy) {
    Say 'cek pembaruan GitHub ...... ditunda, CLIPY.ID sedang memproses project' 'Yellow'
  } else {
    $changed = @(Update-FromGitHub)
  }

  # ---------- 2. first-run setup and dependency updates ----------
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'Node.js dan npm belum tersedia. Jalankan prepare.bat untuk melihat petunjuk pemasangan.'
  }
  $npmChanged = @($changed | Where-Object { $_ -in @('package.json', 'package-lock.json', 'web/package.json') }).Count -gt 0
  $setupChanged = @($changed | Where-Object { $_ -in @('server/requirements.txt', 'scripts/setup.mjs') }).Count -gt 0
  $needsNpm = $npmChanged -or -not (Test-Path -LiteralPath $Vite)
  & $node (Join-Path $Repo 'scripts\setup.mjs') --check
  $needsSetup = $setupChanged -or $LASTEXITCODE -ne 0
  if ($needsNpm -or $needsSetup) {
    if ($busy) { throw 'CLIPY.ID sedang memproses project. Jalankan kembali setelah proses selesai untuk menyiapkan dependensi.' }
    Say 'dependensi ................. menyiapkan aplikasi (bisa beberapa menit)' 'Cyan'
    if ($npmChanged -or $setupChanged) {
      Stop-Port $ApiPort
      Stop-Port $WebPort
    }
    if ($needsNpm) { Invoke-Npm @('ci') }
    if ($needsSetup) { Invoke-Npm @('run', 'setup') }
  } elseif ($changed.Count -gt 0) {
    Say 'dependensi ................. tidak berubah' 'DarkGray'
  }

  if (-not (Test-Path -LiteralPath $Python) -or -not (Test-Path -LiteralPath $Vite)) {
    throw "Penyiapan dependensi CLIPY.ID belum lengkap di $Repo. Periksa pesan instalasi di atas."
  }

  # ---------- 3. restart servers whose code changed ----------
  $state = Read-State
  $apiPrint = Get-Fingerprint $ApiFiles
  $webPrint = Get-Fingerprint $WebFiles
  $apiUp = Responds "$ApiUrl/api/options"
  $webUp = Responds "$WebUrl/"
  # Always replace a running server with a fresh one so the newest code is used,
  # except while a project is still being processed.
  if ($apiUp -or $webUp) {
    if ($apiUp -and (Test-ApiBusy)) {
      Say 'project masih diproses; server lama dibiarkan berjalan' 'Yellow'
    } else {
      Say 'menghentikan server lama ...' 'Cyan'
      Stop-Port $ApiPort
      Stop-Port $WebPort
      $apiUp = $false
      $webUp = $false
    }
  }
  Say 'menyalakan server baru ...' 'Cyan'

  if (-not $apiUp) {
    Start-Process -FilePath $Python -ArgumentList "-m uvicorn app:app --host 127.0.0.1 --port $ApiPort" `
      -WorkingDirectory (Join-Path $Repo 'server') -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $Repo 'server\chrome-api.log') `
      -RedirectStandardError (Join-Path $Repo 'server\chrome-api-error.log')
  }
  if (-not $webUp) {
    Start-Process -FilePath $node -ArgumentList ('"' + $Vite + '" --host 127.0.0.1 --port ' + $WebPort + ' --strictPort') `
      -WorkingDirectory (Join-Path $Repo 'web') -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $Repo 'server\chrome-web.log') `
      -RedirectStandardError (Join-Path $Repo 'server\chrome-web-error.log')
  }

  # ---------- 4. open the app ----------
  Say 'menyiapkan CLIPY.ID ...' 'Gray'
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    if ((Responds "$WebUrl/api/options") -and (Responds "$WebUrl/")) {
      Write-State $apiPrint $webPrint
      Say 'membuka CLIPY.ID' 'Green'
      Start-Process -FilePath $chrome -ArgumentList "--app=$WebUrl/"
      # Leave a warning (skipped update, delayed restart) on screen long enough to read.
      Start-Sleep -Seconds $(if ($script:Warned) { 8 } else { 2 })
      exit 0
    }
    Start-Sleep -Seconds 1
  }
  throw 'CLIPY.ID belum siap. Periksa file chrome-api-error.log dan chrome-web-error.log di folder server.'
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
