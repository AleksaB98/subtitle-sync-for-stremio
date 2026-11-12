import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

// Made-up lists, as in patterns.test.mjs: the real ones are private. GitHub is a stand-in here that keeps its
// discussions in memory, so a second run sees what the first left: nothing is asked of the real API, and nothing
// real is deleted.
process.env.GUARD_RULES = JSON.stringify({ piracySites: ["fakeshare"], piracyLinks: [], referralLinks: [], tradingPhrases: [], flagWords: ["fakeword"] });
const { runGuard, partsOf, GuardStop } = await import("./run.mjs");

const SEALED = "AQx" + "Zk9_-a1B2c3D4e5F6g7H8i9J0".repeat(12);
const LINK = `https://subtitlesync.stream/${SEALED}/manifest.json`;
const AT = "2026-11-05T10:00:00Z";
const LIMIT = 65_536;

afterEach(() => {
  delete process.env.GUARD_LOOKUP_PAGES;
});

/**
 * Who posts. What the workflow's token posts is the bot GitHub reports as author Bot, login "github-actions",
 * databaseId 41898282 (as on the repository's discussion #12, posted by this guard); everyone else is a User.
 */
const BOT = Object.freeze({ __typename: "Bot", login: "github-actions", databaseId: 41898282 });
const person = (login) => ({ __typename: "User", login });
const actor = (who) => (typeof who === "string" ? person(who) : who);

