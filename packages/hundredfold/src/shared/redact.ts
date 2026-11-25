const SECRET_KEY_RE = /(token|secret|password|passwd|pwd|api[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?secret|auth)/i;

const ENV_SECRET_NAME = /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|_KEY/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export function redactJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactJson(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? "[REDACTED]" : redactJson(v);
    }
    return out as T;
  }
  return value;
}

/**
 * `NAME=value` where the name holds a secret word, of any length. The name is matched on its own
 * and tested in code (`[A-Z0-9_]*KEYWORD[A-Z0-9_]*` backtracks quadratically on one long word),
 * and only a secret's value is consumed: a plain pair in front of a secret one (`a=1&token=x`)
 * must not swallow it.
 */
function redactAssignments(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/\b([A-Z0-9_]+)(\s*=\s*)/gi)) {
    const valueStart = m.index + m[0].length;
    if (valueStart < last || !ENV_SECRET_NAME.test(m[1])) continue;
    let valueEnd = valueStart;
    while (valueEnd < text.length && !/\s/.test(text[valueEnd])) valueEnd += 1;
    if (valueEnd === valueStart) continue;
    out += `${text.slice(last, valueStart)}[REDACTED]`;
    last = valueEnd;
  }
  return out + text.slice(last);
}

export function redactText(input: string): string {
  let s = String(input ?? "");
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
  // A body cut before its END line (a long file read) is still a key.
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/, "[REDACTED PRIVATE KEY]");
  s = s.replace(/\b(x-api-key\s*:\s*)[^\s'"]+/gi, "$1[REDACTED]");
  s = s.replace(/(--(?:password|passwd|pwd|token|secret|api-key)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s"']+)/gi, "$1[REDACTED]");
  // curl's `-u user:pass`; a bare `-u name` (git, sort) carries no password.
  s = s.replace(/(\s(?:-u|--user)\s+)(?:"[^"]*:[^"]*"|'[^']*:[^']*'|[^\s"':]+:[^\s"']+)/g, "$1[REDACTED]");
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  s = s.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]");
  s = s.replace(/\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, "$1[REDACTED]");
  s = redactAssignments(s);
  s = s.replace(/\b((?:sk|pk|rk|xox[baprs]|gh[pousr]|glpat|hf|api)[-_][A-Za-z0-9._-]{8,})\b/g, "[REDACTED]");
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1$2:[REDACTED]@");
  s = s.replace(/("(?:token|secret|password|api[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?secret|auth)"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2");
  // `[ \t]*`, not `\s*`: a run of blank lines must not be matched from every one of its starts.
  s = s.replace(/^([ \t]*)([\w.-]+)([ \t]*:[ \t]*)[^\n#]+/gim, (whole, indent: string, name: string, colon: string) =>
    !/^authorization\b/i.test(name) && SECRET_KEY_RE.test(name) ? `${indent}${name}${colon}[REDACTED]` : whole);
  return s;
}

/** Text longer than this is redacted a chunk at a time (see `redactLargeText`). */
const REDACT_CHUNK = 32_768;
/** How far back from a chunk's end a cut looks for a newline, a space, then a delimiter, before cutting mid-word. */
const REDACT_CUT_WINDOW = 8_192;
/** Text kept either side of each cut and redacted again, so a secret that straddles a cut is still seen whole. */
const REDACT_SEAM = 2_048;
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/** Private-key blocks span lines, so they are found over the whole text before it is cut into chunks. */
function redactPrivateKeys(text: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const begin = PRIVATE_KEY_BEGIN.exec(text.slice(from));
    if (!begin) return out + text.slice(from);
    const start = from + begin.index;
    out += `${text.slice(from, start)}[REDACTED PRIVATE KEY]`;
    const end = PRIVATE_KEY_END.exec(text.slice(start + begin[0].length));
    // A body cut before its END line (a long file read) is still a key.
    if (!end) return out;
    from = start + begin[0].length + end.index + end[0].length;
  }
}

function cutAt(text: string, from: number): number {
  const limit = Math.min(from + REDACT_CHUNK, text.length);
  if (limit === text.length) return limit;
  const window = text.slice(Math.max(from, limit - REDACT_CUT_WINDOW), limit);
  const start = limit - window.length;
  const newline = window.lastIndexOf("\n");
  if (newline >= 0) return start + newline + 1;
  const space = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
  if (space >= 0) return start + space + 1;
  // Compact JSON, minified output and base64 have neither: cut after the last delimiter that cannot sit inside a value.
  const delimiter = Math.max(window.lastIndexOf(","), window.lastIndexOf("}"), window.lastIndexOf("]"), window.lastIndexOf("&"), window.lastIndexOf(";"));
  return delimiter >= 0 ? start + delimiter + 1 : limit;
}

/**
 * `redactText` over a text of any length. `redactText` can backtrack badly on one huge run of
 * unbroken characters, so a long text is cut into chunks it handles in bounded time, after its
 * private-key blocks, the one secret that spans lines, are taken out whole. Cuts fall at a line
 * break, a space or a delimiter where the text has one; the text either side of every cut is then
 * redacted once more as a whole, so a secret on a cut is still found.
 */
export function redactLargeText(input: string): string {
  const text = String(input ?? "");
  if (text.length <= REDACT_CHUNK) return redactText(text);
  const withoutKeys = text.includes("PRIVATE KEY-----") ? redactPrivateKeys(text) : text;
  const pieces: string[] = [];
  let carry = "";
  for (let from = 0; from < withoutKeys.length;) {
    const to = cutAt(withoutKeys, from);
    const chunk = redactText(withoutKeys.slice(from, to));
    const current = redactText(carry + chunk.slice(0, REDACT_SEAM)) + chunk.slice(REDACT_SEAM);
    from = to;
    if (from >= withoutKeys.length) {
      pieces.push(current);
      break;
    }
    const keep = Math.max(0, current.length - REDACT_SEAM);
    pieces.push(current.slice(0, keep));
    carry = current.slice(keep);
  }
  return pieces.join("");
}
