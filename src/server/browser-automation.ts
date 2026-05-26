/**
 * SUNy Browser Automation â€” Headless browser control for the agent.
 *
 * Allows SUNy to:
 *   - Take screenshots of web pages
 *   - Extract text content from pages
 *   - Fill forms and click buttons
 *   - Run JavaScript in the browser context
 *   - Generate PDF of pages
 *
 * Uses the bridge to execute browser commands via Playwright/Puppeteer
 * installed on the user's machine, or a built-in fetch-based approach
 * for simpler tasks.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { sendToBridge } from './bridge-manager';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface BrowserScreenshot {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface BrowserPageContent {
  url: string;
  title: string;
  text: string;
  html?: string;
}

export interface BrowserActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs: number;
}

// â”€â”€ Core operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Navigate to a URL and return the page content as text.
 * Falls back to simple fetch if bridge browser is unavailable.
 */
export async function browserNavigate(
  userId: number,
  url: string,
  options?: {
    waitForSelector?: string;
    waitMs?: number;
    extractText?: boolean;
    extractHtml?: boolean;
  },
): Promise<BrowserActionResult> {
  const start = Date.now();

  try {
    // First try via bridge (Playwright/Puppeteer)
    const result = await sendToBridge(userId, 'browser:navigate', {
      url,
      waitForSelector: options?.waitForSelector,
      waitMs: options?.waitMs ?? 2000,
      extractText: options?.extractText ?? true,
      extractHtml: options?.extractHtml ?? false,
    }, 60_000);

    return {
      success: true,
      data: result,
      durationMs: Date.now() - start,
    };
  } catch (bridgeErr) {
    // Fallback: simple fetch + text extraction
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUNyBrowser/1.0)' },
        signal: AbortSignal.timeout(15_000),
      });

      const html = await response.text();

      // Basic text extraction (strip tags)
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50_000);

      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);

      return {
        success: true,
        data: {
          url,
          title: titleMatch ? titleMatch[1].trim() : '',
          text,
          html: options?.extractHtml ? html.slice(0, 100_000) : undefined,
        } as BrowserPageContent,
        durationMs: Date.now() - start,
      };
    } catch (fetchErr) {
      return {
        success: false,
        error: `Bridge browser unavailable and fetch fallback failed: ${(fetchErr as Error).message}`,
        durationMs: Date.now() - start,
      };
    }
  }
}

/**
 * Take a screenshot of the current page.
 */
export async function browserScreenshot(
  userId: number,
  url: string,
  options?: {
    fullPage?: boolean;
    width?: number;
    height?: number;
  },
): Promise<BrowserActionResult> {
  const start = Date.now();

  try {
    const result = await sendToBridge(userId, 'browser:screenshot', {
      url,
      fullPage: options?.fullPage ?? false,
      width: options?.width ?? 1280,
      height: options?.height ?? 720,
    }, 60_000);

    return {
      success: true,
      data: result as BrowserScreenshot,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      error: `Screenshot failed: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Execute JavaScript in the browser context on the current page.
 */
export async function browserEvaluate(
  userId: number,
  url: string,
  script: string,
): Promise<BrowserActionResult> {
  const start = Date.now();

  try {
    const result = await sendToBridge(userId, 'browser:evaluate', {
      url,
      script,
    }, 30_000);

    return {
      success: true,
      data: result,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      error: `Script execution failed: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Fill a form field and optionally click a button/submit.
 */
export async function browserInteract(
  userId: number,
  url: string,
  actions: Array<{
    type: 'click' | 'fill' | 'select' | 'hover' | 'wait';
    selector: string;
    value?: string;
    waitMs?: number;
  }>,
): Promise<BrowserActionResult> {
  const start = Date.now();

  try {
    const result = await sendToBridge(userId, 'browser:interact', {
      url,
      actions,
    }, 60_000);

    return {
      success: true,
      data: result,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      error: `Interaction failed: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Generate a PDF of the current page.
 */
export async function browserPdf(
  userId: number,
  url: string,
): Promise<BrowserActionResult> {
  const start = Date.now();

  try {
    const result = await sendToBridge(userId, 'browser:pdf', {
      url,
    }, 60_000);

    return {
      success: true,
      data: result,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      error: `PDF generation failed: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }
}

// â”€â”€ Tool factory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function createBrowserTools(userId: number) {
  return {
    browser_navigate: tool({
      description: 'Navigate to a URL and extract the page text content. Use this to read web pages, documentation, or any online resource.',
      inputSchema: z.object({
        url: z.string().url().describe('The full URL to navigate to'),
        waitMs: z.number().optional().describe('Milliseconds to wait for page load (default: 2000)'),
        extractText: z.boolean().optional().describe('Extract readable text from the page (default: true)'),
      }),
      execute: async ({ url, waitMs, extractText }) => {
        const result = await browserNavigate(userId, url, { waitMs, extractText });
        if (!result.success) return `[Error] ${result.error}`;
        const data = result.data as BrowserPageContent;
        return data.text || '(No text content extracted)';
      },
    }),

    browser_screenshot: tool({
      description: 'Take a screenshot of a web page. Returns a base64-encoded image that can be analyzed.',
      inputSchema: z.object({
        url: z.string().url().describe('The full URL to screenshot'),
        fullPage: z.boolean().optional().describe('Capture the full page height (default: false)'),
      }),
      execute: async ({ url, fullPage }) => {
        const result = await browserScreenshot(userId, url, { fullPage });
        if (!result.success) return `[Error] ${result.error}`;
        return '(Screenshot captured successfully)';
      },
    }),

    browser_interact: tool({
      description: 'Interact with a web page â€” click buttons, fill forms, select options. Provide a list of actions to perform sequentially.',
      inputSchema: z.object({
        url: z.string().url().describe('The URL to interact with'),
        actions: z.array(z.object({
          type: z.enum(['click', 'fill', 'select', 'hover', 'wait']).describe('The type of action'),
          selector: z.string().describe('CSS selector for the target element'),
          value: z.string().optional().describe('Value for fill/select actions'),
          waitMs: z.number().optional().describe('Wait time after action in ms'),
        })).describe('List of interactions to perform in sequence'),
      }),
      execute: async ({ url, actions }) => {
        const result = await browserInteract(userId, url, actions);
        if (!result.success) return `[Error] ${result.error}`;
        return `Successfully performed ${actions.length} action(s) on ${url}`;
      },
    }),
  };
}
