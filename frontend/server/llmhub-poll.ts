import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { updateJobFromFalWebhook } from '@/server/fal-webhook-handler';
import { toUserFacingFailureMessage } from '@/server/user-facing-failure-messages';
import { ENV } from '@/lib/env';

type LlmhubPendingJob = {
  job_id: string;
  surface: string | null;
  engine_id: string;
  provider_job_id: string;
  status: string;
  updated_at: string;
  created_at: string;
};

const POLL_BASE_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
const POLL_INITIAL_DELAY_MS = 5_000;
const POLL_MAX_DURATION_MS = 35 * 60_000;
const POLL_TIMEOUT_GRACE_MS = 20 * 60_000;

export async function runLlmhubPoll() {
  const rows = await query<LlmhubPendingJob>(
    `SELECT job_id, surface, engine_id, provider_job_id, status, updated_at, created_at
     FROM app_jobs
     WHERE provider_job_id IS NOT NULL
       AND provider = 'llmhub'
       AND status IN ('pending', 'queued', 'running', 'processing', 'in_progress')
     ORDER BY updated_at ASC
     LIMIT 10`
  );

  if (!rows.length) {
    return NextResponse.json({ ok: true, checked: 0, updates: 0 });
  }

  const apiKey = ENV.LLMHUB_API_KEY;
  if (!apiKey) {
    console.error('[llmhub-poll] LLMHUB_API_KEY is not configured in the environment.');
    return NextResponse.json({ ok: false, error: 'LLMHUB_API_KEY is not configured.' }, { status: 500 });
  }

  const baseUrl = ENV.LLMHUB_BASE_URL || 'https://api.llmhub.com.cn/v1';
  let updates = 0;

  for (const job of rows) {
    if (job.surface === 'audio') {
      continue;
    }

    type MarkFailedOptions = {
      autoRefundEligible?: boolean;
      failureOrigin?: 'provider_terminal' | 'poll_internal';
    };

    const recordPollEvent = async (status: string, payload: Record<string, unknown>) => {
      if (!job.provider_job_id) return;
      try {
        await query(
          `INSERT INTO fal_queue_log (job_id, provider, provider_job_id, engine_id, status, payload)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
          [
            job.job_id,
            'llmhub',
            job.provider_job_id,
            job.engine_id,
            status,
            JSON.stringify({
              at: new Date().toISOString(),
              ...payload,
            }),
          ]
        );
      } catch (logError) {
        console.warn('[llmhub-poll] failed to record poll event', { jobId: job.job_id, status }, logError);
      }
    };

    const markJobFailed = async (reason: string, options: MarkFailedOptions = {}) => {
      const autoRefundEligible = options.autoRefundEligible === true;
      const userMessage = toUserFacingFailureMessage(reason);
      console.warn('[llmhub-poll] marking job as failed', {
        at: new Date().toISOString(),
        jobId: job.job_id,
        providerJobId: job.provider_job_id,
        reason,
        autoRefundEligible,
        failureOrigin: options.failureOrigin ?? 'poll_internal',
      });
      await recordPollEvent('poll:failed', { reason });
      try {
        await updateJobFromFalWebhook({
          request_id: job.provider_job_id,
          status: 'failed',
          response: { error: userMessage, status: 'failed' },
          result: { error: userMessage, status: 'failed' },
          auto_refund_eligible: autoRefundEligible,
          failure_origin: options.failureOrigin ?? 'poll_internal',
        });
      } catch (updateError) {
        console.warn('[llmhub-poll] updateJobFromFalWebhook failed, falling back to DB update', job.job_id, updateError);
        try {
          await query(
            `UPDATE app_jobs SET status = 'failed', progress = LEAST(progress, 1), message = $1 WHERE job_id = $2`,
            [userMessage, job.job_id]
          );
        } catch (writeError) {
          console.warn('[llmhub-poll] db update fallback failed', job.job_id, writeError);
        }
      }
      updates += 1;
    };

    try {
      const now = Date.now();
      const updatedAtMs = Date.parse(job.updated_at);
      if (Number.isFinite(updatedAtMs) && now - updatedAtMs < POLL_INITIAL_DELAY_MS) {
        continue;
      }

      const createdAtMs = Date.parse(job.created_at);
      const ageMs = Number.isFinite(createdAtMs) ? now - createdAtMs : 0;
      const timedOut = Number.isFinite(createdAtMs) && ageMs > POLL_MAX_DURATION_MS;
      const beyondTimeoutGrace = Number.isFinite(createdAtMs) && ageMs > POLL_MAX_DURATION_MS + POLL_TIMEOUT_GRACE_MS;

      const pollHistory = await query<{ attempts: number; last_attempt_at: string | null }>(
        `SELECT COUNT(*)::int AS attempts, MAX(created_at) AS last_attempt_at
         FROM fal_queue_log
         WHERE provider_job_id = $1
           AND status LIKE 'poll:%'`,
        [job.provider_job_id]
      );
      const previousAttempts = pollHistory[0]?.attempts ?? 0;
      const pollAttempt = previousAttempts + 1;
      const lastAttemptAtMs = pollHistory[0]?.last_attempt_at ? Date.parse(pollHistory[0].last_attempt_at) : null;
      const backoffMs =
        POLL_BASE_DELAYS_MS[Math.min(previousAttempts, POLL_BASE_DELAYS_MS.length - 1)] ??
        POLL_BASE_DELAYS_MS[POLL_BASE_DELAYS_MS.length - 1];

      if (lastAttemptAtMs && now - lastAttemptAtMs < backoffMs) {
        continue;
      }

      const endpoint = `${baseUrl}/video/generations/${job.provider_job_id}`;
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn('[llmhub-poll] fetch status failed', {
          jobId: job.job_id,
          status: response.status,
          errorText,
        });

        if (timedOut && beyondTimeoutGrace) {
          await markJobFailed(`LLMHub status check failed repeatedly (${response.status}): ${errorText}`);
          continue;
        }
        await recordPollEvent('poll:error', { status: response.status, errorText });
        continue;
      }

      const data = (await response.json()) as {
        task_id: string;
        status: 'queued' | 'in_progress' | 'completed' | 'failed';
        url?: string;
        error?: { code?: number; message?: string };
      };

      await recordPollEvent('poll:status', {
        attempt: pollAttempt,
        status: data.status,
      });

      if (data.status === 'failed') {
        const errMsg = data.error?.message || 'Render failed at LLMHub gateway';
        await markJobFailed(errMsg, {
          autoRefundEligible: true,
          failureOrigin: 'provider_terminal',
        });
        continue;
      }

      if (data.status === 'completed' && data.url) {
        await updateJobFromFalWebhook({
          request_id: job.provider_job_id,
          status: 'completed',
          result: {
            video: {
              url: data.url,
            },
          },
        });
        console.info('[llmhub-poll] job completed successfully', {
          jobId: job.job_id,
          providerJobId: job.provider_job_id,
          url: data.url,
        });
        updates += 1;
        continue;
      }

      // If queued or in_progress, update progress label & record update
      if (data.status === 'in_progress' || data.status === 'queued') {
        if (timedOut && beyondTimeoutGrace) {
          await markJobFailed('Render exceeded maximum duration window.');
          continue;
        }

        await updateJobFromFalWebhook({
          request_id: job.provider_job_id,
          status: data.status === 'in_progress' ? 'in_progress' : 'queued',
        });
        updates += 1;
      }
    } catch (error) {
      console.warn('[llmhub-poll] failed to poll job', job.job_id, error);
      await recordPollEvent('poll:exception', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json({ ok: true, checked: rows.length, updates });
}
