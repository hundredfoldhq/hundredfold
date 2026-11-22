import { describe, expect, it } from "vitest";
import type http from "node:http";
import { rejectUnverifiedIdentifiedUpgradeCaller } from "../upgrade-guards.js";
import * as guards from "../upgrade-guards.js";
import { isSameOriginBrowserRequest } from "../api.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

class FakeUpgradeSocket {
  writes: string[] = [];
  destroyed = false;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function req(headers: http.IncomingHttpHeaders): http.IncomingMessage {
  const rawHeaders = Object.entries(headers).flatMap(([name, raw]) => {
    const values = Array.isArray(raw) ? raw : [raw];
    return values.flatMap((value) => value === undefined ? [] : [name, value]);
  });
  return {
    headers,
    rawHeaders,
    socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 7801 },
  } as http.IncomingMessage;
}

describe("WebSocket upgrade identity guard", () => {
  it("rejects tool-marked upgrades that do not carry a verified session capability", () => {
    const socket = new FakeUpgradeSocket();

    const rejected = rejectUnverifiedIdentifiedUpgradeCaller(
      req({ [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE }),
      socket,
      { sessionExists: (id) => id === "s-1" },
    );

    expect(rejected).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(socket.writes.join("")).toContain("403 Forbidden");
  });

  it("accepts operator/web upgrades that present no MCP identity headers", () => {
    const socket = new FakeUpgradeSocket();

    const rejected = rejectUnverifiedIdentifiedUpgradeCaller(req({}), socket, {
      sessionExists: (id) => id === "s-1",
    });

    expect(rejected).toBe(false);
    expect(socket.destroyed).toBe(false);
  });

  it("accepts capability-bound tool upgrades", () => {
    const socket = new FakeUpgradeSocket();
    const capability = ensureSessionCapability("s-1");

    const rejected = rejectUnverifiedIdentifiedUpgradeCaller(
      req({
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: "s-1",
        [CALLER_SESSION_CAPABILITY_HEADER]: capability,
      }),
      socket,
      { sessionExists: (id) => id === "s-1" },
    );

    expect(rejected).toBe(false);
    expect(socket.destroyed).toBe(false);
  });
});

describe("PTY WebSocket upgrade authority", () => {
  it("rejects capability-bound callers instead of letting them inject PTY stdin", () => {
    const socket = new FakeUpgradeSocket();
    const capability = ensureSessionCapability("s-1");
    const guard = (guards as any).rejectNonOperatorPtyUpgradeCaller;
    expect(typeof guard).toBe("function");

    const rejected = guard(
      req({
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: "s-1",
        [CALLER_SESSION_CAPABILITY_HEADER]: capability,
      }),
      socket,
      { sessionExists: (id: string) => id === "s-1" },
    );

    expect(rejected).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(socket.writes.join("")).toContain("403 Forbidden");
  });

  it("accepts a same-origin browser PTY upgrade via operator trust (CLI view fix)", () => {
    // A browser WebSocket sends an Origin but cannot send Authorization, so the
    // gateway grants operator identity via the same-origin fallback. Regression
    // guard for the empty-CLI-terminal bug (operator-only gate 403'd the view).
    const socket = new FakeUpgradeSocket();
    const guard = (guards as any).rejectNonOperatorPtyUpgradeCaller;
    const headers = {
      host: "127.0.0.1:7801",
      origin: "http://127.0.0.1:7801",
      upgrade: "websocket",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "websocket",
      "sec-fetch-site": "same-origin",
    };
    const request = req(headers);
    const sameOrigin = isSameOriginBrowserRequest(request, { gateway: { host: "127.0.0.1" } } as never);
    expect(sameOrigin).toBe(true);

    const rejected = guard(request, socket, { operatorAuthenticated: sameOrigin });
    expect(rejected).toBe(false);
    expect(socket.destroyed).toBe(false);
  });

  it("rejects a cross-origin browser PTY upgrade (no operator trust)", () => {
    const socket = new FakeUpgradeSocket();
    const guard = (guards as any).rejectNonOperatorPtyUpgradeCaller;
    const headers = {
      host: "127.0.0.1:7801",
      origin: "http://evil.example",
      upgrade: "websocket",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "websocket",
      "sec-fetch-site": "same-origin",
    };
    const request = req(headers);
    const sameOrigin = isSameOriginBrowserRequest(request, { gateway: { host: "127.0.0.1" } } as never);
    expect(sameOrigin).toBe(false);

    const rejected = guard(request, socket, { operatorAuthenticated: sameOrigin });
    expect(rejected).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(socket.writes.join("")).toContain("403 Forbidden");
  });
});

describe("no-auth same-origin trust on a WebSocket handshake without fetch metadata", () => {
  const config = { gateway: { host: "127.0.0.1" } } as never;
  // What Chromium sends on a same-origin WebSocket handshake: an Origin, no Sec-Fetch-*.
  const handshake = {
    host: "127.0.0.1:7801",
    origin: "http://127.0.0.1:7801",
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  };
  function handshakeReq(headers: http.IncomingHttpHeaders, method = "GET"): http.IncomingMessage {
    return Object.assign(req(headers), { method });
  }
  const trusted = (headers: http.IncomingHttpHeaders, method?: string) =>
    isSameOriginBrowserRequest(handshakeReq(headers, method), config, { upgradeHandshake: true });

  it("trusts a handshake whose Origin is exactly the listener's", () => {
    expect(trusted(handshake)).toBe(true);
    expect(trusted({ ...handshake, host: "localhost:7801", origin: "http://localhost:7801" })).toBe(true);

    const socket = new FakeUpgradeSocket();
    const request = handshakeReq(handshake);
    const rejected = (guards as any).rejectPtyUpgrade(request, socket, {
      operatorAuthenticated: isSameOriginBrowserRequest(request, config, { upgradeHandshake: true }),
    });
    expect(rejected).toBe(false);
    expect(socket.destroyed).toBe(false);
  });

  it("refuses a mismatched, missing, duplicated or opaque Origin", () => {
    expect(trusted({ ...handshake, origin: "http://evil.example" })).toBe(false);
    expect(trusted({ ...handshake, origin: "http://127.0.0.1:7802" })).toBe(false);
    expect(trusted({ ...handshake, origin: "https://127.0.0.1:7801" })).toBe(false);
    expect(trusted({ ...handshake, origin: "http://localhost:7801" })).toBe(false);
    expect(trusted({ ...handshake, origin: "null" })).toBe(false);
    expect(trusted({ ...handshake, origin: undefined })).toBe(false);
    expect(trusted({ ...handshake, origin: ["http://127.0.0.1:7801", "http://127.0.0.1:7801"] } as unknown as http.IncomingHttpHeaders)).toBe(false);

    const socket = new FakeUpgradeSocket();
    const request = handshakeReq({ ...handshake, origin: "http://evil.example" });
    const rejected = (guards as any).rejectPtyUpgrade(request, socket, {
      operatorAuthenticated: isSameOriginBrowserRequest(request, config, { upgradeHandshake: true }),
    });
    expect(rejected).toBe(true);
    expect(socket.writes.join("")).toContain("403 Forbidden");
  });

  it("refuses fetch metadata that is present but not same-origin, even partly", () => {
    expect(trusted({ ...handshake, "sec-fetch-site": "cross-site" })).toBe(false);
    expect(trusted({ ...handshake, "sec-fetch-site": "same-site" })).toBe(false);
    expect(trusted({ ...handshake, "sec-fetch-site": "none" })).toBe(false);
    expect(trusted({ ...handshake, "sec-fetch-site": "" })).toBe(false);
    expect(trusted({ ...handshake, "sec-fetch-site": "cross-site", "sec-fetch-mode": "websocket", "sec-fetch-dest": "empty" })).toBe(false);
    expect(trusted({ ...handshake, "sec-fetch-mode": "websocket" })).toBe(false);
    expect(trusted({ ...handshake, "sec-fetch-dest": "empty" })).toBe(false);
    expect(trusted({ ...handshake, "sec-fetch-site": "cross-site", "sec-fetch-mode": "websocket", "sec-fetch-dest": "websocket" })).toBe(false);
    expect(trusted({ ...handshake, "sec-fetch-site": "same-site", "sec-fetch-mode": "websocket", "sec-fetch-dest": "websocket" })).toBe(false);
    expect(trusted({ ...handshake, "sec-fetch-site": "same-origin", "sec-fetch-mode": "websocket", "sec-fetch-dest": "document" })).toBe(false);
    expect(trusted({ ...handshake, "sec-fetch-site": "same-origin", "sec-fetch-mode": "websocket", "sec-fetch-dest": "websocket", origin: "http://evil.example" })).toBe(false);
    // The complete same-origin set is still trusted, with either destination a browser sends.
    expect(trusted({ ...handshake, "sec-fetch-site": "same-origin", "sec-fetch-mode": "websocket", "sec-fetch-dest": "empty" })).toBe(true);
    expect(trusted({ ...handshake, "sec-fetch-site": "same-origin", "sec-fetch-mode": "websocket", "sec-fetch-dest": "websocket" })).toBe(true);
  });

  it("accepts a websocket destination only on a WebSocket handshake", () => {
    const fetchReq = (dest: string) => Object.assign(req({
      host: "127.0.0.1:7801",
      origin: "http://127.0.0.1:7801",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": dest,
    }), { method: "POST" });
    expect(isSameOriginBrowserRequest(fetchReq("empty"), config)).toBe(true);
    expect(isSameOriginBrowserRequest(fetchReq("websocket"), config)).toBe(false);
  });

  it("keeps requiring fetch metadata off the upgrade handshake", () => {
    // The HTTP API's trust check: not an upgrade handshake.
    expect(isSameOriginBrowserRequest(handshakeReq(handshake), config)).toBe(false);
    expect(trusted(handshake, "POST")).toBe(false);
    expect(trusted({ ...handshake, upgrade: "h2c" })).toBe(false);
    expect(trusted({ ...handshake, upgrade: undefined })).toBe(false);
  });

  it("keeps the loopback, proxy and auth gates", () => {
    expect(isSameOriginBrowserRequest(handshakeReq(handshake), { gateway: { host: "127.0.0.1", authRequired: true } } as never, { upgradeHandshake: true })).toBe(false);
    expect(trusted({ ...handshake, "x-forwarded-for": "203.0.113.9" })).toBe(false);
    expect(trusted({ ...handshake, host: "evil.example:7801", origin: "http://evil.example:7801" })).toBe(false);
    const remote = Object.assign(handshakeReq(handshake), {
      socket: { remoteAddress: "203.0.113.9", localAddress: "127.0.0.1", localPort: 7801 },
    });
    expect(isSameOriginBrowserRequest(remote, config, { upgradeHandshake: true })).toBe(false);
  });
});
