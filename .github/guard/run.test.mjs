import { test } from "node:test";
import assert from "node:assert/strict";

// Made-up lists, as in patterns.test.mjs: the real ones are private. GitHub is a stand-in here that keeps its
// discussions in memory, so a second run sees what the first left: nothing is asked of the real API, and nothing
// real is deleted.
process.env.GUARD_RULES = JSON.stringify({ piracySites: ["fakeshare"], piracyLinks: [], referralLinks: [], tradingPhrases: [], flagWords: ["fakeword"] });
const { runGuard, partsOf } = await import("./run.mjs");

const SEALED = "AQx" + "Zk9_-a1B2c3D4e5F6g7H8i9J0".repeat(12);
const LINK = `https://subtitlesync.stream/${SEALED}/manifest.json`;
const AT = "2026-11-05T10:00:00Z";
const LIMIT = 65_536;

/** GitHub in memory: discussions with their comments and replies; mutations change it, and can be made to fail. */
class FakeGitHub {
  constructor() {
    this.discussions = new Map();
    this.comments = new Map();
    this.next = 1;
    this.calls = [];
    this.failures = [];
  }
  /** The next `times` calls of `mutation` fail (once a matching call has failed it no longer does). */
  fail(mutation, times = 1, when = () => true) {
    this.failures.push({ mutation, times, when });
  }
  discussion(title, body, comments = [], answer = null) {
    const id = `D${this.next++}`;
    this.discussions.set(id, { id, title, body, createdAt: this.next, commentIds: [], answer });
    for (const c of comments) this.addComment(id, null, c.body, c.author);
    if (answer !== null) this.discussions.get(id).answer = this.discussions.get(id).commentIds[answer];
    return id;
  }
  addComment(discussionId, replyTo, body, author = "bot") {
    const id = `K${this.next++}`;
    this.comments.set(id, { id, discussionId, replyTo, body, author, createdAt: AT, replyIds: [] });
    if (replyTo) this.comments.get(replyTo).replyIds.push(id);
    else this.discussions.get(discussionId).commentIds.push(id);
    return id;
  }
  /** Every text GitHub holds now, outside the given discussion ids. */
  textsOf(discussionId) {
    const d = this.discussions.get(discussionId);
    const all = [d.body];
    for (const id of d.commentIds) {
      const c = this.comments.get(id);
      all.push(c.body, ...c.replyIds.map((r) => this.comments.get(r).body));
    }
    return all.join("\n");
  }
  replacementOf(originalId) {
    return [...this.discussions.values()].find((d) => d.body.includes(`guard:replaces ${originalId} part 1/`));
  }
  page(list, after, size = 100) {
    const from = after === null || after === undefined ? 0 : Number(after);
    return { slice: list.slice(from, from + size), pageInfo: { hasNextPage: from + size < list.length, endCursor: String(from + size) } };
  }
  replyNodes(ids) {
    return ids.map((r) => { const c = this.comments.get(r); return { author: { login: c.author }, createdAt: c.createdAt, body: c.body }; });
  }
  graphql = async (query, variables) => {
    this.calls.push({ query, variables });
    const mutation = /(\w+)\(input/.exec(query)?.[1];
    const failing = mutation && this.failures.find((f) => f.mutation === mutation && f.times > 0 && f.when(variables));
    if (failing) {
      failing.times--;
      throw new Error(`GitHub answered 502 for ${mutation}`);
    }
    if (query.includes("on Discussion { title body answer")) {
      const d = this.discussions.get(variables.id);
      return { node: d ? { title: d.title, body: d.body, answer: d.answer ? { id: d.answer } : null } : null };
    }
    if (query.includes("comments(first: 100, after: $after)")) {
      const d = this.discussions.get(variables.id);
      if (!d) return { node: null };
      const { slice, pageInfo } = this.page(d.commentIds, variables.after);
      const nodes = slice.map((id) => {
        const c = this.comments.get(id);
        const first = this.page(c.replyIds, null);
        return { id, author: { login: c.author }, createdAt: c.createdAt, body: c.body, replies: { pageInfo: first.pageInfo, nodes: this.replyNodes(first.slice) } };
      });
      return { node: { comments: { pageInfo, nodes } } };
    }
    if (query.includes("replies(first: 100, after: $after)")) {
      const c = this.comments.get(variables.id);
      const { slice, pageInfo } = this.page(c.replyIds, variables.after);
      return { node: { replies: { pageInfo, nodes: this.replyNodes(slice) } } };
    }
    if (query.includes("on DiscussionComment { body replyTo")) {
      const c = this.comments.get(variables.id);
      if (!c) return { node: null };
      const first = this.page(c.replyIds, null);
      return { node: { body: c.body, replyTo: c.replyTo ? { id: c.replyTo } : null, replies: { pageInfo: first.pageInfo, nodes: this.replyNodes(first.slice) } } };
    }
    if (query.includes("discussions(first: 25")) {
      const nodes = [...this.discussions.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 25).map((d) => ({ id: d.id, body: d.body }));
      return { repository: { discussions: { nodes } } };
    }
    if (mutation === "createDiscussion") {
      assert.ok(variables.body.length <= LIMIT, `a new discussion of ${variables.body.length} characters`);
      return { createDiscussion: { discussion: { id: this.discussion(variables.title, variables.body), number: 2 } } };
    }
    if (mutation === "addDiscussionComment") {
      assert.ok(variables.body.length <= LIMIT, `a new reply of ${variables.body.length} characters`);
      if (!this.discussions.has(variables.d)) throw new Error("GitHub answered NOT_FOUND");
      return { addDiscussionComment: { comment: { id: this.addComment(variables.d, variables.r, variables.body) } } };
    }
    if (mutation === "deleteDiscussion") {
      const d = this.discussions.get(variables.id);
      for (const id of d.commentIds) this.comments.delete(id);
      this.discussions.delete(variables.id);
      return {};
    }
    if (mutation === "deleteDiscussionComment") {
      const c = this.comments.get(variables.id);
      const d = this.discussions.get(c.discussionId);
      d.commentIds = d.commentIds.filter((id) => id !== variables.id);
      if (c.replyTo) {
        const parent = this.comments.get(c.replyTo);
        parent.replyIds = parent.replyIds.filter((id) => id !== variables.id);
      }
      this.comments.delete(variables.id);
      return {};
    }
    if (query.includes('label(name: "new")')) return { repository: { label: { id: "L-new" } } };
    if (mutation === "addLabelsToLabelable") return {};
    throw new Error(`the stand-in does not know: ${query.slice(0, 80)}`);
  };
}

const repository = { node_id: "R1", name: "docs", owner: { login: "owner" } };
const discussionEvent = (gh, id) => {
  const d = gh.discussions.get(id);
  return { repository, discussion: { node_id: id, title: d.title, body: d.body, user: { login: "asker" }, category: { node_id: "C1", name: "Setup help" } } };
};
const replyEvent = (gh, discussionId, commentId) => ({ repository, discussion: { node_id: discussionId }, comment: { node_id: commentId, body: gh.comments.get(commentId).body, user: { login: "replier" } } });
const quiet = () => undefined;
const count = (gh, mutation) => gh.calls.filter((c) => c.query.includes(`${mutation}(input`)).length;

/** Every reply's words, and the post's own, are in the replacement: nothing anyone else wrote is lost. */
function assertAllCarried(gh, originalId, texts) {
  const replacement = gh.replacementOf(originalId);
  assert.ok(replacement, "a replacement exists");
  const all = gh.textsOf(replacement.id);
  for (const text of texts) for (const line of text.split("\n")) assert.ok(all.includes(line), `carried: ${line.slice(0, 60)}`);
  assert.doesNotMatch(all, new RegExp(SEALED));
}

test("PUB-001: a discussion of 101 replies, one of them with 101 of its own, is carried over whole, the answer marked", async () => {
  const gh = new FakeGitHub();
  const comments = Array.from({ length: 101 }, (_, i) => ({ body: `comment number ${i}`, author: `u${i}` }));
  const id = gh.discussion("Help", `my link ${LINK}`, comments, 100);
  const first = gh.discussions.get(id).commentIds[0];
  for (let k = 0; k < 101; k++) gh.addComment(id, first, `reply number ${k}`, `r${k}`);
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assert.equal(gh.discussions.has(id), false, "the original is gone");
  assertAllCarried(gh, id, [...comments.map((c) => c.body), ...Array.from({ length: 101 }, (_, k) => `reply number ${k}`)]);
  assert.match(gh.textsOf(gh.replacementOf(id).id), /\*\*@u100\*\*, 2026-11-05 \(marked as the answer\)/);
});

test("PUB-001: a page that cannot be read posts nothing and deletes nothing", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", `my link ${LINK}`, Array.from({ length: 150 }, (_, i) => ({ body: `c${i}`, author: "u" })));
  const read = gh.graphql;
  gh.graphql = async (query, variables) => {
    if (query.includes("comments(first: 100, after: $after)") && variables.after === "100") throw new Error("GitHub answered 502");
    return read(query, variables);
  };
  await assert.rejects(runGuard(discussionEvent(gh, id), gh.graphql, quiet), /502/);
  assert.equal(count(gh, "createDiscussion") + count(gh, "deleteDiscussion"), 0);
  assert.ok(gh.discussions.has(id));
});

