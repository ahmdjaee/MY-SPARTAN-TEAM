# AI Team — daftar tugas yang dikerjakan bot QA / Engineer / DevOps

Aplikasi pribadi untuk menugaskan pekerjaan nyata ke tiga rekan kerja AI senior. Anda menulis tugas, memilih bot, dan tugas itu langsung dikerjakan di mesin ini. Anda membaca hasilnya per tugas, me-review, atau mengopernya ke bot lain.

| Bot | Yang dia kerjakan | Hasil yang Anda baca |
|---|---|---|
| **QA Engineer** | Menguji lewat Chromium (buka, klik, isi form, unggah berkas, baca console) | tab **Live** untuk menonton langsung · `report.md` + screenshot bukti di tab **Laporan** |
| **Software Engineer** | Mengubah kode di `WORKSPACE_DIR`, menjalankan test | Transcript + tab **Perubahan** (git status & diff) |
| **DevOps Engineer** | Inspeksi server, rencana + rollback, eksekusi setelah Anda setujui | Transcript + kartu persetujuan per perintah |

Semua bot memakai **sesi login Claude Code yang sudah ada di mesin ini** (`~/.claude/.credentials.json`) lewat
`@anthropic-ai/claude-agent-sdk` — tanpa `ANTHROPIC_API_KEY`. Buktinya ada di sidebar: email dan tipe langganan Anda.

## Jalankan

```bash
npm install
cp .env.example .env     # sesuaikan WORKSPACE_DIR dan TARGET_URL
npm run check:auth       # bukti sesi login terpakai (apiKeySource: none)
npm run check:browser    # bukti Playwright + Chromium siap
npm run check:mcp        # bukti tool browser & tim terdaftar
npm run build && npm start   # http://127.0.0.1:4320
```

Pengembangan UI (hot reload di 4321, API tetap 4320): `npm run dev`.
Pindahkan laporan dari versi lama (kalau ada `data/reports/`): `npm run migrate:v1`.

### Alias domain lokal (`http://ai-team.local`)

Supaya tidak mengetik `127.0.0.1:4320`: nginx yang sudah ada di port 80 meneruskan nama `ai-team.local`
ke server aplikasi. Berkas vhost-nya ada di `deploy/nginx/ai-team.local.conf` (buffering dimatikan supaya
SSE dan Live MJPEG tidak tertahan). Pasang sekali:

```bash
echo "127.0.0.1 ai-team.local" | sudo tee -a /etc/hosts
sudo cp deploy/nginx/ai-team.local.conf /etc/nginx/sites-available/ai-team.local
sudo ln -s /etc/nginx/sites-available/ai-team.local /etc/nginx/sites-enabled/ai-team.local
sudo nginx -t && sudo systemctl reload nginx
```

`127.0.0.1:4320` tetap bisa dipakai; `ai-team.service` tidak perlu di-restart. Alias ini hanya untuk
build produksi — UI dev `npm run dev` tetap di port Vite 4321. `/etc/hosts` dibaca lebih dulu daripada
mDNS (`nsswitch: files mdns4_minimal`), jadi akhiran `.local` aman walau Avahi aktif.

### Auto-start (systemd user service)

Supaya server hidup sendiri setelah login — tanpa `nohup npx tsx server/main.ts` lagi:

```bash
kill $(ss -ltnp | sed -nE 's/.*127\.0\.0\.1:4320.*pid=([0-9]+).*/\1/p')   # matikan instance manual
mkdir -p ~/.config/systemd/user
cp deploy/ai-team.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ai-team.service
```

Unit-nya ada di `deploy/ai-team.service`. Dua barisnya tidak boleh diubah sembarangan:
`WorkingDirectory` (karena `.env` dibaca dari cwd dan `DATA_DIR=./data`) dan `Environment=PATH`
(karena Agent SDK memanggil `claude` dari PATH — tanpa `~/.local/bin` server tampak sehat tapi
semua tugas gagal start; `GET /api/health/auth` adalah cara tercepat memeriksanya).

Operasi harian:

