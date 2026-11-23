import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-attlogic-"));
process.env.HUNDREDFOLD_HOME = tmp;

type Files = typeof import("../files.js");
type Reg = typeof import("../../sessions/registry.js");
type Paths = typeof import("../../shared/paths.js");

let files: Files;
let reg: Reg;
let paths: Paths;

beforeAll(async () => {
  paths = await import("../../shared/paths.js");
  reg = await import("../../sessions/registry.js");
  files = await import("../files.js");
  (await import("../../shared/db.js")).initDb();
});

/** Simulate a first-message upload that landed in FILES_DIR before a session existed. */
function seedFilesDirUpload(id: string, filename: string, bytes: Buffer): void {
  const dir = path.join(paths.FILES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), bytes);
  reg.insertFile({ id, filename, size: bytes.length, mimetype: filename.endsWith(".zip") ? "application/zip" : "image/png", path: null });
}

describe("rehomeAttachmentsToSession", () => {
  it("moves FILES_DIR uploads into uploads/<date>/<sessionId>/ and records the new path", () => {
    seedFilesDirUpload("f1", "diagram.png", Buffer.from("PNG"));
    files.rehomeAttachmentsToSession(["f1"], "sess-new");

    const meta = reg.getFile("f1")!;
    expect(meta.path).toBeTruthy();
    expect(files.isServablePath(meta.path!)).toBe(true);
    expect(meta.path!.includes(path.join("uploads"))).toBe(true);
    expect(meta.path!.includes("sess-new")).toBe(true);
    expect(fs.existsSync(meta.path!)).toBe(true);
    // original FILES_DIR location is gone
    expect(fs.existsSync(path.join(paths.FILES_DIR, "f1", "diagram.png"))).toBe(false);
  });

  it("is a no-op for files already outside FILES_DIR (already session-scoped)", () => {
    // f1 was re-homed already — running again must not throw or move anything.
    const before = reg.getFile("f1")!.path;
    files.rehomeAttachmentsToSession(["f1"], "sess-new");
    expect(reg.getFile("f1")!.path).toBe(before);
  });
});

describe("same-named uploads in one session", () => {
  it("claimUniqueUploadPath never returns a taken name and keeps the extension", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "claim-"));
    const a = files.claimUniqueUploadPath(dir, "image.png");
    const b = files.claimUniqueUploadPath(dir, "image.png");
    const c = files.claimUniqueUploadPath(dir, "image.png");
    expect([a, b, c].map((p) => path.basename(p))).toEqual(["image.png", "image-2.png", "image-3.png"]);
    // A name that already looks like a suffixed one is skipped, not overwritten.
    fs.writeFileSync(path.join(dir, "notes-2"), "x");
    expect(path.basename(files.claimUniqueUploadPath(dir, "notes"))).toBe("notes");
    expect(path.basename(files.claimUniqueUploadPath(dir, "notes"))).toBe("notes-3");
  });

  it("re-homing two same-named first-message uploads keeps both files", async () => {
    seedFilesDirUpload("p1", "image.png", Buffer.from("FIRST"));
    seedFilesDirUpload("p2", "image.png", Buffer.from("SECOND"));
    files.rehomeAttachmentsToSession(["p1", "p2"], "sess-paste");

    const m1 = reg.getFile("p1")!;
    const m2 = reg.getFile("p2")!;
    expect(m1.path).not.toBe(m2.path);
    expect(fs.readFileSync(m1.path!, "utf8")).toBe("FIRST");
    expect(fs.readFileSync(m2.path!, "utf8")).toBe("SECOND");
    expect(path.dirname(m1.path!)).toBe(path.dirname(m2.path!));
    expect(fs.readdirSync(path.dirname(m1.path!)).sort()).toEqual(["image-2.png", "image.png"]);
    // The paths handed to the engine for the message are distinct too.
    const { resolveAttachmentPaths } = await import("../web-session-dispatch.js");
    expect(resolveAttachmentPaths(["p1", "p2"])).toEqual([m1.path, m2.path]);
  });

  it("re-homing onto a name an earlier message already used does not clobber it", () => {
    seedFilesDirUpload("p3", "image.png", Buffer.from("LATER"));
    files.rehomeAttachmentsToSession(["p3"], "sess-paste");

    const m3 = reg.getFile("p3")!;
    expect(path.basename(m3.path!)).toBe("image-3.png");
    expect(fs.readFileSync(m3.path!, "utf8")).toBe("LATER");
    expect(fs.readFileSync(reg.getFile("p1")!.path!, "utf8")).toBe("FIRST");
    // The recorded name matches what is on disk, so the message references the right file.
    expect(m3.filename).toBe("image.png");
  });

  it("session-scoped multipart uploads of the same name land in distinct files", async () => {
    async function post(bytes: string) {
      const boundary = "mar-same-name-boundary";
      const payload = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\nsess-multi\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n${bytes}\r\n--${boundary}--\r\n`,
      );
      const req = Object.assign(Readable.from([payload]), {
        method: "POST",
        url: "/api/files",
        headers: { host: "gateway.test", "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(payload.length) },
      });
      const out: { status?: number; body?: string } = {};
      const res = {
        writeHead(status: number) { out.status = status; return res; },
        end(body?: string) { out.body = body; return res; },
      } as unknown as import("node:http").ServerResponse;
      const ctx = { emit: () => {}, getConfig: () => ({}) } as unknown as import("../api.js").ApiContext;
      await files.handleFilesRequest(req as never, res, { method: "POST", pathname: "/api/files", url: new URL("/api/files", "http://localhost") }, ctx);
      expect(out.status).toBe(201);
      return JSON.parse(out.body!) as { id: string; filename: string };
    }

    const first = await post("ONE");
    const second = await post("TWO");
    const p1 = reg.getFile(first.id)!.path!;
    const p2 = reg.getFile(second.id)!.path!;
    expect(p1).not.toBe(p2);
    expect(fs.readFileSync(p1, "utf8")).toBe("ONE");
    expect(fs.readFileSync(p2, "utf8")).toBe("TWO");
    // The returned name is the one on disk, so the attachment points at its own file.
    expect(path.basename(p1)).toBe(first.filename);
    expect(path.basename(p2)).toBe(second.filename);
  });
});

describe("fileIdsToMedia", () => {
  it("maps file IDs to media descriptors, deriving type from mimetype (incl. zip → file)", () => {
    seedFilesDirUpload("img", "shot.png", Buffer.from("PNG"));
    seedFilesDirUpload("zip", "bundle.zip", Buffer.from("PKzipdata"));

    const media = files.fileIdsToMedia(["img", "zip", "missing"]);
    expect(media).toHaveLength(2); // missing id skipped
    expect(media[0]).toMatchObject({ type: "image", url: "/api/files/img", name: "shot.png" });
    expect(media[1]).toMatchObject({ type: "file", url: "/api/files/zip", name: "bundle.zip", mimeType: "application/zip" });
  });

  it("maps video MIME types to video media descriptors", () => {
    reg.insertFile({ id: "vid", filename: "clip.mp4", size: 4, mimetype: "video/mp4", path: null });

    expect(files.fileIdsToMedia(["vid"])).toEqual([
      expect.objectContaining({ type: "video", url: "/api/files/vid", name: "clip.mp4", mimeType: "video/mp4" }),
    ]);
  });

  it("returns [] for non-array input", () => {
    expect(files.fileIdsToMedia(undefined)).toEqual([]);
    expect(files.fileIdsToMedia("nope")).toEqual([]);
  });
});
