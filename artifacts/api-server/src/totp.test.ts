import { test } from "node:test";
import assert from "node:assert/strict";
import { base32Decode, base32Encode, hotp, verifyTotp } from "./totp";

test("RFC 6238 / 4226 vectors", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(hotp(secret, 0), "755224");
  assert.equal(hotp(secret, 9), "520489");
  // RFC 6238 SHA-1 at T=59 s → 94287082 (8 digits) → last 6: 287082
  assert.equal(verifyTotp(secret, "287082", 59_000), 1);
  assert.equal(verifyTotp(secret, "000000", 59_000), null);
  assert.deepEqual(base32Decode(secret), Buffer.from("12345678901234567890"));
});
