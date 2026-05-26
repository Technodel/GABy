/**
 * SUNy URL Fetch Tool â€” fetches web pages, API responses, or raw content
 * from any URL and converts it to readable text for the AI.
 *
 * No external dependencies: uses native fetch() (Node 18+) and regex-based
 * HTML-to-text conversion.
 *
 * Registered as a server-side tool (does NOT use the bridge).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { userClientManager } from './user-client-manager';
import { narrateMessage } from './narrator';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Types
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type FetchResult = {
  content: string;
  contentType: string;
  url: string;
  status: number;
  truncated: boolean;
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// HTML â†’ text conversion (no dependencies)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function htmlToText(html: string): string {
  // Remove script and style blocks
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Replace <br>, <p>, <div>, <li>, <tr> with newlines
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<h[1-6][^>]*>/gi, '\n## ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\nâ€¢ ')
    .replace(/<th[^>]*>/gi, '\n| ')
    .replace(/<td[^>]*>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n');

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));

  // Collapse multiple blank lines into max 2
  text = text.replace(/\n{3,}/g, '\n\n');

  // Trim each line
  text = text.split('\n').map(l => l.trim()).join('\n');

  return text.trim();
}

function formatJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Content type detection
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function isHtml(contentType: string): boolean {
  return /text\/html|application\/xhtml|text\/x?htm/i.test(contentType);
}

function isJson(contentType: string): boolean {
  return /application\/json|text\/json/i.test(contentType);
}

function isPlainText(contentType: string): boolean {
  return /text\/plain|text\/markdown|text\/x?md|application\/octet-stream/i.test(contentType);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Fetch with timeout
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function fetchWithTimeout(
  urlStr: string,
  timeoutMs: number,
  maxBytes: number,
  userId?: number,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(urlStr, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; SUNyBot/1.0; +https://suny.technodel.tech)',
        Accept: 'text/html,application/json,*/*',
      },
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') || 'text/plain';
    const contentLength = response.headers.get('content-length');
    let estimatedSize = contentLength ? parseInt(contentLength, 10) : 0;

    // Read body as text (up to maxBytes)
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let truncated = false;

    const decoder = new TextDecoder();
    if (reader) {
      let lastPushBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalBytes += value.length;
        // Push progress narration every ~50KB so the user sees download activity
        if (userId && (totalBytes - lastPushBytes >= 51200 || totalBytes > maxBytes)) {
          lastPushBytes = totalBytes;
          userClientManager.pushNarration(userId, narrateMessage('', 'url_fetch_progress', { bytes: totalBytes }));
        }
        if (totalBytes > maxBytes) {
          truncated = true;
          break;
        }
      }
      reader.cancel().catch(() => {});
    }

    clearTimeout(timeoutId);

    const fullBuffer = Buffer.concat(chunks);
    const rawContent = decoder.decode(fullBuffer, { stream: !truncated });

    let content: string;
    if (truncated) {
      // Trim to exact maxBytes
      const trimmed = rawContent.slice(0, maxBytes);
      if (isHtml(contentType)) {
        content = htmlToText(trimmed);
      } else if (isJson(contentType)) {
        try {
          content = formatJson(JSON.parse(trimmed));
        } catch {
          content = trimmed;
        }
      } else {
        content = trimmed;
      }
      content += `\n\n[...content truncated at ${Math.round(maxBytes / 1024)}KB â€” use range requests or refine URL for full content]`;
    } else if (isHtml(contentType)) {
      content = htmlToText(rawContent);
    } else if (isJson(contentType)) {
      try {
        content = formatJson(JSON.parse(rawContent));
      } catch {
        content = rawContent;
      }
    } else {
      content = rawContent;
    }

    return {
      content,
      contentType,
      url: response.url,
      status: response.status,
      truncated,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Tool factory
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function createUrlFetchTool(userId?: number) {
  return tool({
    description:
      'Fetch the content of a URL (web page, API endpoint, raw file, documentation page, etc.). ' +
      'Returns the content as readable text â€” HTML pages are automatically converted to plain text. ' +
      'JSON responses are pretty-printed. Use this when you need to read documentation, check API ' +
      'responses, download configuration files, or access any online resource. ' +
      'Maximum response size: 512KB (content beyond that is truncated with a notice).',
    inputSchema: z.object({
      url: z
        .string()
        .url()
        .describe(
          'The URL to fetch (must include protocol, e.g. https://example.com/page).',
        ),
      timeout_ms: z
        .number()
        .int()
        .min(5_000)
        .max(120_000)
        .optional()
        .default(30_000)
        .describe('Timeout in milliseconds (5000â€“120000, default 30000).'),
    }),
    execute: async ({ url, timeout_ms }) => {
      // Push start narration
      if (userId) {
        userClientManager.pushNarration(userId, narrateMessage('', 'url_fetch', { url }));
      }
      try {
        const result = await fetchWithTimeout(url, timeout_ms, 524_288, userId); // 512KB

        let heading = `ðŸ“„ Fetched: ${result.url}`;
        if (result.status >= 400) {
          heading = `âš ï¸ HTTP ${result.status} for: ${result.url}`;
        }

        const meta = [
          heading,
          `Status: ${result.status}`,
          `Content-Type: ${result.contentType}`,
          result.truncated ? 'âš ï¸ Response was truncated (512KB limit)' : '',
        ]
          .filter(Boolean)
          .join(' Â· ');

        return `${meta}\n\n${result.content}`;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return `â±ï¸ Request timed out after ${(timeout_ms / 1000).toFixed(0)}s: ${url}`;
        }
        return `âŒ Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
