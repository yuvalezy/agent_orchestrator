import type { AgenticAnswerPort } from '../ports/llm.port';
import type { QueryService, QueryResult, QueryCitation } from './query-service';
import type { QueryScope, ScopeResolver, ResolveScopeOptions } from './scope';
import type { AgenticToolset } from '../ports/llm.port';

// Agentic-first founder query wrapper (WP8, CORE — ports + core only; never imports src/adapters, D1).
//
// A DECORATOR over the existing single-shot QueryService: resolve the scope, build the scope-pinned
// read-only toolset, and try the agentic loop. On success it maps the loop's cited answer into the SAME
// QueryResult shape the Telegram/console renderers already use (formatAnswer). On null — the loop is
// unavailable (no tool-capable provider) or failed for ANY reason — it delegates to the inner single-shot
// engine UNCHANGED, so the single-shot path stays the default and the fallback. Wired ONLY when
// QUERY_AGENTIC_ENABLED (the factory returns the bare inner service otherwise → byte-identical).
//
// The inner engine re-resolves the scope on fallback (deterministic + cheap), so the two never disagree.
// NEVER logs the question, the tool results, or the answer — scope/count/flags only.

export interface AgenticQueryDeps {
  scopeResolver: ScopeResolver;
  /** Build the scope-pinned read-only toolset for a resolved scope (composed in the factory). */
  buildToolset: (scope: QueryScope) => AgenticToolset;
  /** The agentic loop (LlmRouter.answerAgentically). */
  agentic: AgenticAnswerPort;
  /** The single-shot query engine — the default + the fallback. */
  inner: QueryService;
  /** Scope/count/flags ONLY — never the question or the answer. */
  log: { info: (o: object, m: string) => void };
}

/** Clamp the loop's used-source indexes into the accumulated source list, preserving order (the loop
 *  already clamped; this is a defensive mirror of query-service.ts selectUsed). Falls back to the full
 *  list when the model cited none, so the founder always sees the sources behind the answer. */
function citationsFrom(sources: Array<{ label: string }>, usedIndexes: number[]): QueryCitation[] {
  const toCitation = (label: string): QueryCitation => ({ label, snippet: '', distance: 0 });
  const seen = new Set<number>();
  const picked: QueryCitation[] = [];
  for (const i of usedIndexes) {
    if (Number.isInteger(i) && i >= 0 && i < sources.length && !seen.has(i)) {
      seen.add(i);
      picked.push(toCitation(sources[i].label));
    }
  }
  return picked.length > 0 ? picked : sources.map((s) => toCitation(s.label));
}

export function buildAgenticQueryService(deps: AgenticQueryDeps): QueryService {
  return {
    async answer(question: string, opts?: ResolveScopeOptions): Promise<QueryResult> {
      const scope = await deps.scopeResolver.resolveScope(question, opts);
      const tools = deps.buildToolset(scope);

      // The tool loop NEVER throws (any throw → null); a null means unavailable/failed → fall back.
      const result = await deps.agentic.answerAgentically({ question, scope, tools });
      if (!result) {
        deps.log.info({ scope: scope.kind }, 'agentic: unavailable/failed → single-shot fallback');
        return deps.inner.answer(question, opts);
      }

      const body = result.body.trim();
      deps.log.info(
        { scope: scope.kind, tools: result.toolCallCount, cited: result.usedSourceIndexes.length, answered: body.length > 0 },
        'agentic: answered founder query',
      );
      // An empty body → treat as "nothing found" (renders the graceful no-answer line, no citations).
      if (!body) return { scope, answer: null, citations: [] };
      return { scope, answer: body, citations: citationsFrom(result.sources, result.usedSourceIndexes) };
    },
  };
}
