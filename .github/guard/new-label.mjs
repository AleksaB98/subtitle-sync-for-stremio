// Run by .github/workflows/guard.yml on a new discussion: it gets the state label "new" (nobody has looked yet),
// the first of the ticket states (new, in progress, needs info, solved, closed; for suggestions considering, planned,
// in development, done, not planned). Not on announcements. A discussion the guard took down and posted again gets
// its label from guard.mjs (a post made by the workflow starts no workflow).
import { readFileSync } from "node:fs";

/** Labels the discussion `id` with "new" in repository owner/name. Returns false when there is no such label. */
export async function labelNew(graphql, owner, name, id) {
  const { repository } = await graphql(
    'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { label(name: "new") { id } } }',
    { owner, name },
  );
  if (!repository.label) return false;
  await graphql("mutation($id: ID!, $labels: [ID!]!) { addLabelsToLabelable(input: { labelableId: $id, labelIds: $labels }) { clientMutationId } }", { id, labels: [repository.label.id] });
  return true;
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const discussion = event.discussion;
  if (!discussion || discussion.category?.name === "Announcements") return;
  const graphql = async (query, variables) => {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `bearer ${process.env.GITHUB_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (!res.ok || json.errors) throw new Error(`GitHub answered ${res.status}`);
    return json.data;
  };
  try {
    const done = await labelNew(graphql, event.repository.owner.login, event.repository.name, discussion.node_id);
    console.log(done ? "labelled new" : "the label new does not exist");
  } catch (error) {
    // Taken down by the guard a moment ago: its new post was labelled there.
    console.log(`not labelled: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (process.argv[1]?.endsWith("new-label.mjs")) await main();
