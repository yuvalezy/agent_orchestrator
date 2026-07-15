import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { SettingsView } from './SettingsView';

const settingsPayload = {
  data: {
    categories: [
      {
        category: 'Ingest',
        settings: [
          {
            key: 'ingest.enabled', label: 'Ingest enabled', description: 'Pull new messages.',
            type: 'boolean', applyMode: 'live', value: false, default: true,
          },
          {
            key: 'ingest.batch_size', label: 'Batch size', description: 'Messages per poll.',
            type: 'number', applyMode: 'restart', value: 25, default: 25, dependsOn: 'ingest.enabled',
          },
        ],
      },
      {
        category: 'LLM',
        settings: [
          {
            key: 'llm.effort', label: 'Reasoning effort', description: 'Depth per call.',
            type: 'enum', applyMode: 'live', value: 'medium', default: 'medium', options: ['low', 'medium', 'high'],
          },
        ],
      },
    ],
  },
};

function stubApi(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/push/status')) {
      return new Response(JSON.stringify({ data: { configured: false, registrationAvailable: false, publicKey: null } }), { status: 200 });
    }
    return new Response(JSON.stringify(settingsPayload), { status: 200 });
  }));
}

function renderView(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SettingsView /></QueryClientProvider>);
}

afterEach(() => vi.unstubAllGlobals());

describe('SettingsView', () => {
  it('renders the first category and flags restart-apply settings', async () => {
    stubApi();
    renderView();

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    // First category is active by default, so only its settings are on screen.
    expect(screen.getByText('Ingest enabled')).toBeInTheDocument();
    expect(screen.getByText('Batch size')).toBeInTheDocument();
    expect(screen.queryByText('Reasoning effort')).not.toBeInTheDocument();

    // The badge belongs to the restart-apply setting only — scoped per row, since the
    // page intro also uses the words "needs restart".
    const restartRow = screen.getByText('Batch size').parentElement as HTMLElement;
    expect(within(restartRow).getByText('needs restart')).toBeInTheDocument();
    const liveRow = screen.getByText('Ingest enabled').parentElement as HTMLElement;
    expect(within(liveRow).queryByText('needs restart')).not.toBeInTheDocument();
  });

  it('disables a setting whose dependsOn parent is off and names the parent', async () => {
    stubApi();
    renderView();

    expect(await screen.findByText('Disabled — enable Ingest enabled first.')).toBeInTheDocument();
    // ingest.enabled is false, so the dependent number input must be inert.
    expect(screen.getByRole('spinbutton')).toBeDisabled();
    // The parent toggle itself stays interactive.
    expect(screen.getByRole('switch')).toBeEnabled();
  });
});
