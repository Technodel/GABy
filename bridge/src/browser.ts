import fs from 'fs';
import os from 'os';
import path from 'path';

type SendFn = (msg: Record<string, unknown>) => void;

type BrowserAction = {
  type: 'click' | 'fill' | 'select' | 'hover' | 'wait';
  selector?: string;
  value?: string;
  waitMs?: number;
};

type BrowserRuntime = {
  context: any;
  page: any;
};

const BROWSER_PROFILE_DIR = path.join(os.homedir(), '.suny', 'browser-profile');

let runtimePromise: Promise<BrowserRuntime> | null = null;

export async function handleBrowser(
  type: string,
  id: string,
  payload: Record<string, unknown>,
  send: SendFn,
): Promise<void> {
  try {
    switch (type) {
      case 'browser:navigate':
        await browserNavigate(id, payload, send);
        break;
      case 'browser:screenshot':
        await browserScreenshot(id, payload, send);
        break;
      case 'browser:evaluate':
        await browserEvaluate(id, payload, send);
        break;
      case 'browser:interact':
        await browserInteract(id, payload, send);
        break;
      case 'browser:pdf':
        await browserPdf(id, payload, send);
        break;
      default:
        send({ type: 'bridge:error', id, payload: { message: `Unknown browser instruction type: ${type}` } });
    }
  } catch (err) {
    send({
      type: 'bridge:error',
      id,
      payload: { message: err instanceof Error ? err.message : 'Browser operation failed' },
    });
  }
}

async function browserNavigate(id: string, payload: Record<string, unknown>, send: SendFn): Promise<void> {
  const url = requireUrl(payload.url);
  const waitForSelector = asOptionalString(payload.waitForSelector);
  const waitMs = asPositiveNumber(payload.waitMs, 2000);
  const extractText = payload.extractText !== false;
  const extractHtml = payload.extractHtml === true;
  const page = await ensurePage(url);

  if (waitForSelector) {
    await page.waitForSelector(waitForSelector, { timeout: Math.max(waitMs, 1000) });
  } else if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }

  send({
    type: 'bridge:done',
    id,
    payload: {
      url: page.url(),
      title: await page.title(),
      text: extractText ? await extractPageText(page) : '',
      html: extractHtml ? (await page.content()).slice(0, 100_000) : undefined,
      exitCode: 0,
      success: true,
    },
  });
}

async function browserScreenshot(id: string, payload: Record<string, unknown>, send: SendFn): Promise<void> {
  const url = requireUrl(payload.url);
  const fullPage = payload.fullPage !== false;
  const width = asPositiveNumber(payload.width, 1280);
  const height = asPositiveNumber(payload.height, 720);
  const page = await ensurePage(url, { width, height });
  const image = await page.screenshot({ fullPage, type: 'png' });

  send({
    type: 'bridge:done',
    id,
    payload: {
      base64: Buffer.from(image).toString('base64'),
      mimeType: 'image/png',
      width,
      height,
      exitCode: 0,
      success: true,
    },
  });
}

async function browserEvaluate(id: string, payload: Record<string, unknown>, send: SendFn): Promise<void> {
  const url = requireUrl(payload.url);
  const script = asOptionalString(payload.script);
  if (!script) throw new Error('Missing browser evaluate script');
  const page = await ensurePage(url);
  const result = await page.evaluate((source: string) => {
    return (0, eval)(source);
  }, script);

  send({
    type: 'bridge:done',
    id,
    payload: {
      result,
      exitCode: 0,
      success: true,
    },
  });
}

