// The guard's work for one event, with GitHub's API passed in (guard.mjs passes the real one, the tests a stand-in).
// A post holding a link with someone's setup in it or a key is deleted (an edit would leave it in the public edit
// history) and posted again without it, naming its author; a discussion's replies are carried into the new post.
// Never prints a post's text.
import { createHash } from "node:crypto";
import { cleaned, findFlags, findSecrets, noteFor } from "./patterns.mjs";
import { labelNew } from "./new-label.mjs";

/**
 * The most text one part of a new post holds: GitHub keeps a post's body to 65,536 characters, and a part also
 * carries its heading and its marker. Whatever does not fit goes into the next part: nothing is ever cut.
 */
const PART = 60_000;
/** How many pages of 100 discussions the search for an earlier copy reads at most before it gives up and stops. */
const lookupPages = () => Number(process.env.GUARD_LOOKUP_PAGES ?? 50);
/** How many times one run starts over when the post changed while it was being copied. */
const ROUNDS = 3;

/** A stop on purpose: the original is left where it is, and the run says why (it ends red, for the owner). */
export class GuardStop extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardStop";
  }
}

/**
 * The hidden line each part of a new post carries: the post it stands for, its number, and a print of everything
 * the copy holds (all parts together), so a part made from an older version of the post is told from a current one.
 */
const markerOf = (id, part, parts, print) => `<!-- guard:replaces ${id} part ${part}/${parts} snapshot ${print} -->`;

/** The marker as posted() writes it, alone at the very end of a post. */
const TRAILING_MARKER = /\n\n<!-- guard:replaces (\S+) part (\d+)\/(\d+) snapshot ([0-9a-f]{16}) -->$/;

/**
 * What a body's marker says about the post standing for `id`: its part, the number of parts, the print; or null.
 * Only the marker that ends the body counts, the one posted() writes last. A marker anywhere else is text someone
 * typed, carried in a quote or the post's own words: it never stands for anything, even when the body has no marker
 * of its own at the end (copies made before carried text was defused hold such text too). The id is compared as
 * it is, never put into a pattern.
 */
function markerIn(body, id) {
  const found = TRAILING_MARKER.exec(String(body ?? "").replace(/\s+$/, ""));
  if (!found || found[1] !== id) return null;
  return { part: Number(found[2]), parts: Number(found[3]), print: found[4] };
}

/**
 * Carried text with any marker-like words made plain: a zero-width space after "guard" in every "guard:replaces", so
 * nothing anyone typed reads as a marker in the workflow's copy. It reads the same, and inside an HTML comment it
 * stays hidden. Applied after the links and keys are removed, before the copy is cut into parts and printed.
 */
const defused = (text) => text.replace(/(guard)(:replaces)/gi, "$1​$2");

/** Who wrote a post, as every query here asks it: what tells this workflow's own posts from anyone else's. */
const AUTHOR = "author { __typename login ... on Bot { databaseId } }";

/**
 * Whether a post was written by this workflow: its token (GITHUB_TOKEN, an installation token of GitHub's Actions
 * app) posts as the bot "github-actions", user id 41898282 (seen on this repository's discussion #12, posted by this
 * guard on 2026-10-23: author Bot, login github-actions, databaseId 41898282). A person's account is never a Bot,
 * and the app's name is GitHub's own. An author missing or not given is not this workflow.
 */
export const ours = (author) => author?.__typename === "Bot" && author.login === "github-actions" && author.databaseId === 41898282;

/**
 * The marker of a post, only when this workflow wrote it: a marker, a print and the exact text can all be copied by
 * anyone (the post they stand for is public), so a post by anyone else is never taken for a copy or a part of one,
 * never counted, and never deleted as an older copy. In the workflow's own post only its last marker counts
 * (markerIn): one typed by someone and carried in it never makes it pass for another post's copy.
 */
const ourMark = (post, id) => (ours(post?.author) ? markerIn(post.body, id) : null);

const printOf = (title, parts) => createHash("sha256").update([title, ...parts].join("\u0000")).digest("hex").slice(0, 16);

