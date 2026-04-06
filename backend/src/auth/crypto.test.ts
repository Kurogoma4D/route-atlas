import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "./crypto.js";

describe("Token encryption", () => {
  it("should encrypt and decrypt a token successfully", () => {
    const token = "gho_abc123def456";
    const encrypted = encrypt(token);
    expect(encrypted).not.toBe(token);
    expect(encrypted.split(":")).toHaveLength(3);

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(token);
  });

  it("should produce different ciphertexts for the same plaintext", () => {
    const token = "gho_abc123def456";
    const encrypted1 = encrypt(token);
    const encrypted2 = encrypt(token);
    expect(encrypted1).not.toBe(encrypted2);
  });

  it("should throw on invalid ciphertext format", () => {
    expect(() => decrypt("invalid")).toThrow("Invalid encrypted token format");
  });

  it("should throw on tampered ciphertext", () => {
    const token = "gho_test_token";
    const encrypted = encrypt(token);
    const parts = encrypted.split(":");
    // Tamper with the encrypted data
    parts[2] = Buffer.from("tampered").toString("base64");
    expect(() => decrypt(parts.join(":"))).toThrow();
  });
});
