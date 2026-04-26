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
const JOB_MATCH_QUERY_PAGE_SIZE = 50;
const JOB_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESEND_REQUEST_TIMEOUT_MS = 30_000;
const ANTHROPIC_REQUEST_TIMEOUT_MS = 45_000;
const ANTHROPIC_REQUEST_DELAY_MS = 15_000;
const JOB_DESCRIPTION_PROMPT_LIMIT = 8_000;
const RESUME_PROMPT_LIMIT = 10_000;
const USER_AGENT = 'nextrole-job-alerts/1.0';
const MATCH_GRADES = ['A', 'B', 'C'] as const;
const TARGET_LEVEL_TO_EXPERIENCE_LEVEL: Record<string, string> = {
  'Entry Level': 'entry_level',
  Internship: 'internship',
  'New Grad': 'new_grad',
  entry_level: 'entry_level',
  internship: 'internship',
  new_grad: 'new_grad',
};

type Grade = (typeof MATCH_GRADES)[number];
const RECENT_JOB_FALLBACK_GRADE: Grade = 'C';

type ProfileRow = {
  id: string;
  email: string | null;
  resume_embedding: unknown;
  resume_text: string | null;
  target_levels: unknown;
  target_roles: unknown;
  tier: string | null;
};

type EligibleUser = {
  email: string;
  hasResumeEmbedding: boolean;
  id: string;
  resumeText: string | null;
  targetExperienceLevels: string[];
  targetRoles: string[];
  tier: string;
};

type JobRow = {
  company: string | null;
  description: string | null;
  experience_level: string | null;
  id: string;
  is_active: boolean | null;
  is_usa: boolean | null;
  location: string | null;
  posted_at: string | null;
  roles: string[] | null;
  title: string | null;
  url: string | null;
};

type ApplicationRow = {
  job_id: string | null;
};

type JobScoreRow = {
  grade: Grade | null;
  jobs: JobRow | JobRow[] | null;
  [key: string]: unknown;
};

type QueryError = {
  code?: string;
  message: string;
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
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

function uniqueStringList(values: string[]): string[] {
  return [...new Set(values)];
}

function mapTargetLevelsToExperienceLevels(targetLevels: string[]): string[] {
  return uniqueStringList(
    targetLevels
      .map(level => TARGET_LEVEL_TO_EXPERIENCE_LEVEL[level])
      .filter((level): level is string => typeof level === 'string'),
  );
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

function normalizeJobMatch(job: JobRow, grade: Grade, metric: number | null): JobMatch | null {
  if (typeof job.url !== 'string' || normalizeWhitespace(job.url) === '') {
    return null;
  }

  return {
    company: normalizeWhitespace(job.company ?? '') || 'Unknown company',
    description: normalizeWhitespace(job.description ?? ''),
    grade,
    id: job.id,
    location: normalizeWhitespace(job.location ?? '') || 'Location unavailable',
    metric,
    title: normalizeWhitespace(job.title ?? '') || 'Untitled role',
    url: normalizeWhitespace(job.url),
    whyThisMatches: null,
  };
}

function normalizeJobMatches(rows: JobScoreRow[], metricColumn: string): JobMatch[] {
  const matches: JobMatch[] = rows
    .map(row => {
      const job = normalizeJobRow(row.jobs);
      const grade = row.grade;

      if (!job || !grade || !MATCH_GRADES.includes(grade)) {
        return null;
      }

      return normalizeJobMatch(
        job,
        grade,
        typeof row[metricColumn] === 'number' ? (row[metricColumn] as number) : null,
      );
    })
    .filter((match): match is JobMatch => match !== null);

  return matches;
}

function normalizeRecentJobMatches(rows: JobRow[]): JobMatch[] {
  return rows
    .map(row => normalizeJobMatch(row, RECENT_JOB_FALLBACK_GRADE, null))
    .filter((match): match is JobMatch => match !== null);
}

async function fetchEligibleUsers(): Promise<EligibleUser[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, resume_embedding, resume_text, target_levels, target_roles, tier')
    .eq('job_alerts_enabled', true)
    .not('email', 'is', null);

  if (error) {
    throw new Error(`Failed to fetch opted-in users: ${error.message}`);
  }

  const rows = (data ?? []) as ProfileRow[];

  return rows
    .map(row => {
      const email = typeof row.email === 'string' ? normalizeWhitespace(row.email) : '';
      if (!email) {
        return null;
      }

      return {
        email,
        hasResumeEmbedding: row.resume_embedding != null,
        id: row.id,
        resumeText:
          typeof row.resume_text === 'string'
            ? normalizeWhitespace(row.resume_text) || null
            : null,
        targetExperienceLevels: mapTargetLevelsToExperienceLevels(
          normalizeStringList(row.target_levels),
        ),
        targetRoles: uniqueStringList(normalizeStringList(row.target_roles)),
        tier: normalizeWhitespace(row.tier ?? 'free').toLowerCase() || 'free',
      } satisfies EligibleUser;
    })
    .filter((user): user is EligibleUser => user !== null);
}

async function fetchAppliedJobIds(userId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('applications')
    .select('job_id')
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to fetch applied jobs for user ${userId}: ${error.message}`);
  }

  return new Set(
    ((data ?? []) as ApplicationRow[])
      .map(row => row.job_id)
      .filter((jobId): jobId is string => typeof jobId === 'string' && jobId.length > 0),
  );
}

async function collectTopScoredMatches(
  userId: string,
  metricColumn: 'similarity' | 'score',
  appliedJobIds: Set<string>,
  targetRoles: string[],
  targetExperienceLevels: string[],
): Promise<{ error: QueryError | null; matches: JobMatch[] }> {
  const cutoff = new Date(Date.now() - JOB_WINDOW_MS).toISOString();
  const matches: JobMatch[] = [];
  const seenJobIds = new Set<string>();

  for (let offset = 0; matches.length < JOB_MATCH_LIMIT; offset += JOB_MATCH_QUERY_PAGE_SIZE) {
    let query = supabase
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
            is_active,
            is_usa,
            experience_level,
            roles
          )
        `,
      )
      .eq('user_id', userId)
      .in('grade', MATCH_GRADES)
      .gt('jobs.posted_at', cutoff)
      .eq('jobs.is_active', true)
      .eq('jobs.is_usa', true);

    if (targetExperienceLevels.length > 0) {
      query = query.in('jobs.experience_level', targetExperienceLevels);
    }

    if (targetRoles.length > 0) {
      query = query.overlaps('jobs.roles', targetRoles);
    }

    const { data, error } = await query
      .order(metricColumn, { ascending: false })
      .range(offset, offset + JOB_MATCH_QUERY_PAGE_SIZE - 1);

    if (error) {
      return {
        error: {
          code: error.code,
          message: error.message,
        },
        matches: [],
      };
    }

    const page = normalizeJobMatches((data ?? []) as JobScoreRow[], metricColumn);
    for (const match of page) {
      if (appliedJobIds.has(match.id) || seenJobIds.has(match.id)) {
        continue;
      }

      seenJobIds.add(match.id);
      matches.push(match);

      if (matches.length >= JOB_MATCH_LIMIT) {
        break;
      }
    }

    if ((data ?? []).length < JOB_MATCH_QUERY_PAGE_SIZE) {
      break;
    }
  }

  return { error: null, matches };
}

