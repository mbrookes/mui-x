import { createWriteStream, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const LOG_FILE = resolve(process.cwd(), 'dev-server.log');
const IS_DEV = process.env.NODE_ENV !== 'production';

let stream: ReturnType<typeof createWriteStream> | null = null;

function init() {
  if (!IS_DEV) {
    return;
  }
  try {
    rmSync(LOG_FILE, { force: true });
  } catch {
    // ignore
  }
  stream = createWriteStream(LOG_FILE, { flags: 'a' });
}

function write(line: string) {
  stream?.write(line + '\n');
}

function timestamp() {
  return new Date().toISOString();
}

export function log(...args: unknown[]) {
  const msg = args.map(String).join(' ');
  write(`[${timestamp()}] INFO  ${msg}`);
}

export function error(...args: unknown[]) {
  const msg = args.map(String).join(' ');
  console.error(...args);
  write(`[${timestamp()}] ERROR ${msg}`);
}

export function warn(...args: unknown[]) {
  const msg = args.map(String).join(' ');
  write(`[${timestamp()}] WARN  ${msg}`);
}

init();
