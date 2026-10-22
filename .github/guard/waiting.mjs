// Run daily by .github/workflows/waiting.yml: the discussions that wait for the repository's owner, by their
// state label (new, in progress, needs info, solved, closed; for suggestions considering, planned, in development,
// done, not planned), posted to the Discord server's #mod-alerts through its webhook (the secret
// MOD_ALERTS_WEBHOOK, which can only post in that one channel). The Discord server's own posts in #setup-help,
// #subtitle-problems and #suggestions get the same list, by the same rules, from the addon server
// (src/community/digest.ts). Nothing is posted when none waits.

const DAY_MS = 24 * 3_600_000;
export const HEADING = "Waiting for an answer on GitHub:";
/** The state labels, every category together; a discussion carries one. */
export const STATES = ["new", "in progress", "needs info", "solved", "closed", "considering", "planned", "in development", "done", "not planned"];
/** Finished: listed again only when someone writes after the last answer (reopened). */
const FINISHED = new Set(["solved", "closed", "done", "not planned"]);

/**
 * Why a discussion waits for the owner, or null (the same rules as the Discord list):
 * new and not answered; someone wrote after the owner's last answer (any state: an answer to "needs info", a
 * finished one reopened); "in progress" with no word from the owner for 3 days (a suggestion may stay "considering" for weeks); "needs info" with
 * no answer for 7 days ("close?"). A marked answer counts as finished.
 * @param {string | undefined} state
 * @param {{ login: string | undefined, at: number }[]} posts the discussion itself and every comment and reply
 * @param {string} owner
 * @param {number} now
 */
export function waitsFor(state, posts, owner, now) {
  const answers = posts.filter((p) => p.login === owner).map((p) => p.at);
  const others = posts.filter((p) => p.login !== owner).map((p) => p.at);
  const lastAnswer = Math.max(-Infinity, ...answers);
  const lastOther = Math.max(-Infinity, ...others);
  if (lastOther > lastAnswer) return lastAnswer === -Infinity ? "new" : "the asker wrote";
  // Still "new" after an answer: its state was not moved on, so it is named until it is.
  if (state === "new") return "new";
  if (state === undefined) return lastAnswer === -Infinity ? "new" : null;
  // Counted from the last answer, or from the post when none came yet. A suggestion may stay "considering" for weeks.
  const since = Number.isFinite(lastAnswer) ? lastAnswer : Math.min(...posts.map((p) => p.at));
  const days = Math.floor((now - since) / DAY_MS);
  if (state === "in progress" && days >= 3) return `no update for ${days} days`;
  if (state === "needs info" && days >= 7) return `no answer for ${days} days: close?`;
  return null;
}

/**
 * The waiting discussions, oldest first, as lines with why and their links; not announcements, nor the owner's own.
 * @param {{ title: string, url: string, createdAt: string, category: { name: string }, answer: unknown, author: { login: string } | null, labels?: { nodes: { name: string }[] }, comments: { nodes: { author: { login: string } | null, createdAt: string, replies: { nodes: { author: { login: string } | null, createdAt: string }[] } }[] } }[]} discussions
 * @param {string} owner
 * @param {number} now
 */
export function waitingLines(discussions, owner, now) {
  const lines = [];
  for (const d of discussions) {
    if (d.category.name === "Announcements" || d.author?.login === owner) continue;
    const labelled = (d.labels?.nodes ?? []).map((l) => l.name).find((name) => STATES.includes(name));
    const state = labelled ?? (d.answer ? "solved" : undefined);
    const posts = [
      { login: d.author?.login, at: Date.parse(d.createdAt) },
      ...d.comments.nodes.flatMap((c) => [{ login: c.author?.login, at: Date.parse(c.createdAt) }, ...c.replies.nodes.map((r) => ({ login: r.author?.login, at: Date.parse(r.createdAt) }))]),
    ];
    const why = waitsFor(state, posts, owner, now);
    if (!why || (state !== undefined && FINISHED.has(state) && why !== "the asker wrote")) continue;
    const hours = Math.floor((now - Date.parse(d.createdAt)) / 3_600_000);
    const age = hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} h`;
    lines.push({ at: Date.parse(d.createdAt), line: `- ${d.title} (${why}${state ? `, ${state}` : ""}, ${age} old): ${d.url}` });
  }
  return lines.sort((a, b) => a.at - b.at).map((l) => l.line);
}

async function main() {
  const [owner, name] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${process.env.GITHUB_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { discussions(first: 50, orderBy: { field: CREATED_AT, direction: DESC }) { nodes {
        title url createdAt category { name } answer { id } author { login } labels(first: 10) { nodes { name } }
        comments(first: 50) { nodes { author { login } createdAt replies(first: 50) { nodes { author { login } createdAt } } } }
      } } } }`,
      variables: { owner, name },
    }),
  });
  const json = await response.json();
  if (!response.ok || json.errors) throw new Error(`GitHub answered ${response.status}`);
  const lines = waitingLines(json.data.repository.discussions.nodes, owner, Date.now());
  console.log(`${lines.length} waiting`);
  // Started by hand with "test": one line, so the webhook is seen to work.
  const test = process.env.WEBHOOK_TEST === "true";
  // A secret pasted from Windows may carry a byte-order mark or a line end.
  const hook = (process.env.MOD_ALERTS_WEBHOOK ?? "").replace(/^﻿/, "").trim();
  if ((lines.length === 0 && !test) || !hook) return;
  const content = lines.length ? [HEADING, ...lines].join("\n") : "GitHub waiting list: the webhook works (a test; nothing waits).";
  const sent = await fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }),
  });
  if (!sent.ok) throw new Error(`Discord answered ${sent.status}`);
}

if (process.argv[1]?.endsWith("waiting.mjs")) await main();
