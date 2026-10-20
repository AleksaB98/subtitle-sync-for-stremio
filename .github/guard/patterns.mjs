// What a post must never hold: an install link (it opens the person's setup, keys included) or a key.
// Pure functions, tested by patterns.test.mjs (`node --test .github/guard/patterns.test.mjs`).

// A link whose address has a long settings part: Subtitle Sync's install link (hundreds of characters
// of sealed settings) and most stream addons' links (AIOStreams, Torrentio and others keep their setup,
// keys included, in the address). Ordinary links (a page, a commit) have no part this long.
const LONG_LINK = /(?:https?:\/\/|stremio:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>()\[\]"'`]*?[A-Za-z0-9_%=.~+-]{60,}[^\s<>()\[\]"'`]*/gi;

// Gemini keys from Google AI Studio: "AIza…" (older) and "AQ.…" (made since 2026).
const GEMINI = /\b(?:AIza[0-9A-Za-z_-]{35}|AQ\.[0-9A-Za-z_.-]{20,})/g;

// TorBox keys look like a UUID.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// OpenSubtitles (32 letters and digits) and other sites' keys: 32 to 64 letters and digits with a digit
// in them. A file hash or commit (only 0-9 and a-f) is left alone.
const TOKEN = /\b[A-Za-z0-9]{32,64}\b/g;

/**
 * Every link or key in the text, in the order found, each named by its kind.
 * @param {string} text
 * @returns {{ kind: "link" | "key", match: string }[]}
 */
export function findSecrets(text) {
  const found = [];
  const seen = new Set();
  const add = (kind, match) => {
    if (seen.has(match)) return;
    seen.add(match);
    found.push({ kind, match });
  };
  const source = String(text ?? "");
  for (const m of source.matchAll(LONG_LINK)) add("link", m[0]);
  const outsideLinks = found.reduce((rest, f) => rest.split(f.match).join(" "), source);
  for (const m of outsideLinks.matchAll(GEMINI)) add("key", m[0]);
  for (const m of outsideLinks.matchAll(UUID)) add("key", m[0]);
  for (const m of outsideLinks.matchAll(TOKEN)) {
    if (/^[0-9a-f]+$/i.test(m[0]) || !/[0-9]/.test(m[0])) continue;
    add("key", m[0]);
  }
  return found;
}

/**
 * The text with every link and key replaced by a short note in brackets.
 * @param {string} text
 * @param {{ kind: "link" | "key", match: string }[]} found
 */
export function cleaned(text, found) {
  let out = String(text ?? "");
  for (const f of [...found].sort((a, b) => b.match.length - a.match.length)) {
    out = out.split(f.match).join(f.kind === "link" ? "[link removed]" : "[key removed]");
  }
  return out;
}

/**
 * The note posted in place of the removed post, naming its author.
 * @param {string} author
 * @param {{ kind: "link" | "key" }[]} found
 */
export function noteFor(author, found) {
  const kinds = new Set(found.map((f) => f.kind));
  const what = kinds.has("link") && kinds.has("key") ? "a link with your setup in it and a key"
    : kinds.has("link") ? "a link with your setup in it" : "a key";
  return [
    `@${author}, your post had ${what}, so I removed it and posted it again below without it.`,
    "",
    "Anyone who has that link or key can use your accounts through it. To be safe:",
    "1. Make new keys on the sites you use (OpenSubtitles, Gemini, TorBox and others) and delete the old ones.",
    "2. Set up Subtitle Sync again with the new keys at https://subtitlesync.stream/configure, then uninstall the old one in Stremio.",
    "",
    "To get help, your support code is all I need: in Stremio, open Addons, find Subtitle Sync and press its gear (Configure); the code is at the top. Never post your install link.",
  ].join("\n");
}
