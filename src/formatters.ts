import type { PageState, ElementInfo } from './browser-controller.js';

export function formatElement(el: ElementInfo): string {
  const parts: string[] = [`[${el.index}]`, `<${el.tag}>`];

  if (el.role && el.role !== el.tag) parts.push(`role="${el.role}"`);
  if (el.type) parts.push(`type="${el.type}"`);
  if (el.text) parts.push(`"${el.text}"`);
  if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
  if (el.ariaLabel && el.ariaLabel !== el.text)
    parts.push(`aria-label="${el.ariaLabel}"`);
  if (el.title && el.title !== el.text) parts.push(`title="${el.title}"`);
  if (el.href) {
    const short =
      el.href.length > 70 ? el.href.slice(0, 70) + '...' : el.href;
    parts.push(`href="${short}"`);
  }
  if (el.value) parts.push(`value="${el.value}"`);

  return parts.join(' ');
}

export function formatPageState(state: PageState): string {
  const lines: string[] = [
    `URL: ${state.url}`,
    `Title: ${state.title}`,
    `Scroll: ${state.scrollY}/${state.scrollMaxY}px`,
  ];

  if (state.dialogMessage) {
    lines.push(`\n>>> ${state.dialogMessage}`);
  }

  lines.push('', `Interactive elements (${state.elements.length}):`);

  if (state.elements.length === 0) {
    lines.push('  (no interactive elements found on this page)');
  } else {
    for (const el of state.elements) {
      lines.push('  ' + formatElement(el));
    }
  }

  return lines.join('\n');
}

export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str;
}
