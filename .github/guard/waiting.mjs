// Run daily by .github/workflows/waiting.yml: the discussions that have waited a day or more without an
// answer from the repository's owner, posted to the Discord server's #mod-alerts through its webhook (the
// secret MOD_ALERTS_WEBHOOK, which can only post in that one channel). The Discord server's own #help
// posts get the same list from the addon server. Nothing is posted when none waits.

const DAY_MS = 24 * 3_600_000;
export const HEADING = "Waiting for an answer on GitHub (24 h or more):";

/**
 * The waiting discussions, oldest first, as lines with their links: not announcements, no marked answer,
 * a day old or more, and no reply from the owner (in a comment or a reply to one).
 * @param {{ title: string, url: string, createdAt: string, category: { name: string }, answer: unknown, author: { login: string } | null, comments: { nodes: { author: { login: string } | null, replies: { nodes: { author: { login: string } | null }[] } }[] } }[]} discussions
 * @param {string} owner
 * @param {number} now
 */
export function waitingLines(discussions, owner, now) {
  return discussions
    .filter((d) => d.category.name !== "Announcements" && !d.answer && d.author?.login !== owner)
    .filter((d) => now - Date.parse(d.createdAt) >= DAY_MS)
    .filter((d) => !d.comments.nodes.some((c) => c.author?.login === owner || c.replies.nodes.some((r) => r.author?.login === owner)))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((d) => {
      const hours = Math.floor((now - Date.parse(d.createdAt)) / 3_600_000);
      return `- ${d.title} (${hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} h`}): ${d.url}`;
    });
}

async function main() {
  const [owner, name] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${process.env.GITHUB_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { discussions(first: 50, orderBy: { field: CREATED_AT, direction: DESC }) { nodes {
        title url createdAt category { name } answer { id } author { login }
        comments(first: 50) { nodes { author { login } replies(first: 50) { nodes { author { login } } } } }
      } } } }`,
      variables: { owner, name },
    }),
  });
  const json = await response.json();
  if (!response.ok || json.errors) throw new Error(`GitHub answered ${response.status}`);
  const lines = waitingLines(json.data.repository.discussions.nodes, owner, Date.now());
  console.log(`${lines.length} waiting`);
  if (lines.length === 0 || !process.env.MOD_ALERTS_WEBHOOK) return;
  const sent = await fetch(process.env.MOD_ALERTS_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: [HEADING, ...lines].join("\n").slice(0, 2000), allowed_mentions: { parse: [] } }),
  });
  if (!sent.ok) throw new Error(`Discord answered ${sent.status}`);
}

if (process.argv[1]?.endsWith("waiting.mjs")) await main();
