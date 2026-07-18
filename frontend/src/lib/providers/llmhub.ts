import { ENV } from '@/lib/env';
import type { GeneratePayload, GenerateResult, GenerateHooks } from '@/lib/fal-types';
import { resolveLlmhubModelId } from '@/config/llmhub-model-map';

export function getLlmhubResolution(aspectRatio = '16:9', resolution = '720p'): { width: number; height: number } {
  const cleanRatio = (aspectRatio || '16:9').trim();
  const cleanRes = (resolution || '720p').trim().toLowerCase();

  let multiplier = 1;
  if (cleanRes.includes('1080p')) {
    multiplier = 1.5;
  } else if (cleanRes.includes('4k')) {
    multiplier = 3;
  }

  if (cleanRatio === '9:16') {
    return { width: Math.round(720 * multiplier), height: Math.round(1280 * multiplier) };
  } else if (cleanRatio === '1:1') {
    return { width: Math.round(720 * multiplier), height: Math.round(720 * multiplier) };
  }

  // Fallback to 16:9
  return { width: Math.round(1280 * multiplier), height: Math.round(720 * multiplier) };
}

export function parseDuration(durationVal?: number | string | null): number {
  if (typeof durationVal === 'number') {
    return durationVal;
  }
  if (typeof durationVal === 'string') {
    const parsed = parseFloat(durationVal.replace(/[^\d.]/g, ''));
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  return 5; // Default fallback
}

export async function generateVideoViaLlmhub(
  payload: GeneratePayload,
  hooks?: GenerateHooks
): Promise<GenerateResult> {
  const apiKey = ENV.LLMHUB_API_KEY;
  if (!apiKey) {
    throw new Error('LLMHUB_API_KEY is not configured in the environment.');
  }

  const baseUrl = ENV.LLMHUB_BASE_URL || 'https://api.llmhub.com.cn/v1';

  // 1. Resolve starting image (Image-to-Video)
  let imageUrl = payload.imageUrl || '';
  if (!imageUrl && payload.inputs) {
    const imageInput = payload.inputs.find((i) => i.kind === 'image' || i.type?.startsWith('image/'));
    if (imageInput?.url) {
      imageUrl = imageInput.url;
    }
  }
  if (!imageUrl && payload.referenceImages && payload.referenceImages.length > 0) {
    imageUrl = payload.referenceImages[0];
  }

  const isImageToVideo = Boolean(imageUrl);

  // 2. Resolve target model ID
  const modelId = resolveLlmhubModelId(payload.engineId, isImageToVideo);

  // 3. Resolve resolution
  const { width, height } = getLlmhubResolution(payload.aspectRatio, payload.resolution);

  // 4. Resolve duration
  const durationSec = parseDuration(payload.durationSec ?? payload.durationOption);

  // 5. Build prompt details
  const body: Record<string, unknown> = {
    model: modelId,
    prompt: payload.prompt,
    duration: durationSec,
    width,
    height,
    fps: payload.fps || 30,
    n: 1,
  };

  if (imageUrl) {
    body.image = imageUrl;
  }

  if (typeof payload.seed === 'number') {
    body.seed = payload.seed;
  }

  // Handle optional negative prompt in metadata
  const negativePrompt = payload.extraInputValues?.negative_prompt;
  if (typeof negativePrompt === 'string' && negativePrompt.trim()) {
    body.metadata = {
      negative_prompt: negativePrompt.trim(),
    };
  }

  const endpoint = `${baseUrl}/video/generations`;
  console.info('[llmhub] Submitting generation task', {
    endpoint,
    model: modelId,
    duration: durationSec,
    dimensions: `${width}x${height}`,
    isImageToVideo,
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[llmhub] Submission failed', {
      status: response.status,
      statusText: response.statusText,
      errorText,
    });
    throw new Error(`LLMHub API failed (${response.status}): ${errorText || response.statusText}`);
  }

  const data = (await response.json()) as { task_id: string; status?: string };

  if (!data?.task_id) {
    throw new Error('LLMHub API response did not contain a valid task_id.');
  }

  if (hooks?.onRequestId) {
    await Promise.resolve(hooks.onRequestId(data.task_id));
  }

  return {
    provider: 'LLMHUB',
    providerJobId: data.task_id,
    status: 'queued',
    progress: 0,
    thumbUrl: payload.imageUrl || '',
  };
}