/** GitHub in memory: discussions with their comments and replies; mutations change it, and can be made to fail. */
class FakeGitHub {
  constructor() {
    this.discussions = new Map();
    this.comments = new Map();
    this.next = 1;
    this.calls = [];
    this.failures = [];
    this.after = [];
  }
  /** The next `times` calls of `mutation` (matching `when`) fail. */
  fail(mutation, times = 1, when = () => true) {
    this.failures.push({ mutation, times, when });
  }
  /** Once, right after a matching mutation succeeds: `change` runs (someone editing meanwhile). */
  afterMutation(mutation, change, when = () => true) {
    this.after.push({ mutation, change, when, done: false });
  }
  discussion(title, body, comments = [], answer = null, author = "asker") {
    const id = `D${this.next++}`;
    this.discussions.set(id, { id, title, body, author: actor(author), createdAt: this.next, commentIds: [], answer: null });
    for (const c of comments) this.addComment(id, null, c.body, c.author);
    if (answer !== null) this.discussions.get(id).answer = this.discussions.get(id).commentIds[answer];
    return id;
  }
  addComment(discussionId, replyTo, body, author = "someone") {
    const id = `K${this.next++}`;
    this.comments.set(id, { id, discussionId, replyTo, body, author: actor(author), createdAt: AT, replyIds: [] });
    if (replyTo) this.comments.get(replyTo).replyIds.push(id);
    else this.discussions.get(discussionId).commentIds.push(id);
    return id;
  }
  /** Every text a discussion holds now: its body, its replies and theirs. */
  textsOf(discussionId) {
    const d = this.discussions.get(discussionId);
    const all = [d.body];
    for (const id of d.commentIds) {
      const c = this.comments.get(id);
      all.push(c.body, ...c.replyIds.map((r) => this.comments.get(r).body));
    }
    return all.join("\n");
  }
  /** The workflow's own copies of a discussion (anyone else's lookalikes left out). */
  copiesOf(originalId) {
    return [...this.discussions.values()].filter((d) => d.author === BOT && d.body.includes(`guard:replaces ${originalId} part 1/`));
  }
  /** An author as GitHub would answer it: none at all when the test says GitHub gives none. */
  shown(author) {
    return this.hideAuthors ? null : author;
  }
  page(list, after, size = 100) {
    const from = after === null || after === undefined ? 0 : Number(after);
    return { slice: list.slice(from, from + size), pageInfo: { hasNextPage: from + size < list.length, endCursor: String(from + size) } };
  }
  replyNodes(ids) {
    return ids.map((r) => { const c = this.comments.get(r); return { id: r, author: this.shown(c.author), createdAt: c.createdAt, body: c.body }; });
  }
  graphql = async (query, variables) => {
    this.calls.push({ query, variables });
    const mutation = /(\w+)\(input/.exec(query)?.[1];
    const failing = mutation && this.failures.find((f) => f.mutation === mutation && f.times > 0 && f.when(variables));
    if (failing) {
      failing.times--;
      throw new Error(`GitHub answered 502 for ${mutation}`);
    }
    const answer = await this.answer(query, variables, mutation);
    for (const hook of this.after) {
      if (!hook.done && hook.mutation === mutation && hook.when(variables)) {
        hook.done = true;
        hook.change(this);
        break;
      }
    }
    return answer;
  };
  async answer(query, variables, mutation) {
    if (query.includes("on Discussion { title body answer")) {
      const d = this.discussions.get(variables.id);
      return { node: d ? { title: d.title, body: d.body, answer: d.answer ? { id: d.answer } : null } : null };
    }
    if (query.includes("on Discussion { title body author")) {
      const d = this.discussions.get(variables.id);
      return { node: d ? { title: d.title, body: d.body, author: this.shown(d.author) } : null };
    }
    if (query.includes("comments(first: 100, after: $after)")) {
      const d = this.discussions.get(variables.id);
      if (!d) return { node: null };
      const { slice, pageInfo } = this.page(d.commentIds, variables.after);
      const nodes = slice.map((id) => {
        const c = this.comments.get(id);
        const first = this.page(c.replyIds, null);
        return { id, author: this.shown(c.author), createdAt: c.createdAt, body: c.body, replies: { pageInfo: first.pageInfo, nodes: this.replyNodes(first.slice) } };
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
    if (query.includes("discussions(first: 100, after: $after")) {
      if (this.discussionsRefused) throw new Error("GitHub answered 502");
      const all = [...this.discussions.values()].sort((a, b) => b.createdAt - a.createdAt);
      const { slice, pageInfo } = this.page(all, variables.after);
      return { repository: { discussions: { pageInfo, nodes: slice.map((d) => ({ id: d.id, title: d.title, body: d.body, author: this.shown(d.author) })) } } };
    }
    if (mutation === "createDiscussion") {
      assert.ok(variables.body.length <= LIMIT, `a new discussion of ${variables.body.length} characters`);
      return { createDiscussion: { discussion: { id: this.discussion(variables.title, variables.body, [], null, BOT), number: 2 } } };
    }
    if (mutation === "addDiscussionComment") {
      assert.ok(variables.body.length <= LIMIT, `a new reply of ${variables.body.length} characters`);
      if (!this.discussions.has(variables.d)) throw new Error("GitHub answered NOT_FOUND");
      return { addDiscussionComment: { comment: { id: this.addComment(variables.d, variables.r, variables.body, BOT) } } };
    }
    if (mutation === "deleteDiscussion") {
      const d = this.discussions.get(variables.id);
      if (!d) throw new Error("GitHub answered NOT_FOUND");
      for (const id of d.commentIds) this.comments.delete(id);
      this.discussions.delete(variables.id);
      return {};
    }
    if (mutation === "deleteDiscussionComment") {
      const c = this.comments.get(variables.id);
      if (!c) throw new Error("GitHub answered NOT_FOUND");
      const d = this.discussions.get(c.discussionId);
      d.commentIds = d.commentIds.filter((id) => id !== variables.id);
      if (c.replyTo && this.comments.has(c.replyTo)) {
        const parent = this.comments.get(c.replyTo);
        parent.replyIds = parent.replyIds.filter((id) => id !== variables.id);
      }
      // What GitHub does with a deleted reply's own replies is not known here: this stand-in keeps them (in its
      // list) so that a test can see whether the guard counted on either.
      this.comments.delete(variables.id);
      return {};
    }
    if (query.includes('label(name: "new")')) return { repository: { label: { id: "L-new" } } };
    if (mutation === "addLabelsToLabelable") return {};
    throw new Error(`the stand-in does not know: ${query.slice(0, 80)}`);
  }
}

const repository = { node_id: "R1", name: "docs", owner: { login: "owner" } };
const discussionEvent = (gh, id) => {
  const d = gh.discussions.get(id);
  return { repository, discussion: { node_id: id, title: d.title, body: d.body, user: { login: "asker" }, category: { node_id: "C1", name: "Setup help" } } };
};
const replyEvent = (gh, discussionId, commentId) => ({ repository, discussion: { node_id: discussionId }, comment: { node_id: commentId, body: gh.comments.get(commentId).body, user: { login: "replier" } } });
const quiet = () => undefined;
const count = (gh, mutation) => gh.calls.filter((c) => c.query.includes(`${mutation}(input`)).length;

/** The one copy of the discussion `originalId`: each part in it once, and every line of `texts` in it; no link. */
function assertOneWholeCopy(gh, originalId, texts) {
  const copies = gh.copiesOf(originalId);
  assert.equal(copies.length, 1, "one copy");
  const copy = copies[0];
  // The workflow's own parts only: anyone's lookalike in the copy is no part.
  const own = copy.commentIds.map((c) => gh.comments.get(c)).filter((c) => c.author === BOT).map((c) => c.body);
  const marks = [copy.body, ...own].map((b) => /part (\d+)\/(\d+)/.exec(b)).filter(Boolean);
  const numbers = marks.map((m) => Number(m[1])).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: Number(marks[0][2]) }, (_, i) => i + 1), "each part once");
  const all = gh.textsOf(copy.id);
  for (const text of texts) for (const line of text.split("\n")) assert.ok(all.includes(line), `carried: ${line.slice(0, 60)}`);
  assert.doesNotMatch(all, new RegExp(SEALED));
  return all;
}

test("a discussion of 101 replies, one of them with 101 of its own, is carried over whole, the answer marked", async () => {
  const gh = new FakeGitHub();
  const comments = Array.from({ length: 101 }, (_, i) => ({ body: `comment number ${i}`, author: `u${i}` }));
  const id = gh.discussion("Help", `my link ${LINK}`, comments, 100);
  const first = gh.discussions.get(id).commentIds[0];
  for (let k = 0; k < 101; k++) gh.addComment(id, first, `reply number ${k}`, `r${k}`);
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assert.equal(gh.discussions.has(id), false, "the original is gone");
  const all = assertOneWholeCopy(gh, id, [...comments.map((c) => c.body), ...Array.from({ length: 101 }, (_, k) => `reply number ${k}`)]);
  assert.match(all, /\*\*@u100\*\*, 2026-11-05 \(marked as the answer\)/);
});

test("a page that cannot be read posts nothing and deletes nothing", async () => {
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

test("a discussion cleaned by its author while the run waited is left alone; one still holding it is posted as it is now", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", `my link ${LINK}`);
  const event = discussionEvent(gh, id);
  gh.discussions.get(id).body = "my link (removed it, sorry). Also: it was the TV app.";
  assert.equal(await runGuard(event, gh.graphql, quiet), "since-cleaned");
  assert.ok(gh.discussions.has(id));
  gh.discussions.get(id).body = `my link ${LINK}\nUpdate: it is the TV app.`;
  gh.discussions.get(id).title = "Help, edited";
  assert.equal(await runGuard(event, gh.graphql, quiet), "removed");
  assert.equal(gh.copiesOf(id)[0].title, "Help, edited");
  assertOneWholeCopy(gh, id, ["Update: it is the TV app."]);
});

test("an oversized post is posted again whole, in parts each within GitHub's limit, before the original goes", async () => {
  const gh = new FakeGitHub();
  const lines = Array.from({ length: 2_600 }, (_, i) => `line ${String(i).padStart(5, "0")} of a very long post .....`);
  const id = gh.discussion("Long", `${LINK}\n${lines.join("\n")}`);
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assertOneWholeCopy(gh, id, lines);
});

test("an oversized conversation is carried whole: 40 long replies and one longer than a post can be", async () => {
  const gh = new FakeGitHub();
  const replies = Array.from({ length: 40 }, (_, i) => ({ body: `reply ${i}\n${"words of the reply ".repeat(150)}`, author: `u${i}` }));
  replies.push({ body: Array.from({ length: 2_000 }, (_, i) => `huge reply line ${i} with some words in it`).join("\n"), author: "long-writer" });
  const id = gh.discussion("Help", `my link ${LINK}`, replies);
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assertOneWholeCopy(gh, id, replies.map((r) => r.body));
});

test("a part GitHub refuses stops the run with nothing deleted; the next run posts only what is missing", async () => {
  const gh = new FakeGitHub();
  const replies = Array.from({ length: 60 }, (_, i) => ({ body: `reply ${i}\n${"words ".repeat(400)}`, author: `u${i}` }));
  const id = gh.discussion("Help", `my link ${LINK}`, replies);
  assert.ok(partsOf("x", replies.map((r) => r.body)).length >= 3);
  gh.fail("addDiscussionComment", 1, (v) => v.body.includes(" part 3/"));
  await assert.rejects(runGuard(discussionEvent(gh, id), gh.graphql, quiet), /502/);
  assert.ok(gh.discussions.has(id), "the original and its replies stay");
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assert.equal(count(gh, "createDiscussion"), 1, "one replacement");
  assertOneWholeCopy(gh, id, replies.map((r) => r.body));
});

test("the replacement made and the delete refused: the retry deletes, and posts nothing again", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", `my link ${LINK}`, [{ body: "the fix", author: "helper" }]);
  gh.fail("deleteDiscussion", 1, (v) => v.id === id);
  await assert.rejects(runGuard(discussionEvent(gh, id), gh.graphql, quiet), /502/);
  const posts = count(gh, "createDiscussion") + count(gh, "addDiscussionComment");
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assert.equal(count(gh, "createDiscussion") + count(gh, "addDiscussionComment"), posts, "nothing posted twice");
  assert.equal(gh.discussions.has(id), false);
  assertOneWholeCopy(gh, id, ["the fix"]);
});

test("handoff: a copy that has fallen out of the 25 newest discussions (130 newer) is still found: no second copy", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", `my link ${LINK}`, [{ body: "the fix", author: "helper" }]);
  gh.fail("deleteDiscussion", 1, (v) => v.id === id);
  await assert.rejects(runGuard(discussionEvent(gh, id), gh.graphql, quiet), /502/);
  for (let i = 0; i < 130; i++) gh.discussion(`Newer ${i}`, "a question");
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assert.equal(count(gh, "createDiscussion"), 1);
  assertOneWholeCopy(gh, id, ["the fix"]);
});

