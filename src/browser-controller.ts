import { chromium, BrowserContext, Page } from 'playwright';
import { config } from './config.js';

// --- Types ---

export interface ElementInfo {
  index: number;
  tag: string;
  type: string;
  text: string;
  placeholder: string;
  ariaLabel: string;
  title: string;
  href: string;
  value: string;
  role: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface PageState {
  url: string;
  title: string;
  elements: ElementInfo[];
  screenshot: string;
  scrollY: number;
  scrollMaxY: number;
  dialogMessage?: string;
}

// --- Element extraction JS (injected into the page) ---

const EXTRACT_ELEMENTS_JS = `() => {
  // Clean up previous markers
  document.querySelectorAll('.ag-marker').forEach(e => e.remove());
  document.querySelectorAll('[data-ag-id]').forEach(e => e.removeAttribute('data-ag-id'));

  const SELECTORS = [
    'a[href]',
    'button:not([disabled])',
    'input:not([type="hidden"]):not([disabled])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="option"]',
    '[contenteditable="true"]',
    'summary',
  ];

  const seen = new Set();
  const items = [];

  for (const el of document.querySelectorAll(SELECTORS.join(','))) {
    if (seen.has(el)) continue;
    seen.add(el);

    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (parseFloat(style.opacity) < 0.1) continue;

    // Only elements in/near viewport
    if (rect.bottom < -50 || rect.top > window.innerHeight + 50) continue;
    if (rect.right < -50 || rect.left > window.innerWidth + 50) continue;

    items.push({ el, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  }

  // Sort top-to-bottom, left-to-right
  items.sort((a, b) => {
    const dy = a.rect.y - b.rect.y;
    if (Math.abs(dy) > 12) return dy;
    return a.rect.x - b.rect.x;
  });

  const results = [];
  items.forEach(({ el, rect }, i) => {
    const idx = i + 1;
    el.setAttribute('data-ag-id', String(idx));

    // Visual marker overlay
    const m = document.createElement('div');
    m.className = 'ag-marker';
    const top = rect.y < 18 ? rect.y + rect.height : rect.y - 18;
    m.style.cssText =
      'position:fixed;left:' + Math.max(0, rect.x) + 'px;top:' + Math.max(0, top) + 'px;' +
      'background:#e74c3c;color:#fff;font:bold 11px/14px monospace;' +
      'padding:1px 4px;border-radius:3px;z-index:2147483647;pointer-events:none;';
    m.textContent = String(idx);
    document.body.appendChild(m);

    const rawText = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    const text = rawText.length > 120 ? rawText.slice(0, 120) + '...' : rawText;

    results.push({
      index: idx,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      text,
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      href: el.getAttribute('href') || '',
      value: el.value !== undefined ? String(el.value).slice(0, 80) : '',
      role: el.getAttribute('role') || '',
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  });

  return results;
}`;

// --- Text extraction JS ---

const EXTRACT_TEXT_JS = `() => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'META', 'LINK']);
  const texts = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        const s = window.getComputedStyle(p);
        if (s.display === 'none' || s.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        const t = node.textContent?.trim();
        if (t && t.length > 1) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_REJECT;
      }
    }
  );
  while (walker.nextNode()) {
    texts.push(walker.currentNode.textContent.trim());
  }
  return texts.join('\\n').slice(0, 10000);
}`;

// --- Browser Controller ---

export class BrowserController {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastDialog: { type: string; message: string } | null = null;

  async launch(): Promise<void> {
    // Persistent context preserves cookies, localStorage, sessions between runs
    this.context = await chromium.launchPersistentContext(config.userDataDir, {
      headless: config.headless,
      viewport: { width: config.viewportWidth, height: config.viewportHeight },
      locale: 'ru-RU',
      args: [
        `--window-size=${config.viewportWidth},${config.viewportHeight + 100}`,
      ],
    });

    // Use first existing page or create a new one
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.setupPageListeners(this.page);

    // Auto-switch to new tabs/popups
    this.context.on('page', (newPage) => {
      this.page = newPage;
      this.setupPageListeners(newPage);
    });
  }

  private setupPageListeners(page: Page): void {
    page.on('dialog', async (dialog) => {
      this.lastDialog = { type: dialog.type(), message: dialog.message() };
      if (dialog.type() === 'confirm' || dialog.type() === 'beforeunload') {
        await dialog.dismiss();
      } else {
        await dialog.accept();
      }
    });
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
  }

  private getPage(): Page {
    if (!this.page) throw new Error('Browser not launched');
    return this.page;
  }

  // --- Actions ---

  async navigate(url: string): Promise<string> {
    const page = this.getPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.settle();
      return `Navigated to ${page.url()}`;
    } catch (e: any) {
      return `Navigation error: ${e.message}`;
    }
  }

