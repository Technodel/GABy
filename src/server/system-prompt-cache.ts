interface CachedSystemSections {
  base: string;
  rules: string;
  projectGuide: string;
  hash: string;
}

let cachedSections: CachedSystemSections | null = null;

export function buildSystemPromptOptimized(parts: {
  base: string;
  rules: string;
  projectGuide: string;
  crossProject?: string;
  repoMap?: string;
  hypothesis?: string;
  toolMandate?: string;
  workingDir: string;
}): string {
  const stableKey = `${parts.base}|${parts.rules}|${parts.projectGuide}`;
  
  if (!cachedSections || cachedSections.hash !== stableKey) {
    cachedSections = {
      base: parts.base,
      rules: parts.rules,
      projectGuide: parts.projectGuide,
      hash: stableKey,
    };
  }
  
  return [
    cachedSections.base,
    cachedSections.rules,
    cachedSections.projectGuide,
    parts.crossProject ? `<CrossProject>\n${parts.crossProject}\n</CrossProject>` : '',
    `<WorkingDirectory>${parts.workingDir}</WorkingDirectory>`,
    parts.repoMap ? `<RepoMap>\n${parts.repoMap}\n</RepoMap>` : '',
    parts.hypothesis ? `<Hypothesis>\n${parts.hypothesis}\n</Hypothesis>` : '',
    parts.toolMandate ? `<ToolMandate>\n${parts.toolMandate}\n</ToolMandate>` : '',
  ].filter(Boolean).join('\n\n');
}

export function invalidateProjectGuideCache(): void {
  cachedSections = null;
}
