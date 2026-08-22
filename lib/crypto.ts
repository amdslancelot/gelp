import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// Encryption for the one secret this app stores on a user's behalf: their Drive
// refresh token.
//
// A refresh token is a long-lived credential — it mints access tokens to that
// user's picked Drive files for as long as it lives, with the user nowhere near
// the machine. That is exactly what makes the nightly sync possible and exactly
// why it must not sit in the database as plaintext: a database dump, a backup
// on object storage, or a stray `SELECT *` in a log would otherwise hand over
// live access, not just data.
//
// AES-256-GCM, because the token has to come back out (so this is encryption,
// not hashing) and GCM authenticates as well as encrypts — a ciphertext altered
// in the database fails to open rather than decrypting to garbage that the
// Drive call then sends to Google.
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the size GCM is specified for.

// Thrown when a stored ciphertext cannot be opened — wrong key, corrupted row,
// or a value encrypted under a key that has since been rotated away.
//
// It is a named class rather than a bare Error so the nightly sync can tell
// "this user's token is unreadable" (disable their sync, tell them to
// reconnect) apart from "Drive is down" (leave them enabled, try tomorrow).
export class DecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptError";
  }
}

// True when the environment carries a usable token-encryption key. Callers use
// this to refuse to *start* a Drive connect flow rather than to accept a token
// they would then be unable to store safely.
export function isTokenKeyConfigured(): boolean {
  try {
    tokenKey();
    return true;
  } catch {
    return false;
  }
}

// The key, decoded from `DRIVE_TOKEN_KEY` (base64, 32 bytes).
//
// Read per call rather than cached at module load so that a process started
// without the variable can still serve every other route — only the Drive paths
// fail, and they fail with this message instead of a boot crash.
function tokenKey(): Buffer {
  const encoded = process.env.DRIVE_TOKEN_KEY;
  if (!encoded) {
    throw new Error(
      "DRIVE_TOKEN_KEY is not set. Generate one with `openssl rand -base64 32`.",
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `DRIVE_TOKEN_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}.`,
    );
  }
  return key;
}

// Encrypt a secret for storage. The result is `iv:tag:ciphertext`, each part
// base64 — one self-describing column value, so nothing else has to be stored
// alongside it and a row can be moved between databases intact.
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, tokenKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((b) => b.toString("base64")).join(":");
}

// Open a value produced by `encryptSecret`. Every failure mode — a malformed
// value, a wrong key, a tampered ciphertext — surfaces as `DecryptError`, so a
// caller has one thing to catch.
export function decryptSecret(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 3) {
    throw new DecryptError("Stored secret is not in iv:tag:ciphertext form");
  }
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, "base64"));
  if (iv.length !== IV_BYTES) {
    throw new DecryptError("Stored secret has a malformed IV");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, tokenKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    // GCM's own failure is deliberately uninformative — "unable to authenticate
    // data" — and that is the right amount to say. Anything more would describe
    // the key to whoever is probing it.
    throw new DecryptError(
      err instanceof Error && err.message.includes("authenticate")
        ? "Stored secret failed authentication (wrong key or altered value)"
        : "Stored secret could not be decrypted",
    );
  }
}

// Constant-time comparison for the shared bearer secrets this app checks
// (the cron token, the Picker state nonce). A plain `===` on a secret leaks its
// length and its matching prefix through timing; this does not.
export function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