test("handoff: when the discussions cannot all be looked through, nothing is posted and nothing deleted", async () => {
  // A page refused.
  const refused = new FakeGitHub();
  const a = refused.discussion("Help", `my link ${LINK}`);
  refused.discussionsRefused = true;
  await assert.rejects(runGuard(discussionEvent(refused, a), refused.graphql, quiet), /502/);
  assert.equal(count(refused, "createDiscussion") + count(refused, "deleteDiscussion"), 0);
  // More discussions than the search may read.
  process.env.GUARD_LOOKUP_PAGES = "1";
  const many = new FakeGitHub();
  const b = many.discussion("Help", `my link ${LINK}`);
  for (let i = 0; i < 150; i++) many.discussion(`Newer ${i}`, "a question");
  await assert.rejects(runGuard(discussionEvent(many, b), many.graphql, quiet), (error) => error instanceof GuardStop && /could not be told/.test(error.message));
  assert.equal(count(many, "createDiscussion") + count(many, "deleteDiscussion"), 0);
  assert.ok(many.discussions.has(b));
});

test("handoff: the post and its replies changed after part of a copy was made: the older copy is replaced, the newest words carried", async () => {
  const gh = new FakeGitHub();
  const replies = Array.from({ length: 60 }, (_, i) => ({ body: `reply ${i}\n${"words ".repeat(400)}`, author: `u${i}` }));
  const id = gh.discussion("Help", `my link ${LINK}\nfirst version`, replies);
  gh.fail("addDiscussionComment", 1, (v) => v.body.includes(" part 3/"));
  await assert.rejects(runGuard(discussionEvent(gh, id), gh.graphql, quiet), /502/);
  // Meanwhile: the asker edits, and someone answers.
  gh.discussions.get(id).body = `my link ${LINK}\nsecond version, with the app named`;
  gh.addComment(id, null, "a late answer that matters", "newcomer");
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assert.equal(gh.discussions.has(id), false);
  const all = assertOneWholeCopy(gh, id, [...replies.map((r) => r.body), "second version, with the app named", "a late answer that matters"]);
  assert.doesNotMatch(all, /first version/, "nothing of the older copy is left");
});