```bash
systemctl --user restart ai-team               # setelah ubah kode server
npm run build && systemctl --user restart ai-team   # setelah ubah UI (web/)
journalctl --user -u ai-team -f                # log (data/server.log hanya untuk run manual)
systemctl --user status ai-team                # status + PID
```

Service ini mulai saat Anda login dan berhenti saat logout; tugas yang tertunda dilanjutkan
otomatis saat start berikutnya. Kalau ingin hidup sejak boot tanpa login: `loginctl enable-linger jae`
— unit-nya tidak perlu diubah. Node datang dari nvm, jadi setelah upgrade node sesuaikan versi di
`Environment=PATH`, lalu `systemctl --user daemon-reload && systemctl --user restart ai-team`.

## Cara kerja

1. **+ Tugas** → project, judul, instruksi, bot, dan (untuk QA) URL yang diuji. Tugas langsung masuk antrean.
2. Maksimal `MAX_CONCURRENT_AGENTS` tugas berjalan bersamaan (default 2). Tugas **Engineer/DevOps** saling menunggu hanya kalau **workspace-nya sama** — dua project dengan folder berbeda boleh menulis bersamaan; tugas QA selalu boleh paralel.
3. Saat bot minta izin menjalankan sesuatu, muncul **kartu persetujuan**: *Izinkan*, *Izinkan & ingat*, atau *Tolak* dengan alasan. Agen berhenti sampai Anda memutuskan, dan alasan penolakan dibacanya.
4. Setelah selesai, status jadi **perlu dibaca**. Buka tab **Laporan** (QA) atau **Perubahan** (kode), lalu **Review**: *Setuju* menutup tugas; *Perlu perbaikan* mengirim komentar Anda ke bot yang sama dan tugas kembali dikerjakan.
   - Tab **Laporan** berisi `report.md` plus galeri bukti screenshot. Berkas teks lain yang ditulis agen ke folder tugas — laporan tambahan `.md`, bukti data `.tsv`/`.txt`, patch, skrip uji, berkas uji unggahan di `uploads/` — tampil di tab **Lampiran**: daftar berkas di kiri, isinya dirender di kanan (`.md` sebagai markdown, sisanya apa adanya), dengan tombol **Unduh** per berkas. Tidak perlu lagi membuka `data/tasks/` dari terminal.
5. Tab **Kerja** hanya ikut turun kalau Anda memang sedang berada di dasar. Begitu Anda scroll ke atas untuk membaca chat lama, tampilan diam walau agen terus menulis; yang muncul cuma tombol **Pesan baru ↓** (berubah kuning jadi **Menunggu keputusan Anda ↓** kalau ada kartu persetujuan). Kembali ke dasar — lewat tombol itu atau scroll sendiri — membuatnya mengikuti lagi.
6. **Oper ke…** memindahkan tugas ke bot lain. Bot baru menerima instruksi asli, **ringkasan serah terima** bot sebelumnya, catatan operan Anda, dan daftar bukti yang sudah ada. Riwayatnya tampil sebagai `QA → Engineer → QA`.
7. Bot bisa **mengusulkan** operan sendiri (`suggest_handoff`); usulan muncul sebagai tombol satu-klik, tidak pernah jalan tanpa Anda.

Contoh tugas:

```
QA        Uji alur login staging. Sertakan screenshot tiap langkah dan periksa error console.
Engineer  Perbaiki bypass password kosong yang ditemukan QA, tambahkan test, jalankan npm test.
DevOps    Periksa kenapa container api restart terus. Jangan ubah apa pun sebelum saya setujui rencananya.
```

## Alamat (routing)

Posisi Anda tersimpan di alamat, jadi refresh — termasuk setelah `systemctl --user restart ai-team` — mengembalikan Anda ke tempat yang sama, dan tombol Back/Forward browser bekerja seperti biasa.

