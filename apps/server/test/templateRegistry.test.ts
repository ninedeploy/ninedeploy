import { describe, expect, it } from 'vitest';
import { getBundledTemplates, parseBundle } from '../src/templates/registry.js';

describe('bundled template registry', () => {
  const templates = getBundledTemplates();

  it('parses the bundle against the shared schema', () => {
    // getBundledTemplates caches; validate the raw envelope too so a schema
    // drift in registry.json fails here with the registry's own message.
    const raw = JSON.parse(JSON.stringify({ version: 1, templates }));
    expect(() => parseBundle(raw)).not.toThrow();
  });

  it('keeps template ids unique', () => {
    const ids = templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('crosses the 100-template catalog mark', () => {
    // Competitive context: Coolify ships 280+ one-click services; the
    // catalog crossing 100 documents continued content investment. Deliberately
    // a floor, not a pin — additions must not break this test.
    expect(templates.length).toBeGreaterThanOrEqual(100);
  });

  it('every template is deployable on its face: port, image and category present', () => {
    for (const t of templates) {
      expect(t.id).toMatch(/^[a-z0-9-]+$/);
      expect(t.port).toBeGreaterThan(0);
      expect(t.port).toBeLessThanOrEqual(65535);
      expect(t.image).toMatch(/^[A-Za-z0-9][A-Za-z0-9@:/._-]*$/);
      expect(t.category.length).toBeGreaterThan(0);
      expect(t.tagline.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('honestly marks unverified templates', () => {
    // A template that has not been deploy-verified must say so — the wizard
    // surfaces this to the operator.
    for (const t of templates) {
      if (t.runtimeVerified === false) {
        expect(t.verifiedAt).toBeDefined();
      }
    }
  });
});
