import type { ResultProviderMode } from '@/types/providers';
import { defaultResultProvider } from '../../lib/result-provider-mode';

export type { ResultProviderMode } from '@/types/providers';

export function getResultProviderMode(): ResultProviderMode {
  const provider = defaultResultProvider();
  if (provider === 'llmhub') return 'LLMHUB';
  if (provider === 'test') return 'TEST';
  return 'FAL';
}

export function shouldUseFalApis(): boolean {
  return getResultProviderMode() === 'FAL';
}

export function shouldUseLlmhubApis(): boolean {
  return getResultProviderMode() === 'LLMHUB';
}
