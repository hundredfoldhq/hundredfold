import { afterAll, describe, expect, it } from "vitest";
import { __closeDbForTest, initDb } from "../db.js";
import { createSession, getSession } from "../../sessions/registry.js";

/**
 * The retired voice assistant's `talk_*` tables are neither created nor dropped. A database a
 * previous release wrote keeps them, rows and all, and opens and runs as before; a new database
 * never gets them. The DDL below is what those releases created, kept here as the fixture.
 */
const LEGACY_TALK_DDL = `
CREATE TABLE talk_sessions (
  id TEXT PRIMARY KEY,
  browser_instance_id TEXT NOT NULL,
  credential_generation INTEGER NOT NULL CHECK (credential_generation >= 1),
  session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live', 'parked', 'closed')),
  model TEXT NOT NULL,
  brief TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  truncated_turns INTEGER NOT NULL CHECK (truncated_turns >= 0),
  token_expires_at INTEGER NOT NULL,
  exposed_tools_json TEXT NOT NULL CHECK (json_valid(exposed_tools_json)),
  expanded_intents_json TEXT NOT NULL CHECK (json_valid(expanded_intents_json))
);
CREATE TABLE talk_session_turns (
  talk_session_id TEXT NOT NULL REFERENCES talk_sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  visual_receipts_json TEXT NOT NULL CHECK (json_valid(visual_receipts_json)),
  PRIMARY KEY (talk_session_id, ordinal)
);
CREATE TABLE talk_tool_receipts (
  talk_session_id TEXT NOT NULL,
  provider_call_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (talk_session_id, provider_call_id)
);
CREATE TABLE talk_voice_transcripts (
  talk_session_id TEXT NOT NULL,
  browser_instance_id TEXT NOT NULL,
  credential_generation INTEGER NOT NULL CHECK (credential_generation >= 1),
  input_ordinal INTEGER NOT NULL CHECK (input_ordinal >= 1),
  provider_item_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  transcript TEXT NOT NULL CHECK (length(transcript) BETWEEN 1 AND 4000),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (talk_session_id, credential_generation, provider_item_id)
);
CREATE INDEX idx_talk_sessions_state_seen ON talk_sessions (state, last_seen_at);
`;

const talkObjects = (database: ReturnType<typeof initDb>): string[] =>
  (database.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%talk\\_%' ESCAPE '\\' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);

afterAll(() => __closeDbForTest());

describe("the retired talk_* tables", () => {
  it("are not created in a new database", () => {
    expect(talkObjects(initDb())).toEqual([]);
  });

  it("stay on disk, with their rows, in a database that already holds them, and the database still works", () => {
    const database = initDb();
    database.exec(LEGACY_TALK_DDL);
    database.prepare(
      "INSERT INTO talk_sessions VALUES ('talk-1','browser-1',1,'chat-1','parked','gpt-realtime','brief',1,2,0,3,'[]','[]')",
    ).run();
    database.prepare("INSERT INTO talk_session_turns VALUES ('talk-1',1,1,'hello',2,'[]')").run();
    database.prepare("INSERT INTO talk_tool_receipts VALUES ('talk-1','call-1','fp','{}',1)").run();
    database.prepare("INSERT INTO talk_voice_transcripts VALUES ('talk-1','browser-1',1,1,'item-1','event-1','hello',1)").run();
    const before = database.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE '%talk\\_%' ESCAPE '\\' ORDER BY name").all();

    // A restart: the next initDb() reopens the same file and runs every migration again.
    __closeDbForTest();
    const reopened = initDb();

    expect(reopened.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE '%talk\\_%' ESCAPE '\\' ORDER BY name").all()).toEqual(before);
    expect(reopened.prepare("SELECT id, state, session_id FROM talk_sessions").all()).toEqual([{ id: "talk-1", state: "parked", session_id: "chat-1" }]);
    expect(reopened.prepare("SELECT count(*) AS n FROM talk_session_turns").get()).toEqual({ n: 1 });
    expect(reopened.prepare("SELECT count(*) AS n FROM talk_tool_receipts").get()).toEqual({ n: 1 });
    expect(reopened.prepare("SELECT count(*) AS n FROM talk_voice_transcripts").get()).toEqual({ n: 1 });

    // The rest of the registry is unaffected: a stored talk-source chat is an ordinary row.
    const stored = createSession({ engine: "claude", source: "talk", sourceRef: "talk:stored" });
    expect(getSession(stored.id)?.source).toBe("talk");
  });
});
