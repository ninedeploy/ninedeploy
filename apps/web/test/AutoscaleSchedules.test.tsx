import { useState } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AUTOSCALE_SCHEDULES_MAX } from '@ninedeploy/schemas';
import { AutoscaleSchedules, browserTimeZone, scheduleRowsFrom, schedulesFromRows, type ScheduleRow } from '../src/routes/service/AutoscaleSchedules.js';
import { renderWithProviders } from './helpers.js';

function Editor({ initial = [] }: { initial?: ScheduleRow[] }) {
  const [rows, setRows] = useState(initial);
  const [timezone, setTimezone] = useState('UTC');
  return <><AutoscaleSchedules rows={rows} onRows={setRows} timezone={timezone} onTimezone={setTimezone} />
    <output data-testid="schedule-data">{JSON.stringify({ timezone, schedules: schedulesFromRows(rows) })}</output></>;
}
const data = () => JSON.parse(screen.getByTestId('schedule-data').textContent!);

it('adds, edits and removes a scheduled replica floor', async () => {
  renderWithProviders(<Editor />);
  await userEvent.click(screen.getByRole('button', { name: 'Add window' }));
  expect(data().schedules).toEqual([{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00', minReplicas: 2 }]);
  await userEvent.click(screen.getByRole('button', { name: 'Mon' }));
  await userEvent.click(screen.getByRole('button', { name: 'Sun' }));
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '23:00' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '01:00' } });
  fireEvent.change(screen.getByLabelText('At least'), { target: { value: '4' } });
  fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Europe/Istanbul' } });
  expect(data()).toEqual({ timezone: 'Europe/Istanbul', schedules: [{ days: [0, 2, 3, 4, 5], from: '23:00', to: '01:00', minReplicas: 4 }] });
  await userEvent.click(screen.getByRole('button', { name: 'Remove window' }));
  expect(data().schedules).toEqual([]);
});

it('limits the number of windows and shows a validation error', () => {
  const row = { days: [1], from: '08:00', to: '18:00', minReplicas: '2' };
  renderWithProviders(<AutoscaleSchedules rows={Array.from({ length: AUTOSCALE_SCHEDULES_MAX }, () => row)} onRows={vi.fn()} timezone="UTC" onTimezone={vi.fn()} error="A window needs days" />);
  expect(screen.getByRole('button', { name: 'Add window' })).toBeDisabled();
  expect(screen.getByText('A window needs days')).toBeInTheDocument();
});

it('round-trips schedule rows without mutating their day order and falls back to UTC', () => {
  const schedule = { days: [5, 1], from: '08:00', to: '18:00', minReplicas: 2 };
  const rows = scheduleRowsFrom([schedule]);
  expect(schedulesFromRows(rows)[0]?.days).toEqual([1, 5]);
  expect(schedule.days).toEqual([5, 1]);
  expect(scheduleRowsFrom(undefined)).toEqual([]);
  const spy = vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({ resolvedOptions: () => ({ timeZone: '' }) } as Intl.DateTimeFormat);
  try { expect(browserTimeZone()).toBe('UTC'); } finally { spy.mockRestore(); }
});
