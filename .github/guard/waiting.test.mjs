import { test } from "node:test";
import assert from "node:assert/strict";
import { waitingLines, waitsFor } from "./waiting.mjs";

const NOW = Date.parse("2026-10-21T10:00:00Z");
const ago = (hours) => new Date(NOW - hours * 3_600_000).toISOString();
const owner = "AleksaB98";
const comment = (login, hours, replies = []) => ({ author: { login }, createdAt: ago(hours), replies: { nodes: replies.map(([l, h]) => ({ author: { login: l }, createdAt: ago(h) })) } });
let number = 0;
const d = (title, hours, extra = {}) => ({
  title, url: `https://github.com/x/y/discussions/${++number}`, createdAt: ago(hours), category: { name: "Subtitle problems" }, answer: null,
  author: { login: "someone" }, labels: { nodes: [] }, comments: { nodes: [] }, ...extra,
});
const labelled = (name) => ({ labels: { nodes: [{ name }] } });

test("listed by state: new, the asker wrote after the owner, quiet in progress, needs info unanswered for a week; never a finished one, a reply on one neither", () => {
  number = 0;
  const lines = waitingLines([
    d("Fresh one", 5, labelled("new")),
    d("Old unlabelled", 50),
    d("Being looked at", 40, { ...labelled("in progress"), comments: { nodes: [comment(owner, 20)] } }),
    d("Quiet one", 120, { ...labelled("in progress"), comments: { nodes: [comment(owner, 100)] } }),
    d("Asked yesterday", 60, { ...labelled("needs info"), comments: { nodes: [comment(owner, 30)] } }),
    d("Never answered back", 300, { ...labelled("needs info"), comments: { nodes: [comment(owner, 200)] } }),
    d("Info came", 80, { ...labelled("needs info"), comments: { nodes: [comment(owner, 20, [["someone", 5]])] } }),
    d("Solved one", 40, { ...labelled("solved"), comments: { nodes: [comment(owner, 10)] } }),
    d("Came back", 90, { ...labelled("solved"), comments: { nodes: [comment(owner, 30), comment("someone", 3)] } }),
    d("Marked answer", 40, { answer: { id: "x" }, comments: { nodes: [comment(owner, 10)] } }),
    d("News", 70, { category: { name: "Announcements" } }),
    d("Owner's own", 70, { author: { login: owner } }),
    d("Planned idea", 400, { ...labelled("planned"), category: { name: "Suggestions" }, comments: { nodes: [comment(owner, 390)] } }),
  ], owner, NOW);
  assert.deepEqual(lines, [
    "- Never answered back (no answer for 8 days: close?, needs info, 12 days old): https://github.com/x/y/discussions/6",
    "- Quiet one (no update for 4 days, in progress, 5 days old): https://github.com/x/y/discussions/4",
    "- Info came (the asker wrote, needs info, 3 days old): https://github.com/x/y/discussions/7",
    "- Old unlabelled (new, 2 days old): https://github.com/x/y/discussions/2",
    "- Fresh one (new, new, 5 h old): https://github.com/x/y/discussions/1",
  ]);
});

test("a discussion still labelled new after an answer is named until its state is moved on", () => {
  assert.equal(waitsFor("new", [{ login: "someone", at: NOW - 50 * 3_600_000 }, { login: owner, at: NOW - 3_600_000 }], owner, NOW), "new");
  assert.equal(waitsFor(undefined, [{ login: "someone", at: NOW - 50 * 3_600_000 }, { login: owner, at: NOW - 3_600_000 }], owner, NOW), null);
});
