// The guard's work for one event, with GitHub's API passed in (guard.mjs passes the real one, the tests a stand-in).
// A post holding a link with someone's setup in it or a key is deleted (an edit would leave it in the public edit
// history) and posted again without it, naming its author; a discussion's replies are carried into the new post.
// Never prints a post's text.
import { cleaned, findFlags, findSecrets, noteFor } from "./patterns.mjs";
import { labelNew } from "./new-label.mjs";

/**
 * The most text one part of a new post holds: GitHub keeps a post's body to 65,536 characters, and a part also
 * carries its heading and its marker. Whatever does not fit goes into the next part: nothing is ever cut.
 */
const PART = 60_000;

/** The hidden line each part of a new post carries: which post it stands for, and which part it is. */
const markerOf = (id, part, parts) => `<!-- guard:replaces ${id} part ${part}/${parts} -->`;

/** The part number a body says it is of the post standing for `id`, or null. */
function partNumber(body, id) {
  const at = (body ?? "").indexOf(`<!-- guard:replaces ${id} part `);
  if (at === -1) return null;
  const found = /^part (\d+)\/\d+ -->/.exec(body.slice(at + `<!-- guard:replaces ${id} `.length));
  return found ? Number(found[1]) : null;
}

/** A reply's replies past its first 100, page by page. */
async function moreReplies(graphql, commentId, first) {
  const replies = [...first.nodes];
  let more = first.pageInfo;
  while (more.hasNextPage) {
    const { node } = await graphql(
      `query($id: ID!, $after: String) { node(id: $id) { ... on DiscussionComment {
            replies(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { author { login } createdAt body } }
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
          nodes { id author { login } createdAt body replies(first: 100) { pageInfo { hasNextPage endCursor } nodes { author { login } createdAt body } } }
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
  const text = cleaned(c.body, findSecrets(c.body)).split("\n").map((line) => `> ${line}`).join("\n");
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
function posted(text, id, part, parts) {
  const lead = part > 1 ? `_(Part ${part} of ${parts}: the post above goes on here.)_\n\n` : "";
  return `${lead}${text}\n\n${markerOf(id, part, parts)}`;
}

/**
 * Handles one created or edited discussion or reply. The event says which post; what the post says is read again
 * from GitHub first, as the run may have waited in line while its author edited it again: only what it says now is
 * judged and carried over (a post since cleaned is left alone). Between that read and the delete a few hundred
 * milliseconds remain, which GitHub's API gives no way to close; an edit landing exactly then is lost with the post.
 *
 * Everything is posted again before anything is deleted: the post's words and every reply, in as many parts as they
 * take (no text is cut or left out). Each part carries a hidden marker naming the post it stands for, so a run that
 * stopped half way (a part GitHub refused, or the delete) is finished by the next run, which finds the parts made
 * already and posts only those missing: never twice. Runs for one post wait for each other (the workflow's
 * concurrency group, by the post's id); one finding the post gone has nothing to do.
 */
export async function runGuard(event, graphql, log = console.log) {
  const comment = event.comment;
  const discussion = event.discussion;
  const post = comment ?? discussion;
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

  return comment ? replaceReply(event, graphql, log) : replaceDiscussion(event, graphql, log);
}

async function replaceReply(event, graphql, log) {
  const { comment, discussion } = event;
  const { node } = await graphql(
    `query($id: ID!) { node(id: $id) { ... on DiscussionComment { body replyTo { id }
      replies(first: 100) { pageInfo { hasNextPage endCursor } nodes { author { login } createdAt body } } } } }`,
    { id: comment.node_id },
  );
  if (!node) {
    log("the reply is gone already");
    return "gone";
  }
  const found = findSecrets(node.body);
  if (found.length === 0) {
    log("the reply no longer holds it: left as it is");
    return "since-cleaned";
  }
  // A reply with replies of its own: theirs are carried along too, never lost with it.
  const answers = await moreReplies(graphql, comment.node_id, node.replies ?? { nodes: [], pageInfo: { hasNextPage: false } });
  const parts = partsOf(`${noteFor(comment.user.login, found)}\n\n---\n\n${cleaned(node.body, found)}`, answers.map((r) => quote(r, false)));
  // Parts made by an earlier run that stopped half way: found by their markers.
  const made = new Map();
  for (const c of await allComments(graphql, discussion.node_id)) {
    const part = partNumber(c.body, comment.node_id);
    if (part !== null) made.set(part, c.id);
    for (const r of c.replies) {
      const inner = partNumber(r.body, comment.node_id);
      if (inner !== null) made.set(inner, null);
    }
  }
  log(`removing a reply by ${comment.user.login}: ${found.map((f) => f.kind).join(", ")} (${parts.length} part(s), ${made.size} made before)`);
  const add = async (body, replyToId) => {
    const answer = await graphql(
      "mutation($d: ID!, $r: ID, $body: String!) { addDiscussionComment(input: { discussionId: $d, replyToId: $r, body: $body }) { comment { id } } }",
      { d: discussion.node_id, r: replyToId, body },
    );
    return answer?.addDiscussionComment?.comment?.id ?? null;
  };
  // In its own place: under the same reply as before, or, for a top-level reply, its first part with the rest under it.
  let first = made.has(1) ? made.get(1) : undefined;
  if (first === undefined) first = await add(posted(parts[0], comment.node_id, 1, parts.length), node.replyTo?.id ?? null);
  const under = node.replyTo?.id ?? first;
  for (let part = 2; part <= parts.length; part++) {
    if (!made.has(part)) await add(posted(parts[part - 1], comment.node_id, part, parts.length), under);
  }
  await graphql("mutation($id: ID!) { deleteDiscussionComment(input: { id: $id }) { clientMutationId } }", { id: comment.node_id });
  log("removed and posted again without it");
  return "removed";
}

async function replaceDiscussion(event, graphql, log) {
  const { discussion } = event;
  // Deleting a discussion takes its replies with it, and the workflow's token may not edit someone else's post. So
  // its title and body as they are now, and every reply, are read first and carried into the new post.
  const { node } = await graphql(
    "query($id: ID!) { node(id: $id) { ... on Discussion { title body answer { id } } } }",
    { id: discussion.node_id },
  );
  if (!node) {
    log("the discussion is gone already");
    return "gone";
  }
  const found = findSecrets(`${node.title}\n${node.body}`);
  if (found.length === 0) {
    log("the discussion no longer holds it: left as it is");
    return "since-cleaned";
  }
  const comments = await allComments(graphql, discussion.node_id);
  const quotes = comments.flatMap((c) => [quote(c, c.id === node.answer?.id), ...c.replies.map((r) => quote(r, false))]);
  const parts = partsOf(`${noteFor(discussion.user.login, found)}\n\n---\n\n${cleaned(node.body, found)}`, quotes);

  // The new discussion an earlier run made already (it stopped before the delete, or a part was refused): among the
  // newest, by its first part's marker.
  const { repository } = await graphql(
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
      discussions(first: 25, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { id body } }
    } }`,
    { owner: event.repository.owner.login, name: event.repository.name },
  );
  let newId = repository?.discussions?.nodes?.find((d) => partNumber(d.body, discussion.node_id) === 1)?.id;
  const made = new Set([1]);
  if (newId) {
    for (const c of await allComments(graphql, newId)) {
      const part = partNumber(c.body, discussion.node_id);
      if (part !== null) made.add(part);
    }
  } else {
    const created = await graphql(
      "mutation($repo: ID!, $cat: ID!, $title: String!, $body: String!) { createDiscussion(input: { repositoryId: $repo, categoryId: $cat, title: $title, body: $body }) { discussion { id number } } }",
      { repo: event.repository.node_id, cat: discussion.category.node_id, title: cleaned(node.title, found), body: posted(parts[0], discussion.node_id, 1, parts.length) },
    );
    newId = created.createDiscussion.discussion.id;
  }
  log(`removing a discussion by ${discussion.user.login}: ${found.map((f) => f.kind).join(", ")} (${comments.length} replies read, ${parts.length} part(s), ${made.size - 1} more made before)`);
  for (let part = 2; part <= parts.length; part++) {
    if (made.has(part)) continue;
    await graphql(
      "mutation($d: ID!, $r: ID, $body: String!) { addDiscussionComment(input: { discussionId: $d, replyToId: $r, body: $body }) { comment { id } } }",
      { d: newId, r: null, body: posted(parts[part - 1], discussion.node_id, part, parts.length) },
    );
  }
  // Posted again by the workflow, which starts no workflow: its state label is set here (new-label.mjs).
  if (discussion.category?.name !== "Announcements") await labelNew(graphql, event.repository.owner.login, event.repository.name, newId);
  await graphql("mutation($id: ID!) { deleteDiscussion(input: { id: $id }) { clientMutationId } }", { id: discussion.node_id });
  log("removed and posted again without it");
  return "removed";
}
