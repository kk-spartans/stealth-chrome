/** Tiny prefixed logger — every subsystem logs under its own tag. */
export function log(tag: string, message: string): void {
  console.log(`[${tag}] ${message}`);
}

export function warn(tag: string, message: string): void {
  console.warn(`[${tag}] ${message}`);
}

export function error(tag: string, message: string): void {
  console.error(`[${tag}] ${message}`);
}
