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
    expect(screen.getByText('Rolled back')).toBeInTheDocument();

    rerender(
      <PipelineStepper
        rawLogs=""
        deployStatus="running"
      />
    );
    expect(screen.getByText('All traffic is now served by the new release.')).toBeInTheDocument();
  });
});
