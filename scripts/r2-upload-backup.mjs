// Upload the newest Relay backup archive to the R2 bucket.
// Run after /usr/local/sbin/relay-backup.sh has created the local archive.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AwsClient } from "aws4fetch";

const backupDir = process.env.RELAY_BACKUP_DIR || "/var/backups/relay";
const files = readdirSync(backupDir)
  .filter((name) => name.endsWith(".tgz"))
  .map((name) => ({ name, path: path.join(backupDir, name), mtime: statSync(path.join(backupDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (files.length === 0) {
  console.error(`No .tgz backups in ${backupDir}`);
  process.exit(1);
}

const endpoint = process.env.RELAY_R2_ENDPOINT?.replace(/\/+$/, "");
const accessKeyId = process.env.RELAY_R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.RELAY_R2_SECRET_ACCESS_KEY;
const bucket = process.env.RELAY_R2_BUCKET || "relay-media";
if (!endpoint || !accessKeyId || !secretAccessKey) {
  console.error("R2 credentials are not configured.");
  process.exit(2);
}

const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
const latest = files[0];
const key = `backups/${latest.name}`;
const encodedKey = key.split("/").map((part) => encodeURIComponent(part)).join("/");
const url = `${endpoint}/${encodeURIComponent(bucket)}/${encodedKey}`;
const response = await client.fetch(url, {
  method: "PUT",
  headers: { "Content-Type": "application/gzip" },
  body: readFileSync(latest.path),
});
if (!response.ok) {
  console.error(`Upload failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  process.exit(1);
}
console.log(`uploaded ${latest.name} -> ${key}`);
