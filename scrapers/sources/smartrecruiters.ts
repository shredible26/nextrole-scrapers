import { setTimeout as delay } from 'node:timers/promises';

import { generateHash } from '../utils/dedup';
import { isNonUsLocation } from '../utils/location';
import {
  hasTechTitleSignal,
  inferExperienceLevel,
  inferRemote,
  inferRoles,
  type NormalizedJob,
} from '../utils/normalize';

const SOURCE = 'smartrecruiters';
const REQUEST_TIMEOUT_MS = 8_000;
const COMPANY_BATCH_SIZE = 15;
const COMPANY_BATCH_DELAY_MS = 300;
const POSTINGS_PAGE_SIZE = 100;

const SMARTRECRUITERS_COMPANIES = [
  // Validated public identifiers with current relevant tech activity.
  '360ITProfessionals1', '3SBusinessCorporationInc1', '4DSCorp', 'AbbVie',
  'AbercrombieAndFitchCo', 'AccorHotel', 'AcumenSolutions', 'AdeptSolutionsInc',
  'AECOM2', 'AHRCNYC1', 'AIRCommunities', 'AllegisGlobalSolutions',
  'AlphabeInsightInc', 'ALTEN', 'AltenCalsoftLabs', 'AlterSolutions',
  'ApexCleanEnergy', 'ArtechInformationSystemLLC', 'ASTDefeasance', 'ATPCO1',
  'AubergeCollection', 'Aumovio', 'AustroHolding', 'Avaloq1',
  'AveryDennison', 'AxleInformaticsLLC', 'BabbleCloud', 'barkbackLlc',
  'BCforward3', 'BESIX', 'Bet3651', 'BetaSoftSystems3',
  'BEUMERGroup1', 'Bosch-HomeComfort', 'BoschGroup', 'BoydGaming',
  'Brainlab', 'BrakesPlus', 'BryceTech', 'CaliforniaISO',
  'CanadianBankNoteCompany', 'CarousellGroup', 'CarrotInstitute', 'Cermaticom',
  'CERN', 'ChristianBrothersAutomotive', 'ChristianLivingCommunities', 'CirrusAssetManagement',
  'CityAndCountyOfSanFrancisco1', 'CityofPhiladelphia', 'Codeage', 'Collabera2',
  'ColumbiaUniversity1', 'Comcast-CentralPA', 'ComcastCareerCenter', 'ComputerFutures3',
  'ComtechLLC2', 'Consultadd4', 'Continental', 'CornerstoneBuildingBrandsCareers',
  'CoServeGlobalSolutions', 'CRB', 'Cricut', 'CypressGlobalServicesInc',
  'DeegitInc3', 'DeliveryHero', 'Deloitte6', 'DeutscheTelekomITSolutions',
  'DeutscheTelekomITSolutionsSlovakia', 'Devoteam', 'DrReddysLaboratoriesLimited', 'Dungarvin',
  'Eataly', 'EgisGroup', 'Endava', 'EnergyCapitalPower',
  'Entain', 'EntCreditUnion1', 'EnviriCorporation', 'EProInc',
  'Equinox', 'Equus', 'EROSTechnologiesInc', 'EttainGroup',
  'Eurofins', 'Expeditors', 'Experian', 'ExpertInstitute',
  'Flywire1', 'FortuneBrands', 'GalileoLearning', 'GhobashGroup',
  'GlobalLogic4', 'Grab', 'GTCMachiningLLC', 'Hiflylabs',
  'HitachiSolutions', 'HorizonTechnologiesInc', 'HRConnectLimited', 'HSSSoft',
  'HUG', 'I360technologies', 'Idexcel3', 'IFS1',
  'IkanoRetail', 'Inetum2', 'Info-Ways', 'InfojiniInc1',
  'InformaGroupPlc', 'IngramContentGroup1', 'InsilicoLogix', 'Instructure',
  'IntegratedDermatology', 'IntegratedResourcesINC', 'IntegriChain1', 'Interco',
  'InterIKEAGroup', 'Intuitive', 'JobsForHumanity', 'JSHeldLLC',
  'Kataai', 'Keenfinity', 'KGSTechnologyGroupInc', 'Kioxia',
  'KIPP', 'KitePing', 'KMSTechnology1', 'Konecranes',
  'KOSTALGroup', 'KrgTechnologyInc', 'Lakeshore', 'Laxir1',
  'Learnkwikcom', 'LegalAndGeneral', 'Lely1', 'Lesaffre',
  'LGCGroup', 'LinkSolutionsInc', 'LLNL', 'LouisDreyfusCompany',
  'LowellCommunityHealthCenter', 'M3USA', 'Masdar', 'MATHoldings',
  'MattelInc', 'MForceStaffing', 'Mindlance2', 'MinorInternational',
  'MStaffing1', 'MSXInternational', 'MUFGInvestorServices', 'MyriadGenetics1',
  'Nagarro1', 'NationalVision1', 'NatixisInPortugal', 'NazarbayevUniversity1',
  'NBCUniversal3', 'Nemera', 'NETZSCHGroup', 'Nexthink',
  'NorthStarStaffingSolutions1', 'NorthwesternMutual', 'O-I', 'OceanaGold',
  'PAConsulting', 'PactGroup', 'PilmicoFoodsCorporation', 'PilotCompany',
  'PioneerDataSystemsInc', 'Playtech', 'PrecoatMetals', 'Primark',
  'PriviaHealth', 'ProcomServices', 'ProximateTechnologiesInc1', 'PSICRO',
  'PSLogistics', 'QIMA', 'Quadient1', 'RAKUNA1',
  'Ramboll3', 'RedBull', 'RenesasElectronics', 'RESPECInc',
  'Resultant', 'Revalize', 'REWEInternationalDienstleistungsgesellschaftmbH', 'REXEL1',
  'Rjt1', 'RRDonnelley', 'SajixSoftwareSolutionPrivateLimited', 'SampoernaSchoolsSystem',
  'Sandisk', 'SaxonGlobal', 'SBTGlobalInc', 'Securitas',
  'SegulaTechnologies', 'SeniorLifestyle1', 'ServiceNow', 'SGS',
  'SibyllineLtd', 'SigmaSoftware2', 'SikaAG', 'SilfabSolar',
  'SIXT', 'Skyward1', 'SMGSwissMarketplaceGroup', 'SmithsGroup2',
  'Socotec', 'SOCOTECUKIreland', 'SoftNiceINC1', 'SoftpathSystemLLC',
  'Solidigm', 'SolutionsResource2', 'SonsoftInc', 'Sportradar',
  'SQexpetsLLC', 'SQLI1', 'StaubliGroup', 'StemXpert1',
  'StowGroup', 'StratasFoods', 'Sutherland', 'Swissquote',
  'SyngentaGroup', 'SYNTEGON', 'systemCanadaTechnologies', 'TheUniversityOfAuckland',
  'TheWarehouseGroup1', 'TheWonderfulCompany', 'ThirdBridge', 'TimmonsGroup1',
  'TimocomGmbH1', 'Tipico', 'TreehouseStrategyAndCommunicatio', 'TruvenHealthAnalyticsanIBMCompany',
  'TurnerTownsend', 'VeoliaEnvironnementSA', 'Vericast', 'Versant3',
  'Visa', 'VisageINC', 'Vitol', 'VTechSolution1',
  'WabashValleyPowerAlliance', 'Wabtec', 'Wavestone1', 'WellmarkInc',
  'WesternDigital', 'WestgateResorts', 'Wix2', 'WNSGlobalServices144',
  'WynnResorts', 'ZILLIONTECHNOLOGIESINC',
] as const;

