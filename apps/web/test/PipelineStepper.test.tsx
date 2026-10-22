import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { parsePipelineStages, PipelineStepper } from '../src/components/PipelineStepper.js';

describe('PipelineStepper', () => {
  it('parses raw logs into active pipeline stages correctly', () => {
    const rawLogs = `
▶ Deployment #10 for "api" (docker)
##[stage:PREPARE:running] Resolving repository, sources and workspace
##[stage:PREPARE:success]
##[stage:BUILD:running] Building image and compiling dependencies
##[stage:BUILD:success]
##[stage:BOOT:success] Container runtime launched in isolated sandbox
##[stage:HEALTHCHECK:running] Probing container HTTP healthcheck
##[stage:HEALTHCHECK:success]
##[stage:PROXY_SWAP:running] Updating Traefik dynamic router & shifting live traffic
##[stage:PROXY_SWAP:success]
##[stage:CLEANUP:success]
##[stage:COMPLETE:success] Service is live and healthy on production
✓ Deployment successful
`;

    const stages = parsePipelineStages(rawLogs, 'running');
    expect(stages.find((s) => s.id === 'PREPARE')?.status).toBe('success');
    expect(stages.find((s) => s.id === 'BUILD')?.status).toBe('success');
    expect(stages.find((s) => s.id === 'HEALTHCHECK')?.status).toBe('success');
    expect(stages.find((s) => s.id === 'PROXY_SWAP')?.status).toBe('success');
    expect(stages.find((s) => s.id === 'COMPLETE')?.status).toBe('success');
  });

  it('marks running stage as failed when deploy fails or error stage arrives', () => {
    const rawLogs = `
##[stage:PREPARE:success]
##[stage:BUILD:running] Building image
##[stage:ERROR:failed] Docker build timed out
`;

    const stages = parsePipelineStages(rawLogs, 'failed');
    const buildStage = stages.find((s) => s.id === 'BUILD');
    expect(buildStage?.status).toBe('failed');
  });

  it('marks running stage when cancelled', () => {
    const rawLogs = `
##[stage:PREPARE:running] Cloning
`;

    const stages = parsePipelineStages(rawLogs, 'cancelled');
    const prepareStage = stages.find((s) => s.id === 'PREPARE');
    expect(prepareStage?.status).toBe('failed');
    expect(prepareStage?.detail).toBe('Deployment cancelled');
  });

  it('renders interactive stepper buttons and handles stage click', () => {
    const onStageClick = vi.fn();
    const rawLogs = `
##[stage:PREPARE:running] Checking out
`;

    render(
      <PipelineStepper
        rawLogs={rawLogs}
        deployStatus="building"
        onStageClick={onStageClick}
      />
    );

    expect(screen.getByText('Zero-downtime deployment')).toBeInTheDocument();
    expect(screen.getByText('Prepare')).toBeInTheDocument();

    const prepBtn = screen.getByText('Prepare').closest('button');
    expect(prepBtn).toBeTruthy();
    fireEvent.click(prepBtn!);
    expect(onStageClick).toHaveBeenCalledWith('PREPARE');
  });

  it('0.16.13: says a deploy waits for approval', () => {
    render(<PipelineStepper rawLogs="" deployStatus="awaiting_approval" />);
    expect(screen.getByText('Awaiting approval')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for a workspace admin to approve this deploy/)).toBeInTheDocument();
  });

  it('shows CI waiting before any preparation or build stage starts', () => {
    render(<PipelineStepper rawLogs="" deployStatus="awaiting_ci" />);
    expect(screen.getByText('Waiting for CI')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for required CI workflows on the pinned commit/)).toBeInTheDocument();
    expect(parsePipelineStages('', 'awaiting_ci').every((stage) => stage.status === 'pending')).toBe(true);
  });

  it('ignores log lines for unknown stage names', () => {
    const stages = parsePipelineStages('##[stage:MYSTERY:running] nope', 'building');
    expect(stages.every((s) => s.status === 'pending')).toBe(true);
  });

  it('marks the running stage failed with the default detail when ERROR carries no text', () => {
    // A non-failed deploy status keeps the parse-level detail (the isFailed
    // path would overwrite it with the generic banner detail below).
    const stages = parsePipelineStages('##[stage:BUILD:running]\n##[stage:ERROR:failed]', 'building');
    const buildStage = stages.find((s) => s.id === 'BUILD');
    expect(buildStage?.status).toBe('failed');
    expect(buildStage?.detail).toBe('Stage failed');
  });

  it('renders a failed stage with the error styling and its detail', () => {
    render(
      <PipelineStepper
        rawLogs={'##[stage:PREPARE:success] Checked out\n##[stage:BUILD:running] Building\n##[stage:ERROR:failed] Build crashed'}
        deployStatus="building"
      />,
    );
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build: Build crashed' })).toBeInTheDocument();
    expect(screen.getByText('The current release stays live while the new container is prepared.')).toBeInTheDocument();
  });

  it('renders a mid-pipeline running stage with the spinner and done states', () => {
    render(
      <PipelineStepper
        rawLogs={'##[stage:PREPARE:success] Checked out\n##[stage:BUILD:running] Compiling'}
        deployStatus="building"
      />,
    );
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('The current release stays live while the new container is prepared.')).toBeInTheDocument();
  });

  it('renders failed and live badge states appropriately', () => {
    const { rerender } = render(
      <PipelineStepper
        rawLogs=""
        deployStatus="failed"
      />
    );
    expect(screen.getByText('Failed')).toBeInTheDocument();

    rerender(
      <PipelineStepper
        rawLogs=""
        deployStatus="running"
      />
    );
    expect(screen.getByText('All traffic is now served by the new release.')).toBeInTheDocument();
  });

  describe('0.16.9 canary stage', () => {
    const before = `##[stage:PREPARE:success]
##[stage:BUILD:success]
##[stage:BOOT:success]
##[stage:HEALTHCHECK:running] Probing
##[stage:HEALTHCHECK:success]
`;

    it('is left out of a deploy without a canary, including a skipped one', () => {
      const ids = parsePipelineStages(`${before}Canary release skipped: it is a rollback. All traffic switches at once.
##[stage:PROXY_SWAP:running]`, 'deploying').map((s) => s.id);
      expect(ids).toEqual(['PREPARE', 'BUILD', 'BOOT', 'HEALTHCHECK', 'PROXY_SWAP', 'CLEANUP', 'COMPLETE']);
      const { container } = render(<PipelineStepper rawLogs={before} deployStatus="deploying" />);
      expect(container.querySelector('.grid-cols-7')).not.toBeNull();
      expect(screen.queryByText('Canary')).not.toBeInTheDocument();
    });

    it('sits between Health and Route and shows the latest step', () => {
      const logs = `${before}##[stage:CANARY:running] Step 1/2: 10% of requests go to the new release for 120s
##[stage:CANARY:running] Step 2/2: 50% of requests go to the new release for 120s`;
      const stages = parsePipelineStages(logs, 'deploying');
      expect(stages.map((s) => s.id)).toEqual(['PREPARE', 'BUILD', 'BOOT', 'HEALTHCHECK', 'CANARY', 'PROXY_SWAP', 'CLEANUP', 'COMPLETE']);
      expect(stages[4]).toMatchObject({ status: 'running', detail: 'Step 2/2: 50% of requests go to the new release for 120s' });
      const { container } = render(<PipelineStepper rawLogs={logs} deployStatus="deploying" />);
      expect(container.querySelector('.grid-cols-8')).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Canary: Step 2/2: 50% of requests go to the new release for 120s' })).toBeInTheDocument();
    });

    it('passes when every step passed or the canary was promoted', () => {
      for (const end of ['Every step passed', 'Promoted']) {
        const stages = parsePipelineStages(`${before}##[stage:CANARY:running] Step 1/2: 10%
##[stage:CANARY:success] ${end}
##[stage:PROXY_SWAP:running]`, 'deploying');
        expect(stages.find((s) => s.id === 'CANARY')).toMatchObject({ status: 'success', detail: end });
        expect(stages.find((s) => s.id === 'PROXY_SWAP')?.status).toBe('running');
      }
    });

    it('keeps the abort reason when the deploy then fails', () => {
      const reason = 'Canary aborted: at 10%, 12% of 240 requests failed with a 5xx (the limit is 5%)';
      const stages = parsePipelineStages(`${before}##[stage:CANARY:running] Step 1/2: 10%
##[stage:CANARY:failed] ${reason}
##[stage:ERROR:failed]`, 'failed');
      expect(stages.find((s) => s.id === 'CANARY')).toMatchObject({ status: 'failed', detail: reason });
      expect(stages.find((s) => s.id === 'PROXY_SWAP')?.status).toBe('pending');
    });
  });
});
