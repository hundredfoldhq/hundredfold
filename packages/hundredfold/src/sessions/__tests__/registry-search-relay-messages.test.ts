import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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

  it("builds snippets only for the hits it returns, however many long bodies match", () => {
    mkSession(reg, "s-many");
    const db = dbModule.initDb();
    const ins = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)");
    const prose = "the grey heron waded through the shallow water at dawn and ".repeat(160); // ~9,600 chars
    db.transaction(() => {
      for (let i = 0; i < 800; i++) {
        ins.run(`many-relay-${i}`, "s-many", "notification", "📨", 20_000 + i, JSON.stringify({ kind: "agent-relay", fromLabel: "w", hops: 1, maxHops: 3, fullMessage: `${prose} ${i}` }));
        ins.run(`many-reply-${i}`, "s-many", "assistant", `${prose} ${i}`, 30_000 + i, null);
      }
    })();
    // What snippet() over every match costs on this machine right now: the bar the search must clear by a
    // wide margin. A ratio, not a wall-clock bound, so host load moves both sides.
    const snippetEveryMatch = (table: string): number => {
      const started = performance.now();
      db.prepare(`SELECT snippet(${table}, 0, '«', '»', '…', 12) FROM ${table} JOIN messages m ON m.rowid = ${table}.rowid WHERE ${table} MATCH '"heron"' ORDER BY m.timestamp DESC LIMIT 5`).all();
      return performance.now() - started;
    };
    const timed = (run: () => unknown): number => {
      const started = performance.now();
      run();
      return performance.now() - started;
    };
    reg.searchMessages("heron", 5); // warm the statement cache and the page cache
    const everyRelay = snippetEveryMatch("relay_messages_fts");
    const everyReply = snippetEveryMatch("messages_fts");

    let both: ReturnType<Reg["searchMessages"]> = [];
    const bothMs = timed(() => { both = reg.searchMessages("heron", 5); });
    let replies: ReturnType<Reg["searchMessages"]> = [];
    const repliesMs = timed(() => { replies = reg.searchMessages("heron", 5, { role: "assistant" }); });

    expect(both.map((h) => h.messageId)).toEqual(["many-reply-799", "many-reply-798", "many-reply-797", "many-reply-796", "many-reply-795"]);
    expect(both.every((h) => h.snippet.includes("«heron»"))).toBe(true);
    expect(replies.map((h) => h.messageId)).toEqual(both.map((h) => h.messageId));
    const relays = reg.searchMessages("heron", 3, { until: 29_999 });
    expect(relays.map((h) => h.messageId)).toEqual(["many-relay-799", "many-relay-798", "many-relay-797"]);
    expect(relays.every((h) => h.snippet.includes("«heron»"))).toBe(true);

    expect(bothMs).toBeLessThan((everyRelay + everyReply) / 5);
    expect(repliesMs).toBeLessThan(everyReply / 5);
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

    it("indexes a relay once when it reuses a rowid at or below the pinned watermark", () => {
      const db = legacyWithRelays();
      migrateModule.migrateFtsSchema(db);
      const max = Number(migrateModule.getMeta(db, "relay_fts_backfill_max"));
      // Deleting the newest row frees its rowid, so the next insert lands at the watermark: the
      // backfill owns that rowid, and the insert trigger must leave it alone.
      db.prepare("DELETE FROM messages WHERE rowid = ?").run(max);
      const ins = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)");
      const info = ins.run("reused", "leg", "notification", "📨", 50, JSON.stringify({ kind: "agent-relay", fromLabel: "w", hops: 1, maxHops: 3, fullMessage: "reused bilby" }));
      expect(Number(info.lastInsertRowid)).toBeLessThanOrEqual(max);

      reg.backfillFtsSync(db);
      expect(relayHits(db, "bilby")).toEqual(["reused"]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM relay_messages_fts_docsize").get()).toEqual({ n: 2 });
      expect(() => db.exec("INSERT INTO relay_messages_fts(relay_messages_fts, rank) VALUES('integrity-check', 1)")).not.toThrow();
      db.close();
    });

    it("the yielded backfill still seeds relays when the message index finished on an earlier boot", async () => {
      const db = legacyWithRelays();
      migrateModule.migrateFtsSchema(db);
      // An upgraded home: the message backfill completed long ago, the relay index is new.
      migrateModule.setMeta(db, "fts_backfill_done", "1");
      expect(migrateModule.getMeta(db, "relay_fts_backfill_done")).toBeNull();

      await reg.scheduleFtsBackfill(db, 4);
      expect(relayHits(db, "numbat")).toEqual(["old-relay"]);
      expect(migrateModule.getMeta(db, "relay_fts_backfill_done")).toBe("1");
      db.close();
    });

    it("a drain whose index was dropped by another process stops without marking it done", () => {
      const db = legacyWithRelays();
      const ins = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)");
      for (let i = 0; i < 20; i++) {
        ins.run(`drop-r-${i}`, "leg", "notification", "📨", 10 + i, JSON.stringify({ kind: "agent-relay", fromLabel: "w", hops: 1, maxHops: 3, fullMessage: `dropped potoroo ${i}` }));
        ins.run(`drop-a-${i}`, "leg", "assistant", `dropped quoll ${i}`, 40 + i, null);
      }
      migrateModule.migrateFtsSchema(db);
      expect(reg.relayFtsBackfillStep(db, 5)).toBe(false);

      // What disableFtsForProcess does, from another process: drop both indexes and their progress.
      const other = new Database(db.name);
      other.exec(`
        DROP TRIGGER IF EXISTS messages_fts_ai; DROP TRIGGER IF EXISTS messages_fts_ad; DROP TRIGGER IF EXISTS messages_fts_au;
        DROP TABLE IF EXISTS messages_fts;
        ${migrateModule.DROP_RELAY_FTS}
        DELETE FROM meta WHERE key LIKE '%fts_backfill_%';
      `);
      other.close();

      // This process carries on draining: it must stop, and leave the index marked not migrated.
      expect(() => reg.backfillFtsSync(db, 5)).not.toThrow();
      expect(migrateModule.getMeta(db, "relay_fts_backfill_done")).toBeNull();
      expect(migrateModule.getMeta(db, "fts_backfill_done")).toBeNull();

      // So the next boot pins a fresh watermark and rebuilds both indexes whole.
      migrateModule.migrateFtsSchema(db);
      reg.backfillFtsSync(db, 5);
      expect(relayHits(db, "potoroo")).toHaveLength(20);
      expect(db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'quoll'").get()).toEqual({ n: 20 });
      expect(() => db.exec("INSERT INTO relay_messages_fts(relay_messages_fts, rank) VALUES('integrity-check', 1)")).not.toThrow();
      // messages_fts indexes only user/assistant rows of messages, so its integrity-check cannot be used
      // here; its docsize table holds one row per indexed message.
      expect(db.prepare("SELECT COUNT(*) AS n FROM messages_fts_docsize").get()).toEqual({ n: 20 });
      db.close();
    });

    it("four processes draining the same file index every relay once", async () => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const workerPath = path.join(here, "fixtures", "fts-drain-worker.mjs");
      const registryPath = path.resolve(here, "../../../dist/src/sessions/registry.js");
      const db = legacyWithRelays();
      db.pragma("journal_mode = WAL");
      const ins = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)");
      db.transaction(() => {
        for (let i = 0; i < 1500; i++) ins.run(`proc-${i}`, "leg", "notification", "📨", 10 + i, JSON.stringify({ kind: "child-reply", employee: "w", childSessionId: "c", fullMessage: `shared dibbler tag${i} ${"word ".repeat(40)}` }));
      })();
      migrateModule.migrateFtsSchema(db);
      const workers = 4;
      const barrier = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-fts-barrier-"));
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-fts-drain-home-"));
      const run = (): Promise<{ windows: number }> => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [workerPath, home, registryPath, db.name, barrier, String(workers), "3"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.setEncoding("utf8").on("data", (c) => { out += c; });
        child.stderr.setEncoding("utf8").on("data", (c) => { err += c; });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`drain worker exited ${code}: ${err || out}`))));
      });
      const results = await Promise.all(Array.from({ length: workers }, run));
      // Every window was taken by exactly one process.
      expect(results.reduce((n, r) => n + r.windows, 0)).toBeLessThanOrEqual(Math.ceil(Number(migrateModule.getMeta(db, "relay_fts_backfill_max")) / 3));
      expect(migrateModule.getMeta(db, "relay_fts_backfill_done")).toBe("1");
      expect(relayHits(db, "dibbler")).toHaveLength(1500);
      expect(db.prepare("SELECT COUNT(*) AS n FROM relay_messages_fts_docsize").get()).toEqual({ n: 1501 });
      expect(() => db.exec("INSERT INTO relay_messages_fts(relay_messages_fts, rank) VALUES('integrity-check', 1)")).not.toThrow();
      db.close();
    }, 120_000);

    it("a boot cannot slip between disable's drops and its progress reset", () => {
      const db = legacyWithRelays();
      const ins = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)");
      for (let i = 0; i < 10; i++) {
        ins.run(`mix-r-${i}`, "leg", "notification", "📨", 10 + i, JSON.stringify({ kind: "agent-relay", fromLabel: "w", hops: 1, maxHops: 3, fullMessage: `mixed wombat ${i}` }));
        ins.run(`mix-a-${i}`, "leg", "assistant", `mixed echidna ${i}`, 40 + i, null);
      }
      // A finished index: its watermark stays in meta, which is the stale state the interleave trips over.
      migrateModule.migrateFtsSchema(db);
      reg.backfillFtsSync(db, 5);
      expect(migrateModule.getMeta(db, "relay_fts_backfill_max")).not.toBeNull();

      // A second process, no busy wait, booting at the exact point between disable's two steps: just before the
      // meta DELETE runs. Unfixed, the drops are already committed here, so its boot recreates both indexes and
      // pins no watermark (the stale one is still in meta) and the DELETE then removes the stale one.
      const other = new Database(db.name, { timeout: 0 });
      let midBoot: unknown = "did not run";
      const realPrepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        if (sql.startsWith("DELETE FROM meta")) {
          db.prepare = realPrepare as typeof db.prepare;
          try {
            migrateModule.migrateFtsSchema(other);
            midBoot = "booted";
          } catch (e) {
            midBoot = e;
          }
        }
        return realPrepare(sql);
      }) as typeof db.prepare;

      reg.disableFtsForProcess(db, "test");
      // The interleaved boot is shut out until disable has committed; it sees the old state or the disabled one.
      expect(midBoot).toMatchObject({ code: expect.stringMatching(/^SQLITE_BUSY/) });

      // Right after disable, before anything reboots: an old, pre-watermark row deletes cleanly. Unfixed, the
      // mixed state left triggers with no watermark here, and this threw "database disk image is malformed".
      expect(() => db.prepare("DELETE FROM messages WHERE id = 'old-relay'").run()).not.toThrow();

      // The boot that was shut out retries once disable is done, and rebuilds both indexes from scratch.
      migrateModule.migrateFtsSchema(other);
      reg.backfillFtsSync(other, 5);
      other.close();

      // The relay index is whole afterwards, and further old rows still delete cleanly.
      expect(() => db.prepare("DELETE FROM messages WHERE id = 'mix-r-3'").run()).not.toThrow();
      expect(() => db.prepare("DELETE FROM messages WHERE id = 'mix-a-3'").run()).not.toThrow();
      expect(relayHits(db, "wombat")).toHaveLength(9);
      expect(relayHits(db, "numbat")).toEqual([]);
      expect(() => db.exec("INSERT INTO relay_messages_fts(relay_messages_fts, rank) VALUES('integrity-check', 1)")).not.toThrow();
      expect(db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'echidna'").get()).toEqual({ n: 9 });
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
