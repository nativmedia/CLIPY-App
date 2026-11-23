# CLIPY.ID

Aplikasi desktop untuk membuat klip pendek dan rangkuman cerita dari video YouTube atau file lokal. CLIPY.ID membantu memilih momen, menyesuaikan crop, membuat caption, dan menyiapkan video untuk dibagikan.

![Jendela utama CLIPY.ID](docs/screenshots/desktop.webp)

<details>
<summary>Layar pembuka</summary>

![Logo resmi CLIPY.ID saat aplikasi dibuka](docs/screenshots/startup.webp)

</details>

## Install

Siapkan [prasyarat sistem](#prasyarat) sekali. Perintah di bawah mengambil kode sumber, memasang dependensi proyek, lalu membuka jendela CLIPY.ID. Kompilasi pertama bisa memakan waktu beberapa menit.

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/nativmedia/CLIPY-App/main/install.ps1 | iex
```

**macOS dan Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/nativmedia/CLIPY-App/main/install.sh | sh
```

Lokasi kode setelah pemasangan

- Windows — `%LOCALAPPDATA%\CLIPY.ID-Client`
- macOS — `~/Library/Application Support/CLIPY.ID-Client`
- Linux — `~/.local/share/CLIPY.ID-Client` atau di bawah `$XDG_DATA_HOME` jika disetel

Tutup CLIPY.ID sebelum menjalankan ulang perintah instalasi untuk mengambil perubahan terbaru dari GitHub, atau buka folder tersebut dan jalankan **npm run dev:desktop** untuk memakai salinan yang sudah terpasang.

## Jalankan dari kode sumber

Di Windows, klik dua kali **CLIPY.ID.cmd** dari folder yang baru di-clone. Pembukaan pertama menyiapkan paket dan model secara otomatis. **prepare.bat** dapat dipakai untuk mengecek prasyarat sistem.

```sh
git clone https://github.com/nativmedia/CLIPY-App.git
cd CLIPY-App
npm ci
npm run setup
npm run dev:desktop
```

Di PowerShell Windows, gunakan `npm.cmd` jika perintah `npm` diblokir oleh kebijakan skrip.

**npm run setup** menyiapkan lingkungan Python lokal dan model untuk crop serta deteksi tawa. Setelah itu cukup gunakan **npm run dev:desktop** untuk membuka aplikasi lagi. Selesaikan pekerjaan video yang sedang berjalan sebelum menutup jendela.

## Jalankan dengan Kiri

Buka Kiri dan pastikan engine berjalan. Dari folder repo, jalankan
`docker --context kiri compose up -d --build`. Buka
[CLIPY.ID](http://127.0.0.1:4747) di browser. Di Kiri, buka **Docker → Containers**
untuk melihat status dan log container CLIPY.ID.

Versi Docker menggunakan CPU dan menyimpan proyek, pengaturan, serta cache model
transkripsi di volume Docker tersendiri. Untuk video lokal, gunakan unggahan di
browser. Dialog file dan perintah untuk membuka folder Windows tersedia di versi desktop.

### GPU NVIDIA di Kiri untuk Windows

Konfigurasi GPU meneruskan perangkat GPU WSL dan memasang pustaka driver NVIDIA
dalam mode hanya baca. Jalankan dari PowerShell Windows dengan Kiri aktif dan
driver NVIDIA untuk WSL terpasang. Tunggu proses video aktif selesai sebelum
mengganti container. Volume proyek dan model tetap dipakai.

```powershell
docker --context kiri compose -f compose.yaml -f compose.gpu.yaml up -d
docker --context kiri compose exec clipy python -c "from clipy.transcribe import device; print(device())"
```

Hasil `cuda` berarti CTranslate2 mendeteksi GPU. Uji transkripsi lokal dengan video
pendek untuk memastikan model bisa berjalan. FFmpeg memakai NVENC jika lolos uji
encoding, dengan libx264 sebagai cadangan. Jika GPU WSL gagal diakses, jalankan
konfigurasi CPU dengan
`docker --context kiri compose up -d`.

### Akses dari HP lewat Tailscale

Sambungkan PC dan HP ke tailnet yang sama. Dari PowerShell Windows, pastikan
`http://127.0.0.1:4747/api/options` merespons sebelum mengaktifkan Tailscale Serve.
Aplikasi ini memberi akses ke data proyek dan pengaturan. Batasi akses tailnet
ke perangkat atau pengguna yang Anda percayai.

```powershell
tailscale serve status
tailscale serve --https=8443 4747
```

Buka URL HTTPS yang tercetak di browser HP. Untuk tes awal, biarkan PowerShell
terbuka. Setelah berhasil, tambahkan `--bg` jika ingin menutup PowerShell.
Gunakan port lain jika `8443` sudah dipakai.

## Prasyarat

Di Windows, klik dua kali **prepare.bat** di folder proyek. Pilih **1** untuk memeriksa prasyarat atau **2** untuk memasang dependensi aplikasi dan menyiapkan model setelah prasyarat lengkap.

Semua platform memerlukan Git, Node.js 24 LTS dengan npm, Python 3.12, Rust stable, serta FFmpeg dan FFprobe dengan libass dan libx264. Gunakan versi yang sudah terpasang jika memenuhi syarat.

| Sistem | Kebutuhan tambahan |
| --- | --- |
| Windows x64 | Microsoft C++ Build Tools dengan workload **Desktop development with C++** dan WebView2 Runtime. Untuk FFmpeg, gunakan **winget install --id Gyan.FFmpeg --exact**. |
| macOS 15 Apple Silicon dan Intel | Jalankan **xcode-select --install** untuk memasang Xcode Command Line Tools. Pasang Python dan FFmpeg melalui Homebrew dengan perintah di bawah. |
| Linux x64 (Ubuntu 24.04) | Gunakan sesi desktop dengan WebKitGTK 4.1. Pasang paket di bawah dan Node.js 24 melalui pengelola versi atau metode instalasi Node.js pilihan Anda. |

Detail toolchain tersedia di [panduan Tauri](https://v2.tauri.app/start/prerequisites/).

```sh
# macOS
brew install python@3.12 ffmpeg@7 portaudio
export PATH="$(brew --prefix ffmpeg@7)/bin:$PATH"
```

```sh
# Ubuntu 24.04
sudo apt update
sudo apt install git curl build-essential python3.12 python3.12-venv ffmpeg \
  libwebkit2gtk-4.1-dev libssl-dev libxdo-dev libayatana-appindicator3-dev \
  librsvg2-dev libgl1 libportaudio2 gstreamer1.0-libav gstreamer1.0-plugins-good xdg-utils
```

## Cara kerja

- Antarmuka Vite berjalan di dalam jendela Tauri. Peluncur menyalakan API FastAPI secara lokal dan menghentikannya saat jendela ditutup.
- Masukkan API key dari penyedia yang didukung melalui aplikasi. Transkripsi lokal pertama bisa mengunduh model Whisper sekitar 3 GB.
- Proyek, pengaturan, dan hasil lokal tersimpan di **server/data**.

## Memperbarui aplikasi

`npm run dev:desktop` memakai kode di folder lokal. Untuk mengambil versi terbaru, tutup aplikasi dan jalankan perintah berikut dari folder repo.

```sh
git pull --ff-only
npm run dev:desktop
```

Jika dependensi ikut berubah, jalankan `npm ci` dan `npm run setup` setelah `git pull`, lalu buka aplikasi. Jalankan ulang `npm run setup` untuk menambahkan model deteksi tawa pada instalasi lama. Jika memakai perintah instalasi satu baris di atas, jalankan ulang perintah tersebut untuk mengambil pembaruan dan menyiapkan dependensi.

[Panduan mode web, pengaturan, dan pemecahan masalah](docs/web.md)
