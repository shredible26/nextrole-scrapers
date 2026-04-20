import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} must be set`);
  }

  return value;
}

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = requireEnv('SUPABASE_SERVICE_KEY');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? null;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const RESEND_API_URL = 'https://api.resend.com/emails';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const RESEND_FROM = 'onboarding@resend.dev';
const RESEND_SUBJECT = 'Your top job matches today — NextRole';
const RESEND_DAILY_SEND_CAP = 95;
const JOB_MATCH_LIMIT = 10;
const JOB_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESEND_REQUEST_TIMEOUT_MS = 30_000;
const ANTHROPIC_REQUEST_TIMEOUT_MS = 45_000;
const JOB_DESCRIPTION_PROMPT_LIMIT = 8_000;
const RESUME_PROMPT_LIMIT = 10_000;
const USER_AGENT = 'nextrole-job-alerts/1.0';
const MATCH_GRADES = ['A', 'B', 'C'] as const;

type Grade = (typeof MATCH_GRADES)[number];

type ProfileRow = {
  id: string;
  email: string | null;
  resume_text: string | null;
  target_roles: unknown;
  tier: string | null;
};

type EligibleUser = {
  email: string;
  id: string;
  resumeText: string;
  targetRoles: string[];
  tier: string;
};

type JobRow = {
  company: string | null;
  description: string | null;
  id: string;
  is_active: boolean | null;
  location: string | null;
  posted_at: string | null;
  title: string | null;
  url: string | null;
};

type JobScoreRow = {
  grade: Grade | null;
  jobs: JobRow | JobRow[] | null;
  [key: string]: unknown;
};

type JobMatch = {
  company: string;
  description: string;
  grade: Grade;
  id: string;
  location: string;
  metric: number | null;
  title: string;
  url: string;
  whyThisMatches: string | null;
};

type AnthropicMessageResponse = {
  content?: Array<{
    text?: string;
    type?: string;
  }>;
  error?: {
    message?: string;
  };
};

type ResendSendResponse = {
  id?: string;
  message?: string;
  name?: string;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parseJsonResponse<T>(value: string): T | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => normalizeWhitespace(item))
    .filter(Boolean);
}

function getGradeColor(grade: Grade): string {
  switch (grade) {
    case 'A':
      return '#22c55e';
    case 'B':
      return '#14b8a6';
    case 'C':
      return '#eab308';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildCompanyLocationText(company: string, location: string): string {
  return `${company} | ${location}`;
}

function buildCompanyLocationHtml(company: string, location: string): string {
  return `${escapeHtml(company)} &middot; ${escapeHtml(location)}`;
}

function buildUnsubscribeToken(userId: string, resendApiKey: string): string {
  const signature = createHmac('sha256', resendApiKey).update(userId).digest('hex');
  return Buffer.from(`${userId}.${signature}`).toString('base64url');
}

function buildUnsubscribeUrl(token: string, nextPublicUrl: string): string {
  const baseUrl = nextPublicUrl.replace(/\/+$/, '');
  return `${baseUrl}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}

