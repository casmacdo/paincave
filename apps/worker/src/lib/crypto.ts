const ENC_PREFIX = "enc:v1:";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("Invalid hex encoding");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function deriveAesKey(masterSecret: string): Promise<CryptoKey> {
  if (!masterSecret || masterSecret.length < 16) {
    throw new Error("Master encryption secret must be at least 16 characters");
  }
  const keyMaterial = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`paincave-aes-gcm-v1:${masterSecret}`)
  );
  return crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(plaintext: string, masterSecret: string): Promise<string> {
  const key = await deriveAesKey(masterSecret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${ENC_PREFIX}${toHex(iv)}:${toHex(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(encoded: string, masterSecret: string): Promise<string> {
  if (!encoded.startsWith(ENC_PREFIX)) {
    throw new Error("Unsupported encrypted secret format");
  }
  const body = encoded.slice(ENC_PREFIX.length);
  const colon = body.indexOf(":");
  if (colon <= 0) {
    throw new Error("Malformed encrypted secret payload");
  }
  const iv = fromHex(body.slice(0, colon));
  const cipher = fromHex(body.slice(colon + 1));
  const key = await deriveAesKey(masterSecret);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    cipher
  );
  return new TextDecoder().decode(plainBuf);
}