const US_COUNTRY_VALUES = new Set([
  'us',
  'usa',
  'united states',
  'united states of america',
]);

const SUMMARY_SENIOR_EXPERIENCE_IDS = new Set([
  'mid_senior_level',
  'director',
  'executive',
]);

const SUMMARY_ENTRY_EXPERIENCE_IDS = new Set([
  'associate',
  'entry_level',
]);

type SmartRecruitersLocation = {
  city?: string;
  region?: string;
  country?: string;
  remote?: boolean;
  hybrid?: boolean;
  fullLocation?: string;
};

type SmartRecruitersCompany = {
  name?: string;
  identifier?: string;
};

type SmartRecruitersExperienceLevel = {
  id?: string;
  label?: string;
};

type SmartRecruitersPostingSummary = {
  id?: string;
  uuid?: string;
  name?: string;
  releasedDate?: string;
  ref?: string;
  company?: SmartRecruitersCompany;
  experienceLevel?: SmartRecruitersExperienceLevel;
  location?: SmartRecruitersLocation;
};

type SmartRecruitersCompanyResponse = {
  content?: SmartRecruitersPostingSummary[];
  limit?: number;
  offset?: number;
  totalFound?: number;
};

type SmartRecruitersCompanyFetch = {
  companyName: string;
  companyPath: string;
  postings: SmartRecruitersPostingSummary[];
};