/** A reply's replies past its first 100, page by page. */
async function moreReplies(graphql, commentId, first) {
  const replies = [...first.nodes];
  let more = first.pageInfo;
  while (more.hasNextPage) {
    const { node } = await graphql(
      `query($id: ID!, $after: String) { node(id: $id) { ... on DiscussionComment {
            replies(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id ${AUTHOR} createdAt body } }
          } } }`,
      { id: commentId, after: more.endCursor },
    );
    if (!node?.replies) throw new Error("a reply's replies could not be read");
    replies.push(...node.replies.nodes);
    more = node.replies.pageInfo;
  }
  return replies;
}

/**
 * Every reply of a discussion, page by page (100 is the most one page holds), each with its own replies, also page
 * by page. A page that cannot be read throws: nothing is deleted on half a snapshot.
 */
async function allComments(graphql, discussionId) {
  const comments = [];
  let after = null;
  for (;;) {
    const { node } = await graphql(
      `query($id: ID!, $after: String) { node(id: $id) { ... on Discussion {
        comments(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id ${AUTHOR} createdAt body replies(first: 100) { pageInfo { hasNextPage endCursor } nodes { id ${AUTHOR} createdAt body } } }
        }
      } } }`,
      { id: discussionId, after },
    );
    const page = node?.comments;
    if (!page) throw new Error("the discussion's replies could not be read");
    for (const comment of page.nodes) comments.push({ ...comment, replies: await moreReplies(graphql, comment.id, comment.replies) });
    if (!page.pageInfo.hasNextPage) return comments;
    after = page.pageInfo.endCursor;
  }
}

/** A reply quoted with its author and day, the marked answer said so; cleaned of any link or key of its own. */
function quote(c, answer) {
  const text = defused(cleaned(c.body, findSecrets(c.body))).split("\n").map((line) => `> ${line}`).join("\n");
  return `**@${c.author?.login ?? "ghost"}**, ${c.createdAt.slice(0, 10)}${answer ? " (marked as the answer)" : ""}:\n${text}`;
}

/** Text in pieces of at most `size` characters, cut at a line's end where one is near; later pieces say they go on. */
function pieces(text, size) {
  const out = [];
  let rest = text;
  while (rest.length > size) {
    const room = size - 20;
    const cut = rest.lastIndexOf("\n", room) > room / 2 ? rest.lastIndexOf("\n", room) : room;
    out.push(rest.slice(0, cut));
    rest = `_(continued)_\n${rest.slice(cut).replace(/^\n/, "")}`;
  }
  out.push(rest);
  return out;
}

/**
 * The new post's parts: the note and the post's own words, then every reply quoted, each part within GitHub's limit.
 * Nothing is left out or cut short: a long post or reply goes on in the next part.
 */
export function partsOf(head, quotes = []) {
  const all = [...pieces(head, PART)];
  if (quotes.length > 0) {
    all.push("---\n\n**The replies it had:**");
    for (const q of quotes) all.push(...pieces(q, PART));
  }
  const parts = [];
  let current = "";
  for (const piece of all) {
    if (current && current.length + 2 + piece.length > PART) {
      parts.push(current);
      current = piece;
    } else current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) parts.push(current);
  return parts;
}

/** A part as posted: after the first, a line saying it goes on with the post above; its marker last. */
function posted(text, id, part, parts, print) {
  const lead = part > 1 ? `_(Part ${part} of ${parts}: the post above goes on here.)_\n\n` : "";
  return `${lead}${text}\n\n${markerOf(id, part, parts, print)}`;
}

/**
 * Handles one created or edited discussion or reply. The event says which post; what the post says is read again
 * from GitHub first, as the run may have waited in line while its author edited it again: only what it says now is
 * judged and carried over (a post since cleaned is left alone).
 *
 * Everything is posted again before anything is deleted: the post's words and every reply, in as many parts as they
 * take (no text is cut or left out). Each part carries a hidden marker naming the post it stands for, its number and
 * a print of the whole copy. A run that stopped half way (a part GitHub refused, or the delete) is finished by the
 * next one, which finds the copy made already (every discussion is looked through, page by page) and posts only the
 * parts missing: never twice. A copy made from an older version of the post (it changed since) is replaced by a
 * current one, unless someone replied to it, when the run stops and leaves both for the owner. Before the delete,
 * every part is read back and must be exactly what the post says now, and the post is read once more: changed while
 * it was being copied, the run starts over (three times at most, then stops). Runs for one post wait for each other
 * (the workflow's concurrency group, by the post's id). Between the last read and the delete a few hundred
 * milliseconds remain, which GitHub's API gives no way to close.
 */
