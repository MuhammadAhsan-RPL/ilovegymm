# iLovegym

## Chat, Foto, dan Streak (100% Upstash Redis — Tanpa Setup Baru)

Fitur chat, pengiriman foto, dan streak chat berjalan **100% menggunakan database Upstash Redis yang sudah ada** tanpa perlu membuat Vercel Blob, token baru, atau database terpisah.

### 1. Pemisahan Key di Redis
Data latihan lama dan data chat dipisahkan lewat penamaan prefix key:
- **Data latihan & profil**: tetap memakai key seperti biasa (`d:<uid>`, `p:<uid>`, `social:*`).
- **Pesan chat**: `chat:<room_id>:messages` (menyimpan riwayat pesan teks, emoji, dan foto terkompres).
- **Streak chat**: `chat:<room_id>:streak` (menyimpan `count`, `day` WIB, dan `lastAt`).
- **Status kirim harian (WIB)**: `chat:<room_id>:day:<YYYY-MM-DD>` (mencatat siapa saja yang sudah chat hari ini).

### 2. Pengiriman Foto Tanpa Layanan Tambahan
- Foto yang dipilih di HP/laptop otomatis dikompres di browser ke ukuran sekitar **600px (JPEG kualitas ~55–60%, ~20–45 KB)** lalu diubah ke string Base64 (`data:image/jpeg;base64,...`).
- Disimpan langsung bersama pesan di Upstash Redis sehingga foto tampil instan di ruang chat tanpa setup storage tambahan.

### 3. Logika Streak Harian (WIB)
- Dihitung otomatis setiap kali pesan dikirim berdasarkan tanggal **WIB (`YYYY-MM-DD`)**.
- Ketika kedua teman yang saling mengikuti sama-sama mengirim minimal 1 pesan di hari WIB yang sama, streak bertambah **+1**.
- Setelah **3 hari berturut-turut**, ikon **🔥** menyala penuh.
- Jika jeda lewat dari **24 jam** tetapi belum **48 jam**, tampilan streak otomatis meredup (`is-grace`) di UI dan bisa langsung menyala kembali begitu kalian berdua saling chat lagi.
