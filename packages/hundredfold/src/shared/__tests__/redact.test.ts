import { describe, expect, it } from "vitest";
import { redactText, redactJson, redactLargeText } from "../redact.js";

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

describe("redactLargeText", () => {
  it("is redactText on a text that fits one chunk", () => {
    const text = "OPENAI_API_KEY=sk-proj-1234567890abcdef\nplain";
    expect(redactLargeText(text)).toBe(redactText(text));
  });

  it("redacts a secret at the start of a chunk after a long run of text", () => {
    const body = "word ".repeat(30_000);
    const out = redactLargeText(`${body}\nAuthorization: Bearer abcdef0123456789xyz\n${body}\nOPENAI_API_KEY=zzzz-value\n`);
    expect(out).not.toContain("abcdef0123456789xyz");
    expect(out).not.toContain("zzzz-value");
    expect(out).toContain("Authorization: Bearer [REDACTED]");
  });

  it("redacts a private key that spans chunks, and everything after one that never ends", () => {
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${"MIIEowIBAAKCAQEA\n".repeat(8_000)}-----END RSA PRIVATE KEY-----`;
    const out = redactLargeText(`head\n${key}\ntail`);
    expect(out).toBe("head\n[REDACTED PRIVATE KEY]\ntail");
    const cut = redactLargeText(`${"x\n".repeat(20_000)}-----BEGIN PRIVATE KEY-----\n${"MIIEowIBAAKCAQEA\n".repeat(8_000)}`);
    expect(cut.endsWith("[REDACTED PRIVATE KEY]")).toBe(true);
    expect(cut).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("keeps a text's length and order when nothing is secret", () => {
    const text = Array.from({ length: 60_000 }, (_, i) => `line ${i}`).join("\n");
    expect(redactLargeText(text)).toBe(text);
  });

  it("does not stall on a megabyte that backtracks badly", () => {
    const started = Date.now();
    for (const unit of ["A_TOKEN", "\n", "-", "a", "-----BEGIN PRIVATE KEY-----\n", "   auth"]) {
      redactLargeText(unit.repeat(Math.ceil(1_000_000 / unit.length)).slice(0, 1_000_000));
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("still redacts a long variable name, a key name and a `token:` line", () => {
    expect(redactText("MY_SERVICE_ACCESS_TOKEN_VALUE = hunter2")).toContain("[REDACTED]");
    expect(redactText("db.client-secret: hunter2")).toContain("[REDACTED]");
  });
});
