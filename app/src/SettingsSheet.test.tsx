import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsSheet } from './SettingsSheet';
import type { AppConfig } from './types';

// Isolate the sheet from the real Firebase SDK; the toggle wiring is what matters.
vi.mock('./push', () => ({
  pushLocallyEnabled: () => false,
  enablePush: vi.fn(),
  disablePush: vi.fn(),
}));

function renderSheet(config: AppConfig | null) {
  return render(
    <SettingsSheet
      open
      onClose={vi.fn()}
      config={config}
      deviceLabel="Yuval's Pixel"
      installPrompt={null}
      onLogout={vi.fn()}
      onForegroundRefresh={vi.fn()}
    />,
  );
}

describe('SettingsSheet push toggle', () => {
  it('disables the toggle and explains when the server reports Firebase absent', () => {
    renderSheet({ firebase: null, vapidKey: null });
    expect(screen.getByText('Push not configured on server')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Push notifications' })).toBeDisabled();
  });

  it('enables the toggle when Firebase config and a vapid key are present', () => {
    renderSheet({
      firebase: { apiKey: 'k', authDomain: 'a', projectId: 'p', messagingSenderId: 's', appId: 'x' },
      vapidKey: 'vapid',
    });
    expect(screen.queryByText('Push not configured on server')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Push notifications' })).toBeEnabled();
  });

  it('shows the device label', () => {
    renderSheet({ firebase: null, vapidKey: null });
    expect(screen.getByText("Yuval's Pixel")).toBeInTheDocument();
  });
});
