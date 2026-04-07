import { spawnSync } from 'child_process'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { inferExperienceLevel, inferRoles, inferRemote } from '../utils/normalize'
import { generateHash } from '../utils/dedup'
import type { NormalizedJob } from '../utils/normalize'

const SEARCH_TERMS = [
  'software engineer entry level',
  'software engineer new grad',
  'data scientist entry level',
  'machine learning engineer entry level',
  'junior software engineer',
  'associate software engineer',
  'data analyst entry level',
  'software engineer 2026',
  'new grad software engineer',
  'associate data scientist',
]

function ensurePythonJobspy() {
  const check = spawnSync('python3', ['-c', 'import jobspy'], { stdio: 'pipe' })
  if (check.status !== 0) {
    console.log('  [ziprecruiter] installing python-jobspy...')
    spawnSync('pip3', ['install', 'python-jobspy', '--quiet', '--break-system-packages'], {
      stdio: 'inherit',
    })
  }
}

export async function scrapeZipRecruiter(): Promise<NormalizedJob[]> {
  const allJobs: NormalizedJob[] = []
  const seen = new Set<string>()

  try {
    ensurePythonJobspy()
  } catch (err) {
    console.warn('  [ziprecruiter] could not install python-jobspy, skipping')
    return []
  }

  for (const term of SEARCH_TERMS) {
    const tmpFile = join(tmpdir(), `zr_${Date.now()}_${Math.random().toString(36).slice(2)}.json`)
    const scriptFile = join(tmpdir(), `zr_script_${Date.now()}_${Math.random().toString(36).slice(2)}.py`)

    const pythonScript = `
import json, sys
try:
    from jobspy import scrape_jobs
    jobs = scrape_jobs(
        site_name=["zip_recruiter"],
        search_term=${JSON.stringify(term)},
        location="United States",
        results_wanted=100,
        hours_old=72,
        job_type="fulltime",
    )
    cols = [c for c in ["id","title","company","location","job_url","description","date_posted","min_amount","max_amount","is_remote"] if c in jobs.columns]
    result = jobs[cols].to_dict(orient="records")
    with open(${JSON.stringify(tmpFile)}, "w") as f:
        json.dump(result, f, default=str)
    print(f"OK:{len(result)}")
except Exception as e:
    print(f"ERR:{e}", file=sys.stderr)
    with open(${JSON.stringify(tmpFile)}, "w") as f:
        json.dump([], f)
`

    try {
      writeFileSync(scriptFile, pythonScript)
      spawnSync('python3', [scriptFile], { stdio: 'pipe', timeout: 90000 })

      if (existsSync(tmpFile)) {
        const raw: any[] = JSON.parse(readFileSync(tmpFile, 'utf-8'))
        for (const job of raw) {
          const id = String(job.id ?? job.job_url ?? '')
          if (!id || seen.has(id)) continue
          seen.add(id)
          const title = String(job.title ?? '')
          const description = String(job.description ?? '')
          const level = inferExperienceLevel(title, description)
          if (!level) continue
          const location = String(job.location ?? '')
          allJobs.push({
            source: 'ziprecruiter',
            source_id: id,
            title,
            company: String(job.company ?? ''),
            location: location || undefined,
            remote: job.is_remote === true || job.is_remote === 'True' || inferRemote(location),
            url: String(job.job_url ?? ''),
            description: description.slice(0, 5000) || undefined,
            salary_min: job.min_amount && !isNaN(Number(job.min_amount)) ? Math.round(Number(job.min_amount)) : undefined,
            salary_max: job.max_amount && !isNaN(Number(job.max_amount)) ? Math.round(Number(job.max_amount)) : undefined,
            experience_level: level,
            roles: inferRoles(title),
            posted_at: job.date_posted ? new Date(String(job.date_posted)).toISOString() : undefined,
            dedup_hash: generateHash(String(job.company ?? ''), title, location),
          })
        }
        unlinkSync(tmpFile)
      }
    } catch (err) {
      console.warn(`  [ziprecruiter] failed for "${term}":`, String(err).slice(0, 100))
    } finally {
      try { if (existsSync(scriptFile)) unlinkSync(scriptFile) } catch {}
    }

    await new Promise(r => setTimeout(r, 3000))
  }

  console.log(`  [ziprecruiter] ${allJobs.length} jobs fetched`)
  return allJobs
}
