import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// "Project Brain" — a stdio MCP server exposing OUR internal project knowledge
// (Agent Orchestrator planning, decisions, architecture, risk register, backlog,
// specs) as read-only tools, so Claude Code / Codex can recall a decision mid-task
// instead of grepping markdown. NO network listener — stdio only. Reuses the M2(a)
// RAG engine (embedding adapter + internal search over internal_knowledge, mig 016).
//
// ⚠︎ ISOLATION: this process reaches internal_knowledge ONLY (internalKnowledgeRepo);
// it is structurally incapable of touching the customer corpus (agent_memory).
//
// ⚠︎ stdout IS the JSON-RPC transport. The shared pino logger writes to stdout, which
// would corrupt the protocol — so we force it SILENT before any app module (env.ts →
// logger.ts) evaluates. App modules are DYNAMIC-imported inside main() (below), so
// this assignment runs first. Our own diagnostics go to stderr (free under MCP stdio).
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';

// Search snippets are truncated for the tool result; get_project_doc returns full text.
const SNIPPET_CHARS = 900;

/** MCP tool error result (surfaced to the client, not thrown). */
function errorResult(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

async function main(): Promise<void> {
  // Dynamic imports so LOG_LEVEL=silent is applied before env.ts/logger.ts evaluate.
  const { env } = await import('../src/config/env');
  const { tryResolveCredential } = await import('../src/config/credentials');
  const { buildEmbeddingAdapter } = await import('../src/adapters/knowledge/openai-embeddings.client');
  const { internalKnowledgeRepo } = await import('../src/knowledge/internal-repo');
  const { buildInternalKnowledgeSearch } = await import('../src/knowledge/internal-search');
  const { INTERNAL_REPO_ROOTS } = await import('../src/adapters/knowledge/internal-sources');

  // Read-only: a no-op cost sink (no llm_costs writes for query-time embeds).
  const embedding = buildEmbeddingAdapter(() => tryResolveCredential('OPENAI_API_KEY'), env.OPENAI_BASE_URL, {
    model: env.OPENAI_EMBEDDING_MODEL,
    dim: env.OPENAI_EMBEDDING_DIM,
    recordCost: async () => {},
  });

  const knowledgeSearch = buildInternalKnowledgeSearch({
    embedding,
    search: internalKnowledgeRepo.search.bind(internalKnowledgeRepo),
    maxDistance: env.KNOWLEDGE_INTERNAL_MAX_DISTANCE,
    defaultK: env.KNOWLEDGE_INTERNAL_K,
    snippetChars: SNIPPET_CHARS,
  });

  const server = new Server(
    { name: 'project-brain', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Project Brain: semantic memory over the founder\'s internal project docs ' +
        '(Agent Orchestrator planning, decisions, architecture, risk register, backlog, specs). ' +
        'Call search_project_knowledge to recall WHY/HOW a decision was made; ' +
        'call get_project_doc to read a matched doc in full.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search_project_knowledge',
        description:
          'Semantic search over the internal project knowledge base (planning, decisions, ' +
          'architecture, risk register, backlog, specs). Returns cited chunks nearest-first as ' +
          'JSON: [{repo, path, section, snippet, distance}]. Use it to recall a decision or its ' +
          'rationale instead of grepping markdown.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language question or topic.' },
            k: { type: 'number', description: `Max results to return (default ${env.KNOWLEDGE_INTERNAL_K}).` },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'get_project_doc',
        description:
          'Fetch the FULL markdown of one internal project doc by its citation (the source + ' +
          'docKey from a search_project_knowledge result).',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'sourceId from a search result (e.g. "ao-plan").' },
            docKey: {
              type: 'string',
              description: 'docKey from a search result (e.g. "ao-plan:plan/EXECUTION-PLAN.md").',
            },
          },
          required: ['docKey'],
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === 'search_project_knowledge') {
        const query = String(args.query ?? '').trim();
        if (!query) return errorResult('`query` is required');
        const k = typeof args.k === 'number' && Number.isFinite(args.k) ? args.k : undefined;
        const hits = await knowledgeSearch.search(query, k);
        const projected = hits.map((h) => ({
          repo: h.repo,
          path: h.path,
          section: h.section,
          snippet: h.snippet,
          distance: Number(h.distance.toFixed(4)),
        }));
        return textResult(JSON.stringify(projected, null, 2));
      }

      if (name === 'get_project_doc') {
        const docKey = String(args.docKey ?? '').trim();
        if (!docKey) return errorResult('`docKey` is required');
        const loc = await internalKnowledgeRepo.getDocLocation(docKey);
        if (!loc) return errorResult(`no active internal doc found for docKey "${docKey}"`);
        const root = INTERNAL_REPO_ROOTS[loc.repo as keyof typeof INTERNAL_REPO_ROOTS];
        if (!root) return errorResult(`internal doc "${docKey}" has an unknown repo "${loc.repo}"`);
        const markdown = readFileSync(join(root, loc.path), 'utf8');
        return textResult(markdown);
      }

      return errorResult(`unknown tool "${name}"`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write('[project-brain] MCP server ready on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`[project-brain] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