```
/                                 daftar; langsung membuka tugas teratas
/tasks/T-015                      tab bawaan (Kerja), atau Live kalau browser QA sedang hidup
/tasks/T-015/report               tab: work · live · report · docs · notes · diff
/tasks/T-015/docs?doc=audit.md    lampiran yang sedang dibaca
/tasks/T-015/notes?view=preview   catatan pribadi Anda untuk tugas itu
/projects/ews-local               halaman project; ?tab=context|memory|tasks|settings
/memory, /settings                memori global & pengaturan
?project=ews-local&role=qa        filter daftar; ikut terbawa saat pindah tugas
```

Satu tugas atau satu lampiran bisa di-bookmark. Alamat tugas yang sudah tidak ada memberi kartu "tidak ditemukan", bukan memuat selamanya. Ganti filter dan ganti berkas lampiran memakai `replace`, jadi riwayat browser tidak penuh oleh keduanya.

## Sidebar

Tombol **«** di sebelah judul — atau **Ctrl+B** (Cmd+B di Mac) dari mana saja — melipat sidebar jadi rel sempit; isi tugas memakai ruang yang kosong itu. Di rel masih tersedia **»** untuk membuka lagi, tombol **+** untuk tugas baru, dan pengganti tema. Pilihannya tersimpan di browser Anda, jadi bertahan setelah muat ulang.

## Tema

Tampilannya memakai palet bergaya Notion: abu hangat, teks `#37352f`, aksen biru `#2383e2` — tanpa ungu. Tersedia **terang**, **gelap** (`#191919`), dan **ikut sistem**; tombolnya ada di pojok kiri bawah sidebar dan pilihannya tersimpan di browser Anda.

Semua warna komponen memakai token semantik (`bg-page`, `bg-panel`, `text-ink`, `text-muted`, `border-line`, `bg-accent`, `bg-tag-*`) yang didefinisikan sekali di `web/styles.css`. Untuk mengubah palet, sunting variabel di `:root` dan `[data-theme="dark"]` — tidak perlu menyentuh satu pun komponen.

## Menonton QA bekerja (Live)

Tab **Live** di panel tugas menampilkan isi browser QA saat itu juga — halaman yang sedang dibuka, form yang sedang diisi, pesan error yang muncul. Di bawahnya tertulis aksi browser terakhir, dan di daftar tugas ada titik merah `● live` untuk tugas yang browsernya sedang hidup.

- Panel menyala sendiri begitu QA membuka halaman; tugas yang live-nya aktif langsung membuka tab Live saat dipilih.
- **Menonton saja** — klik Anda tidak diteruskan ke halaman. Untuk mengarahkan QA, kirim pesan di tab Kerja atau tekan Stop.
- Tombol **Buka di tab baru** menampilkan aliran gambarnya penuh satu layar (`/api/tasks/<id>/live`, MJPEG biasa).
- Setelah sesi browser berakhir, frame terakhir dibiarkan membeku di panel; bukti permanennya tetap screenshot di tab Laporan.

Secara teknis: CDP `Page.startScreencast` → JPEG (maks ±10 fps, lebar 1280) → MJPEG lewat `multipart/x-mixed-replace`. Kalau screencast gagal, fitur ini mati diam-diam dan pengujian tetap berjalan.

## Mode otonomi

Tiap tugas berjalan dalam salah satu dari tiga mode. Bawaannya diatur per bot di halaman **Pengaturan** (bukan `.env`, tanpa restart), dan tiap tugas bisa diubah sendiri lewat pemilih **Mode** di header tugas — termasuk saat tugas sedang berjalan.

| Mode | Artinya |
|---|---|
| **Auto** | Agen menjalankan perintahnya sendiri. Classifier Claude Code menilai tiap perintah; pagar keras di bawah tetap berlaku. |
| **Minta approval** | Perilaku bawaan: perintah di luar daftar aman memunculkan kartu persetujuan. |
| **Hanya baca** | Agen hanya boleh menyelidiki dan menyusun rencana; perubahan apa pun tertahan. |

**Pagar keras berlaku di semua mode**, lewat `PreToolUse` hook yang membaca string perintah secara utuh — termasuk isi `ssh host '…'`, yang tidak bisa dijangkau aturan allow/deny biasa:

