#!/usr/bin/env node
// ============================================================
// AmanChain x402 MCP Gateway
// ------------------------------------------------------------
// Exposes the live AmanChain x402 service catalog as MCP tools
// with AUTOMATIC x402 payment (USDC on Base, EIP-3009, gasless
// via the Coinbase CDP facilitator).
//
//   · tools/list    → every service becomes a tool, schema from
//                     the live discovery doc (never hardcoded)
//   · tools/call    → POST the service → 402 → sign EIP-3009 →
//                     retry with PAYMENT-SIGNATURE → result + receipt
//   · amanchain_catalog → meta-tool: browse prices/capabilities
//
// SAFETY LAWS (client-side, always enforced):
//   · the wallet key never leaves this process, never logged
//   · AMAN_MAX_USD_PER_CALL hard cap (default $0.05)
//   · AMAN_MAX_USD_PER_DAY rolling cap (default $1.00)
//   · prices come ONLY from the server's signed 402 challenge —
//     never invented, never estimated
//
// Env:
//   AMAN_PRIVATE_KEY        (required to pay) buyer's Base EVM key
//   AMAN_ORIGIN             default https://amanchain-relay.gitajhd.workers.dev
//   AMAN_MAX_USD_PER_CALL   default 0.05
//   AMAN_MAX_USD_PER_DAY    default 1.00
//   AMAN_SPEND_LEDGER       default ~/.amanchain-mcp-spend.json
// ============================================================
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ORIGIN = (process.env.AMAN_ORIGIN || 'https://amanchain-relay.gitajhd.workers.dev').replace(/\/+$/, '');
const MAX_USD_PER_CALL = Number(process.env.AMAN_MAX_USD_PER_CALL || 0.05);
const MAX_USD_PER_DAY = Number(process.env.AMAN_MAX_USD_PER_DAY || 1.0);
const SPEND_LEDGER = process.env.AMAN_SPEND_LEDGER || path.join(os.homedir(), '.amanchain-mcp-spend.json');
const KEY = process.env.AMAN_PRIVATE_KEY;

// ---------- catalog (live, refreshes every 5 min, stale-fallback) ----------
interface CatalogResource {
  serviceId: string; name: string; description: string; category?: string;
  price?: string; priceUsd?: number | null; requestFormat?: string;
  requestRequired?: boolean; inputSchema?: Record<string, unknown>;
  endpoint?: string; healthStatus?: string;
}
interface Catalog {
  name?: string; resources: CatalogResource[];
  mcp?: { npmPackage?: string; install?: string };
}
let catalog: Catalog = { resources: [] };
let catalogFetchedAt = 0;

async function fetchCatalog(): Promise<void> {
  try {
    const res = await fetch(`${ORIGIN}/.well-known/x402.json`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json() as Catalog;
    if (Array.isArray(doc.resources) && doc.resources.length) {
      catalog = doc;
      catalogFetchedAt = Date.now();
      process.stderr.write(`[amanchain-mcp] catalog: ${doc.resources.length} services from ${ORIGIN}\n`);
    }
  } catch (e) {
    process.stderr.write(`[amanchain-mcp] catalog fetch failed (${e instanceof Error ? e.message : e}) — using last good (${catalog.resources.length} services)\n`);
  }
}
function catalogFresh(): Catalog {
  if (Date.now() - catalogFetchedAt > 5 * 60_000) void fetchCatalog();
  return catalog;
}

const toolNameOf = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function toolDef(r: CatalogResource) {
  const schema = r.inputSchema && typeof r.inputSchema === 'object'
    ? r.inputSchema
    : {
        type: 'object',
        properties: (r.requestRequired ?? false) && r.requestFormat
          ? { request: { type: 'string', description: r.requestFormat } }
          : {},
        required: (r.requestRequired ?? false) ? ['request'] : [],
        additionalProperties: false,
      };
  const price = r.priceUsd != null ? `$${r.priceUsd < 0.01 ? r.priceUsd.toFixed(4) : r.priceUsd.toFixed(2)}/call` : 'pay-per-call';
  return {
    name: toolNameOf(r.serviceId),
    description: `${r.name} — ${r.description} [x402 pay-per-call ${price}, AmanChain, settled on-chain]`,
    inputSchema: schema,
  };
}

// ---------- x402 spend ledger (client-side caps, durable) ----------
function loadSpend(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(SPEND_LEDGER, 'utf8')); } catch { return {}; }
}
function saveSpend(s: Record<string, number>): void {
  try { fs.mkdirSync(path.dirname(SPEND_LEDGER), { recursive: true }); fs.writeFileSync(SPEND_LEDGER, JSON.stringify(s)); } catch {}
}
function spendGate(micros: number): string | null {
  const day = new Date().toISOString().slice(0, 10);
  const usd = micros / 1e6;
  if (usd > MAX_USD_PER_CALL) return `quote $${usd.toFixed(4)} exceeds AMAN_MAX_USD_PER_CALL=$${MAX_USD_PER_CALL} — raise the cap env if you trust this call`;
  const s = loadSpend();
  const today = (s[day] ?? 0) + usd;
  if (today > MAX_USD_PER_DAY) return `daily cap: $${today.toFixed(4)} would exceed AMAN_MAX_USD_PER_DAY=$${MAX_USD_PER_DAY}`;
  s[day] = today;
  for (const k of Object.keys(s)) if (k < day) delete s[k];
  saveSpend(s);
  return null;
}

