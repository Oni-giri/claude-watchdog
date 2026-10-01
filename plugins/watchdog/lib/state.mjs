import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const stateRoot = () =>
  process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "claude-watchdog");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s) => String(s).replace(/[^\w.-]/g, "_");

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** mkdir-based mutex. Returns release fn, or null if held (and not stale). */
export function tryLock(dir, staleMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
      return () => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      };
    } catch (e) {
      if (e.code !== "EEXIST") return null;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > staleMs) fs.rmSync(dir, { recursive: true, force: true });
        else return null;
      } catch {
        /* raced with release; retry */
      }
    }
  }
  return null;
}

export class Session {
  constructor(sessionId, root = stateRoot()) {
    this.id = sessionId || "unknown";
    this.dir = path.join(root, "sessions", safe(this.id));
    this.root = root;
    fs.mkdirSync(path.join(this.dir, "inbox"), { recursive: true });
    fs.mkdirSync(path.join(this.dir, "delivered"), { recursive: true });
  }

  file(name) { return path.join(this.dir, name); }

  static initialState() {
    return {
      cursor: 0,
      toolCalls: 0, // PostToolUse count since last review
      idle: false, // true between Stop and the next prompt / tool call
      disabled: false, // /watchdog off
      stopBlocks: 0, // consecutive Stop blocks
      failures: 0, // consecutive reviewer failures
      seen: {}, // dedupe history
      asks: [], // user prompts, pinned into every review
      raised: [], // recent advice, shown to the reviewer to avoid repeats
      usage: { reviews: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
      lastError: null,
      lastReviewAt: null,
    };
  }

  load() {
    try {
      return { ...Session.initialState(), ...JSON.parse(fs.readFileSync(this.file("state.json"), "utf8")) };
    } catch {
      return Session.initialState();
    }
  }

  /** Serialized read-modify-write; hooks run as separate processes in parallel. */
  async update(fn) {
    const lock = this.file("state.lock");
    let release = null;
    for (let i = 0; i < 100 && !release; i++) {
      release = tryLock(lock, 5000);
      if (!release) await sleep(20);
    }
    try {
      const st = this.load();
      const out = fn(st);
      writeAtomic(this.file("state.json"), JSON.stringify(st));
      return out === undefined ? st : out;
    } finally {
      release?.();
    }
  }

  /** Review lock: at most one reviewer runs per session. */
  tryReviewLock(staleMs) { return tryLock(this.file("review.lock"), staleMs); }
  reviewInFlight(staleMs) {
    try { return Date.now() - fs.statSync(this.file("review.lock")).mtimeMs <= staleMs; } catch { return false; }
  }

  // --- inbox: one file per note; claiming = atomic rename, so no double delivery ---
  push(note) {
    const name = `${String(Date.now()).padStart(14, "0")}-${crypto.randomBytes(3).toString("hex")}.json`;
    writeAtomic(path.join(this.dir, "inbox", name), JSON.stringify(note));
  }

  pending() {
    return fs.readdirSync(path.join(this.dir, "inbox")).filter((f) => f.endsWith(".json")).sort().flatMap((f) => {
      try { return [{ f, ...JSON.parse(fs.readFileSync(path.join(this.dir, "inbox", f), "utf8")) }]; } catch { return []; }
    });
  }

  /** Atomically claim pending notes matching `pred`. */
  take(pred = () => true) {
    const taken = [];
    for (const n of this.pending()) {
      if (!pred(n)) continue;
      try {
        fs.renameSync(path.join(this.dir, "inbox", n.f), path.join(this.dir, "delivered", n.f));
        taken.push(n);
      } catch { /* claimed by another hook */ }
    }
    return taken;
  }

  log(entry) {
    try { fs.appendFileSync(this.file("log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"); } catch {}
  }

  // --- /watchdog needs to find "this" session from a Bash call, which has no session id ---
  static pointerFile(root, cwd) {
    return path.join(root, "latest-" + crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12) + ".json");
  }
  static setLatest(root, cwd, sessionId) {
    fs.mkdirSync(root, { recursive: true });
    writeAtomic(Session.pointerFile(root, cwd), JSON.stringify({ sessionId, cwd: path.resolve(cwd) }));
  }
  static latest(root, cwd) {
    try { return JSON.parse(fs.readFileSync(Session.pointerFile(root, cwd), "utf8")).sessionId; } catch { return null; }
  }
}