  async click(elementId: number): Promise<string> {
    const page = this.getPage();
    const sel = `[data-ag-id="${elementId}"]`;
    try {
      const el = page.locator(sel);
      await el.scrollIntoViewIfNeeded({ timeout: 3000 });
      await this.highlight(elementId);
      await el.click({ timeout: 5000 });
      await this.settle();
      return `Clicked [${elementId}]. Page: ${page.url()}`;
    } catch (e: any) {
      return `Click [${elementId}] failed: ${e.message}`;
    }
  }

  async typeText(
    elementId: number,
    text: string,
    pressEnter = false,
  ): Promise<string> {
    const page = this.getPage();
    const sel = `[data-ag-id="${elementId}"]`;
    try {
      const el = page.locator(sel);
      await el.scrollIntoViewIfNeeded({ timeout: 3000 });
      await el.click({ timeout: 3000 });

      // Clear existing text and type new
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(text, { delay: 25 });

      if (pressEnter) {
        await page.keyboard.press('Enter');
      }
      await this.settle();
      return `Typed "${text}" into [${elementId}]${pressEnter ? ' + Enter' : ''}`;
    } catch (e: any) {
      return `Type into [${elementId}] failed: ${e.message}`;
    }
  }

  async selectOption(elementId: number, value: string): Promise<string> {
    const page = this.getPage();
    const sel = `[data-ag-id="${elementId}"]`;
    try {
      try {
        await page.selectOption(sel, { label: value });
      } catch {
        await page.selectOption(sel, { value });
      }
      await this.settle();
      return `Selected "${value}" in [${elementId}]`;
    } catch (e: any) {
      return `Select in [${elementId}] failed: ${e.message}`;
    }
  }

  async scroll(direction: 'up' | 'down', amount = 500): Promise<string> {
    const page = this.getPage();
    const delta = direction === 'down' ? amount : -amount;
    await page.mouse.wheel(0, delta);
    await this.settle();
    const info = await page.evaluate(() => ({
      y: Math.round(window.scrollY),
      max: Math.round(document.body.scrollHeight - window.innerHeight),
    }));
    return `Scrolled ${direction}. Position: ${info.y}/${info.max}px`;
  }

  async goBack(): Promise<string> {
    const page = this.getPage();
    try {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
      await this.settle();
      return `Went back. Page: ${page.url()}`;
    } catch (e: any) {
      return `Go back failed: ${e.message}`;
    }
  }

  async pressKey(key: string): Promise<string> {
    const page = this.getPage();
    try {
      await page.keyboard.press(key);
      await this.settle();
      return `Pressed ${key}`;
    } catch (e: any) {
      return `Key press failed: ${e.message}`;
    }
  }

  async wait(seconds = 2): Promise<string> {
    const ms = Math.min(seconds, 10) * 1000;
    await new Promise((r) => setTimeout(r, ms));
    return `Waited ${seconds}s`;
  }

  // --- State extraction ---

  async getState(): Promise<PageState> {
    const page = this.getPage();
    const elements = await this.extractElements();
    const screenshot = await this.takeScreenshot();
    const scroll = await page.evaluate(() => ({
      y: Math.round(window.scrollY),
      max: Math.round(document.body.scrollHeight - window.innerHeight),
    }));

    const state: PageState = {
      url: page.url(),
      title: await page.title(),
      elements,
      screenshot,
      scrollY: scroll.y,
      scrollMaxY: scroll.max,
    };

    if (this.lastDialog) {
      state.dialogMessage = `[Dialog ${this.lastDialog.type}]: ${this.lastDialog.message}`;
      this.lastDialog = null;
    }

    return state;
  }

  async getTextContent(): Promise<string> {
    const page = this.getPage();
    try {
      return await page.evaluate(EXTRACT_TEXT_JS);
    } catch {
      return '';
    }
  }

  private async extractElements(): Promise<ElementInfo[]> {
    const page = this.getPage();
    try {
      return await page.evaluate(EXTRACT_ELEMENTS_JS);
    } catch {
      return [];
    }
  }

  private async takeScreenshot(): Promise<string> {
    const page = this.getPage();
    const buf = await page.screenshot({
      type: 'jpeg',
      quality: config.screenshotQuality,
    });
    return buf.toString('base64');
  }

  private async highlight(elementId: number): Promise<void> {
    const page = this.getPage();
    await page.evaluate((id: number) => {
      const el = document.querySelector(`[data-ag-id="${id}"]`) as HTMLElement;
      if (!el) return;
      const prev = el.style.outline;
      el.style.outline = '3px solid #e74c3c';
      setTimeout(() => {
        el.style.outline = prev;
      }, 800);
    }, elementId);
  }

  private async settle(): Promise<void> {
    const page = this.getPage();
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
    } catch {}
    await new Promise((r) => setTimeout(r, 600));
  }
}
