import { inferExperienceLevel, inferRoles, inferRemote } from '../utils/normalize'
import { generateHash } from '../utils/dedup'
import type { NormalizedJob } from '../utils/normalize'

const CAREERJET_QUERY_URL = 'https://search.api.careerjet.net/v4/query'

const SEARCH_TERMS = [
  'software engineer entry level',
  'software engineer new grad 2026',
  'data scientist entry level',
  'machine learning engineer entry level',
  'junior software engineer',
  'associate software engineer',
  'data analyst entry level',
  'backend engineer entry level',
  'frontend engineer entry level',
  'devops engineer entry level',
]

interface CareerjetJob {
  url: string
  title: string
  company: string
  locations: string
  date: string
  description: string
  salary?: string
}

interface CareerjetResponse {
  type: string
  hits?: number
  jobs?: CareerjetJob[]
  message?: string
  error?: string
}

function careerjetBasicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`
}

export async function scrapeCareerjet(): Promise<NormalizedJob[]> {
  const apiKey = process.env.CAREERJET_API_KEY
  if (!apiKey) {
    console.warn('  [careerjet] CAREERJET_API_KEY not set, skipping')
    return []
  }

  const userIp = process.env.CAREERJET_USER_IP ?? '127.0.0.1'
  const userAgent =
    process.env.CAREERJET_USER_AGENT ?? 'NextRole/1.0 (job aggregator; +https://nextrole.dev)'

  const allJobs: NormalizedJob[] = []
  const seen = new Set<string>()

  const fetches = SEARCH_TERMS.map(async (term) => {
    for (let page = 1; page <= 3; page++) {
      try {
        const params = new URLSearchParams({
          keywords: term,
          location: 'United States',
          locale_code: 'en_US',
          page_size: '99',
          page: String(page),
          sort: 'date',
          user_ip: userIp,
          user_agent: userAgent,
        })
        const res = await fetch(`${CAREERJET_QUERY_URL}?${params}`, {
          headers: {
            Authorization: careerjetBasicAuth(apiKey),
            Referer: 'https://nextrole-phi.vercel.app',
          },
        })
        if (!res.ok) {
          const body = await res.text()
          const hint =
            res.status === 403 && body.includes('Unauthorized access from IP')
              ? ' (allow this server IP in your Careerjet publisher account if required)'
              : ''
          console.warn(
            `  [careerjet] HTTP ${res.status} for "${term}" page ${page}${hint}:`,
            body.slice(0, 200),
          )
          break
        }
        const data: CareerjetResponse = await res.json()
        if (data.type === 'ERROR') {
          console.warn(
            `  [careerjet] API error for "${term}" page ${page}:`,
            data.error ?? data.message ?? JSON.stringify(data).slice(0, 200),
          )
          break
        }
        if (data.type === 'LOCATIONS') {
          console.warn(
            `  [careerjet] location issue for "${term}" page ${page}:`,
            data.message ?? 'unknown',
          )
          break
        }
        if (data.type !== 'JOBS' || !data.jobs?.length) break

        for (const job of data.jobs) {
          const url = job.url ?? ''
          if (!url || seen.has(url)) continue
          seen.add(url)
          const title = job.title ?? ''
          const description = job.description ?? ''
          const level = inferExperienceLevel(title, description)
          if (!level) continue
          const location = job.locations ?? ''
          allJobs.push({
            source: 'careerjet',
            source_id: url,
            title,
            company: job.company ?? '',
            location: location || undefined,
            remote: inferRemote(location) || inferRemote(title),
            url,
            description: description.slice(0, 5000) || undefined,
            experience_level: level,
            roles: inferRoles(title),
            posted_at: undefined,
            dedup_hash: generateHash(job.company ?? '', title, location),
          })
        }

        if (data.jobs.length < 99) break
        await new Promise(r => setTimeout(r, 500))
      } catch (err) {
        const cause = err instanceof Error && err.cause ? String(err.cause) : ''
        console.warn(
          `  [careerjet] failed for "${term}" page ${page}:`,
          String(err).slice(0, 120),
          cause ? `cause: ${cause.slice(0, 80)}` : '',
        )
        break
      }
    }
  })

  await Promise.all(fetches)
  console.log(`  [careerjet] ${allJobs.length} jobs fetched`)
  return allJobs
}
