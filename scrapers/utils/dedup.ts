import crypto from 'crypto';

export function generateHash(company: string, title: string, location: string): string {
  const str = [company, title, location]
    .map(s => (s ?? '').toLowerCase().trim())
    .join('|');
  return crypto.createHash('md5').update(str).digest('hex');
}
