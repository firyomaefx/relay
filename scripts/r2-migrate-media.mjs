// Copy existing Relay local media into the public R2 bucket.
//
// Usage:
//   RELAY_R2_* ... node scripts/r2-migrate-media.mjs [--media-dir DIR] [--dry-run]
//
// Keys are `media/<basename>`, matching the existing /media URL layout. Files
// are not deleted locally; the console keeps them as a rollback copy.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { AwsClient } from "aws4fetch";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dirArg = args.find((arg) => arg.startsWith("--media-dir="));
const mediaDir = path.resolve(
  dirArg?.slice("--media-dir=".length) || process.env.RELAY_MEDIA_DIR || ".data/media",
);

const endpoint = process.env.RELAY_R2_ENDPOINT?.replace(/\/+$/, "");
const accessKeyId = process.env.RELAY_R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.RELAY_R2_SECRET_ACCESS_KEY;
const bucket = process.env.RELAY_R2_BUCKET || "relay-media";
const prefix = (process.env.RELAY_R2_MEDIA_PREFIX || "media/").replace(/^\/+/, "").replace(/\/*$/, "/");
if (!endpoint || !accessKeyId || !secretAccessKey) {
  console.error("RELAY_R2_ENDPOINT, RELAY_R2_ACCESS_KEY_ID and RELAY_R2_SECRET_ACCESS_KEY are required.");
  process.exit(2);
}

const contentTypes = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
]);

const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
const entries = readdirSync(mediaDir).filter((name) => {
  if (name.startsWith(".")) return false;
  return statSync(path.join(mediaDir, name)).isFile();
});

let uploaded = 0;
let skipped = 0;
for (const name of entries) {
  const filePath = path.join(mediaDir, name);
  const contentType = contentTypes.get(path.extname(name).toLowerCase());
  if (!contentType) {
    skipped += 1;
    console.log(`skip ${name}: unsupported extension`);
    continue;
  }
  const key = `${prefix}${name}`;
  const encodedKey = key
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = `${endpoint}/${encodeURIComponent(bucket)}/${encodedKey}`;
  if (dryRun) {
    console.log(`would upload ${name} -> ${key} (${statSync(filePath).size} bytes)`);
    continue;
  }
  const response = await client.fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: readFileSync(filePath),
  });
  if (!response.ok) {
    console.error(`FAILED ${name}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    process.exitCode = 1;
    continue;
  }
  uploaded += 1;
  console.log(`uploaded ${name} -> ${key}`);
}

console.log(
  `${dryRun ? "dry run: " : ""}${uploaded} uploaded, ${skipped} skipped, ${entries.length} local files in ${mediaDir}`,
);
