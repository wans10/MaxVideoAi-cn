import { query } from '@/lib/db';
import { generateVideoViaLlmhub } from '@/lib/providers/llmhub';
import { translateError } from '@/lib/error-messages';
import { rollbackPendingPayment } from './payment-rollback';
import type { PaymentMode, PendingReceipt } from './initial-video-job';
import {
  buildUserFacingRefundDescription,
  toUserFacingFailureMessage,
} from '@/server/user-facing-failure-messages';
import type { GeneratePayload, GenerateResult } from '@/lib/fal-types';

type LogMetricFn = (
  kind: 'failed' | 'rejected' | 'accepted' | 'completed',
  event?: {
    jobId?: string;
    errorCode?: string;
    meta?: Record<string, unknown>;
    durationMs?: number;
  }
) => void;

export type LlmhubGenerateSubmissionResult =
  | {
      ok: true;
      generationResult: GenerateResult;
    }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

export async function markJobAwaitingLlmhub(params: {
  jobId: string;
  engineId: string;
  providerJobId: string;
  message: string | null;
  statusLabel: string;
}): Promise<void> {
  try {
    await query(
      `UPDATE app_jobs
       SET status = 'running',
           progress = GREATEST(progress, 10),
           message = CASE WHEN $2 IS NOT NULL THEN $2::text ELSE message END,
           provider_job_id = COALESCE($3, provider_job_id),
           provisional = FALSE,
           updated_at = NOW()
       WHERE job_id = $1`,
      [params.jobId, params.message, params.providerJobId]
    );
  } catch (error) {
    console.warn('[api/generate] failed to mark job awaiting LLMHub', { jobId: params.jobId }, error);
  }

  try {
    await query(
      `INSERT INTO fal_queue_log (job_id, provider, provider_job_id, engine_id, status, payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        params.jobId,
        'llmhub',
        params.providerJobId,
        params.engineId,
        params.statusLabel,
        JSON.stringify({
          at: new Date().toISOString(),
          message: params.message,
        }),
      ]
    );
  } catch (error) {
    console.warn('[queue-log] failed to record transient LLMHub event', error);
  }
}

export async function submitLlmhubGenerateTask(params: {
  llmhubPayload: GeneratePayload;
  jobId: string;
  engineId: string;
  engineLabel: string;
  batchId: string | null;
  durationSec: number;
  pendingReceipt: PendingReceipt | null;
  paymentMode: PaymentMode;
  walletChargeReserved: boolean;
  persistProviderJobId: (providerJobId: string) => void | Promise<void>;
  logMetricFn: LogMetricFn;
}): Promise<LlmhubGenerateSubmissionResult> {
  try {
    const generationResult = await generateVideoViaLlmhub(
      { ...params.llmhubPayload },
      {
        onRequestId: async (requestId) => {
          console.info('[llmhub] request id received', {
            jobId: params.jobId,
            engineId: params.engineId,
            requestId,
          });
          await Promise.resolve(params.persistProviderJobId(requestId));
          await markJobAwaitingLlmhub({
            jobId: params.jobId,
            engineId: params.engineId,
            providerJobId: requestId,
            message: 'Queued at LLMHub gateway.',
            statusLabel: 'queued',
          });
        },
      }
    );

    return { ok: true, generationResult };
  } catch (error) {
    const rawStatus =
      error && typeof error === 'object' && 'status' in error ? (error as { status?: number }).status : undefined;
    const status = rawStatus ?? 500;

    const providerMessage = error instanceof Error ? error.message : 'LLMHub task submission failed';
    const translation = translateError({
      code: 'PROVIDER_ERROR',
      status,
      message: providerMessage,
      providerMessage,
    });

    const failureMessage = toUserFacingFailureMessage(translation.message);
    const errorCode = translation.code;
    const providerJobId = params.batchId ?? null;

    const paymentStatusOverride =
      params.pendingReceipt && params.paymentMode === 'wallet'
        ? 'refunded_wallet'
        : params.pendingReceipt && params.paymentMode !== 'wallet'
          ? 'refunded'
          : null;

    const refundDescription = buildUserFacingRefundDescription({
      engineLabel: params.engineLabel,
      durationSec: params.durationSec,
      reason: failureMessage,
    });

    console.error(
      '[api/generate] LLMHub generation failed during submission',
      {
        jobId: params.jobId,
        engineId: params.engineId,
        status,
        providerMessage,
      },
      error
    );

    try {
      await query(
        `UPDATE app_jobs
         SET status = 'failed',
             progress = 0,
             message = $2,
             provisional = FALSE,
             provider_job_id = COALESCE($3, provider_job_id),
             payment_status = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE payment_status END,
             updated_at = NOW()
         WHERE job_id = $1`,
        [params.jobId, failureMessage, providerJobId, paymentStatusOverride]
      );
    } catch (updateError) {
      console.error('[api/generate] failed to update provisional job after LLMHub error', updateError);
    }

    if (params.pendingReceipt) {
      await rollbackPendingPayment({
        pendingReceipt: params.pendingReceipt,
        walletChargeReserved: params.walletChargeReserved,
        refundDescription,
      });
    }

    params.logMetricFn('failed', {
      errorCode,
      meta: {
        stage: 'provider_error',
        provider: 'llmhub',
        providerJobId,
      },
    });

    return {
      ok: false,
      status,
      body: {
        ok: false,
        error: errorCode,
        message: failureMessage,
        providerMessage: null,
        detail: null,
      },
    };
  }
}
