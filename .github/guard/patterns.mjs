// What a post must never hold, and what is only worth a look (the rules: CODE_OF_CONDUCT.md).
// Removed: an install link (it opens the person's setup, keys included), a key, a link to a site or
// file for getting videos (rule 2), a referral link (rule 4). Flagged only: words that often come with
// piracy talk, and account trading. The site and word lists are kept private (a public list of such
// sites would read as pointing to them): the workflow passes them in as the secret GUARD_RULES, the same
// lists the Discord server's AutoMod uses. Pure functions, tested by patterns.test.mjs with made-up lists
// (`node --test .github/guard/patterns.test.mjs`).
const EMPTY = { piracySites: [], piracyLinks: [], referralLinks: [], tradingPhrases: [], flagWords: [] };
const RULES = { ...EMPTY, ...JSON.parse(process.env.GUARD_RULES || "{}") };
export const RULES_URL = "https://github.com/AleksaB98/subtitle-sync-for-stremio/blob/main/CODE_OF_CONDUCT.md";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOT_LINK = "[^\\s<>()\\[\\]\"'`]";

/** A pattern from a list, or one that never matches when the list is empty (an empty alternation matches everything). */
const fromList = (list, build) => (list.length ? new RegExp(build(list), "gi") : /(?!)/g);
// A link to a known site for getting videos, with or without https:// and whatever its domain ends in.
const PIRACY_SITE = fromList(RULES.piracySites, (l) => `(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*\\b(?:${l.map(escape).join("|")})\\.[a-z]{2,}\\b${NOT_LINK}*`);
// A magnet link or a file of that kind, as the whole word it sits in.
const PIRACY_LINK = fromList(RULES.piracyLinks, (l) => l.map((p) => `${NOT_LINK}*${p}${NOT_LINK}*`).join("|"));
// A link carrying someone's referral or affiliate code.
const REFERRAL = fromList(RULES.referralLinks, (l) => l.map((p) => `${NOT_LINK}*${p}${NOT_LINK}*`).join("|"));
// Words and phrases worth a look by the owner, never removed by themselves.
const FLAGS = fromList([...RULES.flagWords, ...RULES.tradingPhrases], (l) => `\\b(?:${l.map(escape).join("|")})\\b`);

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

// A picture or file uploaded to GitHub itself: its link ends in a UUID that is no key (2026-10-23, a
// post's two screenshots were removed as "a key"). Taken out before any rule looks.
const GITHUB_UPLOAD = /https:\/\/(?:github\.com\/user-attachments\/(?:assets|files)\/|(?:private-)?user-images\.githubusercontent\.com\/)[^\s<>()\[\]"'`]*/gi;

/**
 * Everything to remove from the text, in the order found, each named by its kind.
 * @param {string} text
 * @returns {{ kind: "link" | "key" | "piracy" | "referral", match: string }[]}
 */
export function findSecrets(text) {
  const found = [];
  const seen = new Set();
  const add = (kind, match) => {
    if (seen.has(match)) return;
    seen.add(match);
    found.push({ kind, match });
  };
  const source = String(text ?? "").replace(GITHUB_UPLOAD, " ");
  const without = () => found.reduce((rest, f) => rest.split(f.match).join(" "), source);
  for (const m of source.matchAll(PIRACY_SITE)) add("piracy", m[0]);
  for (const m of without().matchAll(PIRACY_LINK)) add("piracy", m[0]);
  for (const m of without().matchAll(REFERRAL)) add("referral", m[0]);
  for (const m of without().matchAll(LONG_LINK)) add("link", m[0]);
  const rest = without();
  for (const m of rest.matchAll(GEMINI)) add("key", m[0]);
  for (const m of rest.matchAll(UUID)) add("key", m[0]);
  for (const m of rest.matchAll(TOKEN)) {
    if (/^[0-9a-f]+$/i.test(m[0]) || !/[0-9]/.test(m[0])) continue;
    add("key", m[0]);
  }
  return found;
}

/**
 * The words worth a look (rules 2 and 4), lowercased, each once. Nothing is removed for them.
 * @param {string} text
 */
export function findFlags(text) {
  return [...new Set([...String(text ?? "").matchAll(FLAGS)].map((m) => m[0].toLowerCase()))];
}

/**
 * The text with everything found replaced by a short note in brackets.
 * @param {string} text
 * @param {{ kind: string, match: string }[]} found
 */
export function cleaned(text, found) {
  let out = String(text ?? "");
  for (const f of [...found].sort((a, b) => b.match.length - a.match.length)) {
    out = out.split(f.match).join(f.kind === "key" ? "[key removed]" : "[link removed]");
  }
  return out;
}

/**
 * The note posted in place of the removed post, naming its author and what was taken out.
 * @param {string} author
 * @param {{ kind: string }[]} found
 */
export function noteFor(author, found) {
  const kinds = new Set(found.map((f) => f.kind));
  const parts = [];
  if (kinds.has("link") && kinds.has("key")) parts.push("a link with your setup in it and a key");
  else if (kinds.has("link")) parts.push("a link with your setup in it");
  else if (kinds.has("key")) parts.push("a key");
  if (kinds.has("piracy")) parts.push("a link to a site or file for getting videos, which this place does not allow (rule 2)");
  if (kinds.has("referral")) parts.push("a referral link, which this place does not allow (rule 4)");
  const what = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  const lines = [`@${author}, your post had ${what}, so I removed it and posted it again below without it.`];
  if (kinds.has("link") || kinds.has("key")) {
    lines.push(
      "",
      "Anyone who has that link or key can use your accounts through it. To be safe:",
      "1. Make new keys on the sites you use (OpenSubtitles, Gemini, TorBox and others) and delete the old ones.",
      "2. Set up Subtitle Sync again with the new keys at https://subtitlesync.stream/configure, then uninstall the old one in Stremio.",
      "",
      "To get help, your support code is all I need: in Stremio, open Addons, find Subtitle Sync and press its gear (Configure); the code is at the top. Never post your install link.",
    );
  }
  lines.push("", `The rules: ${RULES_URL}`);
  return lines.join("\n");
}