async function fetchRecentJobFallbackMatches(
  appliedJobIds: Set<string>,
  targetRoles: string[],
  targetExperienceLevels: string[],
): Promise<JobMatch[]> {
  const matches: JobMatch[] = [];
  const seenJobIds = new Set<string>();

  for (let offset = 0; matches.length < JOB_MATCH_LIMIT; offset += JOB_MATCH_QUERY_PAGE_SIZE) {
    let query = supabase
      .from('jobs')
      .select(
        'id, title, company, location, url, description, posted_at, is_active, is_usa, experience_level, roles',
      )
      .eq('is_active', true)
      .eq('is_usa', true)
      .not('posted_at', 'is', null);

    if (targetExperienceLevels.length > 0) {
      query = query.in('experience_level', targetExperienceLevels);
    }

    if (targetRoles.length > 0) {
      query = query.overlaps('roles', targetRoles);
    }

    const { data, error } = await query
      .order('posted_at', { ascending: false })
      .range(offset, offset + JOB_MATCH_QUERY_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to fetch recent fallback jobs: ${error.message}`);
    }

    const page = normalizeRecentJobMatches((data ?? []) as JobRow[]);
    for (const match of page) {
      if (appliedJobIds.has(match.id) || seenJobIds.has(match.id)) {
        continue;
      }

      seenJobIds.add(match.id);
      matches.push(match);

      if (matches.length >= JOB_MATCH_LIMIT) {
        break;
      }
    }

    if ((data ?? []).length < JOB_MATCH_QUERY_PAGE_SIZE) {
      break;
    }
  }

  return matches;
}

async function fetchJobMatchesForUser(user: EligibleUser): Promise<JobMatch[]> {
  const appliedJobIds = await fetchAppliedJobIds(user.id);

  if (!user.hasResumeEmbedding) {
    return fetchRecentJobFallbackMatches(
      appliedJobIds,
      user.targetRoles,
      user.targetExperienceLevels,
    );
  }

  const preferred = await collectTopScoredMatches(
    user.id,
    'similarity',
    appliedJobIds,
    user.targetRoles,
    user.targetExperienceLevels,
  );
  if (!preferred.error) {
    return preferred.matches;
  }

  const shouldFallback =
    preferred.error.code === '42703' &&
    preferred.error.message.toLowerCase().includes('similarity');

  if (!shouldFallback) {
    throw new Error(`Failed to fetch job matches for user ${user.id}: ${preferred.error.message}`);
  }

  console.warn('[alerts] job_scores.similarity missing, falling back to score ordering.');

  const fallback = await collectTopScoredMatches(
    user.id,
    'score',
    appliedJobIds,
    user.targetRoles,
    user.targetExperienceLevels,
  );
  if (fallback.error) {
    throw new Error(`Failed to fetch job matches for user ${user.id}: ${fallback.error.message}`);
  }

  return fallback.matches;
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
      const matches = await fetchJobMatchesForUser(user);
      if (matches.length === 0) {
        console.log(`[alerts] ${user.id}: no matches for user, skipping`);
        continue;
      }

      if (user.tier === 'pro' && user.resumeText && user.hasResumeEmbedding) {
        for (const [index, match] of matches.entries()) {
          if (ANTHROPIC_API_KEY && index > 0) {
            await sleep(ANTHROPIC_REQUEST_DELAY_MS);
          }

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
