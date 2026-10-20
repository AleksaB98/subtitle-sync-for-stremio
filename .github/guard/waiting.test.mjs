import { test } from "node:test";
import assert from "node:assert/strict";
import { waitingLines } from "./waiting.mjs";

const NOW = Date.parse("2026-10-21T10:00:00Z");
const ago = (hours) => new Date(NOW - hours * 3_600_000).toISOString();
const d = (title, hours, extra = {}) => ({
  title, url: `https://github.com/x/y/discussions/${title.length}`, createdAt: ago(hours), category: { name: "Help" }, answer: null,
  author: { login: "someone" }, comments: { nodes: [] }, ...extra,
});

test("only discussions a day old or more, not announcements, unanswered and without the owner's reply are listed", () => {
  const owner = "AleksaB98";
  const lines = waitingLines([
    d("Waiting long", 50),
    d("Too new", 5),
    d("Answered", 30, { answer: { id: "x" } }),
    d("Owner replied", 30, { comments: { nodes: [{ author: { login: owner }, replies: { nodes: [] } }] } }),
    d("Owner replied in a thread", 30, { comments: { nodes: [{ author: { login: "other" }, replies: { nodes: [{ author: { login: owner } }] } }] } }),
    d("News", 70, { category: { name: "Announcements" } }),
    d("Owner's own", 70, { author: { login: owner } }),
    d("Others talking", 26, { comments: { nodes: [{ author: { login: "other" }, replies: { nodes: [] } }] } }),
  ], owner, NOW);
  assert.deepEqual(lines, [
    "- Waiting long (2 days): https://github.com/x/y/discussions/12",
    "- Others talking (26 h): https://github.com/x/y/discussions/14",
  ]);
});
