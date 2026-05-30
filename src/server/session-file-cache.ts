import fs from 'fs';

const sessionFileCache = new Map<number, Map<string, { content: string; step: number }>>();

export function getOrReadFile(userId: number, filePath: string, currentStep: number): { content: string; memoized: boolean } {
  const userCache = sessionFileCache.get(userId) || new Map();
  
  if (userCache.has(filePath)) {
    const cached = userCache.get(filePath)!;
    return {
      content: `[File content unchanged since step ${cached.step}]\n\n` + cached.content,
      memoized: true,
    };
  }

  // Read file normally
  const content = fs.readFileSync(filePath, 'utf8');
  
  // Cache it
  userCache.set(filePath, { content, step: currentStep });
  sessionFileCache.set(userId, userCache);
  
  return { content, memoized: false };
}

// Clear cache when user edits the file or when the agent writes to it
export function invalidateFileInCache(userId: number, filePath: string): void {
  sessionFileCache.get(userId)?.delete(filePath);
}
