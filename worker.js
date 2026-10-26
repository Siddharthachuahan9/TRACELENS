// Site Worker for tracelens.site.
//
// Serves docs/ as before and adds markdown twins for AI agents, following the
// Dualmark AEO Spec 1.0 (https://dualmark.dev/docs/spec/overview):
//   - every page has a twin at <url>.md  ("/" -> "/index.md", "/blog/" -> "/blog.md")
//   - a client that prefers text/markdown in its Accept header gets the twin
//   - HTML responses carry  Link: <twin>; rel="alternate"; type="text/markdown"
//   - twin responses carry the required headers (see markdownResponse)
//   - everything else (css, js, images, redirects) passes straight through to the assets.
// No dependencies, on purpose: this repo has none.

const AEO_VERSION = "1.0";
const CACHE_CONTROL = "public, max-age=3600";

// Agents that may be served markdown even when they do not ask for it explicitly (spec §3, MAY).
const AI_AGENTS = [
  /GPTBot/i, /ChatGPT-User/i, /OAI-SearchBot/i,
  /ClaudeBot/i, /Claude-User/i, /Claude-SearchBot/i, /anthropic-ai/i,
  /PerplexityBot/i, /Perplexity-User/i,
  /Google-Extended/i, /Applebot-Extended/i, /meta-externalagent/i,
  /Amazonbot/i, /Bytespider/i, /CCBot/i, /cohere-ai/i, /DuckAssistBot/i, /MistralAI-User/i, /YouBot/i,
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.endsWith(".md")) return serveTwin(env, url, path);
    if (!isPage(path)) return env.ASSETS.fetch(request);

    const accept = request.headers.get("Accept") || "";
    const prefs = parseAccept(accept);
    const htmlQ = quality(prefs, "text/html");
    const mdQ = quality(prefs, "text/markdown");
    if (accept && htmlQ === 0 && mdQ === 0) return notAcceptable();

    const twinPath = toMarkdownPath(path);
    const twinUrl = new URL(twinPath, url.origin);
    const isAgent = AI_AGENTS.some((re) => re.test(request.headers.get("User-Agent") || ""));
    const wantsMarkdown = mdQ > htmlQ || (isAgent && mdQ > 0 && mdQ >= htmlQ);

    if (wantsMarkdown) {
      const twin = await env.ASSETS.fetch(new Request(twinUrl));
      if (twin.ok) return markdownResponse(await twin.text());
    }

    const res = await env.ASSETS.fetch(request);
    if (!(res.headers.get("Content-Type") || "").includes("text/html")) return res;

    const out = new Response(res.body, res);
    addVary(out.headers);
    const head = await env.ASSETS.fetch(new Request(twinUrl, { method: "HEAD" }));
    if (head.ok) out.headers.append("Link", `<${twinPath}>; rel="alternate"; type="text/markdown"`);
    return out;
  },
};

async function serveTwin(env, url, path) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
  if (res.ok) return markdownResponse(await res.text());
  return markdownResponse(`# Not found\n\nThere is no page at ${path}.\n`, 404);
}

function markdownResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Markdown-Tokens": String(Math.ceil(body.length / 4)),
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
      "X-AEO-Version": AEO_VERSION,
      "Cache-Control": CACHE_CONTROL,
      Vary: "Accept",
    },
  });
}

function notAcceptable() {
  return new Response("Not Acceptable. This URL is available as text/html or text/markdown.\n", {
    status: 406,
    headers: { "Content-Type": "text/plain; charset=utf-8", Vary: "Accept" },
  });
}

// A page is "/", anything ending in "/", or a last segment with no file extension.
function isPage(path) {
  if (path === "/" || path.endsWith("/")) return true;
  return !/\.[a-z0-9]+$/i.test(path.slice(path.lastIndexOf("/") + 1));
}

function toMarkdownPath(path) {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/index.md" : `${trimmed}.md`;
}

function parseAccept(accept) {
  return accept
    .split(",")
    .map((part) => {
      const [type, ...params] = part.trim().split(";");
      let q = 1;
      for (const p of params) {
        const [k, v] = p.trim().split("=");
        if (k === "q") q = Number.parseFloat(v);
      }
      return { type: type.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((p) => p.type);
}

// Quality of a media type under an Accept list: exact match beats text/*, which beats */*.
// No Accept header at all means no preference, so everything is acceptable.
function quality(prefs, type) {
  if (prefs.length === 0) return 1;
  const [major] = type.split("/");
  for (const candidate of [type, `${major}/*`, "*/*"]) {
    const hit = prefs.find((p) => p.type === candidate);
    if (hit) return hit.q;
  }
  return 0;
}

function addVary(headers) {
  const vary = headers.get("Vary");
  if (!vary) headers.set("Vary", "Accept");
  else if (!/\baccept\b/i.test(vary)) headers.set("Vary", `${vary}, Accept`);
}