function normalizeWhyThisMatches(rawValue: string): string | null {
  let value = normalizeWhitespace(rawValue.replace(/^['"]+|['"]+$/g, ''));
  value = value.replace(/^[-*]\s*/, '');

  if (value.toLowerCase().startsWith('why this matches you:')) {
    value = value.slice('why this matches you:'.length).trim();
  }

  const words = value.split(/\s+/).filter(Boolean).slice(0, 20);
  if (words.length === 0) {
    return null;
  }

  return `Why this matches you: ${words.join(' ')}`;
}

function normalizeJobRow(row: JobRow | JobRow[] | null): JobRow | null {
  if (!row) {
    return null;
  }

  return Array.isArray(row) ? row[0] ?? null : row;
}

function normalizeJobMatches(rows: JobScoreRow[], metricColumn: string): JobMatch[] {
  const matches: JobMatch[] = rows
    .map(row => {
      const job = normalizeJobRow(row.jobs);
      const grade = row.grade;

      if (!job || !grade || !MATCH_GRADES.includes(grade)) {
        return null;
      }

      if (typeof job.url !== 'string' || normalizeWhitespace(job.url) === '') {
        return null;
      }

      const match: JobMatch = {
        company: normalizeWhitespace(job.company ?? '') || 'Unknown company',
        description: normalizeWhitespace(job.description ?? ''),
        grade,
        id: job.id,
        location: normalizeWhitespace(job.location ?? '') || 'Location unavailable',
        metric: typeof row[metricColumn] === 'number' ? (row[metricColumn] as number) : null,
        title: normalizeWhitespace(job.title ?? '') || 'Untitled role',
        url: normalizeWhitespace(job.url),
        whyThisMatches: null,
      };

      return match;
    })
    .filter((match): match is JobMatch => match !== null);

  return matches;
}

async function fetchEligibleUsers(): Promise<EligibleUser[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, resume_text, target_roles, tier')
    .eq('job_alerts_enabled', true)
    .not('resume_text', 'is', null)
    .not('email', 'is', null)
    .not('target_roles', 'is', null);

  if (error) {
    throw new Error(`Failed to fetch opted-in users: ${error.message}`);
  }

  const rows = (data ?? []) as ProfileRow[];

  return rows
    .map(row => {
      const email = typeof row.email === 'string' ? normalizeWhitespace(row.email) : '';
      const resumeText = typeof row.resume_text === 'string' ? normalizeWhitespace(row.resume_text) : '';
      const targetRoles = normalizeStringList(row.target_roles);

      if (!email || !resumeText || targetRoles.length === 0) {
        return null;
      }

      return {
        email,
        id: row.id,
        resumeText,
        targetRoles,
        tier: normalizeWhitespace(row.tier ?? 'free').toLowerCase() || 'free',
      } satisfies EligibleUser;
    })
    .filter((user): user is EligibleUser => user !== null);
}

async function fetchJobMatchesForUser(userId: string): Promise<JobMatch[]> {
  const cutoff = new Date(Date.now() - JOB_WINDOW_MS).toISOString();

  const queryMatches = async (metricColumn: 'similarity' | 'score') => {
    const { data, error } = await supabase
      .from('job_scores')
      .select(
        `
          grade,
          ${metricColumn},
          jobs!inner (
            id,
            title,
            company,
            location,
            url,
            description,
            posted_at,
            is_active
          )
        `,
      )
      .eq('user_id', userId)
      .in('grade', MATCH_GRADES)
      .gt('jobs.posted_at', cutoff)
      .eq('jobs.is_active', true)
      .order(metricColumn, { ascending: false })
      .limit(JOB_MATCH_LIMIT);

    return { data: (data ?? []) as JobScoreRow[], error };
  };

  const preferred = await queryMatches('similarity');
  if (!preferred.error) {
    return normalizeJobMatches(preferred.data, 'similarity');
  }

  const shouldFallback =
    preferred.error.code === '42703' &&
    preferred.error.message.toLowerCase().includes('similarity');

  if (!shouldFallback) {
    throw new Error(`Failed to fetch job matches for user ${userId}: ${preferred.error.message}`);
  }

  console.warn('[alerts] job_scores.similarity missing, falling back to score ordering.');

  const fallback = await queryMatches('score');
  if (fallback.error) {
    throw new Error(`Failed to fetch job matches for user ${userId}: ${fallback.error.message}`);
  }

  return normalizeJobMatches(fallback.data, 'score');
}

async function generateWhyThisMatches(resumeText: string, match: JobMatch): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) {
    return null;
  }

  const prompt = [
    'Write exactly one line for a job alert email.',
    'Start with "Why this matches you:".',
    'Use no more than 20 words after the colon.',
    'No markdown, no bullets, no quotes.',
    '',
    `Resume:\n${truncate(resumeText, RESUME_PROMPT_LIMIT)}`,
    '',
    `Job title:\n${match.title}`,
    '',
    `Job description:\n${truncate(match.description, JOB_DESCRIPTION_PROMPT_LIMIT)}`,
  ].join('\n');

  try {
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        max_tokens: 80,
        model: CLAUDE_HAIKU_MODEL,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
      signal: AbortSignal.timeout(ANTHROPIC_REQUEST_TIMEOUT_MS),
    });

    const responseText = await response.text();
    const payload = parseJsonResponse<AnthropicMessageResponse>(responseText);

    if (!response.ok) {
      throw new Error(
        payload?.error?.message ??
          responseText.slice(0, 300) ??
          `Anthropic request failed with status ${response.status}`,
      );
    }

    const text = payload?.content?.find(item => item.type === 'text')?.text;
    if (!text) {
      return null;
    }

    return normalizeWhyThisMatches(text);
  } catch (error) {
    console.warn(
      `[alerts] ${match.id}: failed to generate pro explanation with Claude Haiku, skipping line (${getErrorMessage(error)})`,
    );
    return null;
  }
}

