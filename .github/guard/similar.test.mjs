import { test } from "node:test";
import assert from "node:assert/strict";
import { commentFor, similarDiscussions, stemsOf } from "./similar.mjs";

const d = (number, title, body, extra = {}) => ({ number, title, body, url: `https://github.com/x/y/discussions/${number}`, isAnswered: false, closed: false, ...extra });

const EARLIER = [
  d(3, "Subtitles two seconds late on Android TV", "Every subtitle is two seconds late on my Android TV.", { isAnswered: true }),
  d(5, "Self-hosting", "Make it possible to self-host the addon on a home server."),
  d(8, "No Serbian subtitles found for Dune", "It says no Serbian subtitles found.", { closed: true }),
];

test("the same thing in other words is found; something else is not", () => {
  assert.deepEqual(similarDiscussions({ title: "Subs are 2 sec late on my android tv", body: "Subs are 2 sec late, every line." }, EARLIER).map((x) => x.number), [3]);
  assert.deepEqual(similarDiscussions({ title: "Can I self host it at home?", body: "I would like to self host it on my home server." }, EARLIER).map((x) => x.number), [5]);
  assert.deepEqual(similarDiscussions({ title: "Bigger font", body: "Make the letters bigger in the player." }, EARLIER), []);
  assert.deepEqual(similarDiscussions({ title: "Croatian rows", body: "Croatian is missing from the languages." }, EARLIER), []);
  assert.ok(stemsOf("self-hosting").has("host"));
});

test("the comment lists them with their state and asks to continue there", () => {
  assert.equal(commentFor([EARLIER[0], EARLIER[2], EARLIER[1]]), [
    "These discussions look similar:",
    "- #3 Subtitles two seconds late on Android TV (answered)",
    "- #8 No Serbian subtitles found for Dune (closed)",
    "- #5 Self-hosting",
    "",
    "If one of them is the same, please continue there; this one may be closed as a duplicate.",
  ].join("\n"));
});