test("PUB-002: a discussion cleaned by its author while the run waited is left alone; one still holding it is posted as it is now", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", `my link ${LINK}`);
  const event = discussionEvent(gh, id);
  gh.discussions.get(id).body = "my link (removed it, sorry). Also: it was the TV app.";
  assert.equal(await runGuard(event, gh.graphql, quiet), "since-cleaned");
  assert.ok(gh.discussions.has(id));
  gh.discussions.get(id).body = `my link ${LINK}\nUpdate: it is the TV app.`;
  gh.discussions.get(id).title = "Help, edited";
  assert.equal(await runGuard(event, gh.graphql, quiet), "removed");
  const replacement = gh.replacementOf(id);
  assert.equal(replacement.title, "Help, edited");
  assert.match(replacement.body, /Update: it is the TV app\./);
});

test("review: an oversized post is posted again whole, in parts each within GitHub's limit, before the original goes", async () => {
  const gh = new FakeGitHub();
  // Near the limit itself (65,000 characters of numbered lines): with the note it no longer fits in one post.
  const lines = Array.from({ length: 2_600 }, (_, i) => `line ${String(i).padStart(5, "0")} of a very long post .....`);
  const id = gh.discussion("Long", `${LINK}\n${lines.join("\n")}`);
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assertAllCarried(gh, id, lines);
  assert.ok(count(gh, "addDiscussionComment") >= 1, "the rest went on in a part of its own");
});

