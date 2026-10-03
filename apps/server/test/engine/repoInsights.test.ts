import { describe, expect, it, vi } from 'vitest';
import { serializeInsights, upsertInsights } from '../../src/engine/repoInsights.js';
import { createFakeDb } from '../helpers.js';

describe('repoInsights', () => {
  it('inserts a fresh row when no prior insights exist for the service', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      findFirst: { repoInsights: undefined },
      insert: {
        repo_insights: (value) => {
          inserts.push(value as Record<string, unknown>);
          return [value as Record<string, unknown>];
        },
      },
    });
    const insights = {
      framework: { id: 'node' },
      commitSha: 'abc123',
    } as never;
    await upsertInsights(db as never, 42, insights);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ serviceId: 42, frameworkId: 'node', commitSha: 'abc123' });
  });

  it('updates the existing row when an insights record already exists', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      findFirst: { repoInsights: { serviceId: 7, frameworkId: 'old', data: {}, commitSha: null } },
      update: {
        repo_insights: (value) => {
          updates.push(value as Record<string, unknown>);
          return [value as Record<string, unknown>];
        },
      },
    });
    const insights = { framework: { id: 'python' }, commitSha: 'def456' } as never;
    await upsertInsights(db as never, 7, insights);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ frameworkId: 'python', commitSha: 'def456' });
  });

  it('serializes a stored row back to its public DTO shape (the JSON column is the source of truth)', () => {
    const dto = { framework: { id: 'go' }, packageManager: 'go-modules' };
    const row = { serviceId: 1, frameworkId: 'go', data: dto, commitSha: 'x' } as never;
    expect(serializeInsights(row)).toBe(dto);
  });

  it('persists a null commitSha when insights do not carry one (best-effort detection)', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      findFirst: { repoInsights: undefined },
      insert: {
        repo_insights: (value) => {
          inserts.push(value as Record<string, unknown>);
          return [value as Record<string, unknown>];
        },
      },
    });
    const insights = { framework: { id: 'static' } } as never;
    await upsertInsights(db as never, 9, insights);
    expect(inserts[0]).toMatchObject({ serviceId: 9, frameworkId: 'static', commitSha: null });
  });

  it('does not silently re-insert after a successful update', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      findFirst: { repoInsights: { serviceId: 3, frameworkId: 'old', data: {}, commitSha: null } },
      update: {
        repo_insights: (value) => {
          updates.push(value as Record<string, unknown>);
          return [value as Record<string, unknown>];
        },
      },
      insert: {
        repo_insights: (value) => {
          inserts.push(value as Record<string, unknown>);
          return [value as Record<string, unknown>];
        },
      },
    });
    await upsertInsights(db as never, 3, { framework: { id: 'new' } } as never);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(1);
  });

  it('reports a meaningful error when the underlying DB throws during the lookup', async () => {
    const db = {
      query: {
        repoInsights: { findFirst: vi.fn().mockRejectedValue(new Error('db down')) },
      },
    };
    await expect(upsertInsights(db as never, 1, { framework: { id: 'x' } } as never)).rejects.toThrow('db down');
  });
});
