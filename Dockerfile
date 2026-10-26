FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Penyelamat database: rclone untuk foto database ke Google Drive.
# Lihat docker-entrypoint.sh — aktif hanya bila env DB_BACKUP_REMOTE terisi.
# ca-certificates WAJIB: tanpa bundel CA sistem, biner Go (rclone) gagal
# verifikasi TLS ke Google ("x509: certificate signed by unknown authority").
ADD https://downloads.rclone.org/v1.69.1/rclone-v1.69.1-linux-amd64.deb /tmp/rclone.deb
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && dpkg -i /tmp/rclone.deb && rm /tmp/rclone.deb && chmod +x /app/docker-entrypoint.sh
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