test("handoff: an older copy someone already replied to is left, with the original: nothing deleted", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", `my link ${LINK}\nfirst version`, [{ body: "the fix", author: "helper" }]);
  gh.fail("deleteDiscussion", 1, (v) => v.id === id);
  await assert.rejects(runGuard(discussionEvent(gh, id), gh.graphql, quiet), /502/);
  const copy = gh.copiesOf(id)[0];
  gh.addComment(copy.id, null, "thanks, that helped", "reader");
  gh.discussions.get(id).body = `my link ${LINK}\nsecond version`;
  await assert.rejects(runGuard(discussionEvent(gh, id), gh.graphql, quiet), (error) => error instanceof GuardStop && /for the owner/.test(error.message));
  assert.ok(gh.discussions.has(id), "the original stays");
  assert.ok(gh.discussions.has(copy.id), "the older copy and its reply stay");
  assert.match(gh.textsOf(copy.id), /thanks, that helped/);
});

test("handoff: the post changed while its copy was being made: the run starts over and carries the newest words", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", `my link ${LINK}\nfirst version`, [{ body: "the fix", author: "helper" }]);
  gh.afterMutation("createDiscussion", (g) => { g.discussions.get(id).body = `my link ${LINK}\nsecond version`; });
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  const all = assertOneWholeCopy(gh, id, ["second version", "the fix"]);
  assert.doesNotMatch(all, /first version/);
  // Changing on every round: it stops, the original left.
  const busy = new FakeGitHub();
  const b = busy.discussion("Help", `my link ${LINK}\nv0`);
  for (let round = 1; round <= 3; round++) busy.afterMutation("createDiscussion", (g) => { g.discussions.get(b).body = `my link ${LINK}\nv${round}`; }, () => true);
  await assert.rejects(runGuard(discussionEvent(busy, b), busy.graphql, quiet), (error) => error instanceof GuardStop && /kept changing/.test(error.message));
  assert.ok(busy.discussions.has(b));
});

