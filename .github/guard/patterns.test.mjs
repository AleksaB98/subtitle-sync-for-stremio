import { test } from "node:test";
import assert from "node:assert/strict";

// The real lists are private (the workflow's GUARD_RULES secret); these made-up ones test the shapes.
process.env.GUARD_RULES = JSON.stringify({
  piracySites: ["fakeshare", "fs"],
  piracyLinks: ["fakelink:\\?id=", "[a-z0-9_-]\\.fakefile\\b"],
  referralLinks: ["[?&](ref|aff)=[a-z0-9_-]+"],
  tradingPhrases: ["fake trade"],
  flagWords: ["fakeword", "where to look"],
});
const { cleaned, findFlags, findSecrets, noteFor } = await import("./patterns.mjs");

const SEALED = "AQx" + "Zk9_-a1B2c3D4e5F6g7H8i9J0".repeat(12);

test("an install link is found, with or without its scheme", () => {
  for (const text of [
    `my link https://subtitlesync.stream/${SEALED}/manifest.json does nothing`,
    `stremio://subtitlesync.stream/${SEALED}/manifest.json`,
    `subtitlesync.stream/${SEALED}/manifest.json`,
  ]) {
    const found = findSecrets(text);
    assert.equal(found.length, 1, text);
    assert.equal(found[0].kind, "link");
    assert.ok(!cleaned(text, found).includes(SEALED));
  }
});

test("a stream addon's link with its setup in the address is found", () => {
  const text = `AIOStreams: https://aiostreams.example.com/stremio/abc/${"eyJ0b3JyZW50aW8iOnRydWV9".repeat(4)}/manifest.json`;
  assert.deepEqual(findSecrets(text).map((f) => f.kind), ["link"]);
});

test("keys are found: Gemini old and new, TorBox, OpenSubtitles", () => {
  const gemini = "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q";
  const geminiNew = "AQ.Ab8RN6Lk2xq9Wv-Tz3mPq1Ys7Ue4Rd5Hf0Jc";
  const torbox = "1f2e3d4c-5b6a-4789-8a9b-0c1d2e3f4a5b";
  const opensubtitles = "Qw3rTy9UiOp1AsDf2GhJk4LzXcV5bNm7";
  const text = `gemini ${gemini}, new ${geminiNew}, torbox ${torbox}, os ${opensubtitles}`;
  const found = findSecrets(text);
  assert.deepEqual(found.map((f) => f.match).sort(), [gemini, geminiNew, torbox, opensubtitles].sort());
  const out = cleaned(text, found);
  for (const key of [gemini, geminiNew, torbox, opensubtitles]) assert.ok(!out.includes(key));
  assert.equal(out.split("[key removed]").length - 1, 4);
});

test("ordinary posts are left alone", () => {
  const text = [
    "Episode 3 of tt11605032 is out of sync by about 2 seconds on Stremio for Android TV.",
    "Support code 4249-0877-FD09, file hash 8e245d9679d31e12, commit 3399008c1f0a3b4e5d6c7b8a9f0e1d2c3b4a5f6e.",
    "See https://subtitlesync.stream/help and https://github.com/AleksaB98/subtitle-sync-for-stremio/discussions/12",
    "and https://www.opensubtitles.com/en/consumers for the key page.",
    "Antidisestablishmentarianismantidisestablishment is a long word.",
  ].join("\n");
  assert.deepEqual(findSecrets(text), []);
});

test("the note names the author and what was removed", () => {
  const note = noteFor("someone", [{ kind: "link", match: "x" }, { kind: "key", match: "y" }]);
  assert.match(note, /^@someone, your post had a link with your setup in it and a key/);
  assert.ok(!note.includes("—"));
  assert.match(note, /The rules: https:\/\/github\.com\/AleksaB98\/subtitle-sync-for-stremio\/blob\/main\/CODE_OF_CONDUCT\.md$/);
});

test("links to a listed site or file for getting videos are removed, with or without https://, whatever the domain ends in", () => {
  for (const link of ["https://fakeshare.org/film/123", "www.fakeshare.to", "fakeshare.example/x?y=1", "fs.mx/page", "fakelink:?id=abc&x=y", "Some.Film.2026.fakefile"]) {
    const text = `look here ${link} thanks`;
    const found = findSecrets(text);
    assert.deepEqual(found.map((f) => f.kind), ["piracy"], link);
    assert.equal(cleaned(text, found), "look here [link removed] thanks", link);
  }
  // A word that only contains a listed name, or a name without a domain, is left alone.
  assert.deepEqual(findSecrets("the fakeshares were fun, I asked fakeshare about it, and fs is short"), []);
  const note = noteFor("someone", findSecrets("fakeshare.org"));
  assert.match(note, /^@someone, your post had a link to a site or file for getting videos, which this place does not allow \(rule 2\)/);
  assert.ok(!note.includes("new keys"), "no key advice for a link that held none");
});

test("referral links are removed; words worth a look are only flagged", () => {
  const found = findSecrets("get it at https://service.example/plans?ref=abc123 now");
  assert.deepEqual(found.map((f) => f.kind), ["referral"]);
  assert.match(noteFor("x", found), /a referral link, which this place does not allow \(rule 4\)/);
  assert.deepEqual(findSecrets("Fakeword, where to look, a fake trade"), []);
  assert.deepEqual(findFlags("Fakeword, where to look, a FAKE TRADE, fakewords"), ["fakeword", "where to look", "fake trade"]);
  assert.deepEqual(findFlags("an ordinary question about timing"), []);
});

test("pictures uploaded to GitHub are not keys, though their links end in a UUID", () => {
  const uuid = "8c1d0b6a-3f2e-4d5c-9b8a-7e6f5d4c3b2a";
  for (const text of [
    `<img width="4080" height="3072" alt="17927608986002089210910904083092" src="https://github.com/user-attachments/assets/${uuid}" />`,
    `![screenshot](https://github.com/user-attachments/assets/${uuid})`,
    `see https://github.com/user-attachments/files/${uuid}/log.txt`,
    `https://private-user-images.githubusercontent.com/123/456-${uuid}.png?jwt=abc`,
    `https://user-images.githubusercontent.com/123/${uuid}.png`,
  ]) assert.deepEqual(findSecrets(text), [], text);
});

test("a UUID beside a GitHub picture, or on another site, is still a key", () => {
  const uuid = "8c1d0b6a-3f2e-4d5c-9b8a-7e6f5d4c3b2a";
  const torbox = "1f2e3d4c-5b6a-4789-8a9b-0c1d2e3f4a5b";
  const found = findSecrets(`![x](https://github.com/user-attachments/assets/${uuid}) my key ${torbox}`);
  assert.deepEqual(found.map((f) => f.match), [torbox]);
  assert.deepEqual(findSecrets(`https://example.com/user-attachments/assets/${torbox}`).map((f) => f.kind), ["key"]);
});
