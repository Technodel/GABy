import path from 'path';

export function canonicalizePaths(output: string, workingDir: string): string {
  if (!workingDir) return output;
  
  const pathMap = new Map<string, string>();
  let refCounter = 1;

  // Find all absolute paths in output that start with the working dir
  // We'll use a simple regex for absolute paths
  const absolutePathRegex = /(?:\b|^|\s)(\/[a-zA-Z0-9_\-./]+|[a-zA-Z]:\\[a-zA-Z0-9_\-.\\/]+)(?=\b|$|\s|:)/gm;
  const matches = output.matchAll(absolutePathRegex);

  for (const match of matches) {
    const fullPath = match[1];
    
    // Check if it's actually an absolute path inside workingDir
    try {
      if (!fullPath.includes(workingDir.slice(0, 10))) continue; // basic check
      
      const rel = path.relative(workingDir, fullPath);
      if (rel && !rel.startsWith('..') && !pathMap.has(fullPath)) {
        pathMap.set(fullPath, `#${refCounter}: ${rel}`);
        refCounter++;
      }
    } catch {
      // ignore path errors
    }
  }

  if (pathMap.size === 0) return output;

  let result = output;
  for (const [full, short] of pathMap.entries()) {
    // Replace all occurrences
    result = result.split(full).join(short);
  }

  const legend = `[Path Reference Legend]\n${
    Array.from(pathMap.entries())
      .map(([full, short]) => `${short}: ${full}`)
      .join('\n')
  }\n\n`;
  
  return legend + result;
}
