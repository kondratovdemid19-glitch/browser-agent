export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

let stepStart = 0;

export function resetTimer() {
  stepStart = Date.now();
}

function elapsed(): string {
  if (!stepStart) return '';
  const ms = Date.now() - stepStart;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function log(color: string, label: string, msg: string) {
  const time = elapsed();
  const timeStr = time ? `${C.dim}(${time})${C.reset} ` : '';
  console.log(`${color}${C.bold}[${label}]${C.reset} ${timeStr}${msg}`);
}

export function separator(color: string) {
  console.log(`\n${color}${C.bold}${'='.repeat(50)}${C.reset}`);
}
