// Run by .github/workflows/guard.yml on every new or edited discussion and reply. A post holding a link
// with someone's setup in it or a key is deleted (an edit would leave it in the public edit history) and
// posted again without it, naming its author. Never prints a post's text.
import { readFileSync } from "node:fs";
import { cleaned, findSecrets, noteFor } from "./patterns.mjs";

const token = process.env.GITHUB_TOKEN;
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GitHub answered ${res.status}: ${JSON.stringify(json.errors ?? json.message)}`);
  return json.data;
}

const comment = event.comment;
const discussion = event.discussion;
const post = comment ?? discussion;
const text = comment ? comment.body : `${discussion.title}\n${discussion.body}`;
const found = findSecrets(text);
if (found.length === 0) {
  console.log("nothing to remove");
  process.exit(0);
}
console.log(`removing a ${comment ? "reply" : "discussion"} by ${post.user.login}: ${found.map((f) => f.kind).join(", ")}`);
const note = noteFor(post.user.login, found);

if (comment) {
  const { node } = await graphql(
    "query($id: ID!) { node(id: $id) { ... on DiscussionComment { replyTo { id } } } }",
    { id: comment.node_id },
  );
  await graphql("mutation($id: ID!) { deleteDiscussionComment(input: { id: $id }) { clientMutationId } }", { id: comment.node_id });
  await graphql(
    "mutation($d: ID!, $r: ID, $body: String!) { addDiscussionComment(input: { discussionId: $d, replyToId: $r, body: $body }) { clientMutationId } }",
    { d: discussion.node_id, r: node?.replyTo?.id ?? null, body: `${note}\n\n---\n\n${cleaned(comment.body, found)}` },
  );
} else {
  await graphql("mutation($id: ID!) { deleteDiscussion(input: { id: $id }) { clientMutationId } }", { id: discussion.node_id });
  await graphql(
    "mutation($repo: ID!, $cat: ID!, $title: String!, $body: String!) { createDiscussion(input: { repositoryId: $repo, categoryId: $cat, title: $title, body: $body }) { discussion { number } } }",
    {
      repo: event.repository.node_id,
      cat: discussion.category.node_id,
      title: cleaned(discussion.title, found),
      body: `${note}\n\n---\n\n${cleaned(discussion.body, found)}`,
    },
  );
}
console.log("removed and posted again without it");
