import { test } from "node:test";
import assert from "node:assert/strict";
import { cleaned, findSecrets, noteFor } from "./patterns.mjs";

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
});