type FetchJsonResult<T> = {
  status: number;
  data: T | null;
};

function isLikelyTechTitle(title: string): boolean {
  return hasTechTitleSignal(title) || inferRoles(title).length > 0;
}

function normalizeCountry(country?: string): string | undefined {
  if (!country) return undefined;

  const trimmed = country.trim();
  const lower = trimmed.toLowerCase();
  if (US_COUNTRY_VALUES.has(lower)) return 'United States';
  return trimmed;
}

function isUsCountry(country?: string): boolean {
  if (!country) return false;
  return US_COUNTRY_VALUES.has(country.trim().toLowerCase());
}

function buildLocation(location?: SmartRecruitersLocation): string | undefined {
  if (!location) return undefined;
  if (location.fullLocation?.trim()) return location.fullLocation.trim();

  const values = new Set<string>();
  if (location.city?.trim()) values.add(location.city.trim());
  if (location.region?.trim()) values.add(location.region.trim());

  const country = normalizeCountry(location.country);
  if (country) values.add(country);

  return Array.from(values).join(', ') || undefined;
}

function isRemoteLocation(location?: SmartRecruitersLocation): boolean {
  if (!location) return false;
  if (location.remote === true) return true;
  return inferRemote(location.fullLocation);
}

function isUsOrRemoteLocation(location?: SmartRecruitersLocation): boolean {
  if (!location) return false;
  if (isRemoteLocation(location)) return true;
  if (isUsCountry(location.country)) return true;

  const fullLocation = buildLocation(location);
  return fullLocation ? !isNonUsLocation(fullLocation) : false;
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildPublicUrl(
  posting: SmartRecruitersPostingSummary,
  companyIdentifier: string,
  title: string,
  postingId: string,
): string {
  const ref = posting.ref?.trim();
  if (ref && !ref.includes('api.smartrecruiters.com')) return ref;

  const titleSlug = slugifyTitle(title);
  const companyPath = encodeURIComponent(companyIdentifier);
  return titleSlug
    ? `https://jobs.smartrecruiters.com/${companyPath}/${postingId}-${titleSlug}`
    : `https://jobs.smartrecruiters.com/${companyPath}/${postingId}`;
}

async function fetchJson<T>(url: string): Promise<FetchJsonResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { status: response.status, data: null };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return { status: response.status, data: null };
    }

    const data = (await response.json()) as T;
    return { status: response.status, data };
  } catch {
    return { status: 0, data: null };
  } finally {
    clearTimeout(timeout);
  }
}

function getCompanyPathVariants(companyName: string): string[] {
  return Array.from(new Set([companyName, encodeURIComponent(companyName)]));
}

async function fetchCompanyPostings(companyName: string): Promise<SmartRecruitersCompanyFetch | null> {
  for (const companyPath of getCompanyPathVariants(companyName)) {
    const postings: SmartRecruitersPostingSummary[] = [];
    const seenPostingIds = new Set<string>();
    let offset = 0;

    while (true) {
      const { status, data } = await fetchJson<SmartRecruitersCompanyResponse>(
        `https://api.smartrecruiters.com/v1/companies/${companyPath}/postings?limit=${POSTINGS_PAGE_SIZE}&offset=${offset}`,
      );

      if (status === 404) {
        break;
      }

      if (!data || !Array.isArray(data.content)) {
        break;
      }

      const page = data.content;
      if (page.length === 0) {
        break;
      }

      let addedOnPage = 0;

      for (const posting of page) {
        const postingId = posting.id?.trim() || posting.uuid?.trim();
        if (postingId) {
          if (seenPostingIds.has(postingId)) continue;
          seenPostingIds.add(postingId);
        }

        postings.push(posting);
        addedOnPage += 1;
      }

      if (addedOnPage === 0) {
        break;
      }

      const pageLimit = typeof data.limit === 'number' && data.limit > 0
        ? data.limit
        : POSTINGS_PAGE_SIZE;
      const totalFound = typeof data.totalFound === 'number' ? data.totalFound : undefined;

      if (page.length < pageLimit) {
        break;
      }

      if (totalFound !== undefined && postings.length >= totalFound) {
        break;
      }

      offset += pageLimit;
    }

    if (postings.length > 0) {
      return {
        companyName,
        companyPath,
        postings,
      };
    }
  }

  return null;
}

