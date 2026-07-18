import { query } from '@/lib/db';
import { updateJobFromFalWebhook } from '@/server/fal-webhook-handler';
import { deriveJobSurface } from '@/lib/job-surface';
import { APP_JOBS_SELECT, type JobRow } from './jobs-route-types';
import { ENV } from '@/lib/env';

const FAILURE_STATES = new Set(['FAILED', 'FAIL', 'ERROR', 'ERRORED', 'CANCELLED', 'CANCELED', 'NOT_FOUND', 'MISSING', 'UNKNOWN']);
const COMPLETED_STATES = new Set(['COMPLETED', 'FINISHED', 'SUCCESS', 'SUCCEEDED']);

function getStaleLlmhubJobs(rows: JobRow[]): JobRow[] {
  return rows.filter((row) => {
    const surface = deriveJobSurface({
      surface: row.surface,
      settingsSnapshot: row.settings_snapshot,
      jobId: row.job_id,
      engineId: row.engine_id,
      videoUrl: row.video_url,
      renderIds: row.render_ids,
    });
    if (surface !== 'video') {
      return false;
    }
    if (!row.provider_job_id) return false;
    if (row.provider !== 'llmhub') return false;
    const status = (row.status ?? '').toLowerCase();
    if (status === 'failed' || status === 'cancelled' || status === 'canceled' || status === 'error') return false;
    const missingVideo = !row.video_url;
    if (!missingVideo && status === 'completed') return false;
    return missingVideo;
  });
}

async function markJobFailedFromStaleRefresh(
  jobRow: JobRow,
  reason: string,
  options: { autoRefundEligible?: boolean; failureOrigin?: 'provider_terminal' | 'stale_refresh_internal' } = {}
): Promise<void> {
  const autoRefundEligible = options.autoRefundEligible === true;
  console.warn('[api/jobs] marking llmhub job as failed after stale refresh', {
    jobId: jobRow.job_id,
    providerJobId: jobRow.provider_job_id,
    reason,
  });
  try {
    await updateJobFromFalWebhook({
      request_id: jobRow.provider_job_id ?? undefined,
      status: 'failed',
      response: { error: reason, status: 'failed' },
      result: { error: reason, status: 'failed' },
      auto_refund_eligible: autoRefundEligible,
      failure_origin: options.failureOrigin ?? 'stale_refresh_internal',
    });
  } catch (updateError) {
    console.warn('[api/jobs] failed to mark llmhub job as failed via webhook handler', jobRow.job_id, updateError);
    try {
      await query(
        `UPDATE app_jobs SET status = 'failed', progress = LEAST(progress, 1), message = $1 WHERE job_id = $2`,
        [reason, jobRow.job_id]
      );
    } catch (writeError) {
      console.warn('[api/jobs] database update fallback failed', jobRow.job_id, writeError);
    }
  }
}

export async function refreshStaleLlmhubJobs({
  rows,
  shouldRefreshStaleLlmhubJobs,
  userId,
}: {
  rows: JobRow[];
  shouldRefreshStaleLlmhubJobs: boolean;
  userId: string;
}): Promise<JobRow[]> {
  const staleJobs = shouldRefreshStaleLlmhubJobs ? getStaleLlmhubJobs(rows) : [];
  if (!staleJobs.length) {
    return rows;
  }

  const apiKey = ENV.LLMHUB_API_KEY;
  if (!apiKey) {
    return rows;
  }

  const baseUrl = ENV.LLMHUB_BASE_URL || 'https://api.llmhub.com.cn/v1';
  const refreshedIds: string[] = [];

  for (const jobRow of staleJobs) {
    const markJobFailed = async (
      reason: string,
      options: { autoRefundEligible?: boolean; failureOrigin?: 'provider_terminal' | 'stale_refresh_internal' } = {}
    ) => {
      await markJobFailedFromStaleRefresh(jobRow, reason, options);
      refreshedIds.push(jobRow.job_id);
    };

    try {
      const endpoint = `${baseUrl}/video/generations/${jobRow.provider_job_id}`;
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        console.warn('[api/jobs] llmhub status fetch failed', jobRow.job_id, response.status);
        continue;
      }

      const statusInfo = (await response.json()) as {
        task_id: string;
        status: 'queued' | 'in_progress' | 'completed' | 'failed';
        url?: string;
        error?: { code?: number; message?: string };
      };

      if (!statusInfo) {
        await markJobFailed('LLMHub job status unavailable.');
        continue;
      }

      const state = statusInfo.status ? statusInfo.status.toUpperCase() : undefined;
      const providerError = statusInfo.error?.message;

      if (state && FAILURE_STATES.has(state)) {
        await markJobFailed(providerError ?? 'LLMHub reported this job as failed.', {
          autoRefundEligible: true,
          failureOrigin: 'provider_terminal',
        });
        continue;
      }

      if (state && !COMPLETED_STATES.has(state)) {
        continue;
      }

      if (state === 'COMPLETED' && statusInfo.url) {
        await updateJobFromFalWebhook({
          request_id: jobRow.provider_job_id ?? undefined,
          status: 'completed',
          result: {
            video: {
              url: statusInfo.url,
            },
          },
        });
        refreshedIds.push(jobRow.job_id);
      }
    } catch (error) {
      console.warn('[api/jobs] failed to refresh llmhub job', jobRow.job_id, error);
      await markJobFailed(
        error instanceof Error ? error.message : 'LLMHub job could not be refreshed.'
      );
    }
  }

  if (!refreshedIds.length) {
    return rows;
  }

  const refreshedRows = await query<JobRow>(
    `SELECT ${APP_JOBS_SELECT}
       FROM app_jobs
      WHERE job_id = ANY($1::text[])`,
    [refreshedIds]
  );
  const refreshedMap = new Map(refreshedRows.map((row) => [row.job_id, row]));
  return rows.map((row) => refreshedMap.get(row.job_id) ?? row);
}
