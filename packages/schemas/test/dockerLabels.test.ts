import { describe, expect, it } from 'vitest';
import { dockerLabelKeyProblem, dockerLabels, formatDockerLabels, MAX_DOCKER_LABELS, parseDockerLabels, updateService } from '../src/index.js';

describe('custom Docker labels (0.16.3)', () => {
  it('takes reverse-DNS style keys and single-line values', () => {
    expect(dockerLabels.parse({ 'com.example.team': 'payments', 'prometheus.io/scrape': 'true', a: '' })).toEqual({
      'com.example.team': 'payments',
      'prometheus.io/scrape': 'true',
      a: '',
    });
    expect(updateService.parse({ dockerLabels: null }).dockerLabels).toBeNull();
  });

  it('refuses reserved prefixes (any case), odd keys, multi-line values and too many labels', () => {
    expect(dockerLabelKeyProblem('ninedeploy.deployment')).toMatch(/reserved/);
    expect(dockerLabelKeyProblem('Traefik.http.routers.x.rule')).toMatch(/reserved/);
    expect(dockerLabelKeyProblem('com.docker.compose.project')).toMatch(/reserved/);
    for (const key of ['-x', 'x-', 'a b', 'a=b', 'x'.repeat(129), '']) expect(dockerLabelKeyProblem(key), key).not.toBeNull();
    expect(dockerLabels.safeParse({ 'ninedeploy.service': '1' }).success).toBe(false);
    expect(dockerLabels.safeParse({ ok: 'a\nb' }).success).toBe(false);
    expect(dockerLabels.safeParse({ ok: 'x'.repeat(1001) }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: MAX_DOCKER_LABELS + 1 }, (_, i) => [`k${i}`, 'v']));
    expect(dockerLabels.safeParse(many).success).toBe(false);
  });

  it('parses and formats the key=value text form', () => {
    const { labels, invalid } = parseDockerLabels('# team\ncom.example.team = payments\n\nempty=\nbad line\nninedeploy.x=1\ncom.example.team=billing\nurl=https://x/?a=b');
    expect(labels).toEqual({ 'com.example.team': 'billing', empty: '', url: 'https://x/?a=b' });
    expect(invalid).toEqual(['bad line', 'ninedeploy.x=1']);
    expect(formatDockerLabels({ b: '2', a: '1' })).toBe('a=1\nb=2');
    expect(formatDockerLabels(null)).toBe('');
  });
});
