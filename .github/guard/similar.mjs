// Run by .github/workflows/guard.yml on every new discussion, after the guard: the earlier discussions that
// look like it (same words, read the way the Discord server's forms read them) get listed in one comment, so
// the asker can continue there, and the owner is told in the Discord server's #mod-alerts (the secret
// MOD_ALERTS_WEBHOOK). Nothing happens when none looks alike. Never prints a post's text.
import { readFileSync } from "node:fs";

/** Words too common to tell posts apart (the same list as the addon server's src/community/words.ts). */
const COMMON = new Set([
  "about", "after", "again", "also", "and", "any", "are", "back", "been", "but", "can", "cannot", "could", "did", "does", "doesn",
  "don", "each", "even", "every", "for", "from", "get", "gets", "got", "has", "have", "here", "how", "into", "its", "just", "like",
  "more", "most", "much", "need", "not", "now", "only", "other", "all", "yes", "had", "may", "off", "his", "her", "our", "out", "same", "see", "should", "some", "still", "than",
  "that", "the", "them", "then", "there", "they", "this", "time", "too", "use", "used", "very", "want", "was", "way", "what", "when",
  "where", "which", "while", "who", "why", "will", "with", "work", "works", "would", "you", "your", "addon", "subtitle", "subtitles",
  "stremio", "sync", "synced", "please", "help", "thanks", "thank", "problem", "question", "it's", "i'm",
]);
const SAME = { sec: "second", secs: "second", subs: "", sub: "", ep: "episode", eps: "episode", tvs: "tv" };

function stem(word) {
  if (word in SAME) return SAME[word];
  for (const end of ["ing", "ed", "es", "s"]) {
    if (word.endsWith(end) && word.length - end.length >= 4) return word.slice(0, -end.length);
  }
  return word;
}

/** A post's words in one form each: lower case, accents off, three letters or more, common ones left out; "tv" kept. */
export function stemsOf(text) {
  const out = new Set();
  for (const word of text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9']+/)) {
    if (word.length < 3 || COMMON.has(word)) continue;
    const s = stem(word);
    if (s) out.add(s);
  }
  if (/\btvs?\b/i.test(text)) out.add("tv");
  return out;
}

/**
 * The earlier discussions most like a new one, best first (at most 3). A title word counts double. Similar:
 * three shared words or more making up 40% of the shorter post's words, or two making up 60%, or the
 * titles sharing two words or more that are most of both.
 * @template {{ title: string, body: string }} T
 * @param {{ title: string, body: string }} mine
 * @param {T[]} earlier
 * @returns {T[]}
 */
export function similarDiscussions(mine, earlier, max = 3) {
  const words = stemsOf(`${mine.title}\n${mine.body}`);
  const title = stemsOf(mine.title);
  if (words.size === 0) return [];
  return earlier
    .flatMap((post) => {
      const theirTitle = stemsOf(post.title);
      const theirs = new Set([...stemsOf(post.body), ...theirTitle]);
      const shared = [...words].filter((w) => theirs.has(w)).length;
      const sharedTitle = [...title].filter((w) => theirTitle.has(w)).length;
      const overlap = shared / Math.min(words.size, theirs.size);
      const titles = title.size && theirTitle.size ? sharedTitle / Math.max(title.size, theirTitle.size) : 0;
      const similar = (shared >= 3 && overlap >= 0.4) || (shared >= 2 && overlap >= 0.6) || (sharedTitle >= 2 && titles >= 0.6);
      return similar ? [{ post, score: shared + sharedTitle + overlap }] : [];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((m) => m.post);
}

/** The comment under the new discussion. */
export function commentFor(matches) {
  return [
    "These discussions look similar:",
    ...matches.map((d) => `- #${d.number} ${d.title}${d.isAnswered ? " (answered)" : d.closed ? " (closed)" : ""}`),
    "",
    "If one of them is the same, please continue there; this one may be closed as a duplicate.",
  ].join("\n");
}

async function post(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${process.env.GITHUB_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`GitHub answered ${res.status}: ${JSON.stringify(json.message ?? json.errors)}`);
  return json;
}

async function graphql(query, variables) {
  const json = await post(query, variables);
  if (json.errors) throw new Error(`GitHub answered: ${JSON.stringify(json.errors)}`);
  return json.data;
}

/**
 * Whether the discussion is still there, from GitHub's answer to `node(id:)`. A removed one is answered with a
 * NOT_FOUND error, not an empty node (2026-10-23: every run after the guard removed a post ended red here).
 */
export function stillThere(answer) {
  const errors = answer.errors ?? [];
  if (errors.length > 0 && errors.every((e) => e.type === "NOT_FOUND")) return false;
  if (errors.length > 0) throw new Error(`GitHub answered: ${JSON.stringify(errors)}`);
  return Boolean(answer.data?.node);
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const discussion = event.discussion;
  if (event.action !== "created" || !discussion || event.comment) return;
  if (discussion.category?.name === "Announcements") return console.log("an announcement: not checked");
  // The guard may have removed it (a link or key in it): its new copy is not checked.
  if (!stillThere(await post("query($id: ID!) { node(id: $id) { id } }", { id: discussion.node_id }))) return console.log("removed by the guard: not checked");

  // Every earlier discussion, 100 a page.
  const [owner, name] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  const all = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const { repository } = await graphql(
      `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) {
        discussions(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes { id number title body url isAnswered closed category { name } }
        } } }`,
      { owner, name, after },
    );
    all.push(...repository.discussions.nodes);
    if (!repository.discussions.pageInfo.hasNextPage) break;
    after = repository.discussions.pageInfo.endCursor;
  }
  const earlier = all.filter((d) => d.id !== discussion.node_id && d.category.name !== "Announcements");
  const matches = similarDiscussions({ title: discussion.title, body: discussion.body ?? "" }, earlier);
  console.log(`${matches.length} similar of ${earlier.length}`);
  if (matches.length === 0) return;
  await graphql("mutation($d: ID!, $body: String!) { addDiscussionComment(input: { discussionId: $d, body: $body }) { clientMutationId } }", { d: discussion.node_id, body: commentFor(matches) });
  const hook = (process.env.MOD_ALERTS_WEBHOOK ?? "").replace(/^﻿/, "").trim();
  if (!hook) return;
  const sent = await fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `GitHub: ${discussion.html_url} looks like ${matches.map((d) => d.url).join(" ")}`.slice(0, 2000), allowed_mentions: { parse: [] } }),
  });
  if (!sent.ok) throw new Error(`Discord answered ${sent.status}`);
}

if (process.argv[1]?.endsWith("similar.mjs")) await main();