export async function runGuard(event, graphql, log = console.log) {
  const comment = event.comment;
  const discussion = event.discussion;
  const said = comment ? comment.body : `${discussion.title}\n${discussion.body}`;

  if (findSecrets(said).length === 0) {
    // Words worth a look (rules 2 and 4) are never removed: the discussion gets the label "needs-look"
    // for the owner to read it.
    const flags = findFlags(said);
    if (flags.length) {
      const { repository } = await graphql(
        "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { label(name: \"needs-look\") { id } } }",
        { owner: event.repository.owner.login, name: event.repository.name },
      );
      if (repository.label) {
        await graphql("mutation($id: ID!, $labels: [ID!]!) { addLabelsToLabelable(input: { labelableId: $id, labelIds: $labels }) { clientMutationId } }", { id: discussion.node_id, labels: [repository.label.id] });
        log(`flagged for a look: ${flags.length} word(s)`);
      } else log("words worth a look, but the label needs-look does not exist");
    } else log("nothing to remove");
    return "clean";
  }

  const round = comment ? replyRound : discussionRound;
  for (let attempt = 1; attempt <= ROUNDS; attempt++) {
    const outcome = await round(event, graphql, log);
    if (outcome !== "changed") return outcome;
    log(`the post changed while it was being copied: starting over (${attempt} of ${ROUNDS})`);
  }
  throw new GuardStop(`the post kept changing while it was being copied (${ROUNDS} times): left where it is`);
}

const addComment = async (graphql, discussionId, replyToId, body) => {
  const answer = await graphql(
    "mutation($d: ID!, $r: ID, $body: String!) { addDiscussionComment(input: { discussionId: $d, replyToId: $r, body: $body }) { comment { id } } }",
    { d: discussionId, r: replyToId, body },
  );
  return answer?.addDiscussionComment?.comment?.id ?? null;
};
const deleteComment = (graphql, id) => graphql("mutation($id: ID!) { deleteDiscussionComment(input: { id: $id }) { clientMutationId } }", { id });

/** A reply as it is now: undefined when it is gone; null when it no longer holds a link or key. */
async function replySnapshot(graphql, comment) {
  const { node } = await graphql(
    `query($id: ID!) { node(id: $id) { ... on DiscussionComment { body replyTo { id }
      replies(first: 100) { pageInfo { hasNextPage endCursor } nodes { id ${AUTHOR} createdAt body } } } } }`,
    { id: comment.node_id },
  );
  if (!node) return undefined;
  const found = findSecrets(node.body);
  if (found.length === 0) return null;
  // A reply with replies of its own: theirs are carried along too. Whether GitHub keeps them once their parent is
  // deleted is not known here; carried, they are never lost (at worst they show twice).
  const answers = await moreReplies(graphql, comment.node_id, node.replies ?? { nodes: [], pageInfo: { hasNextPage: false } });
  const parts = partsOf(`${noteFor(comment.user.login, found)}\n\n---\n\n${defused(cleaned(node.body, found))}`, answers.map((r) => quote(r, false)));
  return { parent: node.replyTo?.id ?? null, found, parts, print: printOf("", parts) };
}

