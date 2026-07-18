import { NextRequest, NextResponse } from 'next/server';
import { runLlmhubPoll } from '@/server/llmhub-poll';
import { authorizeCronRequest } from '@/server/vercel-cron';

export const runtime = 'nodejs';

const CRON_SECRET = (process.env.CRON_SECRET ?? '').trim();
const POLL_TOKEN = (process.env.FAL_POLL_TOKEN ?? '').trim(); // Share the same poll token for ease of setup

function unauthorized(reason: string, req: NextRequest) {
  const info = {
    reason,
    headers: {
      cron: req.headers.get('x-vercel-cron') || null,
      ua: req.headers.get('user-agent') || null,
      deployment: req.headers.get('x-vercel-deployment-id') || null,
      source: req.headers.get('x-vercel-source') || null,
    },
  };
  console.warn('[cron-llmhub-poll] unauthorized', info);
  return NextResponse.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
}

async function triggerPoll(req: NextRequest) {
  const auth = authorizeCronRequest(req.headers, {
    cronSecret: CRON_SECRET,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
    localTokens: [POLL_TOKEN],
    overrideHeaderName: 'x-llmhub-poll-token',
    vercelEnv: process.env.VERCEL,
  });
  if (!auth.ok) {
    return unauthorized(auth.reason, req);
  }

  console.log('[cron-llmhub-poll] triggering LLMHub poll', {
    env: process.env.VERCEL === '1' ? 'vercel' : 'local',
    authMode: auth.mode,
  });

  try {
    return await runLlmhubPoll();
  } catch (error) {
    console.error('[cron-llmhub-poll] failed to run poll', error);
    return NextResponse.json({ ok: false, error: 'Failed to run LLMHub poll' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return triggerPoll(req);
}

export async function POST(req: NextRequest) {
  return triggerPoll(req);
}
