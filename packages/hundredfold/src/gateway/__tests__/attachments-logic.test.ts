import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
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

async function postUpload(bytes: string, sessionId: string, filename = "image.png") {
  const boundary = "same-name-boundary";
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\n${sessionId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n${bytes}\r\n--${boundary}--\r\n`,
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
  return out;
}

afterEach(() => { vi.restoreAllMocks(); });

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
    seedFilesDirUpload("p3a", "image.png", Buffer.from("EARLIER"));
    files.rehomeAttachmentsToSession(["p3a"], "sess-later");
    seedFilesDirUpload("p3", "image.png", Buffer.from("LATER"));
    files.rehomeAttachmentsToSession(["p3"], "sess-later");

    const m3 = reg.getFile("p3")!;
    expect(path.basename(m3.path!)).toBe("image-2.png");
    expect(fs.readFileSync(m3.path!, "utf8")).toBe("LATER");
    expect(fs.readFileSync(reg.getFile("p3a")!.path!, "utf8")).toBe("EARLIER");
    // The registry keeps the display name; the attachment is resolved through its own path.
    expect(m3.filename).toBe("image.png");
  });

  it("a failed re-home leaves no empty placeholder behind", () => {
    // A directory where the file should be makes renameSync fail (not EXDEV).
    const dir = path.join(paths.FILES_DIR, "bad1");
    fs.mkdirSync(path.join(dir, "broken.png"), { recursive: true });
    reg.insertFile({ id: "bad1", filename: "broken.png", size: 0, mimetype: "image/png", path: null });
    files.rehomeAttachmentsToSession(["bad1"], "sess-fail");

    expect(reg.getFile("bad1")!.path).toBeNull();
    const destDir = files.uploadDir("sess-fail");
    expect(fs.existsSync(destDir) ? fs.readdirSync(destDir) : []).toEqual([]);
  });

  it("session-scoped multipart uploads of the same name land in distinct files", async () => {
    const parse = (o: { status?: number; body?: string }) => {
      expect(o.status).toBe(201);
      return JSON.parse(o.body!) as { id: string; filename: string };
    };
    const first = parse(await postUpload("ONE", "sess-multi"));
    const second = parse(await postUpload("TWO", "sess-multi"));
    const p1 = reg.getFile(first.id)!.path!;
    const p2 = reg.getFile(second.id)!.path!;
    expect(p1).not.toBe(p2);
    expect(fs.readFileSync(p1, "utf8")).toBe("ONE");
    expect(fs.readFileSync(p2, "utf8")).toBe("TWO");
    // The returned name is the one on disk, so the attachment points at its own file.
    expect(path.basename(p1)).toBe(first.filename);
    expect(path.basename(p2)).toBe(second.filename);
  });

  it("a failed upload write leaves no empty placeholder behind", async () => {
    vi.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    const out = await postUpload("DATA", "sess-enospc");
    expect(out.status).toBe(500);
    const dir = files.uploadDir("sess-enospc");
    expect(fs.readdirSync(dir)).toEqual([]);
    // A retry gets the plain name back rather than image-2.png.
    const retry = JSON.parse((await postUpload("DATA", "sess-enospc")).body!) as { filename: string };
    expect(retry.filename).toBe("image.png");
  });

  it("a failed cross-device copy leaves no empty placeholder behind", () => {
    seedFilesDirUpload("xdev1", "image.png", Buffer.from("X"));
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw Object.assign(new Error("xdev"), { code: "EXDEV" }); });
    vi.spyOn(fs, "copyFileSync").mockImplementationOnce(() => { throw Object.assign(new Error("io"), { code: "EIO" }); });
    files.rehomeAttachmentsToSession(["xdev1"], "sess-xdev");
    expect(reg.getFile("xdev1")!.path).toBeNull();
    expect(fs.readdirSync(files.uploadDir("sess-xdev"))).toEqual([]);
  });

  it("a second upload of a name at the filesystem length limit still gets a distinct file", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "long-"));
    for (const name of ["a".repeat(251) + ".png", "字".repeat(83) + ".png"]) {
      expect(Buffer.byteLength(name)).toBeGreaterThan(250);
      const a = files.claimUniqueUploadPath(dir, name);
      const b = files.claimUniqueUploadPath(dir, name);
      const c = files.claimUniqueUploadPath(dir, name);
      expect(new Set([a, b, c]).size).toBe(3);
      for (const p of [a, b, c]) {
        expect(Buffer.byteLength(path.basename(p))).toBeLessThanOrEqual(255);
        expect(path.extname(p)).toBe(".png");
      }
    }
  });

  it("a claim that throws skips that attachment without aborting the rest", () => {
    seedFilesDirUpload("long1", "first.png", Buffer.from("L"));
    seedFilesDirUpload("long2", "second.png", Buffer.from("A"));
    vi.spyOn(fs, "openSync").mockImplementationOnce(() => { throw Object.assign(new Error("name too long"), { code: "ENAMETOOLONG" }); });
    files.rehomeAttachmentsToSession(["long1", "long2"], "sess-long");
    expect(reg.getFile("long1")!.path).toBeNull();
    expect(fs.readFileSync(reg.getFile("long2")!.path!, "utf8")).toBe("A");
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
