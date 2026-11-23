# Check the Windows desktop prerequisites. Use -Setup to prepare this checkout.
param([switch]$Setup)

$ErrorActionPreference = 'Stop'
$script:missing = 0

function Report([bool]$Ready, [string]$Name, [string]$Instruction) {
    if ($Ready) {
        Write-Host "[OK] $Name" -ForegroundColor Green
    } else {
        $script:missing++
        Write-Host "[PERLU] $Name" -ForegroundColor Yellow
        Write-Host "        $Instruction"
    }
}

Report ([bool](Get-Command git.exe -ErrorAction SilentlyContinue)) 'Git' 'Pasang Git for Windows dari https://git-scm.com/download/win'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeReady = $node -and ((& $node.Source --version) -match '^v24\.')
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
Report ($nodeReady -and $null -ne $npm) 'Node.js 24 dan npm' 'Pilih Node.js versi 24 dari https://nodejs.org/en/download'

$pythonReady = $false
$launcher = Get-Command py.exe -ErrorAction SilentlyContinue
if ($launcher) { $pythonReady = [bool](& $launcher.Source --list | Select-String '(?:-V:|-)(?:PythonCore/)?3\.12(?:\s|[-*]|$)') }
if (-not $pythonReady) {
    foreach ($name in 'python3.12.exe', 'python.exe', 'python3.exe') {
        $python = Get-Command $name -ErrorAction SilentlyContinue
        if ($python -and $python.Source -notlike '*\WindowsApps\*' -and ((& $python.Source --version) -match '^Python 3\.12\.')) {
            $pythonReady = $true
            break
        }
    }
}
Report $pythonReady 'Python 3.12' 'Pasang Python 3.12 dari https://www.python.org/downloads/windows/ dan aktifkan opsi Add Python to PATH.'

$cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
$rustc = Get-Command rustc.exe -ErrorAction SilentlyContinue
$rustReady = $cargo -and $rustc -and ((& $rustc.Source --version 2>$null) -match '^rustc ')
Report $rustReady 'Rust dan Cargo' 'Pasang toolchain stable dari https://rustup.rs/'

$ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
$ffprobe = Get-Command ffprobe.exe -ErrorAction SilentlyContinue
$ffmpegReady = $false
if ($ffmpeg -and $ffprobe) {
    $filters = (& $ffmpeg.Source -hide_banner -filters 2>$null) -join "`n"
    $encoders = (& $ffmpeg.Source -hide_banner -encoders 2>$null) -join "`n"
    $ffmpegReady = $filters -match '\bass\s' -and $encoders -match '\blibx264\s'
}
Report $ffmpegReady 'FFmpeg dan FFprobe dengan libass dan libx264' 'Jalankan winget install --id Gyan.FFmpeg --exact'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$cppReady = (Test-Path -LiteralPath $vswhere) -and [bool](& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
Report $cppReady 'Microsoft C++ Build Tools' 'Pasang Desktop development with C++ dari https://visualstudio.microsoft.com/visual-cpp-build-tools/'

$webView = Get-ItemProperty -Path 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*', 'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\*', 'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.name -like '*WebView2*' -and $_.pv -and $_.pv -ne '0.0.0.0' }
Report ([bool]$webView) 'Microsoft Edge WebView2 Runtime' 'Unduh Evergreen Runtime dari https://developer.microsoft.com/microsoft-edge/webview2/'

if ($script:missing) {
    Write-Host "`nPasang komponen yang ditandai PERLU, buka PowerShell baru, lalu jalankan skrip ini kembali."
    exit 1
}

if ($Setup) {
    Push-Location -LiteralPath $PSScriptRoot
    try {
        & $npm.Source ci
        if ($LASTEXITCODE -ne 0) { throw 'Pemasangan dependensi npm gagal.' }
        & $npm.Source run setup
        if ($LASTEXITCODE -ne 0) { throw 'Persiapan dependensi Python atau model gagal.' }
    } finally {
        Pop-Location
    }
    Write-Host "`nCLIPY.ID siap dibuka dengan npm.cmd run dev:desktop."
} else {
    Write-Host "`nPrasyarat siap. Jalankan .\prepare.ps1 -Setup untuk memasang dependensi aplikasi dan mengunduh model."
}
