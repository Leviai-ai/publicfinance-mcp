# @leviai/publicfinance-mcp

**Public Finance MCP Server** — SEC EDGAR filings, US Treasury rates, BLS labor statistics, and economic indicators in one MCP server. **Zero API keys required.**

[![npm version](https://img.shields.io/npm/v/@leviai/publicfinance-mcp)](https://www.npmjs.com/package/@leviai/publicfinance-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why This Exists

Existing SEC EDGAR MCP servers only cover filings. Existing FRED servers require API keys. No MCP server combines SEC EDGAR + US Treasury rates + BLS labor stats into one unified interface with zero configuration.

**PublicFinance MCP** gives AI agents access to the entire US public financial data landscape — company filings, yield curves, unemployment data, CPI, and more — all from free government APIs.

## Tools (6)

| Tool | Description |
|------|-------------|
| `company_filings` | Search SEC EDGAR for company filings (10-K, 10-Q, 8-K, S-1, etc.) by ticker or CIK |
| `company_facts` | Get XBRL financial data — Revenue, NetIncome, Assets, and 1000+ standardized concepts |
| `treasury_rates` | US Treasury yield curve, bill rates, long-term rates, real yields |
| `labor_statistics` | BLS data: unemployment rate, CPI, nonfarm payrolls, participation rate, PPI, and custom series |
| `ticker_lookup` | Resolve ticker symbols ↔ company names ↔ CIK numbers |
| `economic_overview` | One-call snapshot of key US economic indicators (yield curve + unemployment + CPI + payrolls) |

## Quick Start

### Install

```bash
npm install -g @leviai/publicfinance-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "publicfinance": {
      "command": "npx",
      "args": ["-y", "@leviai/publicfinance-mcp"]
    }
  }
}
```

### Cursor / Windsurf / VS Code

Add to your MCP settings:

```json
{
  "publicfinance": {
    "command": "npx",
    "args": ["-y", "@leviai/publicfinance-mcp"]
  }
}
```

## Usage Examples

### "Show me Apple's recent 10-K filings"
→ `company_filings(company: "AAPL", form_type: "10-K")`

### "What's Apple's revenue over the past 5 years?"
→ `company_facts(company: "AAPL", concept: "RevenueFromContractWithCustomerExcludingAssessedTax")`

### "Get the current Treasury yield curve"
→ `treasury_rates(rate_type: "yield_curve")`

### "What's the unemployment rate?"
→ `labor_statistics(preset: "unemployment")`

### "Give me an economic overview"
→ `economic_overview()`

### "Look up Tesla's CIK number"
→ `ticker_lookup(query: "TSLA")`

## Data Sources

All data comes from **free, public US government APIs** with no authentication required:

| Source | Data | API |
|--------|------|-----|
| SEC EDGAR | Company filings, XBRL financials | `data.sec.gov` |
| US Treasury | Yield curves, bill rates, long-term rates | `home.treasury.gov` |
| Bureau of Labor Statistics | Unemployment, CPI, payrolls, PPI | `api.bls.gov` (v1, no key) |

## BLS Preset Series

| Preset | Description | Series ID |
|--------|-------------|-----------|
| `unemployment` | Unemployment Rate (SA) | LNS14000000 |
| `cpi` | CPI All Urban Consumers | CUUR0000SA0 |
| `nonfarm_payrolls` | Total Nonfarm Employment | CES0000000001 |
| `participation` | Labor Force Participation Rate | LNS11300000 |
| `core_cpi` | CPI Less Food & Energy | CUUR0000SA0L1E |
| `avg_hourly_earnings` | Average Hourly Earnings (Private) | CES0500000003 |
| `manufacturing` | Manufacturing Employment | CES3000000001 |
| `ppi` | Producer Price Index | PCU327320327320 |

You can also pass any custom BLS series ID via `series_id`.

## Requirements

- Node.js >= 18.0.0
- No API keys needed
- Internet access to US government APIs

## Rate Limits

- **SEC EDGAR**: Max 10 requests/second. The server uses a compliant User-Agent header.
- **BLS API v1**: 25 series per query, 25 queries per day (no registration). For higher limits, register at [bls.gov](https://data.bls.gov/registrationEngine/).
- **US Treasury**: No documented rate limits.

## License

MIT — Built by [Levi Labs](https://github.com/btcgodx)