test("a reply: refused delete then the retry, posted once in the same place; changed meanwhile, the older copy is replaced", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", "a question");
  const parent = gh.addComment(id, null, "an answer", "helper");
  const reply = gh.addComment(id, parent, `here ${LINK} and one more thing`, "replier");
  gh.fail("deleteDiscussionComment", 1, (v) => v.id === reply);
  await assert.rejects(runGuard(replyEvent(gh, id, reply), gh.graphql, quiet), /502/);
  // The reply is edited before the retry.
  gh.comments.get(reply).body = `here ${LINK} and one more thing, edited`;
  assert.equal(await runGuard(replyEvent(gh, id, reply), gh.graphql, quiet), "removed");
  const now = gh.comments.get(parent).replyIds.map((r) => gh.comments.get(r).body);
  assert.equal(now.length, 1, "one copy, under the same reply, the older copy and the original gone");
  assert.match(now[0], /one more thing, edited/);
  assert.doesNotMatch(now[0], new RegExp(SEALED));
});

test("a top-level reply with replies of its own: theirs are carried into the copy, whatever GitHub does with them", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", "a question");
  const top = gh.addComment(id, null, `see ${LINK}`, "replier");
  gh.addComment(id, top, "thanks, that worked", "asker");
  assert.equal(await runGuard(replyEvent(gh, id, top), gh.graphql, quiet), "removed");
  assert.match(gh.textsOf(id), /> thanks, that worked/);
  assert.equal(gh.comments.has(top), false);
});

