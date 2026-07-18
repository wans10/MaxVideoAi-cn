export const LLMHUB_MODEL_MAP: Record<string, string | { t2v: string; i2v: string }> = {
  'seedance-2-0': 'doubao-seedance-2.0',
  'seedance-2-0-fast': 'doubao-seedance-2.0-fast',
};

export function resolveLlmhubModelId(engineId: string, isImageToVideo: boolean): string {
  // 1. Specific environment overrides for Wan 2.7
  if (engineId === 'wan-2-7') {
    const wanT2vOverride = process.env.LLMHUB_MODEL_WAN_2_7_T2V;
    const wanI2vOverride = process.env.LLMHUB_MODEL_WAN_2_7_I2V;
    if (isImageToVideo && wanI2vOverride?.trim()) {
      return wanI2vOverride.trim();
    }
    if (!isImageToVideo && wanT2vOverride?.trim()) {
      return wanT2vOverride.trim();
    }
  }

  // 2. Generic environment overrides for single-value models
  const envKey = `LLMHUB_MODEL_${engineId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
  const override = process.env[envKey];
  if (override && override.trim()) {
    return override.trim();
  }

  // 3. Fallback to static mapping
  const mapped = LLMHUB_MODEL_MAP[engineId];
  if (!mapped) {
    return engineId; // Fallback to the engine ID directly if not mapped
  }

  if (typeof mapped === 'string') {
    return mapped;
  }

  return isImageToVideo ? mapped.i2v : mapped.t2v;
}