async function replyRound(event, graphql, log) {
  const { comment, discussion } = event;
  const now = await replySnapshot(graphql, comment);
  if (now === undefined) {
    log("the reply is gone already");
    return "gone";
  }
  if (now === null) {
    log("the reply no longer holds it: left as it is");
    return "since-cleaned";
  }
  const { parent, found, parts, print } = now;
  const id = comment.node_id;
  // The parts an earlier run of this workflow made, by their markers: current ones are kept, older ones replaced.
  // Anyone else's post with a marker is no part (ourMark): never counted, never deleted.
  const scan = async () => {
    const current = new Map();
    let doubled = 0;
    const stale = [];
    for (const c of await allComments(graphql, discussion.node_id)) {
      for (const one of [c, ...c.replies]) {
        const mark = ourMark(one, id);
        if (!mark) continue;
        if (mark.print === print && mark.parts === parts.length) {
          if (current.has(mark.part)) doubled++;
          else current.set(mark.part, { id: one.id, body: one.body });
        } else stale.push({ id: one.id, replies: one === c ? c.replies : [] });
      }
    }
    return { current, stale, doubled };
  };
  const { current, stale } = await scan();
  for (const old of stale) {
    if (old.replies.some((r) => !ourMark(r, id))) {
      throw new GuardStop("an older copy of the reply has replies of its own: both left where they are, for the owner");
    }
  }
  // An older copy's parts: the ones under another first (they were posted last), then the first.
  for (const old of [...stale].reverse()) await deleteComment(graphql, old.id);
  log(`removing a reply by ${comment.user.login}: ${found.map((f) => f.kind).join(", ")} (${parts.length} part(s), ${current.size} current made before, ${stale.length} older replaced)`);
  // In its own place: under the same reply as before, or, for a top-level reply, its first part with the rest under it.
  let first = current.get(1)?.id;
  if (!current.has(1)) first = await addComment(graphql, discussion.node_id, parent, posted(parts[0], id, 1, parts.length, print));
  const under = parent ?? first;
  for (let part = 2; part <= parts.length; part++) {
    if (!current.has(part)) await addComment(graphql, discussion.node_id, under, posted(parts[part - 1], id, part, parts.length, print));
  }
  // Read back: every part there once, exactly as the reply says now; and the reply itself unchanged meanwhile.
  const back = await scan();
  if (back.doubled > 0 || back.stale.length > 0) throw new GuardStop("the copy has a part twice or an older part left: the reply is left where it is");
  for (let part = 1; part <= parts.length; part++) {
    if (back.current.get(part)?.body !== posted(parts[part - 1], id, part, parts.length, print)) {
      throw new GuardStop(`part ${part} of the copy could not be read back as posted: the reply is left where it is`);
    }
  }
  const again = await replySnapshot(graphql, comment);
  if (!again || again.print !== print) return "changed";
  await deleteComment(graphql, id);
  log("removed and posted again without it");
  return "removed";
}

/** A discussion as it is now: undefined when it is gone; null when it no longer holds a link or key. */
async function discussionSnapshot(graphql, discussion) {
  const { node } = await graphql(
    "query($id: ID!) { node(id: $id) { ... on Discussion { title body answer { id } } } }",
    { id: discussion.node_id },
  );
  if (!node) return undefined;
  const found = findSecrets(`${node.title}\n${node.body}`);
  if (found.length === 0) return null;
  const comments = await allComments(graphql, discussion.node_id);
  const quotes = comments.flatMap((c) => [quote(c, c.id === node.answer?.id), ...c.replies.map((r) => quote(r, false))]);
  const parts = partsOf(`${noteFor(discussion.user.login, found)}\n\n---\n\n${defused(cleaned(node.body, found))}`, quotes);
  const title = cleaned(node.title, found);
  return { title, found, parts, replies: comments.length, print: printOf(title, parts) };
}

/**
 * The copy an earlier run made of the discussion `id`, if any: every discussion of the repository is looked through,
 * newest first, page by page. When that cannot be finished (a page refused, or more pages than allowed) nobody can
 * say whether a copy exists: the run stops rather than risk a second one.
 */
async function earlierCopy(graphql, event, id) {
  let after = null;
  for (let page = 1; page <= lookupPages(); page++) {
    const { repository } = await graphql(
      `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) {
        discussions(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { id title body ${AUTHOR} } }
      } }`,
      { owner: event.repository.owner.login, name: event.repository.name, after },
    );
    const list = repository?.discussions;
    if (!list) throw new GuardStop("the discussions could not be read to look for an earlier copy: left where it is");
    // Only one this workflow posted: anyone can post a discussion with the same marker, print and text.
    const copy = list.nodes.find((d) => ourMark(d, id)?.part === 1);
    if (copy) return copy;
    if (!list.pageInfo.hasNextPage) return null;
    after = list.pageInfo.endCursor;
  }
  throw new GuardStop(`more than ${lookupPages() * 100} discussions: whether an earlier copy exists could not be told, left where it is`);
}