- **Ditolak, tanpa bisa disetujui:** `rm -rf` pada direktori sistem, `mkfs`, `dd of=/dev/…`, `shutdown`/`reboot`, fork bomb, `DROP DATABASE`.
- **Selalu minta persetujuan, walau mode Auto:** service & container (`systemctl restart`, `docker compose down`, `pm2 restart`) · data & database (`TRUNCATE`, migrasi, `pg_restore`, `docker volume rm`) · kredensial, firewall & akses (`ufw`, `iptables`, `ssh-keygen`, tulis `.env`) · hapus berkas & instalasi paket (`rm` di luar area kerja, `apt install`) · perintah yang isinya tidak bisa dinilai (`sudo` di dalam `ssh`, `curl … | sh`).

Polanya ada di `server/policy.ts` sebagai tabel data, dan `npm run check:policy` menguji 37 kasus tanpa biaya model. Alasan penolakan atau permintaan izin ditulis di kartu, mis. *"Perlu persetujuan owner · hapus berkas & paket: mengubah paket sistem."*

## Notifikasi browser

Agen yang berhenti menunggu keputusan tidak lagi terlewat. Di **Pengaturan** Anda menyalakan izin notifikasi dan memilih pemicunya: kartu persetujuan, agen bertanya, tugas selesai & perlu dibaca, dan tugas gagal. Bawaannya notifikasi hanya muncul saat tab AI Team **tidak aktif** — saat tabnya terbuka, kartunya sudah terlihat sendiri.

Jumlah tugas yang menunggu keputusan selalu tampil di judul tab, mis. `(2) AI Team`. Notifikasi berlaku lintas tugas (satu aliran `GET /api/events`), jadi tetap muncul walau Anda sedang membuka tugas lain atau halaman Pengaturan.

## Tanya (chat incognito)

Tombol **Tanya** di header tugas — atau **Ctrl+K** — membuka panel di sisi kanan: sesi Claude terpisah yang tahu seluk-beluk tugas itu dan bisa Anda tanyai tanpa mengotori percakapan utama.

Yang ia **tidak** lakukan: tidak menulis satu baris pun ke `thread.jsonl`, tidak dibaca bot yang mengerjakan tugas, tidak menulis sesi ke `~/.claude` (`persistSession: false`), tidak pernah memunculkan kartu persetujuan, dan tidak bisa mengubah apa pun — hanya `Read`/`Grep`/`Glob`, tanpa Bash/Edit/Write, dengan `notes.md` dan kredensial tetap ditolak.

Yang ia **lihat**: instruksi tugas, status, ringkasan serah terima, 40 kejadian terakhir percakapan, konteks & memori project, plus path transcript penuh/laporan/lampiran/workspace supaya bisa membuka sendiri kalau perlu.

- Panel tetap terbuka saat Anda berpindah tab (Kerja → Laporan → Lampiran), ditutup dengan **Esc**, tombol **✕**, atau Ctrl+K lagi.
- Pemilih model per pertanyaan: *Cepat & murah* (`MODEL_QA`) atau *Analisis berat* (`MODEL_ENGINEER`).
- Percakapannya hidup **di memori server**: bertahan saat refresh halaman, hilang saat `systemctl --user restart ai-team` atau saat Anda menekan **Hapus percakapan**.
- Biayanya dicatat terpisah (`askCostUsd` di `task.json`) dan tampil di kaki panel, jadi angka biaya di daftar tugas tetap berarti "biaya bot".

## Catatan per tugas

Tab **Catatan** di tiap tugas berisi satu berkas Markdown (`data/tasks/<id>/notes.md`) yang **hanya milik Anda**: kesimpulan sementara, daftar yang perlu dicek ulang, dugaan penyebab, pertanyaan yang belum terjawab.

- **Tidak pernah dikirim ke bot.** Isinya tidak ikut ke konteks agen, dan karena folder tugas memang boleh dibaca agen, ada deny eksplisit `Read(//<DATA_DIR>/tasks/**/notes.md)` untuk ketiga role.
- Punya tab **Tulis** dan **Pratinjau** seperti konteks project, dan alamat sendiri (`/tasks/T-015/notes`).
- **Tersimpan sendiri** saat Anda berpindah tab atau menutup halaman, jadi catatan setengah jadi tidak hilang; tombol **Simpan** tetap ada.
- Tidak ikut tampil di tab Lampiran, dan titik kecil di tab menandakan tugas itu sudah punya catatan.

