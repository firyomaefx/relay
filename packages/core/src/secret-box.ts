import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RelayError } from "./errors.js";

export interface EncryptedBlob {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

/**
 * AES-256-GCM encryption for OAuth tokens and client secrets at rest.
 * The key lives in the data directory as `secret.key` and never leaves the machine.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static async open(dataDir: string): Promise<SecretBox> {
    await mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, "secret.key");
    let key: Buffer;
    try {
      key = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      key = randomBytes(32);
      await writeFile(file, key, { mode: 0o600 });
      try {
        await chmod(file, 0o600);
      } catch {
        // Windows may not support chmod; the file is still local-only.
      }
    }
    if (key.length !== 32) {
      throw new RelayError(`Invalid encryption key at ${file} (expected 32 bytes)`, "secret_key_invalid");
    }
    return new SecretBox(key);
  }

  encrypt(value: unknown): EncryptedBlob {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return {
      v: 1,
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }

  decrypt<T>(blob: EncryptedBlob): T {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(blob.iv, "base64"));
      decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as T;
    } catch {
      throw new RelayError("Unable to decrypt stored secrets (was the data directory moved?)", "secret_decrypt_failed");
    }
  }
}
