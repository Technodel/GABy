import { getModelsForMode, getVisionCapableModels, classifyTaskType, reorderModelsForProTask } from './agent';
import { resolveModelsForTier } from './model-distribution-engine';

export async function resolveModelsForTurn(resolvedMode: string, imageData: string | null, userMessage: string) {
  const isVisionRequest = !!imageData;
  let modelEntries = isVisionRequest
    ? await (async () => {
        const vision = await getVisionCapableModels();
        if (vision.length > 0) {
          console.log(`[model-factory] Using vision-capable models: ${vision.map(v => v.provider).join(', ')}`);
          return vision;
        }
        console.warn('[model-factory] imageData present but no vision-capable model found');
        return [];
      })()
    : await resolveModelsForTier(resolvedMode);

  if (resolvedMode === 'pro' && modelEntries.length >= 2) {
    const taskType = classifyTaskType(userMessage);
    const prevOrder = modelEntries.map(e => e.provider).join(' -> ');
    modelEntries = reorderModelsForProTask(modelEntries, taskType);
    const newOrder = modelEntries.map(e => e.provider).join(' -> ');
    if (prevOrder !== newOrder) {
      console.log(`[model-factory] Pro task-routing: "${taskType}" -> ${newOrder}`);
    }
  }
  return modelEntries;
}
