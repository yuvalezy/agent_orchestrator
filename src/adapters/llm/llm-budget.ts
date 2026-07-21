import { query, withClient } from '../../db';
import type { TokenUsage } from '../../ports/llm.port';
import { CostCapExceeded } from './errors';

export interface BudgetReservation {
  id: string;
  reservedUsd: number;
}

export interface BudgetCostRecord {
  provider: string;
  model: string;
  role: string;
  customerId: string | null;
  usage: TokenUsage;
  actualUsd: number;
}

export interface LlmBudgetPort {
  reserve(provider: string, model: string, role: string, maximumUsd: number, dailyCapUsd: number): Promise<BudgetReservation>;
  settle(reservation: BudgetReservation, cost: BudgetCostRecord): Promise<void>;
  forfeit(reservation: BudgetReservation): Promise<void>;
}

export interface LlmBudgetStatus {
  budgetDate: string;
  spentUsd: number;
  reservedUsd: number;
  activeReservations: number;
}

const TODAY_PANAMA = `(now() AT TIME ZONE 'America/Panama')::date`;

/** Operational aggregate only: no prompts, customer ids, or model outputs. */
export async function getLlmBudgetStatus(): Promise<LlmBudgetStatus> {
  const { rows } = await query<{
    budget_date: string;
    spent_usd: string;
    reserved_usd: string;
    active_reservations: number;
  }>(
    `SELECT ${TODAY_PANAMA}::text AS budget_date,
            coalesce(b.spent_usd, 0)::text AS spent_usd,
            coalesce(b.reserved_usd, 0)::text AS reserved_usd,
            count(r.id)::int AS active_reservations
       FROM (SELECT ${TODAY_PANAMA} AS budget_date) d
       LEFT JOIN llm_daily_budgets b USING (budget_date)
       LEFT JOIN llm_budget_reservations r
              ON r.budget_date = d.budget_date AND r.status = 'reserved'
      GROUP BY d.budget_date, b.spent_usd, b.reserved_usd`,
  );
  const row = rows[0];
  return {
    budgetDate: row.budget_date,
    spentUsd: Number(row.spent_usd),
    reservedUsd: Number(row.reserved_usd),
    activeReservations: row.active_reservations,
  };
}

/** PostgreSQL-backed hard cap. The budget row is locked while reserve/settle mutates it. */
export const postgresLlmBudget: LlmBudgetPort = {
  async reserve(provider, model, role, maximumUsd, dailyCapUsd) {
    return withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO llm_daily_budgets (budget_date) VALUES (${TODAY_PANAMA})
           ON CONFLICT (budget_date) DO NOTHING`,
        );
        // Rebuild committed spend from its durable sources: every usage-bearing call in
        // llm_costs (including embeddings and pre-migration callers), plus pessimistically
        // forfeited reservations that have no usage row. Summing either with the previous
        // spent_usd would double-count router settlements; GREATEST would undercount new
        // external costs after a forfeiture.
        await client.query(
          `UPDATE llm_daily_budgets b
              SET spent_usd =
                    (SELECT coalesce(sum(cost_usd), 0) FROM llm_costs
                      WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'America/Panama') AT TIME ZONE 'America/Panama')
                    +
                    (SELECT coalesce(sum(reserved_usd), 0) FROM llm_budget_reservations
                      WHERE budget_date = b.budget_date AND status = 'forfeited'),
                  updated_at = now()
            WHERE budget_date = ${TODAY_PANAMA}`,
        );
        const { rows } = await client.query<{ spent_usd: string; reserved_usd: string }>(
          `SELECT spent_usd, reserved_usd FROM llm_daily_budgets
            WHERE budget_date = ${TODAY_PANAMA} FOR UPDATE`,
        );
        const spent = Number(rows[0]?.spent_usd ?? 0);
        const reserved = Number(rows[0]?.reserved_usd ?? 0);
        if (spent + reserved + maximumUsd > dailyCapUsd) {
          await client.query('ROLLBACK');
          throw new CostCapExceeded(spent + reserved, dailyCapUsd);
        }
        const inserted = await client.query<{ id: string }>(
          `WITH bumped AS (
             UPDATE llm_daily_budgets
                SET reserved_usd = reserved_usd + $1, updated_at = now()
              WHERE budget_date = ${TODAY_PANAMA}
          )
          INSERT INTO llm_budget_reservations (budget_date, reserved_usd, provider, model, role)
          VALUES (${TODAY_PANAMA}, $1, $2, $3, $4)
          RETURNING id`,
          [maximumUsd, provider, model, role],
        );
        await client.query('COMMIT');
        return { id: inserted.rows[0].id, reservedUsd: maximumUsd };
      } catch (err) {
        // ROLLBACK is harmless after the explicit over-cap rollback above.
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    });
  },

  async settle(reservation, cost) {
    if (cost.actualUsd > reservation.reservedUsd) {
      throw new Error(
        `LLM actual cost ${cost.actualUsd} exceeded reservation ${reservation.reservedUsd}; reservation retained`,
      );
    }
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const updated = await client.query<{ budget_date: string }>(
          `UPDATE llm_budget_reservations
              SET actual_usd = $2, status = 'settled', settled_at = now()
            WHERE id = $1 AND status = 'reserved'
          RETURNING budget_date`,
          [reservation.id, cost.actualUsd],
        );
        if (updated.rowCount !== 1) throw new Error(`LLM budget reservation ${reservation.id} is not open`);
        await client.query(
          `UPDATE llm_daily_budgets
              SET reserved_usd = greatest(0, reserved_usd - $2),
                  spent_usd = spent_usd + $3,
                  updated_at = now()
            WHERE budget_date = $1`,
          [updated.rows[0].budget_date, reservation.reservedUsd, cost.actualUsd],
        );
        await client.query(
          `INSERT INTO llm_costs (provider, model, role, customer_id, input_tokens, output_tokens, cost_usd)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [cost.provider, cost.model, cost.role, cost.customerId, cost.usage.inputTokens, cost.usage.outputTokens, cost.actualUsd],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  },

  async forfeit(reservation) {
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const updated = await client.query<{ budget_date: string }>(
          `UPDATE llm_budget_reservations
              SET actual_usd = reserved_usd, status = 'forfeited', settled_at = now()
            WHERE id = $1 AND status = 'reserved'
          RETURNING budget_date`,
          [reservation.id],
        );
        if (updated.rowCount === 1) {
          await client.query(
            `UPDATE llm_daily_budgets
                SET reserved_usd = greatest(0, reserved_usd - $2),
                    spent_usd = spent_usd + $2,
                    updated_at = now()
              WHERE budget_date = $1`,
            [updated.rows[0].budget_date, reservation.reservedUsd],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  },
};
