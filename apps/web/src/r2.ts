// Cloudflare R2 media storage for the Relay console.
//
// Relay keeps the local media file as a fallback, but uploads a copy to R2 so
// the public media URL no longer depends on the GCP VM. R2 uses the S3 API;
// aws4fetch keeps the signing dependency small.
import { AwsClient } from "aws4fetch";
import { RelayError } from "@relay/core";

export interface R2MediaConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
  prefix: string;
}

export function r2MediaConfig(env: NodeJS.ProcessEnv = process.env): R2MediaConfig | null {
  const endpoint = env.RELAY_R2_ENDPOINT?.trim();
  const accessKeyId = env.RELAY_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.RELAY_R2_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    accessKeyId,
    secretAccessKey,
    bucket: env.RELAY_R2_BUCKET?.trim() || "relay-media",
    publicBaseUrl: (env.RELAY_R2_PUBLIC_BASE_URL?.trim() || "https://media.duitpoket.fun").replace(/\/+$/, ""),
    prefix: (env.RELAY_R2_MEDIA_PREFIX?.trim() || "media/").replace(/^\/+/, "").replace(/\/*$/, "/"),
  };
}

function objectUrl(config: R2MediaConfig, key: string): string {
  const encodedKey = key
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodedKey}`;
}

export function r2PublicMediaUrl(config: R2MediaConfig, name: string): string {
  return `${config.publicBaseUrl}/${config.prefix}${encodeURIComponent(name)}`;
}

/** Upload one media object. Throws on a non-2xx response so the caller can fall back to local disk. */
export async function uploadR2Media(
  config: R2MediaConfig,
  name: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const response = await client.fetch(objectUrl(config, `${config.prefix}${name}`), {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Uint8Array(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new RelayError(
      `R2 media upload failed (${response.status}): ${text.slice(0, 200)}`,
      "r2_upload_failed",
      undefined,
      502,
    );
  }
  return r2PublicMediaUrl(config, name);
}
