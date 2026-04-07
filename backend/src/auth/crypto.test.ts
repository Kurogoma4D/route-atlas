import { describe, it, expect } from "vitest";
import { encrypt, decrypt, generateRandomHex } from "./crypto.js";

describe("Token encryption", () => {
  it("should encrypt and decrypt a token successfully", async () => {
    const token = "gho_abc123def456";
    const encrypted = await encrypt(token);
    expect(encrypted).not.toBe(token);
    expect(encrypted.split(":")).toHaveLength(3);

    const decrypted = await decrypt(encrypted);
    expect(decrypted).toBe(token);
  });

  it("should produce different ciphertexts for the same plaintext", async () => {
    const token = "gho_abc123def456";
    const encrypted1 = await encrypt(token);
    const encrypted2 = await encrypt(token);
    expect(encrypted1).not.toBe(encrypted2);
  });

  it("should throw on invalid ciphertext format", async () => {
    await expect(decrypt("invalid")).rejects.toThrow(
      "Invalid encrypted token format",
    );
  });

  it("should throw on tampered ciphertext", async () => {
    const token = "gho_test_token";
    const encrypted = await encrypt(token);
    const parts = encrypted.split(":");
    // Tamper with the encrypted data
    parts[2] = btoa("tampered");
    await expect(decrypt(parts.join(":"))).rejects.toThrow();
  });
});

describe("generateRandomHex", () => {
  it("should generate a hex string of the expected length", () => {
    const hex = generateRandomHex(16);
    expect(hex).toMatch(/^[0-9a-f]{32}$/);
  });

  it("should generate different values each time", () => {
    const hex1 = generateRandomHex(16);
    const hex2 = generateRandomHex(16);
    expect(hex1).not.toBe(hex2);
  });
});
