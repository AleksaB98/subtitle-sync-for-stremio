// Run by .github/workflows/guard.yml on every new or edited discussion and reply: the work itself is in run.mjs.
// Never prints a post's text.
import { readFileSync } from "node:fs";
import { runGuard } from "./run.mjs";

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

await runGuard(event, graphql);
