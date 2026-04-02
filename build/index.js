#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as https from "https";
import * as http from "http";
// ─── Helpers ────────────────────────────────────────────────────────────────
const USER_AGENT = "PublicFinanceMCP/1.0 (contact@levilabs.dev)";
function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith("https") ? https : http;
        const req = mod.get(url, {
            headers: { "User-Agent": USER_AGENT, "Accept": "application/json", ...headers },
            timeout: 20000,
        }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpGet(res.headers.location, headers).then(resolve, reject);
            }
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve(data));
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    });
}
function httpPost(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const mod = parsed.protocol === "https:" ? https : http;
        const req = mod.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: "POST",
            headers: {
                "User-Agent": USER_AGENT,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                ...headers,
            },
            timeout: 20000,
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve(data));
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
        req.write(body);
        req.end();
    });
}
function padCIK(cik) {
    return cik.replace(/^0+/, "").padStart(10, "0");
}
function truncate(text, maxLen = 8000) {
    if (text.length <= maxLen)
        return text;
    return text.slice(0, maxLen) + "\n\n... [truncated]";
}
// ─── SEC EDGAR: Ticker → CIK mapping ───────────────────────────────────────
let tickerCache = null;
async function loadTickerMap() {
    if (tickerCache)
        return tickerCache;
    try {
        const raw = await httpGet("https://www.sec.gov/files/company_tickers.json");
        const data = JSON.parse(raw);
        const map = {};
        for (const key of Object.keys(data)) {
            const entry = data[key];
            map[entry.ticker.toUpperCase()] = {
                cik: String(entry.cik_str),
                name: entry.title,
            };
        }
        tickerCache = map;
        return map;
    }
    catch {
        return {};
    }
}
async function resolveToCIK(identifier) {
    // If it looks like a CIK number, use it directly
    if (/^\d+$/.test(identifier)) {
        return { cik: identifier, name: "Unknown" };
    }
    const map = await loadTickerMap();
    const upper = identifier.toUpperCase();
    if (map[upper])
        return map[upper];
    // Try partial name match
    for (const [ticker, info] of Object.entries(map)) {
        if (info.name.toUpperCase().includes(upper)) {
            return { ...info };
        }
    }
    return null;
}
// ─── SEC EDGAR: Company Filings ─────────────────────────────────────────────
async function getCompanyFilings(identifier, formType, count = 10) {
    const resolved = await resolveToCIK(identifier);
    if (!resolved)
        return `Could not resolve "${identifier}" to a CIK number. Try a ticker symbol (e.g., AAPL) or CIK number.`;
    const cik = padCIK(resolved.cik);
    try {
        const raw = await httpGet(`https://data.sec.gov/submissions/CIK${cik}.json`);
        const data = JSON.parse(raw);
        const recent = data.filings?.recent;
        if (!recent)
            return "No filing data found.";
        const results = [];
        results.push(`Company: ${data.name || resolved.name}`);
        results.push(`CIK: ${resolved.cik}`);
        if (data.tickers?.length)
            results.push(`Tickers: ${data.tickers.join(", ")}`);
        if (data.exchanges?.length)
            results.push(`Exchanges: ${data.exchanges.join(", ")}`);
        if (data.sic)
            results.push(`SIC: ${data.sic} - ${data.sicDescription || ""}`);
        if (data.stateOfIncorporation)
            results.push(`State: ${data.stateOfIncorporation}`);
        results.push("");
        let matched = 0;
        const filingCount = recent.form?.length || 0;
        for (let i = 0; i < filingCount && matched < count; i++) {
            const form = recent.form[i];
            if (formType && form !== formType && form !== `${formType}/A`)
                continue;
            matched++;
            const accession = recent.accessionNumber[i];
            const filed = recent.filingDate[i];
            const primary = recent.primaryDocument[i];
            const desc = recent.primaryDocDescription?.[i] || "";
            results.push(`[${matched}] ${form} — Filed: ${filed}`);
            results.push(`    Description: ${desc}`);
            results.push(`    Accession: ${accession}`);
            if (primary) {
                const accClean = accession.replace(/-/g, "");
                results.push(`    URL: https://www.sec.gov/Archives/edgar/data/${resolved.cik}/${accClean}/${primary}`);
            }
            results.push("");
        }
        if (matched === 0) {
            results.push(formType ? `No ${formType} filings found.` : "No recent filings found.");
        }
        return truncate(results.join("\n"));
    }
    catch (e) {
        return `Failed to fetch filings: ${e.message}`;
    }
}
// ─── SEC EDGAR: Company Financial Facts (XBRL) ─────────────────────────────
async function getCompanyFacts(identifier, concept) {
    const resolved = await resolveToCIK(identifier);
    if (!resolved)
        return `Could not resolve "${identifier}" to a CIK number.`;
    const cik = padCIK(resolved.cik);
    try {
        if (concept) {
            // Specific concept
            const taxonomy = concept.includes(":") ? concept.split(":")[0] : "us-gaap";
            const tag = concept.includes(":") ? concept.split(":")[1] : concept;
            const raw = await httpGet(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${tag}.json`);
            const data = JSON.parse(raw);
            const results = [];
            results.push(`Company: ${data.entityName}`);
            results.push(`Concept: ${taxonomy}:${data.tag}`);
            results.push(`Label: ${data.label || "N/A"}`);
            results.push(`Description: ${data.description || "N/A"}`);
            results.push("");
            for (const [unit, facts] of Object.entries(data.units || {})) {
                results.push(`Unit: ${unit}`);
                const factArray = facts;
                // Show the most recent 10 entries
                const recent = factArray.slice(-10);
                for (const f of recent) {
                    const period = f.end ? `${f.start || ""} → ${f.end}` : `instant: ${f.end || f.start}`;
                    results.push(`  ${f.fy || ""}${f.fp || ""} | ${period} | ${f.val} | Filed: ${f.filed}`);
                }
                results.push("");
            }
            return truncate(results.join("\n"));
        }
        else {
            // All facts — just return a summary of available concepts
            const raw = await httpGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
            const data = JSON.parse(raw);
            const results = [];
            results.push(`Company: ${data.entityName}`);
            results.push(`CIK: ${data.cik}`);
            results.push("");
            for (const [taxonomy, concepts] of Object.entries(data.facts || {})) {
                const conceptObj = concepts;
                const keys = Object.keys(conceptObj);
                results.push(`Taxonomy: ${taxonomy} (${keys.length} concepts)`);
                // Show first 20 concept names
                const sample = keys.slice(0, 20);
                for (const k of sample) {
                    const label = conceptObj[k]?.label || k;
                    results.push(`  - ${k}: ${label}`);
                }
                if (keys.length > 20) {
                    results.push(`  ... and ${keys.length - 20} more. Use concept parameter to query specific ones.`);
                }
                results.push("");
            }
            return truncate(results.join("\n"));
        }
    }
    catch (e) {
        return `Failed to fetch company facts: ${e.message}`;
    }
}
// ─── US Treasury Yield Curve ────────────────────────────────────────────────
async function getTreasuryRates(year, month, rateType = "yield_curve") {
    const dataMap = {
        yield_curve: "daily_treasury_yield_curve",
        bill_rates: "daily_treasury_bill_rates",
        long_term: "daily_treasury_long_term_rate",
        real_yield: "daily_treasury_real_yield_curve",
        real_long_term: "daily_treasury_real_long_term",
    };
    const dataParam = dataMap[rateType] || dataMap.yield_curve;
    let url;
    if (month && year) {
        const mm = String(month).padStart(2, "0");
        url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=${dataParam}&field_tdr_date_value_month=${year}${mm}`;
    }
    else {
        const y = year || new Date().getFullYear();
        url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=${dataParam}&field_tdr_date_value=${y}`;
    }
    try {
        const raw = await httpGet(url, { Accept: "application/xml" });
        // Parse XML manually (no external dep) — extract entries
        const entries = [];
        const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
        let match;
        let entryCount = 0;
        while ((match = entryRegex.exec(raw)) !== null) {
            entryCount++;
            if (entryCount > 20)
                continue; // limit output
            const content = match[1];
            const props = {};
            // Extract properties from the content
            const propRegex = /<d:(\w+)[^>]*>([^<]*)<\/d:\w+>/g;
            let propMatch;
            while ((propMatch = propRegex.exec(content)) !== null) {
                props[propMatch[1]] = propMatch[2];
            }
            if (Object.keys(props).length > 0) {
                const date = props.NEW_DATE || props.INDEX_DATE || "";
                const dateClean = date ? date.replace(/T.*/, "") : "N/A";
                if (rateType === "yield_curve" || rateType === "real_yield") {
                    const tenors = [
                        ["1Mo", props.BC_1MONTH],
                        ["2Mo", props.BC_2MONTH],
                        ["3Mo", props.BC_3MONTH],
                        ["6Mo", props.BC_6MONTH],
                        ["1Y", props.BC_1YEAR],
                        ["2Y", props.BC_2YEAR],
                        ["3Y", props.BC_3YEAR],
                        ["5Y", props.BC_5YEAR],
                        ["7Y", props.BC_7YEAR],
                        ["10Y", props.BC_10YEAR],
                        ["20Y", props.BC_20YEAR],
                        ["30Y", props.BC_30YEAR],
                    ].filter(([, v]) => v && v !== "");
                    entries.push(`${dateClean}: ${tenors.map(([t, v]) => `${t}=${v}%`).join(" | ")}`);
                }
                else if (rateType === "bill_rates") {
                    entries.push(`${dateClean}: ${Object.entries(props).filter(([k]) => k !== "Id" && k !== "NEW_DATE").map(([k, v]) => `${k}=${v}`).join(" | ")}`);
                }
                else {
                    entries.push(`${dateClean}: ${Object.entries(props).filter(([k]) => k !== "Id" && k !== "NEW_DATE" && k !== "INDEX_DATE").map(([k, v]) => `${k}=${v}`).join(" | ")}`);
                }
            }
        }
        const rateTypeLabel = {
            yield_curve: "Treasury Par Yield Curve Rates",
            bill_rates: "Treasury Bill Rates",
            long_term: "Treasury Long-Term Rates",
            real_yield: "Treasury Real Yield Curve Rates",
            real_long_term: "Treasury Real Long-Term Rates",
        };
        const results = [];
        results.push(`${rateTypeLabel[rateType] || "Treasury Rates"}`);
        results.push(`Total entries found: ${entryCount}`);
        if (entryCount > 20)
            results.push(`(Showing most recent 20)`);
        results.push("");
        results.push(...entries);
        return results.length > 3 ? truncate(results.join("\n")) : "No rate data found for the specified period.";
    }
    catch (e) {
        return `Failed to fetch Treasury rates: ${e.message}`;
    }
}
// ─── BLS Labor Statistics ───────────────────────────────────────────────────
const POPULAR_SERIES = {
    unemployment: { id: "LNS14000000", desc: "Unemployment Rate (Seasonally Adjusted)" },
    cpi: { id: "CUUR0000SA0", desc: "CPI - All Urban Consumers (All Items)" },
    nonfarm_payrolls: { id: "CES0000000001", desc: "Total Nonfarm Employment" },
    participation: { id: "LNS11300000", desc: "Labor Force Participation Rate" },
    core_cpi: { id: "CUUR0000SA0L1E", desc: "CPI - All Items Less Food and Energy" },
    avg_hourly_earnings: { id: "CES0500000003", desc: "Average Hourly Earnings - Private" },
    manufacturing: { id: "CES3000000001", desc: "Manufacturing Employment" },
    ppi: { id: "PCU327320327320", desc: "Producer Price Index - Concrete" },
};
async function getLaborStatistics(seriesId, preset, startYear, endYear) {
    const currentYear = new Date().getFullYear();
    const start = startYear || currentYear - 3;
    const end = endYear || currentYear;
    let targetId;
    let description;
    if (preset && POPULAR_SERIES[preset]) {
        targetId = POPULAR_SERIES[preset].id;
        description = POPULAR_SERIES[preset].desc;
    }
    else if (seriesId) {
        targetId = seriesId;
        description = `BLS Series ${seriesId}`;
    }
    else {
        // List available presets
        const results = ["Available preset series:"];
        for (const [key, info] of Object.entries(POPULAR_SERIES)) {
            results.push(`  ${key}: ${info.desc} (${info.id})`);
        }
        results.push("");
        results.push("Use 'preset' parameter with one of the above keys, or provide a custom 'series_id'.");
        results.push("Find series IDs at: https://data.bls.gov/dataQuery/find");
        return results.join("\n");
    }
    try {
        // Use BLS API v1 (no key required) — GET request
        const url = `https://api.bls.gov/publicAPI/v1/timeseries/data/${targetId}?startyear=${start}&endyear=${end}`;
        const raw = await httpGet(url);
        const data = JSON.parse(raw);
        if (data.status !== "REQUEST_SUCCEEDED") {
            return `BLS API error: ${data.message?.join("; ") || "Unknown error"}`;
        }
        const series = data.Results?.series?.[0];
        if (!series)
            return "No data returned.";
        const results = [];
        results.push(`Series: ${description}`);
        results.push(`ID: ${series.seriesID}`);
        results.push(`Period: ${start} - ${end}`);
        results.push("");
        const entries = series.data || [];
        // BLS returns newest first
        for (const entry of entries) {
            const period = entry.periodName || entry.period;
            const note = entry.footnotes?.map((f) => f.text).filter(Boolean).join("; ") || "";
            const latest = entry.latest === "true" ? " [LATEST]" : "";
            results.push(`${entry.year} ${period}: ${entry.value}${latest}${note ? ` (${note})` : ""}`);
        }
        return truncate(results.join("\n"));
    }
    catch (e) {
        return `Failed to fetch BLS data: ${e.message}`;
    }
}
// ─── Ticker Lookup ──────────────────────────────────────────────────────────
async function tickerLookup(query) {
    const map = await loadTickerMap();
    const upper = query.toUpperCase();
    // Exact ticker match
    if (map[upper]) {
        const info = map[upper];
        return `${upper}: ${info.name} (CIK: ${info.cik})\nEDGAR: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${info.cik}&type=&dateb=&owner=include&count=40`;
    }
    // Search by name (partial match, limit 15)
    const matches = [];
    for (const [ticker, info] of Object.entries(map)) {
        if (info.name.toUpperCase().includes(upper) || ticker.includes(upper)) {
            matches.push(`${ticker}: ${info.name} (CIK: ${info.cik})`);
            if (matches.length >= 15)
                break;
        }
    }
    if (matches.length === 0)
        return `No companies found matching "${query}".`;
    return [`Found ${matches.length} match(es):`, "", ...matches].join("\n");
}
// ─── Economic Overview (Multi-source snapshot) ──────────────────────────────
async function economicOverview() {
    const results = [];
    results.push("═══ US ECONOMIC OVERVIEW ═══");
    results.push("");
    // 1. Treasury Yield Curve (latest)
    try {
        const year = new Date().getFullYear();
        const month = new Date().getMonth() + 1;
        const mm = String(month).padStart(2, "0");
        const raw = await httpGet(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${year}${mm}`, { Accept: "application/xml" });
        const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
        let lastEntry = "";
        let m;
        while ((m = entryRegex.exec(raw)) !== null) {
            lastEntry = m[1];
        }
        if (lastEntry) {
            const propRegex = /<d:(\w+)[^>]*>([^<]*)<\/d:\w+>/g;
            const props = {};
            let pm;
            while ((pm = propRegex.exec(lastEntry)) !== null) {
                props[pm[1]] = pm[2];
            }
            const date = (props.NEW_DATE || "").replace(/T.*/, "");
            results.push(`📊 Treasury Yield Curve (${date}):`);
            const tenors = [
                ["1Mo", props.BC_1MONTH], ["3Mo", props.BC_3MONTH], ["6Mo", props.BC_6MONTH],
                ["1Y", props.BC_1YEAR], ["2Y", props.BC_2YEAR], ["5Y", props.BC_5YEAR],
                ["10Y", props.BC_10YEAR], ["30Y", props.BC_30YEAR],
            ].filter(([, v]) => v);
            results.push(`  ${tenors.map(([t, v]) => `${t}: ${v}%`).join("  ")}`);
            // 2s10s spread
            const two = parseFloat(props.BC_2YEAR || "0");
            const ten = parseFloat(props.BC_10YEAR || "0");
            if (two && ten) {
                const spread = (ten - two).toFixed(2);
                results.push(`  2s10s Spread: ${spread}% ${parseFloat(spread) < 0 ? "⚠️ INVERTED" : ""}`);
            }
            results.push("");
        }
    }
    catch {
        results.push("📊 Treasury Rates: unavailable");
        results.push("");
    }
    // 2. Latest BLS unemployment rate
    try {
        const raw = await httpGet(`https://api.bls.gov/publicAPI/v1/timeseries/data/LNS14000000`);
        const data = JSON.parse(raw);
        const latest = data.Results?.series?.[0]?.data?.[0];
        if (latest) {
            results.push(`📈 Unemployment Rate: ${latest.value}% (${latest.periodName} ${latest.year})`);
        }
    }
    catch {
        results.push("📈 Unemployment Rate: unavailable");
    }
    // 3. Latest CPI
    try {
        const raw = await httpGet(`https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0`);
        const data = JSON.parse(raw);
        const latest = data.Results?.series?.[0]?.data?.[0];
        if (latest) {
            results.push(`📈 CPI (All Items): ${latest.value} (${latest.periodName} ${latest.year})`);
        }
    }
    catch {
        results.push("📈 CPI: unavailable");
    }
    // 4. Latest Nonfarm Payrolls
    try {
        const raw = await httpGet(`https://api.bls.gov/publicAPI/v1/timeseries/data/CES0000000001`);
        const data = JSON.parse(raw);
        const latest = data.Results?.series?.[0]?.data?.[0];
        if (latest) {
            const thousands = parseInt(latest.value);
            results.push(`📈 Nonfarm Payrolls: ${(thousands / 1000).toFixed(1)}M (${latest.periodName} ${latest.year})`);
        }
    }
    catch {
        results.push("📈 Nonfarm Payrolls: unavailable");
    }
    results.push("");
    results.push("Use individual tools for detailed data.");
    return results.join("\n");
}
// ─── Server Setup ───────────────────────────────────────────────────────────
const server = new McpServer({
    name: "publicfinance-mcp",
    version: "1.0.0",
});
// Tool: company_filings
server.tool("company_filings", "Search SEC EDGAR for company filings (10-K, 10-Q, 8-K, etc.). Accepts ticker symbol or CIK number.", {
    company: z.string().describe("Company ticker symbol (e.g., AAPL, MSFT) or CIK number"),
    form_type: z.string().optional().describe("Filter by form type: 10-K, 10-Q, 8-K, S-1, 4, etc."),
    count: z.number().optional().describe("Number of results to return (default: 10, max: 40)"),
}, async ({ company, form_type, count }) => {
    const result = await getCompanyFilings(company, form_type, Math.min(count || 10, 40));
    return { content: [{ type: "text", text: result }] };
});
// Tool: company_facts
server.tool("company_facts", "Get XBRL financial data for a company from SEC EDGAR. Returns standardized financial facts like Revenue, NetIncome, Assets, etc.", {
    company: z.string().describe("Company ticker symbol (e.g., AAPL) or CIK number"),
    concept: z.string().optional().describe("Specific XBRL concept to query (e.g., 'Revenue', 'NetIncomeLoss', 'Assets'). Use us-gaap taxonomy prefix for non-standard: 'us-gaap:AccountsPayableCurrent'. Without this, returns a summary of all available concepts."),
}, async ({ company, concept }) => {
    const result = await getCompanyFacts(company, concept);
    return { content: [{ type: "text", text: result }] };
});
// Tool: treasury_rates
server.tool("treasury_rates", "Get US Treasury interest rates including yield curve, bill rates, and long-term rates. No API key required.", {
    rate_type: z.enum(["yield_curve", "bill_rates", "long_term", "real_yield", "real_long_term"]).optional()
        .describe("Type of rate data (default: yield_curve)"),
    year: z.number().optional().describe("Year to query (default: current year)"),
    month: z.number().optional().describe("Specific month (1-12) to narrow results"),
}, async ({ rate_type, year, month }) => {
    const result = await getTreasuryRates(year, month, rate_type || "yield_curve");
    return { content: [{ type: "text", text: result }] };
});
// Tool: labor_statistics
server.tool("labor_statistics", "Get US labor market and economic statistics from the Bureau of Labor Statistics (BLS). Includes unemployment rate, CPI, payrolls, and more. No API key required (v1 API).", {
    preset: z.enum(["unemployment", "cpi", "nonfarm_payrolls", "participation", "core_cpi", "avg_hourly_earnings", "manufacturing", "ppi"]).optional()
        .describe("Preset data series to query. Omit to see all available presets."),
    series_id: z.string().optional().describe("Custom BLS series ID (e.g., LAUCN040010000000005). Overrides preset."),
    start_year: z.number().optional().describe("Start year (default: 3 years ago)"),
    end_year: z.number().optional().describe("End year (default: current year)"),
}, async ({ preset, series_id, start_year, end_year }) => {
    const result = await getLaborStatistics(series_id, preset, start_year, end_year);
    return { content: [{ type: "text", text: result }] };
});
// Tool: ticker_lookup
server.tool("ticker_lookup", "Look up company ticker symbols, names, and CIK numbers. Search by ticker or company name.", {
    query: z.string().describe("Ticker symbol (e.g., AAPL) or company name to search for"),
}, async ({ query }) => {
    const result = await tickerLookup(query);
    return { content: [{ type: "text", text: result }] };
});
// Tool: economic_overview
server.tool("economic_overview", "Get a snapshot of key US economic indicators: Treasury yield curve, unemployment rate, CPI, and nonfarm payrolls. Multi-source overview in one call.", {}, async () => {
    const result = await economicOverview();
    return { content: [{ type: "text", text: result }] };
});
// ─── Start ──────────────────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map