test("run again after it worked, or for a reply whose discussion another run took down: nothing posted", async () => {
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

/** The same discussion built twice gets the same ids: a twin shows what the workflow's copy of it says, exactly. */
function longTalk() {
  return Array.from({ length: 60 }, (_, i) => ({ body: `reply ${i}\n${"words ".repeat(400)}`, author: `u${i}` }));
}

test("an outsider's discussion with this post's marker, print and exact text is never taken for its copy, nor deleted", async () => {
  // What the workflow's copy would say, from a twin whose delete was refused.
  const twin = new FakeGitHub();
  const twinId = twin.discussion("Help", `my link ${LINK}`, [{ body: "the fix", author: "helper" }]);
  twin.fail("deleteDiscussion", 1, (v) => v.id === twinId);
  await assert.rejects(runGuard(discussionEvent(twin, twinId), twin.graphql, quiet), /502/);
  const genuine = twin.copiesOf(twinId)[0];

  const gh = new FakeGitHub();
  const id = gh.discussion("Help", `my link ${LINK}`, [{ body: "the fix", author: "helper" }]);
  assert.equal(id, twinId);
  // An outsider posts that very copy (marker, print, title and text), and an older-looking one beside it.
  const exact = gh.discussion(genuine.title, genuine.body, [], null, "outsider");
  const older = gh.discussion(genuine.title, genuine.body.replace(/snapshot [0-9a-f]+/, "snapshot 0000000000000000"), [], null, "outsider");
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assert.ok(gh.discussions.has(exact) && gh.discussions.has(older), "the outsider's posts are left alone");
  assert.equal(gh.discussions.get(exact).body, genuine.body);
  assert.equal(count(gh, "createDiscussion"), 1, "the workflow made its own copy");
  assert.equal(gh.discussions.has(id), false);
  assertOneWholeCopy(gh, id, ["the fix"]);
});

test("an outsider's reply carrying a part's marker and exact text inside the workflow's copy is not counted as that part, nor removed", async () => {
  // The exact third part, from a twin that copied the discussion whole.
  const twin = new FakeGitHub();
  const twinId = twin.discussion("Help", `my link ${LINK}`, longTalk());
  assert.equal(await runGuard(discussionEvent(twin, twinId), twin.graphql, quiet), "removed");
  const third = twin.copiesOf(twinId)[0].commentIds.map((c) => twin.comments.get(c).body).find((b) => b.includes(" part 3/"));
  assert.ok(third);

  const gh = new FakeGitHub();
  const id = gh.discussion("Help", `my link ${LINK}`, longTalk());
  gh.fail("addDiscussionComment", 1, (v) => v.body.includes(" part 3/"));
  await assert.rejects(runGuard(discussionEvent(gh, id), gh.graphql, quiet), /502/);
  // While the copy waits for its third part, an outsider posts exactly that part into it.
  const copy = gh.copiesOf(id)[0];
  const fake = gh.addComment(copy.id, null, third, "outsider");
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assert.ok(gh.comments.has(fake), "the outsider's reply stays");
  assert.equal(gh.comments.get(fake).author.login, "outsider");
  assertOneWholeCopy(gh, id, longTalk().map((r) => r.body));
});

test("an outsider's reply with a reply's marker and exact text is not taken for its copy: the workflow posts its own, and leaves theirs", async () => {
  const build = () => {
    const g = new FakeGitHub();
    const d = g.discussion("Help", "a question");
    const parent = g.addComment(d, null, "an answer", "helper");
    const reply = g.addComment(d, parent, `here ${LINK} and one more thing`, "replier");
    return { g, d, parent, reply };
  };
  const twin = build();
  twin.g.fail("deleteDiscussionComment", 1, (v) => v.id === twin.reply);
  await assert.rejects(runGuard(replyEvent(twin.g, twin.d, twin.reply), twin.g.graphql, quiet), /502/);
  const genuine = twin.g.comments.get(twin.g.comments.get(twin.parent).replyIds.find((r) => r !== twin.reply)).body;

  const { g, d, parent, reply } = build();
  const fake = g.addComment(d, parent, genuine, "outsider");
  assert.equal(await runGuard(replyEvent(g, d, reply), g.graphql, quiet), "removed");
  assert.equal(count(g, "addDiscussionComment"), 1, "the workflow posted its own copy");
  assert.ok(g.comments.has(fake), "the outsider's reply stays");
  const under = g.comments.get(parent).replyIds.map((r) => g.comments.get(r));
  assert.equal(under.filter((c) => c.author === BOT).length, 1);
  assert.equal(g.comments.has(reply), false);
});

test("when GitHub gives no author, nothing is taken for the workflow's: the original stays; with authors back, the copy is finished, not made twice", async () => {
  // No replies, so the copy says the same whether or not GitHub names who wrote them.
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", `my link ${LINK}\nthe details`);
  gh.hideAuthors = true;
  await assert.rejects(runGuard(discussionEvent(gh, id), gh.graphql, quiet), (error) => error instanceof GuardStop && /posted by this workflow/.test(error.message));
  assert.ok(gh.discussions.has(id), "the original stays");
  assert.equal(count(gh, "deleteDiscussion"), 0);
  gh.hideAuthors = false;
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assert.equal(count(gh, "createDiscussion"), 1, "the workflow's own copy was found and finished");
  assertOneWholeCopy(gh, id, ["the details"]);
  // With replies whose authors could not be named, the copy made then (naming them "ghost") is of another version:
  // once names are back it is replaced, and one copy remains.
  const named = new FakeGitHub();
  const n = named.discussion("Help", `my link ${LINK}`, [{ body: "the fix", author: "helper" }]);
  named.hideAuthors = true;
  await assert.rejects(runGuard(discussionEvent(named, n), named.graphql, quiet), GuardStop);
  named.hideAuthors = false;
  assert.equal(await runGuard(discussionEvent(named, n), named.graphql, quiet), "removed");
  assert.match(assertOneWholeCopy(named, n, ["the fix"]), /\*\*@helper\*\*/);
});

// A marker anyone types is only text: quoted into the workflow's copy of another post, it never makes that copy pass
// for this post's copy. Only the marker the workflow writes last in its own post counts.
const typedMarker = (id) => `thanks <!-- guard:replaces ${id} part 1/1 snapshot 0000000000000000 -->`;
const FIX = "the fix that worked: set the cache to 64 MB";
const wordsAnywhere = (gh, text) => [...gh.discussions.keys()].some((id) => gh.textsOf(id).includes(text));

test("a discussion's copy quoting a marker typed for another discussion is never taken for that one's copy, nor deleted", async () => {
  const gh = new FakeGitHub();
  const other = gh.discussion("Other", `mine ${LINK}`, [], null, "mallory");
  const id = gh.discussion("Help", `my link ${LINK}`, [{ body: FIX, author: "helper" }, { body: typedMarker(other), author: "mallory" }]);
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  const copy = gh.copiesOf(id)[0].id;
  assert.equal(await runGuard(discussionEvent(gh, other), gh.graphql, quiet), "removed");
  assert.ok(gh.discussions.has(copy), "the first discussion's copy stays");
  assert.ok(wordsAnywhere(gh, FIX), "the helper's words are still there");
  assertOneWholeCopy(gh, id, [FIX]);
  assert.equal(gh.discussions.has(other), false);
  assert.equal(gh.copiesOf(other).filter((d) => d.id !== copy).length, 1, "the other discussion got its own copy");
});

test("a reply's copy quoting a marker typed for another reply is never taken for an older part of it, nor deleted", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", "a question");
  const first = gh.addComment(id, null, `mine ${LINK}`, "mallory");
  const second = gh.addComment(id, null, `see ${LINK}`, "replier");
  gh.addComment(id, second, FIX, "helper");
  gh.addComment(id, second, typedMarker(first), "mallory");
  assert.equal(await runGuard(replyEvent(gh, id, second), gh.graphql, quiet), "removed");
  const copy = gh.discussions.get(id).commentIds.find((c) => gh.comments.get(c).author === BOT);
  assert.ok(gh.comments.get(copy).body.includes(FIX));
  assert.equal(await runGuard(replyEvent(gh, id, first), gh.graphql, quiet), "removed");
  assert.ok(gh.comments.has(copy), "the second reply's copy stays");
  assert.ok(gh.textsOf(id).includes(FIX), "the helper's words are still there");
  assert.equal(gh.comments.has(first), false);
});

test("a copy made by the previous version, with a typed marker quoted in it, is known only by its own last marker", async () => {
  const gh = new FakeGitHub();
  const other = gh.discussion("Other", `mine ${LINK}`, [], null, "mallory");
  const id = gh.discussion("Help", `my link ${LINK}`, [{ body: FIX, author: "helper" }, { body: typedMarker(other), author: "mallory" }]);
  // As the previous version posted it, its run stopped before the delete: the typed marker quoted as it was.
  const old = gh.discussion("Help", `note\n\n---\n\nmy link [link removed]\n\n---\n\n**The replies it had:**\n\n**@helper**, 2026-11-05:\n> ${FIX}\n\n**@mallory**, 2026-11-05:\n> ${typedMarker(other)}\n\n<!-- guard:replaces ${id} part 1/1 snapshot 1111111111111111 -->`, [], null, BOT);
  assert.equal(await runGuard(discussionEvent(gh, other), gh.graphql, quiet), "removed");
  assert.ok(gh.discussions.has(old), "not taken for the other discussion's copy");
  // The discussion it stands for, guarded again: found by its own marker, of an older version, so replaced; one copy.
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  assert.equal(gh.discussions.has(old), false);
  assert.equal(gh.discussions.has(id), false);
  assertOneWholeCopy(gh, id, [FIX]);
});

test("a marker-like text carried into a copy keeps its words, loses its meaning, and links are still removed", async () => {
  const gh = new FakeGitHub();
  const id = gh.discussion("Help", `my link ${LINK}\nGUARD:REPLACES is just words here`, [{ body: `${typedMarker("D99")} and the rest of my words ${LINK}`, author: "helper" }]);
  assert.equal(await runGuard(discussionEvent(gh, id), gh.graphql, quiet), "removed");
  const all = assertOneWholeCopy(gh, id, []);
  assert.equal(all.match(/guard:replaces/gi).length, 1, "the copy's own marker is the only one");
  assert.match(all, /and the rest of my words \[link removed\]/);
  assert.match(all, /is just words here/);
  assert.equal(all.replace(/​/g, "").match(/guard:replaces/gi).length, 3, "the typed ones are all still there to read");
});
