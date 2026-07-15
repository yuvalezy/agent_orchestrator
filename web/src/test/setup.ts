import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Tests run with globals disabled, so RTL's auto-cleanup hook never registers itself.
afterEach(cleanup);