// ---------- x402 exact-scheme payment (EIP-3009, USDC v2 domain on Base) ----------
let account: PrivateKeyAccount | null = null;
function payer(): PrivateKeyAccount {
  if (!account) {
    if (!KEY) throw new Error('AMAN_PRIVATE_KEY is not set — the gateway can list and quote services, but cannot pay. Get USDC on Base (Coinbase withdraw → Base, or bridge.base.org) and set the env var.');
    account = privateKeyToAccount((KEY.startsWith('0x') ? KEY : `0x${KEY}`) as `0x${string}`);
  }
  return account;
}

async function signEip3009(acc: PrivateKeyAccount, o: {
  to: string; valueMicros: string; asset: string; name?: string; version?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const nonce = `0x${crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')}`;
  const signature = await acc.signTypedData({
    domain: {
      name: o.name ?? 'USD Coin',
      version: o.version ?? '2',
      chainId: 8453,
      verifyingContract: o.asset as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: acc.address,
      to: o.to as `0x${string}`,
      value: BigInt(o.valueMicros),
      validAfter: BigInt(now - 60),
      validBefore: BigInt(now + 900),
      nonce: nonce as `0x${string}`,
    },
  });
  return {
    signature,
    authorization: {
      from: acc.address, to: o.to, value: o.valueMicros,
      validAfter: String(now - 60), validBefore: String(now + 900), nonce,
    },
  };
}

// ---------- the paid call: POST → 402 → sign → retry ----------
interface Quote {
  resource?: string;
  accepts?: Array<Record<string, unknown>>;
}
function pickUsdcAccept(quote: Quote): Record<string, unknown> | null {
  const accepts = quote.accepts ?? [];
  return (accepts.find(a => a.scheme === 'exact' && (a.network === 'base' || a.network === 'eip155:8453'))
    ?? accepts.find(a => a.scheme === 'exact')) as Record<string, unknown> | undefined ?? null;
}

async function callService(serviceId: string, request: string | undefined): Promise<Record<string, unknown>> {
  const cat = catalogFresh();
  const r = cat.resources.find(x => x.serviceId === serviceId || toolNameOf(x.serviceId) === toolNameOf(serviceId));
  if (!r) throw new Error(`unknown service "${serviceId}" — use amanchain_catalog to browse the live list`);

  const ep = r.endpoint || `${ORIGIN}/api/x402`;
  const [base, qs] = ep.split('?');
  const url = `${base.replace(/\/+$/, '')}/${r.serviceId}${qs ? '?' + qs : ''}`;
  const body = JSON.stringify({ request: request ?? '' });

  const t0 = Date.now();
  const first = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body, signal: AbortSignal.timeout(30_000),
  });
  if (first.status !== 402) {
    // free/optional path or unexpected — surface honestly
    const j = await first.json().catch(() => ({}));
    return { httpStatus: first.status, ms: Date.now() - t0, ...(j as Record<string, unknown>) };
  }

  // 402 → the SIGNED challenge is the only price source (never invented)
  const hdr = first.headers.get('payment-required') ?? first.headers.get('x-payment-required');
  let quote: Quote = {};
  if (hdr) {
    try { quote = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8')) as Quote; } catch {}
  }
  if (!quote.accepts) { try { quote = await first.json() as Quote; } catch {} }
  const acc0 = pickUsdcAccept(quote);
  if (!acc0) {
    const j = await first.json().catch(() => ({}));
    return { error: 'service returned 402 without a USDC-on-Base accept — only the native AMAN rail is available for this service', ...(j as Record<string, unknown>) };
  }
  const micros = String(acc0.maxAmountRequired ?? '');
  const capMsg = spendGate(Number(micros));
  if (capMsg) return { error: `client-cap: ${capMsg}`, quotedMicroUsd: micros };

  const acc = payer();
  const { signature, authorization } = await signEip3009(acc, {
    to: String(acc0.payTo),
    valueMicros: micros,
    asset: String(acc0.asset),
    name: (acc0.extra as Record<string, unknown> | undefined)?.name as string | undefined,
    version: (acc0.extra as Record<string, unknown> | undefined)?.version as string | undefined,
  });
  // the challenge's resource may arrive as a string (v1 body) or an object
  // (v2 header {url, description, mimeType, ...}) — normalize to the URL string
  const resourceUrl = typeof quote.resource === 'string'
    ? quote.resource
    : ((quote.resource as { url?: string } | undefined)?.url ?? url);
  const resourceDesc = typeof quote.resource === 'object' && quote.resource && (quote.resource as { description?: string }).description
    ? String((quote.resource as { description?: string }).description)
    : (r.description ?? '');
  const payment = {
    x402Version: 2,
    resource: { url: resourceUrl, description: resourceDesc, mimeType: 'application/json' },
    accepted: {
      scheme: 'exact', network: 'eip155:8453', amount: micros,
      asset: acc0.asset, payTo: acc0.payTo, maxTimeoutSeconds: 120,
      extra: acc0.extra ?? { name: 'USD Coin', version: '2' },
    },
    // echo the challenge's extensions verbatim (the platform's bazaar block
    // rides here — the CDP V2 payload validation expects the echo)
    ...((quote as { extensions?: unknown }).extensions ? { extensions: (quote as { extensions?: unknown }).extensions } : {}),
    payload: { signature, authorization },
  };
  const second = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payment), 'utf8').toString('base64'),
      'User-Agent': 'amanchain-mcp/1.0 (+x402 auto-pay)',
    },
    body, signal: AbortSignal.timeout(60_000),
  });
  const j = await second.json().catch(() => ({ error: `HTTP ${second.status}` })) as Record<string, unknown>;
  if (second.status === 402) {
    return { error: 'payment rejected — the facilitator refused the signature (check USDC balance on Base)', detail: j };
  }
  return {
    paid: true,
    paidUsd: Number(micros) / 1e6,
    payer: acc.address,
    ms: Date.now() - t0,
    ...(j),
  };
}

