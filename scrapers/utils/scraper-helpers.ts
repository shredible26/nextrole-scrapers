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

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function stripHtml(value: string | null | undefined): string {
  if (!value) return '';

  return cleanScrapedDescription(
    decodeHtmlEntities(value)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .trim(),
  );
}

function collectJsonLdObjects(value: unknown, objects: Record<string, unknown>[]): void {
  if (!value) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLdObjects(item, objects);
    }
    return;
  }

  if (typeof value !== 'object') return;

  const object = value as Record<string, unknown>;
  objects.push(object);

  const graph = object['@graph'];
  if (Array.isArray(graph)) {
    for (const item of graph) {
      collectJsonLdObjects(item, objects);
    }
  }
}

export function extractJobPostingJsonLd(html: string): Record<string, unknown> | null {
  const scriptPattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptPattern.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw) as unknown;
      const objects: Record<string, unknown>[] = [];
      collectJsonLdObjects(parsed, objects);

      const jobPosting = objects.find((item) => {
        const type = item['@type'];
        if (Array.isArray(type)) {
          return type.some(entry => String(entry).toLowerCase() === 'jobposting');
        }
        return String(type ?? '').toLowerCase() === 'jobposting';
      });

      if (jobPosting) return jobPosting;
    } catch {
      continue;
    }
  }

  return null;
}