## Project (induk tugas)

Setiap tugas berada di dalam sebuah **project**, dan project itulah yang memegang konteks bersama. Pemilihnya ada di atas daftar tugas (bisa dicari; pilihannya tersimpan di alamat sebagai `?project=…`), dan ikon ⚙ di sebelahnya membuka halaman project.

Satu project menyimpan empat hal:

| Isi | Siapa yang menulis | Dipakai untuk |
|---|---|---|
| **Konteks project** (`context.md`) | Anda, di tab **Konteks** | ditempel ke konteks setiap bot di project itu, sebelum instruksi tugas |
| **Memori project** (`memory.md`) | bot, lewat tool `remember` | fakta lintas tugas: akun uji, prosedur, cacat yang belum diperbaiki |
| **URL target bawaan** | Anda, di tab **Setelan** | mengisi sendiri kolom target saat membuat tugas QA |
| **Folder workspace** | Anda, di tab **Setelan** | folder yang dipegang Engineer & DevOps di project itu |

Yang membuat tugas tidak lagi bekerja sendirian: setiap bot juga menerima **daftar tugas sebelah** di project yang sama (id, bot, status, judul, ringkasan serah terima satu baris). Kalau butuh lengkapnya, ia memanggil `project_task("T-015")` — instruksi asli, semua ringkasan, path laporan, dan daftar lampiran tugas itu. Tugas di project lain ditolak, jadi project sekaligus menjadi batas konteks: bot yang menguji EWS tidak lagi menerima kredensial staging RDMS.

Memindahkan tugas antar project: halaman Project → tab **Tugas** → pemilih "pindah ke…". Project yang masih punya tugas tidak bisa dihapus (boleh diarsipkan).

**Folder workspace per project** diperiksa sebelum disimpan: harus folder yang ada, bukan folder sistem (`/etc`, `/usr`, `/var/lib`, …), bukan folder `data/` aplikasi ini, dan bukan folder yang memuat sesi login Claude (`~/.claude`). Aturan deny QA (`Edit(//<workspace>/**)`) dan pagar perintah shell ikut memakai workspace project tugas itu, bukan satu folder global.

## Memori global

`data/memory.md` dibaca **setiap** tugas di **semua** project — isinya hal yang benar-benar berlaku di mana saja (mis. "jangan mengubah berkas di luar workspace"). Panel **Memori global** di sidebar menyuntingnya.

Hal yang hanya berlaku di satu proyek masuk ke konteks/memori project, bukan ke sini. Karena konteks itu, tugas QA cukup ditulis "uji alur login" — akun uji dan URL-nya diambil sendiri oleh bot.

## Konteks & sesi

Tiap **penugasan** punya sesi Claude sendiri (`task.json` → `assignments[].sessionId`), jadi konteks antar tugas tidak tercampur dan dua tugas QA bisa jalan bersamaan. Sesi disimpan, sehingga:

- tugas yang menganggur lebih dari `IDLE_SHUTDOWN_MS` (default 10 menit) menutup subprocess-nya, dan pesan berikutnya melanjutkan sesi yang sama;
- tugas yang sedang berjalan saat server mati akan **dilanjutkan otomatis** setelah server hidup lagi.

## Model izin (penting)

Urutan evaluasi Claude Code: **hooks → deny → ask → permission mode → allow → kartu persetujuan**.