async function browserInteract(id: string, payload: Record<string, unknown>, send: SendFn): Promise<void> {
  const url = requireUrl(payload.url);
  const actions = Array.isArray(payload.actions) ? payload.actions as BrowserAction[] : [];
  const page = await ensurePage(url);

  for (const action of actions) {
    switch (action.type) {
      case 'click':
        if (!action.selector) throw new Error('Click action requires a selector');
        await page.click(action.selector);
        break;
      case 'fill':
        if (!action.selector) throw new Error('Fill action requires a selector');
        await page.fill(action.selector, action.value ?? '');
        break;
      case 'select':
        if (!action.selector) throw new Error('Select action requires a selector');
        await page.selectOption(action.selector, action.value ?? '');
        break;
      case 'hover':
        if (!action.selector) throw new Error('Hover action requires a selector');
        await page.hover(action.selector);
        break;
      case 'wait':
        if (action.selector) {
          await page.waitForSelector(action.selector, { timeout: Math.max(action.waitMs ?? 5000, 1000) });
        } else {
          await page.waitForTimeout(action.waitMs ?? 1000);
        }
        break;
      default:
        throw new Error(`Unsupported browser action: ${(action as { type?: string }).type ?? 'unknown'}`);
    }
  }

  await page.waitForTimeout(300);

  send({
    type: 'bridge:done',
    id,
    payload: {
      url: page.url(),
      title: await page.title(),
      text: await extractPageText(page),
      exitCode: 0,
      success: true,
    },
  });
}

async function browserPdf(id: string, payload: Record<string, unknown>, send: SendFn): Promise<void> {
  const url = requireUrl(payload.url);
  const page = await ensurePage(url);
  const pdf = await page.pdf({ format: 'A4', printBackground: true });

  send({
    type: 'bridge:done',
    id,
    payload: {
      base64: Buffer.from(pdf).toString('base64'),
      mimeType: 'application/pdf',
      exitCode: 0,
      success: true,
    },
  });
}

async function ensurePage(url: string, viewport?: { width: number; height: number }) {
  const runtime = await getBrowserRuntime();
  const { page } = runtime;

  if (viewport) {
    await page.setViewportSize(viewport);
  }

  if (page.url() !== url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }

  return page;
}

async function getBrowserRuntime(): Promise<BrowserRuntime> {
  if (!runtimePromise) {
    runtimePromise = createRuntime().catch((err) => {
      runtimePromise = null;
      throw err;
    });
  }
  return runtimePromise;
}

async function createRuntime(): Promise<BrowserRuntime> {
  fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
  const playwright = await loadPlaywright();
  const context = await launchContext(playwright);
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(60_000);
  return { context, page };
}

async function loadPlaywright(): Promise<any> {
  try {
    return await import('playwright-core');
  } catch {
    throw new Error('Browser automation requires playwright-core in the bridge package. Run npm install inside bridge and restart the bridge.');
  }
}

async function launchContext(playwright: any): Promise<any> {
  const candidates = buildLaunchCandidates();
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      return await playwright.chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
        headless: false,
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,
        ...candidate,
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  throw new Error(`Could not launch a local browser for SUNy. Tried ${candidates.length} browser candidates. ${errors[0] ?? ''}`.trim());
}

function buildLaunchCandidates(): Array<Record<string, unknown>> {
  const envPath = process.env.SUNY_BROWSER_PATH;
  const candidates: Array<Record<string, unknown>> = [];

  if (envPath) {
    candidates.push({ executablePath: envPath });
  }

  for (const channel of detectChannels()) {
    candidates.push({ channel });
  }

  for (const executablePath of detectExecutablePaths()) {
    candidates.push({ executablePath });
  }

  return candidates;
}

function detectChannels(): string[] {
  if (process.platform === 'win32') return ['msedge', 'chrome'];
  if (process.platform === 'darwin') return ['chrome', 'msedge'];
  return ['chrome', 'msedge'];
}

function detectExecutablePaths(): string[] {
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    const prefixes = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const prefix of prefixes) {
      candidates.push(path.join(prefix, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(prefix, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(prefix, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    candidates.push('/usr/bin/google-chrome');
    candidates.push('/usr/bin/google-chrome-stable');
    candidates.push('/usr/bin/microsoft-edge');
    candidates.push('/usr/bin/chromium');
    candidates.push('/snap/bin/chromium');
  }

  return candidates.filter((candidate, index, all) => all.indexOf(candidate) === index && fs.existsSync(candidate));
}

async function extractPageText(page: any): Promise<string> {
  const text = await page.evaluate(new Function("return document.body ? document.body.innerText : '';"));
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 50_000);
}

function requireUrl(value: unknown): string {
  const url = asOptionalString(value);
  if (!url) throw new Error('Missing browser URL');
  return url;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}