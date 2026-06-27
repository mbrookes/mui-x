function timestamp() {
  return new Date().toISOString();
}

export function log(...args: unknown[]) {
  console.log(`[${timestamp()}]`, ...args);
}

export function error(...args: unknown[]) {
  console.error(`[${timestamp()}]`, ...args);
}

export function warn(...args: unknown[]) {
  console.warn(`[${timestamp()}]`, ...args);
}
