import {
  scryptSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "crypto";

const N = 1 << 15;
const KEY_LEN = 64;
const SALT_LEN = 16;
const MAXMEM = 64 * 1024 * 1024;

export function hashPassword(plain: string): string {
  if (!plain || plain.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(plain, salt, KEY_LEN, { N, maxmem: MAXMEM });
  return `scrypt$N=${N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  if (!plain || !stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const m = /^N=(\d+)$/.exec(parts[1]);
  if (!m) return false;
  const n = Number(m[1]);
  const salt = Buffer.from(parts[2], "base64");
  const expected = Buffer.from(parts[3], "base64");
  let actual: Buffer;
  try {
    actual = scryptSync(plain, salt, expected.length, { N: n, maxmem: MAXMEM });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function randomSessionId(): string {
  return randomBytes(32).toString("hex");
}

export function newId(): string {
  return randomUUID();
}

const TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomTempPassword(len = 12): string {
  const buf = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += TEMP_ALPHABET[buf[i] % TEMP_ALPHABET.length];
  }
  return out;
}
