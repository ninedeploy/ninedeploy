// Client surface: ci (R5 CI jobs on enrolled runners).
import type { CiAttemptView, CiJobView, CiPipeline, CiRunnerCreate, CiRunnerView } from '@ninedeploy/schemas';
import type { Transport } from '../transport.js';

/** A slice of an attempt's log. Ask again from `size` for what came after. */
export interface CiLogSlice {
  data: string;
  size: number;
  done: boolean;
}

export interface CiApi {
  ci: {
    runners: {
      /** Operator. */
      list: () => Promise<CiRunnerView[]>;
      /** Operator. The token is shown once: give it to the runner as NINEDEPLOY_RUNNER_TOKEN. */
      create: (input: Partial<CiRunnerCreate> & { name: string }) => Promise<{ id: number; name: string; token: string }>;
      /** Operator. Its token stops working and its running jobs are requeued. */
      revoke: (runnerId: number) => Promise<{ ok: boolean }>;
    };
    /** The service's pipeline, or null when it has none. */
    pipeline: (serviceId: number) => Promise<{ pipeline: CiPipeline | null }>;
    /** Service admin. */
    setPipeline: (serviceId: number, pipeline: Partial<CiPipeline> & Pick<CiPipeline, 'image' | 'script'>) => Promise<{ pipeline: CiPipeline }>;
    /** Service admin. */
    deletePipeline: (serviceId: number) => Promise<{ ok: boolean }>;
    jobs: {
      /** The latest 50, newest first. */
      list: (serviceId: number) => Promise<CiJobView[]>;
      get: (serviceId: number, jobId: number) => Promise<{ job: CiJobView; attempts: CiAttemptView[] }>;
      /** Member. `ref` is a branch or commit; the service branch when left out. */
      create: (serviceId: number, opts?: { ref?: string }) => Promise<CiJobView>;
      /** Service admin, for a pipeline that requires approval (and fork previews). */
      approve: (serviceId: number, jobId: number) => Promise<{ ok: boolean }>;
      cancel: (serviceId: number, jobId: number) => Promise<{ ok: boolean }>;
      log: (serviceId: number, jobId: number, attempt: number, opts?: { offset?: number }) => Promise<CiLogSlice>;
    };
  };
}

export function ciApi(t: Transport): CiApi {
  const { get, send } = t;
  const jobs = (serviceId: number) => `/v1/services/${serviceId}/ci/jobs`;
  return {
    ci: {
      runners: {
        list: () => get<CiRunnerView[]>('/v1/ci/runners'),
        create: (input) => send('POST', '/v1/ci/runners', input),
        revoke: (runnerId) => send<{ ok: boolean }>('DELETE', `/v1/ci/runners/${runnerId}`),
      },
      pipeline: (serviceId) => get<{ pipeline: CiPipeline | null }>(`/v1/services/${serviceId}/ci`),
      setPipeline: (serviceId, pipeline) => send<{ pipeline: CiPipeline }>('PUT', `/v1/services/${serviceId}/ci`, pipeline),
      deletePipeline: (serviceId) => send<{ ok: boolean }>('DELETE', `/v1/services/${serviceId}/ci`),
      jobs: {
        list: (serviceId) => get<CiJobView[]>(jobs(serviceId)),
        get: (serviceId, jobId) => get<{ job: CiJobView; attempts: CiAttemptView[] }>(`${jobs(serviceId)}/${jobId}`),
        create: (serviceId, opts) => send<CiJobView>('POST', jobs(serviceId), opts ?? {}),
        approve: (serviceId, jobId) => send<{ ok: boolean }>('POST', `${jobs(serviceId)}/${jobId}/approve`),
        cancel: (serviceId, jobId) => send<{ ok: boolean }>('POST', `${jobs(serviceId)}/${jobId}/cancel`),
        log: (serviceId, jobId, attempt, opts) =>
          get<CiLogSlice>(`${jobs(serviceId)}/${jobId}/attempts/${attempt}/log${opts?.offset ? `?offset=${opts.offset}` : ''}`),
      },
    },
  };
}
