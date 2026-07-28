/**
 * Plugin contoh tipe CONNECTOR (blueprint §5: integrasi service luar ala MCP).
 * Connector expose object client yang dipanggil orchestrator sebagai service
 * eksternal "hackernews-connector.hn" (method: top, search).
 */
export function register(ctx) {
  ctx.connectors.register({
    name: 'hn',
    description: 'HackerNews reader (tanpa auth).',
    client: {
      async top({ count = 5 } = {}) {
        const res = await ctx.http(`https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${count}`);
        const data = await res.json();
        return data.hits.map((h, i) => `${i + 1}. ${h.title} (${h.points} poin) — https://news.ycombinator.com/item?id=${h.objectID}`).join('\n');
      },
      async search({ query, count = 5 }) {
        if (!query) throw new Error('param "query" wajib');
        const res = await ctx.http(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${count}`);
        const data = await res.json();
        return data.hits.map((h) => `${h.title} — ${h.url || ('https://news.ycombinator.com/item?id=' + h.objectID)}`).join('\n');
      },
    },
  });
}
