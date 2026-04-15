const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function mapInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  delayMs: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];

  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    const batchResults = await Promise.all(
      batch.map((item, index) => mapper(item, offset + index)),
    );
    results.push(...batchResults);

    if (offset + batchSize < items.length) {
      await delay(delayMs);
    }
  }

  return results;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = 10_000,
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function cleanScrapedDescription(value: string | null | undefined): string {
  if (!value) return '';

  let cleaned = '';

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code === 0) {
      continue;
    }

    if (code >= 0xD800 && code <= 0xDBFF) {
      const nextCode = value.charCodeAt(index + 1);

      if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
        cleaned += value[index] + value[index + 1];
        index += 1;
      }

      continue;
    }

    if (code >= 0xDC00 && code <= 0xDFFF) {
      continue;
    }

    cleaned += value[index];
  }

  return cleaned;
}
