import { describe, expect, it } from "vitest";
import { redactText, redactJson } from "../redact.js";

describe("Hermes-style redaction", () => {
  it("redacts auth headers, env assignments, private keys, token prefixes, and userinfo URLs", () => {
    const authScheme = "Bear" + "er";
    const input = [
      `Authorization: ${authScheme} sk-live_1234567890abcdef`,
      "OPENAI_API_KEY=sk-proj-1234567890abcdef",
      "-----BEGIN PRIVATE KEY-----\nsecret-key-body\n-----END PRIVATE KEY-----",
      "postgres://alice:secretpass@db.example/app",
      "xox" + "b-1234567890-abcdefghijklmnop",
      "slack:\n  botToken: custom-secret-value\n  signingSecret: another-secret-value",
    ].join("\n");
    const out = redactText(input);
    expect(out).not.toContain("sk-live_1234567890abcdef");
    expect(out).not.toContain("sk-proj-1234567890abcdef");
    expect(out).not.toContain("secret-key-body");
    expect(out).not.toContain("secretpass");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("custom-secret-value");
    expect(out).not.toContain("another-secret-value");
    expect(out).toContain(`Authorization: ${authScheme} [REDACTED]`);
    expect(out).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(out).toContain("[REDACTED PRIVATE KEY]");
  });

  it("recursively redacts JSON secret fields while preserving harmless fields", () => {
    expect(redactJson({ token: "abc", nested: { password: "pw", model: "opus" } })).toEqual({
      token: "[REDACTED]",
      nested: { password: "[REDACTED]", model: "opus" },
    });
  });

  it("redacts bare key assignments, CLI password forms and key-shaped tokens", () => {
    const out = redactText([
      "ENCRYPTION_KEY=abcdef0123456789",
      "curl -H 'X-API-Key: key-value-1234' -u bob:pw-value-1 https://example.com",
      "mysql --password hunter2 --user root",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU",
      "aws AKIAABCDEFGHIJKLMNOP",
    ].join("\n"));
    for (const secret of ["abcdef0123456789", "key-value-1234", "pw-value-1", "hunter2", "eyJhbGciOiJIUzI1NiJ9", "AKIAABCDEFGHIJKLMNOP"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("--user root");
  });

  it("leaves ordinary flags alone", () => {
    const command = "mkdir -p /tmp/x && git push -u origin main && sort -u list.txt";
    expect(redactText(command)).toBe(command);
  });

  it("redacts a private key whose end was cut off", () => {
    const out = redactText("before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA");
    expect(out).toBe("before\n[REDACTED PRIVATE KEY]");
  });

  it("does not stall on a long run of blank lines", () => {
    const started = Date.now();
    redactText(`${"\n".repeat(100_000)}x`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