function inferPostingExperienceLevel(posting: SmartRecruitersPostingSummary, title: string) {
  const summaryExperienceId = posting.experienceLevel?.id?.trim().toLowerCase();
  if (summaryExperienceId && SUMMARY_SENIOR_EXPERIENCE_IDS.has(summaryExperienceId)) {
    return null;
  }

  const inferred = inferExperienceLevel(title);
  if (inferred === null) {
    return null;
  }

  if (summaryExperienceId === 'internship') {
    return 'internship' as const;
  }

  if (summaryExperienceId && SUMMARY_ENTRY_EXPERIENCE_IDS.has(summaryExperienceId)) {
    return inferred === 'internship' || inferred === 'new_grad'
      ? inferred
      : 'entry_level';
  }

  return inferred;
}

function normalizePosting(
  companyFetch: SmartRecruitersCompanyFetch,
  posting: SmartRecruitersPostingSummary,
): NormalizedJob | null {
  const postingId = posting.id?.trim() || posting.uuid?.trim();
  const title = posting.name?.trim();
  if (!postingId || !title || !isLikelyTechTitle(title)) {
    return null;
  }

  if (!isUsOrRemoteLocation(posting.location)) {
    return null;
  }

  const experienceLevel = inferPostingExperienceLevel(posting, title);
  if (experienceLevel === null) {
    return null;
  }

  const company =
    posting.company?.name?.trim() ||
    companyFetch.companyName;
  if (!company) {
    return null;
  }

  const companyIdentifier =
    posting.company?.identifier?.trim() ||
    companyFetch.companyName;

  const location = buildLocation(posting.location);
  const remote =
    isRemoteLocation(posting.location) ||
    inferRemote(location);

  return {
    source: SOURCE,
    source_id: postingId,
    title,
    company,
    location,
    remote,
    url: buildPublicUrl(posting, companyIdentifier, title, postingId),
    experience_level: experienceLevel,
    roles: inferRoles(title),
    posted_at: posting.releasedDate,
    dedup_hash: generateHash(company, title, location ?? ''),
  };
}

async function fetchCompanyJobs(companyFetch: SmartRecruitersCompanyFetch): Promise<NormalizedJob[]> {
  const normalized: NormalizedJob[] = [];

  for (const posting of companyFetch.postings) {
    const job = normalizePosting(companyFetch, posting);
    if (job) {
      normalized.push(job);
    }
  }

  return normalized;
}

export async function scrapeSmartRecruiters(): Promise<NormalizedJob[]> {
  const companies = Array.from(new Set(SMARTRECRUITERS_COMPANIES));
  const jobMap = new Map<string, NormalizedJob>();
  let companiesWithPostings = 0;

  for (let index = 0; index < companies.length; index += COMPANY_BATCH_SIZE) {
    const batch = companies.slice(index, index + COMPANY_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(fetchCompanyPostings));
    const liveCompanies: SmartRecruitersCompanyFetch[] = [];

    for (const result of results) {
      if (result.status !== 'fulfilled' || result.value === null) continue;
      liveCompanies.push(result.value);
    }

    companiesWithPostings += liveCompanies.length;

    const jobResults = await Promise.allSettled(
      liveCompanies.map(fetchCompanyJobs),
    );

    for (const result of jobResults) {
      if (result.status !== 'fulfilled') continue;

      for (const job of result.value) {
        jobMap.set(job.source_id || job.dedup_hash, job);
      }
    }

    console.log(
      `  [smartrecruiters] Processed ${Math.min(index + COMPANY_BATCH_SIZE, companies.length)}/${companies.length} companies; ` +
        `live=${companiesWithPostings}; jobs=${jobMap.size}`,
    );

    if (index + COMPANY_BATCH_SIZE < companies.length) {
      await delay(COMPANY_BATCH_DELAY_MS);
    }
  }

  console.log(`  [smartrecruiters] Companies with postings: ${companiesWithPostings}`);
  console.log(`  [smartrecruiters] Total unique jobs: ${jobMap.size}`);

  return Array.from(jobMap.values());
}
