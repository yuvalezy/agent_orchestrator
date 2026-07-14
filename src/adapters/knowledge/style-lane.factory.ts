import { env } from '../../config/env';
import { logger } from '../../logger';
import { buildStyleLane, type StyleLane } from '../../knowledge/style-lane';
import { memoryRepo } from '../../knowledge/memory-repo';

// Style-Correction Always-On lane (gated STYLE_LANE_ENABLED) — the ONE composition root where the
// core style-lane meets the core memoryRepo's non-gated style reader (a pure DB read — no embedding
// adapter, no secret). Shared so EVERY drafting/revising composition root wires the SAME gated
// builder (DRY): the inbox-processor drafter AND the 🔁 Revise reviser. Returns undefined when off
// → the caller injects no voice guidance. Best-effort at read time (a fetch miss degrades to [],
// never a drafting/revise failure). NO new flag — reuses STYLE_LANE_ENABLED / STYLE_LANE_MAX.

export function buildStyleLaneGated(): StyleLane | undefined {
  if (!env.STYLE_LANE_ENABLED) {
    logger.info('style lane NOT wired (STYLE_LANE_ENABLED=false)');
    return undefined;
  }
  logger.info({ max: env.STYLE_LANE_MAX }, 'style lane wired (STYLE_LANE_ENABLED=true)');
  return buildStyleLane({
    list: memoryRepo.listStyleCorrections.bind(memoryRepo),
    options: { limit: env.STYLE_LANE_MAX },
  });
}
