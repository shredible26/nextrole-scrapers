export const GITHUB_REPO_SOURCES = [
  'pittcsc',
  'simplify_internships',
  'vanshb03_newgrad',
  'vanshb03_internships',
  'ambicuity',
  'speedyapply_swe',
  'speedyapply_ai',
  'speedyapply_ai_newgrad',
  'speedyapply_swe_newgrad',
  'jobright_swe',
  'jobright_data',
  'zapplyjobs',
] as const;

export const GITHUB_REPO_SOURCE_SET = new Set<string>(GITHUB_REPO_SOURCES);
