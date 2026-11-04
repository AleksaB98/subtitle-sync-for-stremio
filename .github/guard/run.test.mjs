import { test } from "node:test";
import assert from "node:assert/strict";

// Made-up lists, as in patterns.test.mjs: the real ones are private. GitHub is a stand-in here: nothing is asked
// of the real API, and nothing real is deleted.
process.env.GUARD_RULES = JSON.stringify({ piracySites: ["fakeshare"], piracyLinks: [], referralLinks: [], tradingPhrases: [], flagWords: ["fakeword"] });
const { runGuard } = await import("./run.mjs");

const SEALED = "AQx" + "Zk9_-a1B2c3D4e5F6g7H8i9J0".repeat(12);
const LINK = `https://subtitlesync.stream/${SEALED}/manifest.json`;
const at = "2026-11-05T10:00:00Z";
const reply = (n, body = `reply ${n}`) => ({ author: { login: `r${n}` }, createdAt: at, body });

/** GitHub as the guard sees it: a discussion now saying `now`, with `comments`, every page served `perPage` at a time. */
function stand(discussionNow, comments, options = {}) {
  const calls = [];
  const perPage = 100;
  const graphql = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes("on Discussion { title body answer")) return { node: discussionNow };
    if (query.includes("comments(first: 100")) {
      const from = variables.after === null ? 0 : Number(variables.after);
      if (options.failPage !== undefined && from === options.failPage) throw new Error("GitHub answered 502");
      const nodes = comments.slice(from, from + perPage).map((c) => ({
        id: c.id, author: c.author, createdAt: c.createdAt, body: c.body,
        replies: { pageInfo: { hasNextPage: c.replies.length > perPage, endCursor: String(perPage) }, nodes: c.replies.slice(0, perPage) },
      }));
      return { node: { comments: { pageInfo: { hasNextPage: from + perPage < comments.length, endCursor: String(from + perPage) }, nodes } } };
    }
    if (query.includes("on DiscussionComment {\n            replies(first: 100, after")) {
      const c = comments.find((one) => one.id === variables.id);
      const from = Number(variables.after);
      return { node: { replies: { pageInfo: { hasNextPage: from + perPage < c.replies.length, endCursor: String(from + perPage) }, nodes: c.replies.slice(from, from + perPage) } } };
    }
    if (query.includes("on DiscussionComment { body replyTo")) return { node: options.commentNow ?? null };
    if (query.includes("createDiscussion")) return { createDiscussion: { discussion: { id: "D2", number: 2 } } };
    if (query.includes('label(name: "new")')) return { repository: { label: null } };
    return {};
  };
  const did = (word) => calls.filter((c) => c.query.includes(word));
  return { graphql, calls, did };
}

const repository = { node_id: "R1", name: "docs", owner: { login: "owner" } };
const discussionEvent = (title, body) => ({ repository, discussion: { node_id: "D1", title, body, user: { login: "asker" }, category: { node_id: "C1", name: "Setup help" } } });
const quiet = () => undefined;

test("PUB-001: a discussion of 101 replies, one of them with 101 of its own, is carried over whole", async () => {
  const comments = Array.from({ length: 101 }, (_, i) => ({
    id: `c${i}`, author: { login: `u${i}` }, createdAt: at, body: `comment ${i}`,
    replies: i === 0 ? Array.from({ length: 101 }, (_, k) => reply(k)) : [],
  }));
  const gh = stand({ title: "Help", body: `my link ${LINK}`, answer: { id: "c100" } }, comments);
  assert.equal(await runGuard(discussionEvent("Help", `my link ${LINK}`), gh.graphql, quiet), "removed");
  const made = gh.did("createDiscussion")[0].variables.body;
  assert.match(made, /comment 0\b/);
  assert.match(made, /comment 100\b/, "the second page of replies");
  assert.match(made, /\*\*@u100\*\*, 2026-11-05 \(marked as the answer\)/);
  assert.match(made, /> reply 100\b/, "the second page of a reply's replies");
  assert.doesNotMatch(made, new RegExp(SEALED));
  // Read whole before anything was deleted.
  const deleted = gh.calls.findIndex((c) => c.query.includes("deleteDiscussion"));
  const lastRead = gh.calls.map((c) => c.query.includes("comments(first: 100") || c.query.includes("replies(first: 100, after")).lastIndexOf(true);
  assert.ok(lastRead < deleted);
});

test("PUB-001: a page that cannot be read deletes nothing", async () => {
  const comments = Array.from({ length: 150 }, (_, i) => ({ id: `c${i}`, author: { login: `u${i}` }, createdAt: at, body: `comment ${i}`, replies: [] }));
  const gh = stand({ title: "Help", body: `my link ${LINK}`, answer: null }, comments, { failPage: 100 });
  await assert.rejects(runGuard(discussionEvent("Help", `my link ${LINK}`), gh.graphql, quiet), /502/);
  assert.equal(gh.did("deleteDiscussion").length, 0);
});

test("PUB-002: a discussion cleaned by its author while the run waited is left alone", async () => {
  const gh = stand({ title: "Help", body: "my link (removed it, sorry). Also: it was the TV app.", answer: null }, []);
  assert.equal(await runGuard(discussionEvent("Help", `my link ${LINK}`), gh.graphql, quiet), "since-cleaned");
  assert.equal(gh.did("deleteDiscussion").length, 0);
  assert.equal(gh.did("createDiscussion").length, 0);
});

test("PUB-002: what is posted again is the discussion as it is now, not as the event had it", async () => {
  const gh = stand({ title: "Help, edited", body: `my link ${LINK}\nUpdate: it is the TV app.`, answer: null }, []);
  assert.equal(await runGuard(discussionEvent("Help", `my link ${LINK}`), gh.graphql, quiet), "removed");
  const made = gh.did("createDiscussion")[0].variables;
  assert.equal(made.title, "Help, edited");
  assert.match(made.body, /Update: it is the TV app\./);
  assert.doesNotMatch(made.body, new RegExp(SEALED));
});

test("PUB-002: a reply cleaned meanwhile is left alone; one that still holds it is posted again as it is now", async () => {
  const event = { repository, discussion: { node_id: "D1" }, comment: { node_id: "K1", body: `here ${LINK}`, user: { login: "replier" } } };
  const clean = stand(null, [], { commentNow: { body: "here (removed)", replyTo: null } });
  assert.equal(await runGuard(event, clean.graphql, quiet), "since-cleaned");
  assert.equal(clean.did("deleteDiscussionComment").length, 0);
  const still = stand(null, [], { commentNow: { body: `here ${LINK} and one more thing`, replyTo: { id: "K0" } } });
  assert.equal(await runGuard(event, still.graphql, quiet), "removed");
  const posted = still.did("addDiscussionComment")[0].variables;
  assert.equal(posted.r, "K0");
  assert.match(posted.body, /and one more thing/);
  assert.doesNotMatch(posted.body, new RegExp(SEALED));
});
