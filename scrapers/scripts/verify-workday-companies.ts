import { WORKDAY_COMPANIES, WORKDAY_KNOWN_TARGETS } from '../sources/workday';

const VERIFY_WD_VERSIONS = [
  'wd1',
  'wd2',
  'wd3',
  'wd4',
  'wd5',
  'wd6',
  'wd7',
  'wd8',
  'wd10',
  'wd12',
  'wd100',
] as const;
const VERIFY_BATCH_SIZE = 15;
const VERIFY_BATCH_DELAY_MS = 500;
const VERIFY_TIMEOUT_MS = 8_000;
const VERIFY_REQUEST_BODY = {
  appliedFacets: {},
  limit: 1,
  offset: 0,
  searchText: '',
};

type CompanyPair = {
  company: string;
  careerSite: string;
};

type VerifyResult =
  | (CompanyPair & {
      status: 'verified';
      wdVersion: string;
    })
  | (CompanyPair & {
      status: 'dead' | 'timeout';
    });

function pairKey(company: string, careerSite: string): string {
  return `${company}|${careerSite}`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getUniqueCompanyPairs(): CompanyPair[] {
  return Array.from(
    new Map(
      WORKDAY_COMPANIES.map(([company, careerSite]) => [
        pairKey(company, careerSite),
        { company, careerSite },
      ]),
    ).values(),
  );
}

async function probeWorkdayVersion(
  company: string,
  careerSite: string,
  wdVersion: string,
): Promise<'verified' | 'failed' | 'timeout'> {
  const url = `https://${company}.${wdVersion}.myworkdayjobs.com/wday/cxs/${company}/${careerSite}/jobs`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VERIFY_REQUEST_BODY),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });

    if (response.status !== 200) {
      return 'failed';
    }

    const data = (await response.json()) as { jobPostings?: unknown };
    return Array.isArray(data.jobPostings) ? 'verified' : 'failed';
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return 'timeout';
    }

    return 'failed';
  }
}

async function verifyCompanyPair(company: string, careerSite: string): Promise<VerifyResult> {
  let hadTimeout = false;

  for (const wdVersion of VERIFY_WD_VERSIONS) {
    const result = await probeWorkdayVersion(company, careerSite, wdVersion);

    if (result === 'verified') {
      console.log(`[verify] ${company}|${careerSite}: found ${wdVersion}`);
      return { company, careerSite, status: 'verified', wdVersion };
    }

    if (result === 'timeout') {
      hadTimeout = true;
    }
  }

  if (hadTimeout) {
    console.log(`[verify] ${company}|${careerSite}: timeout (keeping)`);
    return { company, careerSite, status: 'timeout' };
  }

  console.log(`[verify] ${company}|${careerSite}: dead (no working version)`);
  return { company, careerSite, status: 'dead' };
}

async function main(): Promise<void> {
  const pairs = getUniqueCompanyPairs();
  const knownKeys = new Set(Object.keys(WORKDAY_KNOWN_TARGETS));
  const alreadyKnown = pairs.filter(({ company, careerSite }) => knownKeys.has(pairKey(company, careerSite)));
  const pendingPairs = pairs.filter(({ company, careerSite }) => !knownKeys.has(pairKey(company, careerSite)));
  const results: VerifyResult[] = [];

  for (let index = 0; index < pendingPairs.length; index += VERIFY_BATCH_SIZE) {
    const batch = pendingPairs.slice(index, index + VERIFY_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(({ company, careerSite }) => verifyCompanyPair(company, careerSite)),
    );
    results.push(...batchResults);

    if (index + VERIFY_BATCH_SIZE < pendingPairs.length) {
      await delay(VERIFY_BATCH_DELAY_MS);
    }
  }

  const verified = results
    .filter((result): result is Extract<VerifyResult, { status: 'verified' }> => result.status === 'verified')
    .sort((left, right) => pairKey(left.company, left.careerSite).localeCompare(pairKey(right.company, right.careerSite)));
  const dead = results.filter(result => result.status === 'dead');
  const timedOut = results.filter(result => result.status === 'timeout');

  console.log(
    `Summary: ${verified.length} verified, ${dead.length} dead, ${timedOut.length} timeout, ${alreadyKnown.length} already known`,
  );

  for (const result of verified) {
    console.log(
      `'${result.company}|${result.careerSite}': { wdVersion: '${result.wdVersion}', slug: '${result.careerSite}' },`,
    );
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
