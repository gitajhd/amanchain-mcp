# AmanChain MCP Gateway

**59 pay-per-call AI services as MCP tools — with automatic x402 payment in USDC on Base.**

Crypto prices & audits, whale alerts, market reports, LLM chat, image generation,
invoices & receipts, web fetch/search/summarize, geolocation, translation, and more —
no API keys, no signups, no subscriptions. Your agent pays per call with USDC
(gasless — the facilitator covers gas), every settlement lands on-chain with a receipt.

Works with **Claude Code, Claude Desktop, Cursor**, and any MCP-compatible client.

## Quickstart (60 seconds)

1. Get a Base wallet with ~$1 of USDC (Coinbase → withdraw USDC → Base network, or bridge.base.org).
2. Add the server:

**Claude Code**
```bash
claude mcp add amanchain -e AMAN_PRIVATE_KEY=0xYOUR_KEY -- npx -y amanchain-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` / `mcp.json`)
```json
{
  "mcpServers": {
    "amanchain": {
      "command": "npx",
      "args": ["-y", "amanchain-mcp"],
      "env": { "AMAN_PRIVATE_KEY": "0xYOUR_KEY" }
    }
  }
}
```

3. Ask your agent: *"use amanchain to get the current BTC price"* — done.

> **No wallet yet?** Run it without `AMAN_PRIVATE_KEY` — the catalog, prices and
> service discovery all work; paid calls explain exactly what to set up.

## What your agent gets

`amanchain_catalog` first, then one tool per service. Highlights:

| Tool | What it does | Price |
|------|--------------|-------|
| `aman_crypto_price` | Live crypto price | ~$0.001 |
| `aman_token_audit` | On-chain token audit (backing, flags, holders, depth) | ~$0.025 |
| `aman_market_report` | Full market report | ~$0.03 |
| `aman_llm_chat` | LLM completion | ~$0.008 |
| `aman_image_gen` | Image generation | ~$0.013 |
| `aman_web_search` / `aman_web_fetch` / `aman_summarize` | Web pipeline | ~$0.003–0.008 |
| `aman_crypto_whale_watch` | Whale transaction watch | ~$0.10 |
| `aman_geo_ip`, `aman_weather`, `aman_fx_rates`, `aman_translate` … | utilities | ~$0.001–0.005 |

Prices are set by the network, quoted live in every 402 response, and published in
the [live catalog](https://amanchain-relay.gitajhd.workers.dev/.well-known/x402.json).
Every payment produces an on-chain receipt — see the public
[receipts ledger](https://amanchain-relay.gitajhd.workers.dev/receipts).

## Safety

- Your key **never leaves your machine** — it only signs EIP-3009 USDC transfers locally.
- `AMAN_MAX_USD_PER_CALL` (default **$0.05**) — refuses any pricier quote.
- `AMAN_MAX_USD_PER_DAY` (default **$1.00**) — rolling daily cap, persisted in `~/.amanchain-mcp-spend.json`.
- Prices are taken **only from the server's signed 402 challenge** — never guessed.

All env vars: `AMAN_PRIVATE_KEY`, `AMAN_ORIGIN`, `AMAN_MAX_USD_PER_CALL`, `AMAN_MAX_USD_PER_DAY`, `AMAN_SPEND_LEDGER`.

## How it works

```
agent ── tools/call ──▶ amanchain-mcp ──▶ POST /api/x402/<service>
                              ◀────────── 402 + signed price challenge
        local EIP-3009 signature (USDC on Base, gasless)
                              ──▶ retry + PAYMENT-SIGNATURE
                              ◀────────── 200 + result + on-chain receipt
```

AmanChain is a quantum-resistant proof-of-work chain whose AI marketplace settles
agent payments on-chain — service results and receipts are mined into blocks.

## Links

- Live catalog: `/.well-known/x402.json`
- Public receipts: `/receipts`
- Ecosystem: [x402scan](https://x402scan.com) · [402index](https://402index.io)

MIT © AmanChain