test("review: an oversized conversation is carried whole: 40 long replies and one longer than a post can be", async () => {
  const gh = new FakeGitHub();
  const replies = Array.from({ length: 40 }, (_, i) => ({ body: `reply ${i}\n${"words of the reply ".repeat(150)}`, author: `u${i}` }));
  const huge = Array.from({ length: 2_000 }, (_, i) => `huge reply line ${i} with some words in it`).join("\n");
  replies.push({ body: huge, author: "long-writer" });
  const id = gh.discussion("Help", `my link ${LINK}`, replies);
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assertAllCarried(gh, id, replies.map((r) => r.body));
});

test("review: a part GitHub refuses stops the run with nothing deleted; the next run posts only what is missing", async () => {
  const gh = new FakeGitHub();
  const replies = Array.from({ length: 60 }, (_, i) => ({ body: `reply ${i}\n${"words ".repeat(400)}`, author: `u${i}` }));
  const id = gh.discussion("Help", `my link ${LINK}`, replies);
  const parts = partsOf("x", replies.map((r) => r.body)).length;
  assert.ok(parts >= 3, `${parts} parts`);
  // The third part is refused.
  gh.fail("addDiscussionComment", 1, (v) => v.body.includes(" part 3/"));
  await assert.rejects(runGuard(discussionEvent(gh, id), gh.graphql, quiet), /502/);
  assert.ok(gh.discussions.has(id), "the original and its replies stay");
  assert.equal(count(gh, "deleteDiscussion"), 0);
  // The next run (a retry, or the next edit's): the replacement is recognised, nothing is posted twice.
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assert.equal(count(gh, "createDiscussion"), 1, "one replacement");
  const replacement = gh.replacementOf(id);
  const partsPosted = [replacement.body, ...replacement.commentIds.map((c) => gh.comments.get(c).body)].map((b) => /part (\d+)\//.exec(b)?.[1]);
  assert.deepEqual([...partsPosted].sort(), [...new Set(partsPosted)].sort(), "each part once");
  assertAllCarried(gh, id, replies.map((r) => r.body));
});

test("review: the replacement made and the delete refused: the retry deletes, and posts nothing again", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", `my link ${LINK}`, [{ body: "the fix", author: "helper" }]);
  gh.fail("deleteDiscussion");
  await assert.rejects(runGuard(discussionEvent(gh, id), gh.graphql, quiet), /502/);
  assert.ok(gh.discussions.has(id) && gh.replacementOf(id));
  const posts = count(gh, "createDiscussion") + count(gh, "addDiscussionComment");
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assert.equal(count(gh, "createDiscussion") + count(gh, "addDiscussionComment"), posts, "nothing posted twice");
  assert.equal(gh.discussions.has(id), false);
  assertAllCarried(gh, id, ["the fix"]);
});

