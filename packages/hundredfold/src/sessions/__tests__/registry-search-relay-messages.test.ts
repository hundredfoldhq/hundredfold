import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Own file: the last test disables FTS for the process, which would silence every search after it.
// Point the DB at a throwaway dir BEFORE importing the registry.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-fts-relay-"));
process.env.HUNDREDFOLD_HOME = tmp;
const migrateModule = await import("../migrate.js");
const dbModule = await import("../../shared/db.js");

type Reg = typeof import("../registry.js");
let reg: Reg;

function mkSession(reg: Reg, id: string): void {
  void reg;
  dbModule
    .initDb()
    .prepare("INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES (?, 'claude', 'web', ?, 'idle', 't', 't')")
    .run(id, `web:${id}`);
}
function mkMessage(reg: Reg, sessionId: string, role: string, content: string, ts: number): void {
  void reg;
  dbModule
    .initDb()
    .prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)")
    .run(`m-${role}-${ts}`, sessionId, role, content, ts);
}

beforeAll(async () => {
  reg = await import("../registry.js");
  dbModule.initDb();
});

describe("searchMessages — relayed messages and child replies", () => {
  const BANNER_CUT = 200;
  // A body whose unique word sits far past the banner cut the web UI stores as `content`.
  const longBody = (word: string): string => `${"filler ".repeat(300)}and finally ${word} ends it.`;
  const banner = (body: string): string => `📨 From worker: ${body.slice(0, BANNER_CUT)}…`;

  function mkNotification(sessionId: string, id: string, content: string, meta: unknown, ts: number): void {
    dbModule
      .initDb()
      .prepare("INSERT INTO messages (id, session_id, role, content, timestamp, meta) VALUES (?, ?, 'notification', ?, ?, ?)")
      .run(id, sessionId, content, ts, typeof meta === "string" ? meta : JSON.stringify(meta));
  }

  it("finds a word past the banner cut of a relayed message, and reads it back whole", () => {
    mkSession(reg, "s-relay");
    const body = longBody("zyzzyva");
    mkNotification("s-relay", "relay-1", banner(body), { kind: "agent-relay", fromLabel: "worker", hops: 1, maxHops: 3, fullMessage: body }, 7000);
    expect(banner(body)).not.toContain("zyzzyva");

    const hits = reg.searchMessages("zyzzyva", 10, { sessionId: "s-relay" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ messageId: "relay-1", sessionId: "s-relay", role: "notification", timestamp: 7000 });
    expect(hits[0].snippet).toContain("«zyzzyva»");

    const context = reg.getMessageContext("s-relay", hits[0].messageId, 1);
    const anchor = context?.messages.find((m) => m.isAnchor);
    expect(anchor?.content).toContain("and finally zyzzyva ends it.");
  });

  it("finds a child's reply and a child's failure by the body they carry", () => {
    mkSession(reg, "s-child");
    const reply = longBody("kakapo");
    const failure = longBody("takahe");
    mkNotification("s-child", "child-ok", banner(reply), { kind: "child-reply", employee: "worker", childSessionId: "c1", fullMessage: reply }, 7100);
    mkNotification("s-child", "child-bad", banner(failure), { kind: "child-error", employee: "worker", childSessionId: "c2", fullMessage: failure }, 7101);

    expect(reg.searchMessages("kakapo").map((h) => h.messageId)).toEqual(["child-ok"]);
    expect(reg.searchMessages("takahe").map((h) => h.messageId)).toEqual(["child-bad"]);
  });

  it("keeps other notifications unsearchable, whatever they carry", () => {
    mkSession(reg, "s-chatter");
    mkNotification("s-chatter", "n-manager", "📋 visibility", { kind: "manager-visibility", fullMessage: "quagga one" }, 7200);
    mkNotification("s-chatter", "n-plain", "restart acknowledged quagga two", null, 7201);
    mkNotification("s-chatter", "n-unkinded", "status quagga three", { fullMessage: "quagga four" }, 7202);
    mkNotification("s-chatter", "n-notext", "📨 relay", { kind: "agent-relay", fullMessage: 12345 }, 7203);
    mkNotification("s-chatter", "n-badjson", "📨 relay quagga five", "{not json", 7204);

    expect(reg.searchMessages("quagga")).toEqual([]);
  });

  it("matches the body, not the banner's wording, and narrows by the usual filters", () => {
    mkSession(reg, "s-filter-a");
    mkSession(reg, "s-filter-b");
    const body = longBody("aardwolf");
    for (const [sid, id, ts] of [["s-filter-a", "fa", 7300], ["s-filter-b", "fb", 7301]] as const) {
      mkNotification(sid, id, banner(body), { kind: "agent-relay", fromLabel: "worker", hops: 1, maxHops: 3, fullMessage: body }, ts);
    }
    mkMessage(reg, "s-filter-b", "assistant", "an aardwolf in the reply", 7302);

    expect(reg.searchMessages("aardwolf").map((h) => h.messageId)).toContain("fa");
    expect(reg.searchMessages("aardwolf", 10, { sessionId: "s-filter-a" }).map((h) => h.messageId)).toEqual(["fa"]);
    expect(reg.searchMessages("aardwolf", 10, { excludeSessionId: "s-filter-a" }).every((h) => h.sessionId === "s-filter-b")).toBe(true);
    expect(reg.searchMessages("aardwolf", 10, { since: 7301, until: 7301 }).map((h) => h.messageId)).toEqual(["fb"]);
    // The role filter names user/assistant rows; a relayed notification is neither.
    const assistantOnly = reg.searchMessages("aardwolf", 10, { role: "assistant" });
    expect(assistantOnly.map((h) => h.role)).toEqual(["assistant"]);
    // Newest first across both indexes, and the limit applies to the merged list.
    expect(reg.searchMessages("aardwolf", 10).map((h) => h.timestamp)).toEqual([7302, 7301, 7300]);
    expect(reg.searchMessages("aardwolf", 2).map((h) => h.timestamp)).toEqual([7302, 7301]);
  });

  it("drops a relay from the index when it is rewritten or deleted", () => {
    mkSession(reg, "s-edit");
    const body = longBody("pangolin");
    mkNotification("s-edit", "edit-1", banner(body), { kind: "agent-relay", fromLabel: "worker", hops: 1, maxHops: 3, fullMessage: body }, 7400);
    const db = dbModule.initDb();

    const edited = longBody("ocelot");
    db.prepare("UPDATE messages SET meta = ? WHERE id = 'edit-1'").run(JSON.stringify({ kind: "agent-relay", fromLabel: "worker", hops: 1, maxHops: 3, fullMessage: edited }));
    expect(reg.searchMessages("pangolin")).toEqual([]);
    expect(reg.searchMessages("ocelot").map((h) => h.messageId)).toEqual(["edit-1"]);

    // An update that leaves the body alone (the row is touched by other writers) keeps it findable.
    db.prepare("UPDATE messages SET timestamp = timestamp + 1 WHERE id = 'edit-1'").run();
    expect(reg.searchMessages("ocelot")).toHaveLength(1);

    db.prepare("DELETE FROM messages WHERE id = 'edit-1'").run();
    expect(reg.searchMessages("ocelot")).toEqual([]);
    expect(() => db.exec("INSERT INTO relay_messages_fts(relay_messages_fts, rank) VALUES('integrity-check', 1)")).not.toThrow();
  });

  it("deleting a session de-indexes its relays", () => {
    mkSession(reg, "s-gone");
    const body = longBody("dugong");
    mkNotification("s-gone", "gone-1", banner(body), { kind: "child-reply", employee: "worker", childSessionId: "c9", fullMessage: body }, 7500);
    expect(reg.searchMessages("dugong")).toHaveLength(1);
    reg.deleteSession("s-gone");
    expect(reg.searchMessages("dugong")).toEqual([]);
  });

  describe("on a database that already holds relays", () => {
    function legacyWithRelays(): Database.Database {
      const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-fts-relay-legacy-")), "legacy.db");
      const db = new Database(p);
      db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL)");
      migrateModule.migrateMessagesSchema(db);
      const ins = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)");
      const body = longBody("numbat");
      ins.run("old-relay", "leg", "notification", banner(body), 1, JSON.stringify({ kind: "agent-relay", fromLabel: "w", hops: 1, maxHops: 3, fullMessage: body }));
      ins.run("old-bad", "leg", "notification", "📨 numbat", 2, "{not json");
      ins.run("old-chatter", "leg", "notification", "restart numbat", 3, null);
      return db;
    }
    const relayHits = (db: Database.Database, q: string): string[] =>
      (db
        .prepare("SELECT m.id AS id FROM relay_messages_fts JOIN messages m ON m.rowid = relay_messages_fts.rowid WHERE relay_messages_fts MATCH ?")
        .all(q) as Array<{ id: string }>).map((r) => r.id);

    it("starts with an empty index: boot only creates it, the chunked backfill fills it", () => {
      const db = legacyWithRelays();
      migrateModule.migrateFtsSchema(db);
      expect(relayHits(db, "numbat")).toEqual([]);
      expect(migrateModule.getMeta(db, "relay_fts_backfill_done")).toBeNull();

      reg.backfillFtsSync(db);
      expect(relayHits(db, "numbat")).toEqual(["old-relay"]);
      expect(migrateModule.getMeta(db, "relay_fts_backfill_done")).toBe("1");

      // A later boot neither repeats the backfill nor duplicates the index.
      migrateModule.migrateFtsSchema(db);
      reg.backfillFtsSync(db);
      expect(relayHits(db, "numbat")).toEqual(["old-relay"]);
      expect(() => db.prepare("DELETE FROM messages WHERE id = 'old-relay'").run()).not.toThrow();
      expect(relayHits(db, "numbat")).toEqual([]);
      db.close();
    });

    it("backfills in rowid windows, resumes, and indexes every relay once", () => {
      const db = legacyWithRelays();
      const ins = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)");
      for (let i = 0; i < 40; i++) {
        if (i % 3 === 0) ins.run(`bulk-${i}`, "leg", "notification", "📨", 10 + i, JSON.stringify({ kind: "child-reply", employee: "w", childSessionId: "c", fullMessage: `bulk wombat ${i}` }));
        else ins.run(`bulk-${i}`, "leg", "assistant", `plain ${i}`, 10 + i, null);
      }
      migrateModule.migrateFtsSchema(db);
      // A window of 4 rowids forces many chunks; two full passes must not double-index.
      reg.backfillFtsSync(db, 4);
      reg.backfillFtsSync(db, 4);
      expect(relayHits(db, "wombat")).toHaveLength(14);
      expect(relayHits(db, "numbat")).toEqual(["old-relay"]);
      expect(() => db.exec("INSERT INTO relay_messages_fts(relay_messages_fts, rank) VALUES('integrity-check', 1)")).not.toThrow();
      db.close();
    });

    it("keeps updates, deletes and new relays safe while the backfill is only partly done", () => {
      const db = legacyWithRelays();
      const ins = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)");
      const relayMeta = (text: string): string => JSON.stringify({ kind: "agent-relay", fromLabel: "w", hops: 1, maxHops: 3, fullMessage: text });
      for (let i = 0; i < 30; i++) ins.run(`part-${i}`, "leg", "notification", "📨", 10 + i, relayMeta(`partial quokka tag${i}`));
      migrateModule.migrateFtsSchema(db);

      // One window only: the earliest rows are indexed, the later ones are not yet.
      expect(reg.relayFtsBackfillStep(db, 10)).toBe(false);
      expect(relayHits(db, "tag0")).toEqual(["part-0"]);
      expect(relayHits(db, "tag29")).toEqual([]);

      // Rewrite and delete rows on both sides of the watermark, and add a relay after it.
      expect(() => {
        db.prepare("UPDATE messages SET meta = ? WHERE id = 'part-0'").run(relayMeta("rewritten ibex"));
        db.prepare("DELETE FROM messages WHERE id = 'part-1'").run();
        db.prepare("UPDATE messages SET meta = ? WHERE id = 'part-29'").run(relayMeta("rewritten civet"));
        db.prepare("DELETE FROM messages WHERE id = 'part-28'").run();
        ins.run("part-new", "leg", "notification", "📨", 99, relayMeta("fresh genet tag99"));
      }).not.toThrow();
      expect(relayHits(db, "tag0")).toEqual([]);
      expect(relayHits(db, "ibex")).toEqual(["part-0"]);
      expect(relayHits(db, "tag1")).toEqual([]);
      expect(relayHits(db, "genet")).toEqual(["part-new"]);

      reg.backfillFtsSync(db, 7);
      expect(relayHits(db, "civet")).toEqual(["part-29"]);
      expect(relayHits(db, "tag29")).toEqual([]);
      expect(relayHits(db, "tag28")).toEqual([]);
      expect(relayHits(db, "quokka")).toHaveLength(26); // 30 - part-0 rewritten - part-1 and part-28 deleted - part-29 rewritten
      expect(() => db.exec("INSERT INTO relay_messages_fts(relay_messages_fts, rank) VALUES('integrity-check', 1)")).not.toThrow();
      db.close();
    });

    it("a gateway that serves writes before the yielded backfill starts stays consistent", async () => {
      const db = legacyWithRelays();
      migrateModule.migrateFtsSchema(db);
      expect(() => db.prepare("DELETE FROM messages WHERE id = 'old-relay'").run()).not.toThrow();
      await reg.scheduleFtsBackfill(db, 4);
      expect(relayHits(db, "numbat")).toEqual([]);
      expect(migrateModule.getMeta(db, "relay_fts_backfill_done")).toBe("1");
      db.close();
    });

    it("two connections draining the same database index every relay once", () => {
      const db = legacyWithRelays();
      const ins = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)");
      for (let i = 0; i < 40; i++) ins.run(`two-${i}`, "leg", "notification", "📨", 10 + i, JSON.stringify({ kind: "child-error", employee: "w", childSessionId: "c", fullMessage: `shared marmot tag${i}` }));
      migrateModule.migrateFtsSchema(db);
      const other = new Database(db.name);
      other.pragma("busy_timeout = 5000");
      // Each connection takes a window in turn, as two processes sharing the file would.
      for (let guard = 0; guard < 100; guard++) {
        const a = reg.relayFtsBackfillStep(db, 5);
        const b = reg.relayFtsBackfillStep(other, 5);
        if (a && b) break;
      }
      other.close();
      expect(relayHits(db, "marmot")).toHaveLength(40);
      expect(() => db.exec("INSERT INTO relay_messages_fts(relay_messages_fts, rank) VALUES('integrity-check', 1)")).not.toThrow();
      db.close();
    });

    it("is rebuilt on the next boot after FTS was disabled for the process", () => {
      const db = legacyWithRelays();
      migrateModule.migrateFtsSchema(db);
      reg.disableFtsForProcess(db, "test");
      expect(() => db.prepare("SELECT 1 FROM relay_messages_fts").get()).toThrow(/no such table/);
      expect(migrateModule.getMeta(db, "relay_fts_backfill_done")).toBeNull();

      migrateModule.migrateFtsSchema(db);
      reg.backfillFtsSync(db);
      expect(relayHits(db, "numbat")).toEqual(["old-relay"]);
      db.close();
    });
  });
});
