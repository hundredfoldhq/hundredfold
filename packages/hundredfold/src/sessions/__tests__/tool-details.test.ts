import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-tool-details-"));
process.env.HUNDREDFOLD_HOME = home;
const dbModule = await import("../../shared/db.js");

type Registry = typeof import("../registry.js");
type Store = typeof import("../tool-details.js");
let registry: Registry;
let store: Store;

function session(ref: string): string {
  return registry.createSession({ engine: "claude", source: "web", sourceRef: `web:${ref}`, prompt: "q" }).id;
}

beforeAll(async () => {
  dbModule.initDb();
  registry = await import("../registry.js");
  store = await import("../tool-details.js");
});

describe("the tool_details table", () => {
  it("is created on a database that has none, and creating it again changes nothing", () => {
    const db = dbModule.initDb();
    db.exec("DROP TABLE tool_details");
    dbModule.__closeDbForTest();
    const reopened = dbModule.initDb();
    const columns = (reopened.prepare("PRAGMA table_info(tool_details)").all() as Array<{ name: string; pk: number }>);
    expect(columns.map((c) => c.name)).toEqual(["session_id", "tool_id", "input", "input_chars", "output", "output_chars", "is_error", "created_at"]);
    expect(columns.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["session_id", "tool_id"]);
    reopened.prepare("INSERT INTO tool_details (session_id, tool_id, created_at) VALUES ('s', 't', 1)").run();
    dbModule.__closeDbForTest();
    const again = dbModule.initDb();
    expect(again.prepare("SELECT COUNT(*) AS n FROM tool_details").get()).toEqual({ n: 1 });
    again.prepare("DELETE FROM tool_details").run();
  });
});

describe("saving and reading a call's detail", () => {
  it("keeps the input at the start and adds the output at the end", () => {
    const id = session("save-1");
    store.saveToolDetail(id, "toolu_1", { input: { command: "seq 1 9" }, inputChars: 400_000 });
    expect(store.getToolDetail(id, "toolu_1")).toEqual({ input: { command: "seq 1 9" }, inputChars: 400_000 });
    store.saveToolDetail(id, "toolu_1", { output: "1\n2\n3", outputChars: 5_000_000, isError: true });
    expect(store.getToolDetail(id, "toolu_1")).toEqual({
      input: { command: "seq 1 9" },
      inputChars: 400_000,
      output: "1\n2\n3",
      outputChars: 5_000_000,
      isError: true,
    });
  });

  it("answers nothing for a call or a session it has nothing for", () => {
    const id = session("save-2");
    store.saveToolDetail(id, "toolu_a", { output: "x" });
    expect(store.getToolDetail(id, "toolu_b")).toBeUndefined();
    expect(store.getToolDetail(session("save-3"), "toolu_a")).toBeUndefined();
  });

  it("keeps one call's detail apart from another session's with the same call id", () => {
    const one = session("save-4");
    const two = session("save-5");
    store.saveToolDetail(one, "call_1", { output: "one" });
    store.saveToolDetail(two, "call_1", { output: "two" });
    expect(store.getToolDetail(one, "call_1")?.output).toBe("one");
    expect(store.getToolDetail(two, "call_1")?.output).toBe("two");
  });
});

describe("what goes with a session or a call row", () => {
  it("is deleted with its session, one or several", () => {
    const one = session("del-1");
    const two = session("del-2");
    const three = session("del-3");
    for (const id of [one, two, three]) store.saveToolDetail(id, "toolu_1", { output: "x" });
    registry.deleteSession(one);
    expect(store.getToolDetail(one, "toolu_1")).toBeUndefined();
    expect(registry.deleteSessions([two, three])).toBe(2);
    expect(store.getToolDetail(two, "toolu_1")).toBeUndefined();
    expect(store.getToolDetail(three, "toolu_1")).toBeUndefined();
  });

  it("is dropped when a turn settles without the call's row, and kept when it keeps it", () => {
    const id = session("settle-1");
    const kept = registry.insertPartialMessage(id, "assistant", "Using Bash", 0, "Bash", "toolu_kept");
    registry.insertPartialMessage(id, "assistant", "Using Bash", 1, "Bash", "toolu_gone");
    store.saveToolDetail(id, "toolu_kept", { output: "k" });
    store.saveToolDetail(id, "toolu_gone", { output: "g" });
    registry.settlePartialMessages(id, new Set([kept]));
    expect(store.getToolDetail(id, "toolu_kept")?.output).toBe("k");
    expect(store.getToolDetail(id, "toolu_gone")).toBeUndefined();
  });

  it("is dropped by the boot sweep of a stranded turn", () => {
    const id = session("sweep-1");
    registry.insertPartialMessage(id, "assistant", "Using Bash", 0, "Bash", "toolu_s");
    store.saveToolDetail(id, "toolu_s", { output: "s" });
    registry.clearAllPartialMessages();
    expect(store.getToolDetail(id, "toolu_s")).toBeUndefined();
  });
});
