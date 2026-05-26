/**
 * SUNy Web Search Tool â€” searches the web using configurable backends.
 *
 * Providers (checked in order):
 *   1. Tavily (requires TAVILY_API_KEY env var) â€” best for AI agents
 *   2. SerpAPI (requires SERPAPI_KEY env var)
 *   3. Fallback: DuckDuckGo HTML scrape (no key needed, limited)
 *
 * Registered as a server-side tool (does NOT use the bridge).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getAdapter } from './db';

// Lazy-read a search API key from app_settings (fallback when env var is missing)
async function getDbKey(settingKey: string): Promise<string | undefined> {
  try {
    const db = getAdapter();
    const row = await db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [settingKey]);
    return row?.value || undefined;
  } catch {
    return undefined;
  }
}

// -- Result formatting --------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
}

function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) return `No results found for "${query}".`;

  const lines: string[] = [
    `â—ˆâ—ˆâ—ˆ Web search results for: ${query} â—ˆâ—ˆâ—ˆ`,
    '',
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`  ${i + 1}. ${r.title}`);
    lines.push(`     ${r.url}`);
    lines.push(`     ${r.snippet}`);
    if (r.content) lines.push(`     â”€â”€ ${r.content.slice(0, 300)}`);
    lines.push('');
  }

  lines.push(`â”€â”€ ${results.length} result(s) â”€â”€`);
  return lines.join('\n');
}

// -- Tavily provider ----------------------------------------------------------

async function searchTavily(
  query: string,
  maxResults: number,
): Promise<SearchResult[] | null> {
  const key = process.env['TAVILY_API_KEY'];
  if (!key) return null;

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: Math.min(maxResults, 10),
        include_answer: false,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      results?: Array<{
        title: string;
        url: string;
        content: string;
      }>;
    };

    return (data.results || []).map((r) => ({
      title: r.title || '(no title)',
      url: r.url,
      snippet: r.content?.slice(0, 250) || '(no content)',
      content: r.content,
    }));
  } catch {
    return null;
  }
}

// -- SerpAPI provider --------------------------------------------------------

async function searchSerpApi(
  query: string,
  maxResults: number,
): Promise<SearchResult[] | null> {
  const key = process.env['SERPAPI_KEY'] || await getDbKey('serpapi_key');
  if (!key) return null;

  try {
    const url = new URL('https://serpapi.com/search');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', key);
    url.searchParams.set('num', String(Math.min(maxResults, 10)));

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      organic_results?: Array<{
        title: string;
        link: string;
        snippet: string;
      }>;
    };

    return (data.organic_results || []).map((r) => ({
      title: r.title || '(no title)',
      url: r.link,
      snippet: r.snippet || '(no snippet)',
    }));
  } catch {
    return null;
  }
}

// -- Serper provider (serper.dev) --------------------------------------------

async function searchSerper(
  query: string,
  maxResults: number,
): Promise<SearchResult[] | null> {
  const key = process.env['SERPER_API_KEY'] || await getDbKey('serper_api_key');
  if (!key) return null;

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num: Math.min(maxResults, 10),
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      organic?: Array<{
        title: string;
        link: string;
        snippet: string;
      }>;
    };

    return (data.organic || []).map((r) => ({
      title: r.title || '(no title)',
      url: r.link,
      snippet: r.snippet || '(no snippet)',
    }));
  } catch {
    return null;
  }
}

// -- DuckDuckGo fallback (no API key needed) ---------------------------------

async function searchDuckDuckGo(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  try {
    // Use DuckDuckGo Instant Answer API
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('skip_disambig', '1');

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as {
      AbstractText?: string;
      AbstractSource?: string;
      AbstractURL?: string;
      Results?: Array<{ Text: string; FirstURL: string }>;
      RelatedTopics?: Array<{ Text: string; FirstURL: string; Topics?: Array<{ Text: string; FirstURL: string }> }>;
    };

    const results: SearchResult[] = [];

    // Abstract result (featured snippet)
    if (data.AbstractText) {
      results.push({
        title: data.AbstractSource || 'Featured',
        url: data.AbstractURL || '',
        snippet: data.AbstractText.slice(0, 300),
      });
    }

    // Standard results
    if (data.Results) {
      for (const r of data.Results) {
        if (results.length >= maxResults) break;
        results.push({
          title: r.Text?.split(' - ')[0] || r.Text,
          url: r.FirstURL,
          snippet: r.Text || '',
        });
      }
    }

    // Related topics
    if (data.RelatedTopics && results.length < maxResults) {
      for (const t of data.RelatedTopics) {
        if (results.length >= maxResults) break;
        if (t.Topics) {
          for (const subt of t.Topics) {
            if (results.length >= maxResults) break;
            results.push({
              title: subt.Text?.split(' - ')[0] || subt.Text,
              url: subt.FirstURL,
              snippet: subt.Text || '',
            });
          }
        } else if (t.Text) {
          results.push({
            title: t.Text?.split(' - ')[0] || t.Text,
            url: t.FirstURL,
            snippet: t.Text || '',
          });
        }
      }
    }

    return results;
  } catch {
    return [];
  }
}

// -- Tool factory -------------------------------------------------------------

export function createWebSearchTool() {
  return tool({
    description:
      'Search the web for current information. Use this when you need up-to-date data, documentation, news, API references, or any information the model was not trained on. Supports Tavily (best), SerpAPI, or DuckDuckGo fallback â€” no configuration needed for basic usage.',
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(500)
        .describe('The search query. Be specific for best results.'),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(5)
        .describe('Maximum number of search results to return (1-10).'),
    }),
    execute: async ({ query, max_results }) => {
      // Providers checked in priority order
      const providers: Array<{
        name: string;
        fn: () => Promise<SearchResult[] | null>;
      }> = [
        { name: 'Tavily', fn: () => searchTavily(query, max_results) },
        { name: 'Serper', fn: () => searchSerper(query, max_results) },
        { name: 'SerpAPI', fn: () => searchSerpApi(query, max_results) },
        {
          name: 'DuckDuckGo',
          fn: () => searchDuckDuckGo(query, max_results),
        },
      ];

      for (const provider of providers) {
        try {
          const results = await provider.fn();
          if (results && results.length > 0) {
            console.log(
              `[web-search] ${provider.name} returned ${results.length} results for: "${query.slice(0, 60)}"`,
            );
            return formatResults(results, query);
          }
        } catch {
          // Try next provider
        }
      }

      return `No search results found for "${query}" from any provider.`;
    },
  });
}
