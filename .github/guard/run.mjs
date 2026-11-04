// The guard's work for one event, with GitHub's API passed in (guard.mjs passes the real one, the tests a stand-in).
// A post holding a link with someone's setup in it or a key is deleted (an edit would leave it in the public edit
// history) and posted again without it, naming its author; a discussion's replies are carried into the new post.
// Never prints a post's text.
import { cleaned, findFlags, findSecrets, noteFor } from "./patterns.mjs";
import { labelNew } from "./new-label.mjs";

/** GitHub keeps a post's body to 65,536 characters: a new post stays short of it. */
const MAX_BODY = 65_000;

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
    for (const comment of page.nodes) {
      const replies = [...comment.replies.nodes];
      let more = comment.replies.pageInfo;
      while (more.hasNextPage) {
        const { node: again } = await graphql(
          `query($id: ID!, $after: String) { node(id: $id) { ... on DiscussionComment {
            replies(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { author { login } createdAt body } }
          } } }`,
          { id: comment.id, after: more.endCursor },
        );
        if (!again?.replies) throw new Error("a reply's replies could not be read");
        replies.push(...again.replies.nodes);
        more = again.replies.pageInfo;
      }
      comments.push({ ...comment, replies });
    }
    if (!page.pageInfo.hasNextPage) return comments;
    after = page.pageInfo.endCursor;
  }
}

/** The replies as the new post quotes them, each with its author, the marked answer said so. */
function quotes(comments, answerId) {
  const quote = (c, answer) => {
    const text = cleaned(c.body, findSecrets(c.body)).split("\n").map((line) => `> ${line}`).join("\n");
    return `**@${c.author?.login ?? "ghost"}**, ${c.createdAt.slice(0, 10)}${answer ? " (marked as the answer)" : ""}:\n${text}`;
  };
  return comments.flatMap((c) => [quote(c, c.id === answerId), ...c.replies.map((r) => quote(r, false))]);
}

/**
 * A post's new body within GitHub's limit: the note and the post's own words first (cut, and said so, in the rare
 * case they alone are too long: the note adds a few lines to a post that was near the limit), then as many of the
 * replies as fit, and how many did not.
 */
export function bodyWithin(head, carried = []) {
  const room = MAX_BODY - 500;
  const own = head.length > room ? `${head.slice(0, room)}\n\n_(The rest of the post was too long to post again.)_` : head;
  if (carried.length === 0) return own;
  const kept = [];
  let length = own.length + 40;
  for (const one of carried) {
    if (length + one.length + 2 > MAX_BODY - 200) break;
    kept.push(one);
    length += one.length + 2;
  }
  const left = carried.length - kept.length;
  const tail = left > 0 ? `\n\n_${left} more ${left === 1 ? "reply" : "replies"} did not fit here and could not be carried over._` : "";
  return kept.length ? `${own}\n\n---\n\n**The replies it had:**\n\n${kept.join("\n\n")}${tail}` : `${own}${tail}`;
}

/**
 * Handles one created or edited discussion or reply. The event says which post; what the post says is read again
 * from GitHub first, as the run may have waited in line while its author edited it again: only what it says now is
 * judged and carried over (a post since cleaned is left alone). Between that read and the delete a few hundred
 * milliseconds remain, which GitHub's API gives no way to close; an edit landing exactly then is lost with the post.
 *
 * The new post is made before the old one is deleted, so a failure never loses a post. Runs for one post wait for
 * each other (the workflow's concurrency group, by the post's id): a later run finds it gone and posts nothing. A run
 * for a reply whose discussion another run took down finds the reply gone too. One case is left: the new post made
 * and the delete then failing; a rerun would post it a second time (the run fails red, and the owner sees it).
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

  if (comment) {
    const { node } = await graphql(
      "query($id: ID!) { node(id: $id) { ... on DiscussionComment { body replyTo { id } } } }",
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
    log(`removing a reply by ${post.user.login}: ${found.map((f) => f.kind).join(", ")}`);
    // Posted again first, then deleted: a post that cannot be made leaves the original where it is (the run fails,
    // and is seen), never a reply lost.
    await graphql(
      "mutation($d: ID!, $r: ID, $body: String!) { addDiscussionComment(input: { discussionId: $d, replyToId: $r, body: $body }) { clientMutationId } }",
      { d: discussion.node_id, r: node.replyTo?.id ?? null, body: bodyWithin(`${noteFor(post.user.login, found)}\n\n---\n\n${cleaned(node.body, found)}`) },
    );
    await graphql("mutation($id: ID!) { deleteDiscussionComment(input: { id: $id }) { clientMutationId } }", { id: comment.node_id });
  } else {
    // Deleting a discussion takes its replies with it, and the workflow's token may not edit someone else's
    // post. So its title and body as they are now, and every reply (an old question edited later), are read
    // first and carried into the new post, each reply with its author, the marked answer said so.
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
    log(`removing a discussion by ${post.user.login}: ${found.map((f) => f.kind).join(", ")} (${comments.length} replies read)`);
    // Posted again first, then deleted: a post that cannot be made leaves the original and its replies where they
    // are (the run fails, and is seen). Run again after the delete, the original is gone and nothing is posted twice.
    const made = await graphql(
      "mutation($repo: ID!, $cat: ID!, $title: String!, $body: String!) { createDiscussion(input: { repositoryId: $repo, categoryId: $cat, title: $title, body: $body }) { discussion { id number } } }",
      {
        repo: event.repository.node_id,
        cat: discussion.category.node_id,
        title: cleaned(node.title, found),
        body: bodyWithin(`${noteFor(post.user.login, found)}\n\n---\n\n${cleaned(node.body, found)}`, quotes(comments, node.answer?.id)),
      },
    );
    await graphql("mutation($id: ID!) { deleteDiscussion(input: { id: $id }) { clientMutationId } }", { id: discussion.node_id });
    // Posted again by the workflow, which starts no workflow: its state label is set here (new-label.mjs).
    if (discussion.category?.name !== "Announcements") await labelNew(graphql, event.repository.owner.login, event.repository.name, made.createDiscussion.discussion.id);
  }
  log("removed and posted again without it");
  return "removed";
}
