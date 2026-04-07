const IV_LENGTH = 12; // 96-bit IV recommended for AES-GCM

function getSessionSecret(): string {
  const secret =
    (globalThis as unknown as Record<string, string | undefined>)[
      "SESSION_SECRET"
    ] ?? process.env["SESSION_SECRET"];
  if (
    !secret &&
    (process.env["NODE_ENV"] === "production" ||
      (globalThis as unknown as Record<string, string | undefined>)[
        "NODE_ENV"
      ] === "production")
  ) {
    throw new Error(
      "SESSION_SECRET environment variable must be set in production",
    );
  }
  return secret ?? "default-dev-secret-key";
}

async function getEncryptionKey(): Promise<CryptoKey> {
  const secret = getSessionSecret();
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  // Derive a 256-bit AES-GCM key using PBKDF2 with a fixed salt.
  // The salt is constant so the same secret always produces the same key.
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("route-atlas-salt"),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Convert a Uint8Array to a base64 string.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Convert a base64 string to a Uint8Array.
 */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function encrypt(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoder = new TextEncoder();

  // AES-GCM encrypt returns ciphertext with the auth tag appended
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );

  const cipherBytes = new Uint8Array(cipherBuffer);

  // The Web Crypto API appends a 16-byte (128-bit) auth tag to the ciphertext.
  // Split it into: encrypted data + auth tag for our storage format.
  const encrypted = cipherBytes.slice(0, cipherBytes.length - 16);
  const authTag = cipherBytes.slice(cipherBytes.length - 16);

  return [toBase64(iv), toBase64(authTag), toBase64(encrypted)].join(":");
}

export async function decrypt(ciphertext: string): Promise<string> {
  const key = await getEncryptionKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }
  const iv = fromBase64(parts[0]);
  const authTag = fromBase64(parts[1]);
  const encrypted = fromBase64(parts[2]);

  // Web Crypto API expects ciphertext + authTag concatenated
  const combined = new Uint8Array(encrypted.length + authTag.length);
  combined.set(encrypted);
  combined.set(authTag, encrypted.length);

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    combined,
  );

  return new TextDecoder().decode(decryptedBuffer);
}

/**
 * Generate a random hex string suitable for CSRF state tokens.
 */
export function generateRandomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