test("review: a reply, its own replies carried along; refused delete, then the retry: posted once, in the same place", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", "a question");
  const parent = gh.addComment(id, null, "an answer", "helper");
  const reply = gh.addComment(id, parent, `here ${LINK} and one more thing`, "replier");
  gh.fail("deleteDiscussionComment");
  await assert.rejects(runGuard(replyEvent(gh, id, reply), gh.graphql, quiet), /502/);
  assert.equal(await runGuard(replyEvent(gh, id, reply), gh.graphql, quiet), "removed");
  assert.equal(count(gh, "addDiscussionComment"), 1, "posted once");
  const now = gh.comments.get(parent).replyIds.map((r) => gh.comments.get(r).body);
  assert.equal(now.length, 1, "under the same reply as before, the original gone");
  assert.match(now[0], /and one more thing/);
  assert.doesNotMatch(now[0], new RegExp(SEALED));
  // A top-level reply with answers of its own: theirs are carried too.
  const top = gh.addComment(id, null, `see ${LINK}`, "replier");
  gh.addComment(id, top, "thanks, that worked", "asker");
  assert.equal(await runGuard(replyEvent(gh, id, top), gh.graphql, quiet), "removed");
  assert.match(gh.textsOf(id), /> thanks, that worked/);
});

test("review: run again after it worked, or for a reply whose discussion another run took down: nothing posted", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", `my link ${LINK}`);
  const event = discussionEvent(gh, id);
  const reply = gh.addComment(id, null, `also ${LINK}`, "replier");
  const orphan = replyEvent(gh, id, reply);
  assert.equal(await runGuard(event, gh.graphql, quiet), "removed");
  const posts = count(gh, "createDiscussion") + count(gh, "addDiscussionComment");
  assert.equal(await runGuard(event, gh.graphql, quiet), "gone");
  assert.equal(await runGuard(orphan, gh.graphql, quiet), "gone");
  assert.equal(count(gh, "createDiscussion") + count(gh, "addDiscussionComment"), posts);
});
