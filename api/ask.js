// api/ask.js  (Vercel serverless handler, Node 18+)
// Simple free Fusion Agent: parallel free web scrapers + basic fusion
import { JSDOM } from "jsdom";

function cleanText(html) {
  if (!html) return "";
  try {
    const dom = new JSDOM(html);
    const text = dom.window.document.body.textContent || "";
    return text.replace(/\s+/g, " ").trim();
  } catch (e) {
    return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  }
}

async function safeFetch(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/118 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await resp.text();
    return { ok: true, status: resp.status, text };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const CHANNELS = {
  general: [
    { id: "duckduckgo", url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` },
    { id: "bing", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
    { id: "brave", url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}` },
    { id: "wikipedia", url: (q) => `https://en.wikipedia.org/wiki/${encodeURIComponent(q.replace(/\s+/g, "_"))}` },
  ],
  flights: [
    { id: "duckduckgo", url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q + " flights")}` },
    { id: "google_preview", url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q + " flights")}` },
    { id: "skyscanner", url: (q) => `https://www.skyscanner.net/search?keywords=${encodeURIComponent(q)}` },
  ],
  deals: [
    { id: "google_shopping", url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q + " best price")}` },
    { id: "slickdeals", url: (q) => `https://slickdeals.net/newsearch.php?q=${encodeURIComponent(q)}` },
    { id: "ebay", url: (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}` },
  ],
  sports: [
    { id: "espn", url: (q) => `https://www.espn.com/search/results?q=${encodeURIComponent(q)}` },
    { id: "bbc_sport", url: (q) => `https://www.bbc.co.uk/sport/search?q=${encodeURIComponent(q)}` },
    { id: "duckduckgo", url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q + " sports")}` },
  ],
  research: [
    { id: "arxiv", url: (q) => `https://arxiv.org/search/?query=${encodeURIComponent(q)}&searchtype=all` },
    { id: "semantic", url: (q) => `https://www.semanticscholar.org/search?q=${encodeURIComponent(q)}` },
    { id: "pubmed", url: (q) => `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(q)}` },
  ],
  finance: [
    { id: "yahoo_finance", url: (q) => `https://finance.yahoo.com/lookup?s=${encodeURIComponent(q)}` },
    { id: "marketwatch", url: (q) => `https://www.marketwatch.com/search?q=${encodeURIComponent(q)}` },
    { id: "investing", url: (q) => `https://www.investing.com/search/?q=${encodeURIComponent(q)}` },
  ],
};

function authorityFor(id) {
  const map = { arxiv: 0.95, pubmed: 0.95, semantic: 0.9, wikipedia: 0.9, yahoo_finance: 0.8 };
  return map[id] || 0.5;
}

export default async function handler(req) {
  // Vercel serverless signature: req, res
  const { method, body, query } = req;
  // support both GET q= and POST JSON {domain,query}
  let domain, q;
  if (method === "GET") {
    domain = (query.domain || "general");
    q = query.q;
  } else {
    domain = (body && body.domain) || "general";
    q = body && body.query;
  }
  if (!q) return new Response(JSON.stringify({ error: "query required" }), { status: 400 });

  const channels = CHANNELS[domain] || CHANNELS.general;

  // fetch in parallel
  const fetches = channels.map(async (ch) => {
    const url = typeof ch.url === "function" ? ch.url(q) : ch.url;
    const r = await safeFetch(url);
    const text = r.ok ? cleanText(r.text).slice(0, 3000) : "";
    const matchScore = r.ok && text.toLowerCase().includes(q.toLowerCase()) ? 1 : 0;
    return {
      id: ch.id,
      url,
      ok: r.ok,
      status: r.status || null,
      error: r.error || null,
      snippet: text,
      matchScore,
      authority: authorityFor(ch.id),
    };
  });

  const results = await Promise.all(fetches);
  const ranked = results.filter(r => r.ok).map(r => ({ ...r, rank: r.matchScore * r.authority })).sort((a,b)=>b.rank-a.rank);

  const top = ranked.slice(0,5);
  const executive = top.map(t => t.snippet.slice(0,300)).join(" ... ");
  const findings = top.flatMap(t=>t.snippet.split(".").slice(0,2).map(s=>s.trim()).filter(Boolean)).slice(0,6).map((s,i)=>({text:s, cite: top[i%top.length]?.id || null}));

  const appendix = ranked.map(r=>({id:r.id,url:r.url,authority:r.authority,status:r.status}));

  const confidence = Math.round(Math.min(100, (top.reduce((s,r)=>s+r.rank,0)/(top.length||1))*100));

  const answer = {
    executive_summary: executive || "No strong evidence found.",
    confidence,
    key_findings: findings,
    detailed_analysis: `Searched ${ranked.length} channels, top sources: ${top.map(t=>t.id).join(", ")}`,
    appendix,
    probe: "Would you like a deeper dive on any result?"
  };

  return new Response(JSON.stringify({ query: q, domain, answer }), { status: 200, headers: { "Content-Type": "application/json" }});
}
