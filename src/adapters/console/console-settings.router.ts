import { Router, type Response } from 'express';
import { logger } from '../../logger';
import { SETTINGS_REGISTRY, settingDef, coerceSettingValue, type ApplyMode } from '../../config/settings-registry';
import { settingsStore, type SettingsStore } from '../../config/settings-store';
import { query } from '../../db';
import type { ConsoleAuditContext } from './console-repo';

// Console Settings surface (ADAPTER composition). Mounted under /console/api/settings by the main
// console router — so it inherits its session-auth + audit-context middleware and the CSRF guard,
// exactly like console-approvals.router. Reads/writes the 22 non-secret `*_ENABLED` flags via the
// core `settingsStore` overlay against `SETTINGS_REGISTRY` (the single source of truth). Setting
// VALUES are non-secret, but the value is NEVER logged or audited beyond its key + applyMode.

const auditCtx = (res: Response): ConsoleAuditContext => res.locals.consoleAuditContext as ConsoleAuditContext;

/** Best-effort console audit row for a settings change (post-success, non-tx; never throws). Mirrors
 *  auditApproval — records key + action + applyMode; the boolean value is NOT persisted. */
async function auditSetting(context: ConsoleAuditContext, key: string, applyMode: ApplyMode): Promise<void> {
  try {
    await query(
      `INSERT INTO console_audit_events (actor, action, entity_type, entity_id, request_id, safe_metadata)
       VALUES ($1, 'setting.update', 'app_settings', $2, $3, jsonb_build_object('apply_mode', $4::text))`,
      [context.actor, key, context.requestId, applyMode],
    );
  } catch (err) {
    logger.warn({ key, reason: (err as Error)?.message }, 'console settings audit insert failed (non-fatal)');
  }
}

export function buildConsoleSettingsRouter(deps: { store?: SettingsStore } = {}): Router {
  const router = Router();
  const store = deps.store ?? settingsStore;

  // GET → registry grouped into categories (first-seen order), each setting carrying its effective
  // value from the overlay cache plus its registry metadata.
  router.get('/', (_req, res) => {
    const byCategory = new Map<string, Array<Record<string, unknown>>>();
    for (const def of SETTINGS_REGISTRY) {
      let bucket = byCategory.get(def.category);
      if (!bucket) {
        bucket = [];
        byCategory.set(def.category, bucket);
      }
      bucket.push({
        key: def.key,
        label: def.label,
        description: def.description,
        type: def.type,
        applyMode: def.applyMode,
        value: store.get(def.key),
        default: def.default,
        dependsOn: def.dependsOn ?? null,
        options: def.options ?? null,
        min: def.min ?? null,
        max: def.max ?? null,
        integer: def.integer ?? null,
      });
    }
    const categories = Array.from(byCategory, ([category, settings]) => ({ category, settings }));
    res.json({ data: { categories } });
  });

  // PUT /:key → update a single setting. 400 on unknown key or a value that fails the
  // setting's type/constraint validation (coerced per its registry def).
  router.put('/:key', async (req, res, next) => {
    const key = req.params.key;
    const def = settingDef(key);
    if (!def) return void res.status(400).json({ error: 'unknown setting key' });
    const coerced = coerceSettingValue(def, (req.body as { value?: unknown } | undefined)?.value);
    if ('error' in coerced) return void res.status(400).json({ error: coerced.error });
    try {
      const { applyMode } = await store.set(key, coerced.value, auditCtx(res)?.actor);
      await auditSetting(auditCtx(res), key, applyMode);
      res.status(200).json({ data: { key, value: coerced.value, applyMode, needsRestart: applyMode === 'restart' } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