async function discussionRound(event, graphql, log) {
  const { discussion } = event;
  const id = discussion.node_id;
  const now = await discussionSnapshot(graphql, discussion);
  if (now === undefined) {
    log("the discussion is gone already");
    return "gone";
  }
  if (now === null) {
    log("the discussion no longer holds it: left as it is");
    return "since-cleaned";
  }
  const { title, found, parts, print } = now;

  // The copy an earlier run made: kept when it is of the post as it is now, replaced when of an older version
  // (unless someone replied to it: then both are left for the owner).
  let copy = await earlierCopy(graphql, event, id);
  let made = new Map();
  if (copy) {
    const first = ourMark(copy, id);
    const comments = await allComments(graphql, copy.id);
    // Anyone else's post in the copy (a marker in it or not) is theirs: it is never counted as a part, and an older
    // copy holding one is never deleted.
    const others = comments.flatMap((c) => [c, ...c.replies]).filter((c) => !ourMark(c, id));
    if (first.print === print && first.parts === parts.length && copy.title === title) {
      for (const c of comments) {
        const mark = ourMark(c, id);
        if (mark && mark.print === print) made.set(mark.part, c.body);
      }
    } else if (others.length > 0) {
      throw new GuardStop("an older copy of the discussion has replies of its own: both left where they are, for the owner");
    } else {
      log("an older copy of the discussion (it changed since) is replaced by a current one");
      await graphql("mutation($id: ID!) { deleteDiscussion(input: { id: $id }) { clientMutationId } }", { id: copy.id });
      copy = null;
      made = new Map();
    }
  }
  if (!copy) {
    const created = await graphql(
      "mutation($repo: ID!, $cat: ID!, $title: String!, $body: String!) { createDiscussion(input: { repositoryId: $repo, categoryId: $cat, title: $title, body: $body }) { discussion { id number } } }",
      { repo: event.repository.node_id, cat: discussion.category.node_id, title, body: posted(parts[0], id, 1, parts.length, print) },
    );
    copy = { id: created.createDiscussion.discussion.id };
  }
  log(`removing a discussion by ${discussion.user.login}: ${found.map((f) => f.kind).join(", ")} (${now.replies} replies read, ${parts.length} part(s), ${made.size} more made before)`);
  for (let part = 2; part <= parts.length; part++) {
    if (!made.has(part)) await addComment(graphql, copy.id, null, posted(parts[part - 1], id, part, parts.length, print));
  }

  // Read back: the copy's title and every part exactly as the post says now, each once; and the post unchanged.
  // The copy must read back as this workflow's own: an author that cannot be told stops the run, the original left.
  const { node: back } = await graphql(`query($id: ID!) { node(id: $id) { ... on Discussion { title body ${AUTHOR} } } }`, { id: copy.id });
  if (!ours(back?.author)) {
    throw new GuardStop("the copy could not be read back as posted by this workflow: the discussion is left where it is");
  }
  if (back.title !== title || back.body !== posted(parts[0], id, 1, parts.length, print)) {
    throw new GuardStop("the copy's first part could not be read back as posted: the discussion is left where it is");
  }
  const seen = new Map();
  for (const c of await allComments(graphql, copy.id)) {
    const mark = ourMark(c, id);
    if (mark) seen.set(mark.part, [...(seen.get(mark.part) ?? []), c.body]);
  }
  for (let part = 2; part <= parts.length; part++) {
    const bodies = seen.get(part) ?? [];
    if (bodies.length !== 1 || bodies[0] !== posted(parts[part - 1], id, part, parts.length, print)) {
      throw new GuardStop(`part ${part} of the copy is missing, doubled or not as posted: the discussion is left where it is`);
    }
  }
  const again = await discussionSnapshot(graphql, discussion);
  if (!again || again.print !== print) return "changed";

  // Posted again by the workflow, which starts no workflow: its state label is set here (new-label.mjs).
  if (discussion.category?.name !== "Announcements") await labelNew(graphql, event.repository.owner.login, event.repository.name, copy.id);
  await graphql("mutation($id: ID!) { deleteDiscussion(input: { id: $id }) { clientMutationId } }", { id });
  log("removed and posted again without it");
  return "removed";
}
