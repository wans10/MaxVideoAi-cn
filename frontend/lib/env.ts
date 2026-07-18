const RESULT_PROVIDER = (process.env.NEXT_PUBLIC_RESULT_PROVIDER ?? '').trim();
const FAL_API_KEY =
  typeof window === 'undefined'
    ? (process.env.FAL_API_KEY ?? process.env.FAL_KEY ?? '').trim()
    : '';
const WORKSPACE_CENTER_GALLERY = (process.env.NEXT_PUBLIC_WORKSPACE_CENTER_GALLERY ?? '').trim().toLowerCase();

const LLMHUB_API_KEY =
  typeof window === 'undefined'
    ? (process.env.LLMHUB_API_KEY ?? '').trim()
    : '';
const LLMHUB_BASE_URL = (process.env.LLMHUB_BASE_URL ?? 'https://api.llmhub.com.cn/v1').trim();

export const ENV = {
  RESULT_PROVIDER: RESULT_PROVIDER || null,
  FAL_API_KEY: FAL_API_KEY || null,
  FAL_KEY: FAL_API_KEY || null,
  LLMHUB_API_KEY: LLMHUB_API_KEY || null,
  LLMHUB_BASE_URL,
  WORKSPACE_CENTER_GALLERY,
} as const;

export type EnvShape = typeof ENV;