- `deny` menang atas segalanya. Pola destruktif (`sudo`, `mkfs`, `dd`, `shutdown`, edit `/etc`, baca kredensial Claude) ditolak untuk semua bot tanpa prompt.
- `allow` berisi perintah yang boleh jalan sendiri: `npm test`, `git status/diff`, `df`, `docker ps`, dan sejenisnya.
- **`ask` sengaja dikosongkan.** `ask` dievaluasi *sebelum* `allow`, jadi menaruh `"Bash"` di sana membuat seluruh allow-list tidak berguna. Perintah di luar allow-list tetap sampai ke kartu persetujuan lewat `canUseTool`.
- QA tidak boleh mengubah kode: ada deny `Edit(//<WORKSPACE_DIR>/**)`. Ia hanya menulis di folder tugasnya.
- Engineer tidak boleh `git commit`/`git push` — perubahan ditinggal di working tree supaya Anda yang memutuskan.

Aturan per bot ada di `server/roles.ts`, persona di `server/prompts/*.md`. Keduanya memang dibuat untuk Anda sunting.

## Konfigurasi (`.env`)

| Variabel | Arti |
|---|---|
| `WORKSPACE_DIR` | Folder kerja **bawaan** Engineer & DevOps, dipakai project yang tidak punya folder sendiri. |
| `TARGET_URL` | URL target **bawaan**, dipakai project yang tidak punya URL sendiri. |
| `MODEL_QA` / `MODEL_ENGINEER` / `MODEL_DEVOPS` | Model per bot. |
| `EFFORT_*` | `low` … `max`. Makin tinggi makin teliti, makin lambat, makin boros kuota. |
| `MAX_CONCURRENT_AGENTS` | Berapa tugas boleh jalan bersamaan (default 2). |
| `IDLE_SHUTDOWN_MS` | Kapan subprocess tugas yang menganggur ditutup (default 10 menit). |
| `INCLUDE_USER_SETTINGS` | `1` untuk ikut memuat skill/plugin global dari `~/.claude`. |

## Data

```
data/tasks/T-012/task.json     judul, bot, status, riwayat penugasan, biaya, review
data/tasks/T-012/thread.jsonl  transcript yang ditampilkan di UI
data/tasks/T-012/assets/*.png  bukti screenshot
data/tasks/T-012/report.md     laporan tugas, ditulis bot yang mengerjakannya (tab Laporan)
data/tasks/T-012/notes.md      catatan pribadi Anda (tab Catatan; tidak dibaca bot)
                               (panel Tanya tidak menulis berkas apa pun — hidup di memori)
data/tasks/T-012/*.md, bukti/*  berkas lain yang ditulis agen (tab Lampiran)
data/memory.md                 memori global (lintas project)
data/projects/<id>/project.json  nama, URL target, folder workspace
data/projects/<id>/context.md    konteks project yang Anda tulis
data/projects/<id>/memory.md     memori project (ditulis bot lewat `remember`)
```

Hapus `data/` untuk mulai dari nol (sesi Claude Code-nya sendiri ada di `~/.claude/projects/`).

## Batasan yang perlu Anda tahu

- **Aplikasi ini menjalankan perintah sebagai user Anda.** Server hanya bind ke `127.0.0.1` dan tanpa autentikasi. Jangan diekspos ke jaringan.
- **Kuota langganan dibagi** dengan Claude Code harian Anda. Satu tugas QA penuh ±$0,25–0,6; satu tugas Engineer dengan test ±$0,7–1,0 setara pemakaian. Biaya per tugas tampil di daftar.
- **Satu workspace per project dipakai bersama** oleh tugas di project itu: tugas kode di project yang sama dijalankan bergantian (kunci per folder workspace), belum ada checkout terpisah per tugas.
- `settingSources: ["project"]` berarti `CLAUDE.md` dan `.claude/` milik workspace ikut termuat; aturan `permissions.allow` milik repo itu ikut berlaku (deny milik aplikasi ini tetap menang).
- Belum ada: sandbox container, jadwal otomatis, dependensi antar tugas, beberapa bot paralel di dalam **satu** tugas, dan bot yang membuat tugas sendiri tanpa persetujuan.

## Halaman demo

`http://127.0.0.1:4320/demo` disajikan dari `demo/index.html` **di dalam workspace**, supaya alur lengkap bisa dicoba: QA menemukan bug → oper ke Engineer → Engineer memperbaiki di workspace → oper balik ke QA untuk uji ulang.