// ---------- MCP server (low-level = tools stay dynamic) ----------
const server = new Server(
  { name: 'amanchain-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const cat = catalogFresh();
  const tools = cat.resources.map(toolDef);
  tools.push({
    name: 'amanchain_catalog',
    description: `Browse the live AmanChain x402 catalog: ${tools.length - 1} pay-per-call services with prices, categories and input formats. Call this FIRST when unsure which service fits a task.`,
    inputSchema: {
      type: 'object',
      properties: { category: { type: 'string', description: 'optional filter, e.g. market-data, audit, documents, web, ai' } },
      additionalProperties: false,
    },
  });
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = String(req.params.name ?? '');
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    if (name === 'amanchain_catalog') {
      const cat = catalogFresh();
      const f = typeof args.category === 'string' ? args.category.toLowerCase() : null;
      const items = cat.resources
        .filter(r => !f || (r.category ?? '').toLowerCase().includes(f))
        .map(r => ({ serviceId: r.serviceId, name: r.name, priceUsd: r.priceUsd, category: r.category, input: r.requestFormat ?? (r.requestRequired ? 'required — see tool schema' : 'no input needed'), health: r.healthStatus }));
      return { content: [{ type: 'text', text: JSON.stringify({ origin: ORIGIN, count: items.length, services: items }, null, 2) }] };
    }
    const cat = catalogFresh();
    const r = cat.resources.find(x => toolNameOf(x.serviceId) === name);
    if (!r) return { content: [{ type: 'text', text: `Unknown tool "${name}". Use amanchain_catalog to browse services.` }], isError: true };
    const request = typeof args.request === 'string' ? args.request : (Object.values(args)[0] != null ? String(Object.values(args)[0]) : undefined);
    const out = await callService(r.serviceId, request);
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: Boolean((out as { error?: string }).error) };
  } catch (e) {
    return { content: [{ type: 'text', text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
});

// ---------- boot ----------
await fetchCatalog();
void setInterval(() => void fetchCatalog(), 5 * 60_000);
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[amanchain-mcp] ready — ${catalog.resources.length} services · origin ${ORIGIN} · caps $${MAX_USD_PER_CALL}/call $${MAX_USD_PER_DAY}/day · payer ${KEY ? 'configured' : 'NOT configured (quotes only)'}\n`);
