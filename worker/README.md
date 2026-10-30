# HestiaFlow Worker

Layanan pekerja terpisah untuk mengambil tugas panen dari antrean web,
menjalankan mesin yang didukung, lalu menyetor hasil kembali ke web.

## Variabel lingkungan

- `HF_BASE_URL` — alamat publik web HestiaFlow, tanpa garis miring akhir.
- `WORKER_TOKEN` — token yang sama dengan variabel `WORKER_TOKEN` di layanan web.
- `WORKER_ID` — nama pekerja opsional.
- `POLL_MS` — jeda polling saat antrean kosong, default `10000`.
- `WORK_ROOT` — folder induk ruang kerja sekali pakai. Setiap tugas membuat
  subfolder sendiri dan subfolder itu dihapus setelah tugas selesai.

Versi pertama mendukung provider berkode Spesial. Satu pekerja memproses satu
tugas pada satu waktu agar tempo pendaftaran terkendali.