function buildEmailHtml(matches: JobMatch[], unsubscribeUrl: string): string {
  const jobMarkup = matches
    .map((match, index) => {
      const dividerStyle = index === 0 ? '' : 'border-top:1px solid #232533;';
      const whyThisMatchesMarkup = match.whyThisMatches
        ? `<div style="margin-top:12px;font-size:14px;line-height:1.6;color:#818cf8;font-style:italic;">${escapeHtml(match.whyThisMatches)}</div>`
        : '';

      return `
        <div style="${dividerStyle}padding:24px 0;">
          <div style="display:inline-block;padding:4px 10px;border-radius:9999px;background-color:${getGradeColor(match.grade)};color:#0d0d12;font-size:12px;font-weight:700;line-height:1.2;">${escapeHtml(match.grade)}</div>
          <div style="margin-top:14px;font-size:18px;font-weight:700;line-height:1.4;color:#ffffff;">${escapeHtml(match.title)}</div>
          <div style="margin-top:6px;font-size:14px;line-height:1.5;color:#9ca3af;">${buildCompanyLocationHtml(match.company, match.location)}</div>
          ${whyThisMatchesMarkup}
          <div style="margin-top:18px;">
            <a href="${escapeHtml(match.url)}" style="display:inline-block;padding:12px 16px;background-color:#4f46e5;border-radius:9999px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;">View &amp; Apply &rarr;</a>
          </div>
        </div>
      `;
    })
    .join('');

  return `
    <!DOCTYPE html>
    <html lang="en">
      <body style="margin:0;padding:0;background-color:#0d0d12;">
        <div style="background-color:#0d0d12;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#ffffff;">
          <div style="max-width:600px;margin:0 auto;background-color:#13131a;border:1px solid #1f2230;border-radius:16px;overflow:hidden;">
            <div style="padding:32px 28px 20px 28px;">
              <div style="font-size:24px;font-weight:700;line-height:1.2;color:#ffffff;">NextRole</div>
              <div style="margin-top:6px;font-size:15px;line-height:1.5;color:#9ca3af;">Your top matches today</div>
            </div>
            <div style="padding:0 28px 8px 28px;">
              ${jobMarkup}
            </div>
            <div style="padding:20px 28px 28px 28px;border-top:1px solid #232533;">
              <div style="font-size:12px;line-height:1.6;color:#6b7280;">
                You're receiving this because you enabled job alerts on NextRole.
              </div>
              <div style="margin-top:8px;font-size:12px;line-height:1.6;">
                <a href="${escapeHtml(unsubscribeUrl)}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a>
              </div>
            </div>
          </div>
        </div>
      </body>
    </html>
  `.trim();
}

function buildEmailText(matches: JobMatch[], unsubscribeUrl: string): string {
  const body = matches
    .map(match => {
      const whyLine = match.whyThisMatches ? `\n${match.whyThisMatches}` : '';
      return [
        `${match.grade} - ${match.title}`,
        buildCompanyLocationText(match.company, match.location),
        `${whyLine}\nView & Apply: ${match.url}`.trim(),
      ].join('\n');
    })
    .join('\n\n');

  return [
    'NextRole',
    'Your top matches today',
    '',
    body,
    '',
    "You're receiving this because you enabled job alerts on NextRole.",
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join('\n');
}

async function sendJobAlertEmail(user: EligibleUser, matches: JobMatch[]): Promise<string> {
  const resendApiKey = requireEnv('RESEND_API_KEY');
  const nextPublicUrl = requireEnv('NEXT_PUBLIC_URL');
  const unsubscribeToken = buildUnsubscribeToken(user.id, resendApiKey);
  const unsubscribeUrl = buildUnsubscribeUrl(unsubscribeToken, nextPublicUrl);
  const emailDate = new Date().toISOString().slice(0, 10);

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `job-alert-${user.id}-${emailDate}`,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      html: buildEmailHtml(matches, unsubscribeUrl),
      subject: RESEND_SUBJECT,
      text: buildEmailText(matches, unsubscribeUrl),
      to: user.email,
    }),
    signal: AbortSignal.timeout(RESEND_REQUEST_TIMEOUT_MS),
  });

  const responseText = await response.text();
  const payload = parseJsonResponse<ResendSendResponse>(responseText);

  if (!response.ok || !payload?.id) {
    throw new Error(
      payload?.message ??
        responseText.slice(0, 300) ??
        `Resend request failed with status ${response.status}`,
    );
  }

  return payload.id;
}

async function main(): Promise<void> {
  const users = await fetchEligibleUsers();
  console.log(`[alerts] eligible users: ${users.length}`);

  let processedUsers = 0;
  let emailsSent = 0;

  for (const user of users) {
    processedUsers += 1;

    try {
      const matches = await fetchJobMatchesForUser(user.id);
      if (matches.length === 0) {
        console.log(`[alerts] ${user.id}: no matches for user, skipping`);
        continue;
      }

      if (user.tier === 'pro') {
        for (const match of matches) {
          match.whyThisMatches = await generateWhyThisMatches(user.resumeText, match);
        }
      }

      const resendId = await sendJobAlertEmail(user, matches);
      emailsSent += 1;
      console.log(`[alerts] ${user.id}: sent email to ${user.email} (${resendId})`);

      if (emailsSent >= RESEND_DAILY_SEND_CAP) {
        console.warn('Approaching Resend daily limit, stopping.');
        break;
      }
    } catch (error) {
      console.error(`[alerts] ${user.id}: failed (${getErrorMessage(error)})`);
    }
  }

  console.log(`[alerts] users processed: ${processedUsers}`);
  console.log(`[alerts] total emails sent: ${emailsSent}`);
  process.exit(0);
}

main().catch(error => {
  console.error(`[alerts] fatal: ${getErrorMessage(error)}`);
  process.exit(1);
});
