// Foto konsisten database SQLite yang sedang dipakai aplikasi (aman di mode WAL).
// Dipakai docker-entrypoint.sh untuk cadangan berkala ke Google Drive via rclone.
// Pakai: node db-snapshot.mjs <db-sumber> <file-hasil>
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";

const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error("pakai: db-snapshot.mjs <sumber> <hasil>"); process.exit(2); }
rmSync(dst, { force: true });
const d = new DatabaseSync(src);
d.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
d.close();
console.log("snapshot OK:", dst);
