// Onboarding composition (ADAPTER). Shared by the CLI (scripts/onboard-customer.ts) and the
// console onboarding screen so both run the identical onboard + backfill-seed sequence.
export { onboardCustomerCore, defaultOnboardCoreDeps, WorkItemTypeError } from './onboard-core';
export type { OnboardCoreInput, OnboardCoreResult, OnboardCoreDeps } from './onboard-core';
export { seedBackfillDry, syncCustomerTaskInventory } from './backfill-seed';
export type { SeedDryResult } from './backfill-seed';
export { buildOnboardingService } from './onboarding-service';
export type {
  OnboardingService,
  OnboardingServiceDeps,
  CustomerSearchResult,
  ProjectSearchResult,
  CustomerPreview,
  ContactPreview,
  OnboardResult,
  BackfillState,
  BackfillMode,
  DrySummary,
} from './onboarding-service';
