import { chromium, Browser } from 'playwright';

export async function createBrowser(useProxy = false): Promise<Browser> {
  return await chromium.launch({
    headless: true,
    proxy: useProxy ? {
      server: process.env.PROXY_SERVER!,
      username: process.env.PROXY_USER!,
      password: process.env.PROXY_PASS!,
    } : undefined,
  });
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const RATE_LIMIT_MS = 2000;
