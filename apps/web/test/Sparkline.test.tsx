import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import './web-utils.js';
import { Sparkline } from '../src/components/Sparkline.js';

describe('Sparkline', () => {
  it('renders a flat baseline when there are no points', () => {
    const { container } = render(<Sparkline points={[]} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(container.querySelector('line')).not.toBeNull();
    expect(container.querySelector('path')).toBeNull();
    expect(svg?.getAttribute('class')).toContain('opacity-40');
  });

  it('renders a flat baseline for a single point', () => {
    const { container } = render(<Sparkline points={[5]} />);
    expect(container.querySelector('line')).not.toBeNull();
    expect(container.querySelector('path')).toBeNull();
  });

  it('renders a polyline and area fill for multiple points', () => {
    const { container } = render(<Sparkline points={[1, 3, 2, 5]} />);
    const paths = container.querySelectorAll('path');
    expect(paths).toHaveLength(2);
    expect(container.querySelector('line')).toBeNull();
  });

  it('handles a flat series (max === min) without dividing by zero', () => {
    const { container } = render(<Sparkline points={[4, 4, 4]} />);
    expect(container.querySelectorAll('path')).toHaveLength(2);
  });

  it('respects custom color, height and width', () => {
    const { container } = render(<Sparkline points={[1, 2]} color="#ff0000" height={50} width={200} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('200');
    expect(svg?.getAttribute('height')).toBe('50');
    const stroke = container.querySelector('path[stroke]');
    expect(stroke?.getAttribute('stroke')).toBe('#ff0000');
  });
});
