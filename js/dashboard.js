/* =====================================================================
   ADC & Cards Operations Dashboard
   Vanilla JS application logic. No external frameworks. No network calls.
   ===================================================================== */
"use strict";

/* ---------------------------------------------------------------------
   0. CONFIGURATION
   --------------------------------------------------------------------- */

const CARD_INVENTORY_RULES = {
  planningHorizonMonths: 8,
  warningMonths: 6,     // <= 6 months and > 3 months => Warning
  criticalMonths: 3     // <= 3 months => Critical
};

const STATIONERY_MIN_MONTHS = 3;

const SHEET_NAMES = [
  "Overview", "ATM", "RAAST", "IBFT", "IBFT_Failures",
  "Card_Inventory", "Card_Stationery", "Active_Cards", "Card_Financials",
  "Spend_By_Product", "Spend_By_Channel", "Top_Merchants",
  "Chargeback", "Chargeback_Merchants", "Reconciliation", "Nostro",
  "Rejected_Transactions"
];

/* Column alias map: normalized key -> array of header variants to match (case/space-insensitive) */
const COLUMN_ALIASES = {
  txnCount: ["txn count", "transaction count", "transactions", "count"],
  txnAmount: ["txn amount", "transaction amount", "value", "amount"],
  complaintCount: ["complaint count", "complaints"],
  capturedCards: ["captured cards", "card captures", "cards captured"],
  gl: ["gl", "gl no", "gl number"],
  mom: ["mom", "month on month", "monthly change"],
  today: ["today", "current day"],
  yesterday: ["yesterday", "previous day"],
  mtd: ["mtd", "month to date"],
  prevMtd: ["previous mtd", "prev mtd", "pmtd"],
  currentMonth: ["current month", "this month"],
  previousMonth: ["previous month", "last month"]
};

/* ---------------------------------------------------------------------
   1. CENTRALIZED STATE
   --------------------------------------------------------------------- */

const appState = {
  rawWorkbook: null,
  processedData: null,
  selectedFile: null,
  activePage: "overview",
  filters: {},
  lastUpdated: null
};

/* Cached DOM references, populated in init() */
const dom = {};

/* ---------------------------------------------------------------------
   2. FORMATTING HELPERS
   --------------------------------------------------------------------- */

function formatNumber(value, decimals) {
  if (value === null || value === undefined || isNaN(value)) return "N/A";
  const n = Number(value);
  const abs = Math.abs(n);
  const d = decimals !== undefined ? decimals : (abs % 1 === 0 ? 0 : 2);
  if (abs >= 1e9) return (n / 1e9).toFixed(decimals !== undefined ? decimals : 2) + " Billion";
  if (abs >= 1e6) return (n / 1e6).toFixed(decimals !== undefined ? decimals : 2) + " Million";
  if (abs >= 1e5) return (n / 1e3).toFixed(decimals !== undefined ? decimals : 1) + " Thousand";
  return n.toLocaleString("en-US", { maximumFractionDigits: d });
}

function formatCurrency(value, currency) {
  if (value === null || value === undefined || isNaN(value)) return "N/A";
  const cur = currency || "PKR";
  const n = Number(value);
  const abs = Math.abs(n);
  let short;
  if (abs >= 1e9) short = (n / 1e9).toFixed(2) + " Billion";
  else if (abs >= 1e6) short = (n / 1e6).toFixed(2) + " Million";
  else if (abs >= 1e5) short = (n / 1e3).toFixed(1) + " Thousand";
  else short = n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return cur + " " + short;
}

function formatPercentage(value, decimals) {
  if (value === null || value === undefined || isNaN(value)) return "N/A";
  return Number(value).toFixed(decimals !== undefined ? decimals : 2) + "%";
}

function fullValueTitle(value, isCurrency, currency) {
  if (value === null || value === undefined || isNaN(value)) return "";
  const n = Number(value);
  const formatted = n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return isCurrency ? (currency || "PKR") + " " + formatted : formatted;
}

/* Builds a small ▲ / ▼ / — indicator with correct positive/negative colour class */
function indicatorHTML(current, previous, higherIsBetter) {
  if (previous === null || previous === undefined || previous === 0 || isNaN(previous)) {
    return '<span class="indicator flat">&mdash;</span>N/A';
  }
  if (current === null || current === undefined || isNaN(current)) {
    return '<span class="indicator flat">&mdash;</span>N/A';
  }
  const change = current - previous;
  const pct = (change / Math.abs(previous)) * 100;
  const better = higherIsBetter === undefined ? true : higherIsBetter;
  if (Math.abs(change) < 1e-9) {
    return '<span class="indicator flat">&mdash;</span>0.00%';
  }
  const isUp = change > 0;
  const goodDirection = isUp ? better : !better;
  const cls = (isUp ? "up" : "down") + " " + (goodDirection ? "positive" : "negative");
  const arrow = isUp ? "&#9650;" : "&#9660;";
  return '<span class="indicator ' + cls + '">' + arrow + '</span>' + Math.abs(pct).toFixed(2) + "%";
}

/* Returns { change, changePct, indicatorHTML } for use in KPI cards */
function calculateComparisons(current, previous, higherIsBetter) {
  const hasPrev = previous !== null && previous !== undefined && !isNaN(previous) && previous !== 0;
  const change = hasPrev ? current - previous : null;
  const changePct = hasPrev ? (change / Math.abs(previous)) * 100 : null;
  return {
    change: change,
    changePct: changePct,
    html: indicatorHTML(current, previous, higherIsBetter)
  };
}

function sparklineSVG(values) {
  if (!values || !values.length) return "";
  const max = Math.max.apply(null, values);
  const bars = values.map(function (v) {
    const h = max > 0 ? Math.max(2, Math.round((v / max) * 20)) : 2;
    return '<span class="bar" style="height:' + h + 'px"></span>';
  }).join("");
  return '<span class="sparkline" title="7-day trend">' + bars + '</span>';
}

/* ---------------------------------------------------------------------
   3. DOM BUILDING HELPERS
   --------------------------------------------------------------------- */

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (k) {
      if (k === "class") node.className = attrs[k];
      else if (k === "html") node.innerHTML = attrs[k];
      else if (k === "text") node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
  }
  (children || []).forEach(function (c) { if (c) node.appendChild(c); });
  return node;
}

function kpiCard(label, valueText, subHTML, titleAttr) {
  const card = el("div", { class: "kpi-card" });
  card.appendChild(el("div", { class: "kpi-label", text: label }));
  const valEl = el("div", { class: "kpi-value", text: valueText });
  if (titleAttr) valEl.setAttribute("title", titleAttr);
  card.appendChild(valEl);
  if (subHTML) card.appendChild(el("div", { class: "kpi-sub", html: subHTML }));
  return card;
}

function statusBadge(status) {
  const map = { "Sufficient": "ok", "Warning": "warning", "Critical": "critical" };
  const cls = map[status] || "ok";
  return '<span class="status-badge ' + cls + '">' + status + '</span>';
}

/* Renders a data table from column defs + rows into a wrapper div.
   columns: [{key, label, numeric, currency}]  rows: array of objects */
function buildTable(caption, columns, rows, emptyMessage) {
  const wrap = el("div", { class: "table-wrap" });
  if (!rows || rows.length === 0) {
    wrap.appendChild(el("div", { class: "no-data-note", text: emptyMessage || ("No data available" + (caption ? " for " + caption : "")) }));
    return wrap;
  }
  const table = el("table", { class: "data-table" });
  if (caption) table.appendChild(el("caption", { text: caption }));
  const thead = el("thead");
  const headRow = el("tr");
  columns.forEach(function (c) {
    headRow.appendChild(el("th", { class: c.numeric ? "num" : "", text: c.label }));
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  rows.forEach(function (row) {
    const tr = el("tr");
    columns.forEach(function (c) {
      let text;
      const raw = row[c.key];
      if (c.currency) text = formatCurrency(raw);
      else if (c.percent) text = formatPercentage(raw);
      else if (c.numeric) text = formatNumber(raw, c.decimals);
      else text = (raw === null || raw === undefined || raw === "") ? "N/A" : raw;
      text = String(text);
      const isMarkup = text.indexOf("<span") !== -1 || text.indexOf("<strong") !== -1;
      const td = el("td", isMarkup ? { class: c.numeric ? "num" : "", html: text } : { class: c.numeric ? "num" : "", text: text });
      if (c.numeric && typeof raw === "number") td.setAttribute("title", fullValueTitle(raw, !!c.currency));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function sectionTitle(text) {
  return el("div", { class: "section-title", text: text });
}

function dataQualityNote(text) {
  return el("div", { class: "data-quality-note", text: text });
}

/* ---------------------------------------------------------------------
   4. ILLUSTRATIVE (DEMO) DATA
   Used only before a real workbook is loaded, so the dashboard is never
   blank. Shape matches exactly what normalizeWorkbookData() produces.
   --------------------------------------------------------------------- */

function generateIllustrativeData() {
  return {
    meta: { missingSheets: [], dataQualityMessages: [], source: "illustrative" },

    atm: {
      totalATMs: 1240, uptimeToday: 97.8, uptimeYesterday: 97.1,
      withdrawalCountToday: 68450, withdrawalCountYesterday: 65210, withdrawalCountMTD: 1452000, withdrawalCountPrevMTD: 1398000,
      withdrawalAmountToday: 812000000, withdrawalAmountYesterday: 779000000, withdrawalAmountMTD: 17650000000, withdrawalAmountPrevMTD: 16920000000,
      failedTxnToday: 1120, failedTxnYesterday: 1340,
      disputesToday: 42, disputesMTD: 610,
      capturedCardsToday: 18, capturedCardsMTD: 260,
      retractTxnToday: 65, retractTxnMTD: 940
    },
    atmTop5Best: [
      { rank: 1, atmId: "ATM-0142", location: "Gulberg Main, Lahore", txnCount: 2450, successRate: 99.4, uptime: 99.8 },
      { rank: 2, atmId: "ATM-0087", location: "Clifton Block 5, Karachi", txnCount: 2310, successRate: 99.1, uptime: 99.6 },
      { rank: 3, atmId: "ATM-0311", location: "F-10 Markaz, Islamabad", txnCount: 2185, successRate: 98.9, uptime: 99.5 },
      { rank: 4, atmId: "ATM-0206", location: "DHA Phase 6, Lahore", txnCount: 2050, successRate: 98.7, uptime: 99.3 },
      { rank: 5, atmId: "ATM-0455", location: "Saddar, Rawalpindi", txnCount: 1990, successRate: 98.5, uptime: 99.1 }
    ],
    atmBottom5: [
      { rank: 1, atmId: "ATM-0902", location: "Korangi Industrial Area", txnCount: 180, successRate: 82.1, uptime: 84.2 },
      { rank: 2, atmId: "ATM-0765", location: "Hub Chowki", txnCount: 210, successRate: 84.5, uptime: 86.0 },
      { rank: 3, atmId: "ATM-0633", location: "Mianwali Cantt", txnCount: 240, successRate: 86.2, uptime: 88.4 },
      { rank: 4, atmId: "ATM-0518", location: "Muzaffargarh Bypass", txnCount: 265, successRate: 87.0, uptime: 89.1 },
      { rank: 5, atmId: "ATM-0399", location: "Kotli AJK", txnCount: 290, successRate: 88.4, uptime: 90.0 }
    ],

    raast: {
      successCountToday: 41200, successAmountToday: 1980000000,
      successCountMTD: 895000, successAmountMTD: 41200000000,
      successRateToday: 98.6, successRateMTD: 98.2,
      failedCountToday: 590, complaintsToday: 14, complaintsMTD: 210
    },
    ibft: {
      successCountToday: 27800, successAmountToday: 3120000000,
      successCountMTD: 601000, successAmountMTD: 66800000000,
      successRateToday: 97.9, successRateMTD: 97.5,
      failureCountToday: 620, failureCountMTD: 11800,
      complaintsToday: 9, complaintsMTD: 158
    },
    ibftFailures: [
      { reason: "Beneficiary invalid", today: 180, mtd: 3550 },
      { reason: "Timeout", today: 150, mtd: 2890 },
      { reason: "Insufficient funds", today: 140, mtd: 2650 },
      { reason: "Core banking issue", today: 90, mtd: 1620 },
      { reason: "Network error", today: 60, mtd: 1090 }
    ],

    cardInventory: [
      { category: "Blank Debit", qty: 82000, avgMonthlyUse: 9500, minStock: 30000 },
      { category: "Blank Credit", qty: 21000, avgMonthlyUse: 4200, minStock: 12000 },
      { category: "Personalized Ready Stock", qty: 15500, avgMonthlyUse: 6100, minStock: 15000 },
      { category: "Debit Classic", qty: 40000, avgMonthlyUse: 7000, minStock: 18000 },
      { category: "Debit Gold", qty: 18000, avgMonthlyUse: 3100, minStock: 9000 },
      { category: "Debit Platinum", qty: 9200, avgMonthlyUse: 2600, minStock: 8000 },
      { category: "Credit Classic", qty: 12600, avgMonthlyUse: 2900, minStock: 9000 },
      { category: "Credit Gold", qty: 7100, avgMonthlyUse: 1800, minStock: 6000 },
      { category: "Credit Platinum", qty: 3200, avgMonthlyUse: 1450, minStock: 4500 },
      { category: "World Elite", qty: 640, avgMonthlyUse: 260, minStock: 800 }
    ],
    cardStationery: [
      { item: "Envelopes", qty: 96000, avgMonthlyUse: 21000, minStock: 63000 },
      { item: "Mailers", qty: 41000, avgMonthlyUse: 19500, minStock: 58500 },
      { item: "PIN mailers", qty: 88000, avgMonthlyUse: 20500, minStock: 61500 },
      { item: "Welcome packs", qty: 26000, avgMonthlyUse: 8600, minStock: 25800 }
    ],
    activeCards: [
      { product: "Debit Classic", count: 612000, prevMonth: 601500, fee: 0 },
      { product: "Debit Gold", count: 188000, prevMonth: 184200, fee: 1500 },
      { product: "Debit Platinum", count: 63500, prevMonth: 61900, fee: 3500 },
      { product: "Credit Classic", count: 94000, prevMonth: 92100, fee: 2500 },
      { product: "Credit Gold", count: 41200, prevMonth: 40100, fee: 6000 },
      { product: "Credit Platinum", count: 15800, prevMonth: 15200, fee: 12000 },
      { product: "World Elite", count: 2650, prevMonth: 2500, fee: 35000 }
    ],

    cardFinancials: {
      credit: {
        cif: 148600, aif: 115200,
        spendCurrent: 24600000000, spendPrevious: 23100000000,
        annualFeeIncome: 410000000,
        domesticTxnCount: 1850000, domesticTxnAmount: 19800000000,
        intlTxnCount: 96000, intlTxnAmount: 4800000000,
        oifIncome: 62000000,
        domesticInterchange: 288000000, intlInterchange: 94000000,
        mdrIncome: 145000000, fxIncome: 71000000
      },
      debit: {
        spendCurrent: 41200000000, spendPrevious: 39500000000,
        annualFeeIncome: 320000000,
        domesticTxnCount: 5250000, domesticTxnAmount: 38100000000,
        intlTxnCount: 61000, intlTxnAmount: 3100000000,
        domesticInterchange: 198000000, intlInterchange: 52000000,
        oifIncome: 28000000, mdrIncome: 0, fxIncome: 41000000
      }
    },
    spendByProduct: [
      { product: "Debit", currentBn: 41.2, previousBn: 39.5 },
      { product: "Credit", currentBn: 24.6, previousBn: 23.1 }
    ],
    spendByChannel: [
      { channel: "E-Commerce", current: 18600000000, previous: 17100000000 },
      { channel: "ATM", current: 17650000000, previous: 16920000000 },
      { channel: "POS", current: 29550000000, previous: 28580000000 }
    ],
    topMerchants: [
      { rank: 1, merchant: "Merchant Group A", channel: "E-Commerce", txnCount: 92000, spend: 2100000000, share: 8.1 },
      { rank: 2, merchant: "Merchant Group B", channel: "POS", txnCount: 78500, spend: 1850000000, share: 7.1 },
      { rank: 3, merchant: "Merchant Group C", channel: "POS", txnCount: 65200, spend: 1520000000, share: 5.8 },
      { rank: 4, merchant: "Merchant Group D", channel: "E-Commerce", txnCount: 54000, spend: 1210000000, share: 4.6 },
      { rank: 5, merchant: "Merchant Group E", channel: "ATM", txnCount: 48900, spend: 980000000, share: 3.8 }
    ],
    revenueComposition: [
      { item: "Interchange Income (Domestic)", current: 486000000, previous: 462000000 },
      { item: "Interchange Income (International)", current: 146000000, previous: 138000000 },
      { item: "Annual Fees", current: 730000000, previous: 715000000 },
      { item: "FX Income", current: 112000000, previous: 104000000 },
      { item: "OIF Income", current: 90000000, previous: 83000000 },
      { item: "MDR Income", current: 145000000, previous: 139000000 }
    ],
    netInterchange: { income: 632000000, expense: 210000000 },
    sbpCrossBorder: { customerCountCurrent: 186, customerCountPrevious: 171 },

    chargeback: {
      domestic: { count: 1240, amount: 86000000, prevCount: 1180, prevAmount: 81500000 },
      international: { count: 380, amount: 41000000, prevCount: 410, prevAmount: 44200000 },
      pos: { count: 690, amount: 52000000, prevCount: 655, prevAmount: 49800000 },
      ecommerce: { count: 930, amount: 75000000, prevCount: 935, prevAmount: 75800000 },
      preArbRaised: { count: 82, amount: 9800000, prevCount: 76, prevAmount: 9100000 },
      preArbReceived: { count: 58, amount: 6900000, prevCount: 63, prevAmount: 7400000 },
      highAging: { count: 47, amount: 8100000, prevCount: 52, prevAmount: 8900000 }
    },
    chargebackMerchantsByCount: [
      { rank: 1, merchant: "Merchant Group F", disputeCount: 145, disputedAmount: 12100000, share: 9.2 },
      { rank: 2, merchant: "Merchant Group G", disputeCount: 118, disputedAmount: 10200000, share: 7.5 },
      { rank: 3, merchant: "Merchant Group H", disputeCount: 96, disputedAmount: 8600000, share: 6.1 },
      { rank: 4, merchant: "Merchant Group I", disputeCount: 84, disputedAmount: 7400000, share: 5.3 },
      { rank: 5, merchant: "Merchant Group J", disputeCount: 71, disputedAmount: 6300000, share: 4.5 }
    ],
    chargebackMerchantsByAmount: [
      { rank: 1, merchant: "Merchant Group F", chargebackCount: 145, chargebackAmount: 12100000, share: 9.2 },
      { rank: 2, merchant: "Merchant Group K", chargebackCount: 62, chargebackAmount: 11400000, share: 8.6 },
      { rank: 3, merchant: "Merchant Group G", chargebackCount: 118, chargebackAmount: 10200000, share: 7.5 },
      { rank: 4, merchant: "Merchant Group H", chargebackCount: 96, chargebackAmount: 8600000, share: 6.1 },
      { rank: 5, merchant: "Merchant Group L", chargebackCount: 54, chargebackAmount: 7900000, share: 5.9 }
    ],
    chargebackGL: [
      { gl: "GL-71200", txnCount: 320, amount: 26000000 },
      { gl: "GL-71205", txnCount: 210, amount: 17500000 }
    ],

    reconciliation: {
      receivables: [
        { gl: "GL-40010", description: "Interbank settlement receivable", txnCount: 86, amount: 41200000, bucket: "30+" },
        { gl: "GL-40015", description: "ATM cash-in-transit receivable", txnCount: 42, amount: 18600000, bucket: "60+" },
        { gl: "GL-40022", description: "Card scheme receivable", txnCount: 29, amount: 12100000, bucket: "90+" }
      ],
      payables: [
        { gl: "GL-50010", description: "Interbank settlement payable", txnCount: 74, amount: 36500000, bucket: "30+" },
        { gl: "GL-50014", description: "Merchant settlement payable", txnCount: 51, amount: 22300000, bucket: "60+" },
        { gl: "GL-50030", description: "Scheme fee payable", txnCount: 18, amount: 6400000, bucket: "120+" }
      ],
      agingBuckets: [
        { bucket: "Current", txnCount: 940, amount: 210000000, share: 62.4 },
        { bucket: "30+", txnCount: 160, amount: 77700000, share: 23.0 },
        { bucket: "60+", txnCount: 93, amount: 40900000, share: 12.1 },
        { bucket: "90+", txnCount: 29, amount: 12100000, share: 3.6 },
        { bucket: "120+", txnCount: 18, amount: 6400000, share: 1.9 }
      ]
    },
    nostro: [
      { gl: "NOSTRO-USD-01", balance: 18600000, fundingRequirement: 15200000, buffer: 3400000, reportingDate: "" },
      { gl: "NOSTRO-EUR-01", balance: 6200000, fundingRequirement: 5100000, buffer: 1100000, reportingDate: "" }
    ],
    rejected: {
      gl: "GL-60010", rejectedCount: 62, rejectedAmount: 8900000,
      repostedCount: 48, repostedAmount: 6800000,
      pendingCount: 14, pendingAmount: 2100000
    },
    oif: { caseCountCurrent: 96, valueCurrent: 62000000, caseCountPrevious: 88, valuePrevious: 55500000 },

    /* 7-day total ADC transaction count trend (ATM + RAAST + IBFT) */
    adcTrend7Day: [
      { date: "05-Sep", count: 128900 },
      { date: "06-Sep", count: 134200 },
      { date: "07-Sep", count: 131500 },
      { date: "08-Sep", count: 138700 },
      { date: "09-Sep", count: 142300 },
      { date: "10-Sep", count: 139200 },
      { date: "11-Sep", count: 137450 }
    ]
  };
}

/* ---------------------------------------------------------------------
   5. EXCEL / CSV PARSING
   --------------------------------------------------------------------- */

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/* Resolves a normalized column key from a raw row object using COLUMN_ALIASES,
   falling back to a direct case-insensitive match on candidateKey. */
function getAliasedValue(row, canonicalKey, directKeys) {
  const aliasList = COLUMN_ALIASES[canonicalKey] || [];
  const normalizedRowKeys = {};
  Object.keys(row).forEach(function (k) { normalizedRowKeys[normalizeHeader(k)] = row[k]; });
  const allCandidates = (directKeys || []).concat(aliasList, [canonicalKey]);
  for (let i = 0; i < allCandidates.length; i++) {
    const norm = normalizeHeader(allCandidates[i]);
    if (Object.prototype.hasOwnProperty.call(normalizedRowKeys, norm)) {
      return normalizedRowKeys[norm];
    }
  }
  return undefined;
}

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const cleaned = String(v).replace(/[,%\s]/g, "").replace(/^PKR|USD/i, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/* Minimal built-in CSV parser (handles quoted fields), used when the CSV
   path is taken directly — independent of the bundled xlsx library. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some(function (v) { return v !== ""; })) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map(function (r) {
    const obj = {};
    headers.forEach(function (h, i) { obj[h] = r[i]; });
    return obj;
  });
}

/* Reads sheet-like arrays-of-objects out of a parsed workbook (from the
   xlsx library) or a single CSV table, keyed by the SHEET_NAMES list. */
function extractRawSheets(workbookOrRows, isCSV) {
  const rawSheets = {};
  const missingSheets = [];
  if (isCSV) {
    /* A CSV file only ever contains one table — treat it as the Overview sheet
       plus best-effort detection is not attempted; user should use xlsx for
       the full multi-sheet workbook. */
    rawSheets["Overview"] = workbookOrRows;
    SHEET_NAMES.forEach(function (name) { if (name !== "Overview") missingSheets.push(name); });
  } else {
    SHEET_NAMES.forEach(function (name) {
      const sheetName = Object.keys(workbookOrRows.Sheets).find(function (s) {
        return normalizeHeader(s) === normalizeHeader(name);
      });
      if (sheetName) {
        rawSheets[name] = XLSX.utils.sheet_to_json(workbookOrRows.Sheets[sheetName], { defval: null });
      } else {
        missingSheets.push(name);
      }
    });
  }
  return { rawSheets: rawSheets, missingSheets: missingSheets };
}

/* normalizeWorkbookData(): converts raw per-sheet row arrays into the
   canonical shape consumed by the render functions. Only sheets that are
   present are transformed; everything else is left null so pages can show
   a "No data available" message instead of crashing. */
function normalizeWorkbookData(rawSheets, missingSheets) {
  const data = { meta: { missingSheets: missingSheets, dataQualityMessages: [], source: "excel" } };

  function num(row, key, direct) { return toNumber(getAliasedValue(row, key, direct)); }

  if (rawSheets["ATM"] && rawSheets["ATM"].length) {
    const r = rawSheets["ATM"][0] || {};
    data.atm = {
      totalATMs: num(r, "totalATMs", ["Total ATMs"]),
      uptimeToday: num(r, "uptimeToday", ["Uptime Today", "ATM Uptime"]),
      uptimeYesterday: num(r, "uptimeYesterday", ["Uptime Yesterday"]),
      withdrawalCountToday: num(r, "today", ["Withdrawal Count Today"]),
      withdrawalCountYesterday: num(r, "yesterday", ["Withdrawal Count Yesterday"]),
      withdrawalCountMTD: num(r, "mtd", ["Withdrawal Count MTD"]),
      withdrawalCountPrevMTD: num(r, "prevMtd", ["Withdrawal Count Previous MTD"]),
      withdrawalAmountToday: num(r, "txnAmount", ["Withdrawal Amount Today"]),
      withdrawalAmountYesterday: num(r, null, ["Withdrawal Amount Yesterday"]),
      withdrawalAmountMTD: num(r, null, ["Withdrawal Amount MTD"]),
      withdrawalAmountPrevMTD: num(r, null, ["Withdrawal Amount Previous MTD"]),
      failedTxnToday: num(r, null, ["Failed ATM Transactions Today", "Failed Transactions Today"]),
      failedTxnYesterday: num(r, null, ["Failed ATM Transactions Yesterday"]),
      disputesToday: num(r, null, ["ATM Disputes Today", "Disputes Today"]),
      disputesMTD: num(r, null, ["ATM Disputes MTD", "Disputes MTD"]),
      capturedCardsToday: num(r, "capturedCards", ["Captured Cards Today"]),
      capturedCardsMTD: num(r, null, ["Captured Cards MTD"]),
      retractTxnToday: num(r, null, ["Cash Retract Today", "Retract Transactions Today"]),
      retractTxnMTD: num(r, null, ["Cash Retract MTD"])
    };
    const rows = rawSheets["ATM"];
    if (rows.length > 1) {
      data.atmTop5Best = rows.slice(0, 5).map(function (row, i) { return atmRow(row, i); });
      data.atmBottom5 = rows.slice(-5).map(function (row, i) { return atmRow(row, i); });
    }
  }
  function atmRow(row, i) {
    return {
      rank: i + 1,
      atmId: getAliasedValue(row, null, ["ATM ID"]) || "N/A",
      location: getAliasedValue(row, null, ["ATM Location", "Location"]) || "N/A",
      txnCount: num(row, "txnCount"),
      successRate: num(row, null, ["Success Rate"]),
      uptime: num(row, null, ["Uptime"])
    };
  }

  if (rawSheets["RAAST"] && rawSheets["RAAST"].length) {
    const r = rawSheets["RAAST"][0] || {};
    data.raast = {
      successCountToday: num(r, "today", ["Successful Transaction Count Today"]),
      successAmountToday: num(r, null, ["Successful Transaction Amount Today"]),
      successCountMTD: num(r, "mtd", ["Successful Transaction Count MTD"]),
      successAmountMTD: num(r, null, ["Successful Transaction Amount MTD"]),
      successRateToday: num(r, null, ["Success Rate Today"]),
      successRateMTD: num(r, null, ["Success Rate MTD"]),
      failedCountToday: num(r, null, ["Failed Transaction Count Today"]),
      complaintsToday: num(r, "complaintCount", ["Complaints Today"]),
      complaintsMTD: num(r, null, ["Complaints MTD"])
    };
  }

  if (rawSheets["IBFT"] && rawSheets["IBFT"].length) {
    const r = rawSheets["IBFT"][0] || {};
    data.ibft = {
      successCountToday: num(r, "today", ["Successful Transaction Count Today"]),
      successAmountToday: num(r, null, ["Successful Transaction Amount Today"]),
      successCountMTD: num(r, "mtd", ["Successful Transaction Count MTD"]),
      successAmountMTD: num(r, null, ["Successful Transaction Amount MTD"]),
      successRateToday: num(r, null, ["Success Rate Today"]),
      successRateMTD: num(r, null, ["Success Rate MTD"]),
      failureCountToday: num(r, null, ["Failure Count Today"]),
      failureCountMTD: num(r, null, ["Failure Count MTD"]),
      complaintsToday: num(r, "complaintCount", ["Complaints Today"]),
      complaintsMTD: num(r, null, ["Complaints MTD"])
    };
  }
  if (rawSheets["IBFT_Failures"] && rawSheets["IBFT_Failures"].length) {
    data.ibftFailures = rawSheets["IBFT_Failures"].map(function (row) {
      return {
        reason: getAliasedValue(row, null, ["Failure Reason"]) || "Other",
        today: num(row, null, ["Today Count"]),
        mtd: num(row, null, ["MTD Count"])
      };
    });
  }

  if (rawSheets["Card_Inventory"] && rawSheets["Card_Inventory"].length) {
    data.cardInventory = rawSheets["Card_Inventory"].map(function (row) {
      return {
        category: getAliasedValue(row, null, ["Plastic Category", "Category"]) || "Other",
        qty: num(row, null, ["Current Quantity", "Quantity"]),
        avgMonthlyUse: num(row, null, ["Average Monthly Consumption", "Avg Monthly Consumption"]),
        minStock: num(row, null, ["Required Minimum Stock", "Minimum Stock"])
      };
    });
  }
  if (rawSheets["Card_Stationery"] && rawSheets["Card_Stationery"].length) {
    data.cardStationery = rawSheets["Card_Stationery"].map(function (row) {
      return {
        item: getAliasedValue(row, null, ["Item"]) || "Other",
        qty: num(row, null, ["Current Quantity", "Quantity"]),
        avgMonthlyUse: num(row, null, ["Average Monthly Usage", "Avg Monthly Usage"]),
        minStock: num(row, null, ["Minimum Requirement", "Minimum Stock"])
      };
    });
  }
  if (rawSheets["Active_Cards"] && rawSheets["Active_Cards"].length) {
    data.activeCards = rawSheets["Active_Cards"].map(function (row) {
      return {
        product: getAliasedValue(row, null, ["Product"]) || "Other",
        count: num(row, "currentMonth", ["Active Card Count", "Current Month"]),
        prevMonth: num(row, "previousMonth", ["Previous Month"]),
        fee: num(row, null, ["Annual Fee"])
      };
    });
  }

  if (rawSheets["Card_Financials"] && rawSheets["Card_Financials"].length) {
    const rows = rawSheets["Card_Financials"];
    const creditRow = rows.find(function (r) { return normalizeHeader(getAliasedValue(r, null, ["Card Type", "Type"])) === "credit"; }) || rows[0] || {};
    const debitRow = rows.find(function (r) { return normalizeHeader(getAliasedValue(r, null, ["Card Type", "Type"])) === "debit"; }) || rows[1] || {};
    function buildFin(r) {
      return {
        cif: num(r, null, ["Credit Card CIF", "CIF"]),
        aif: num(r, null, ["Credit Card AIF", "AIF"]),
        spendCurrent: num(r, "currentMonth", ["Current Month Spend"]),
        spendPrevious: num(r, "previousMonth", ["Previous Month Spend"]),
        annualFeeIncome: num(r, null, ["Annual Fee Income"]),
        domesticTxnCount: num(r, null, ["Domestic Transaction Count"]),
        domesticTxnAmount: num(r, null, ["Domestic Transaction Amount"]),
        intlTxnCount: num(r, null, ["International Transaction Count"]),
        intlTxnAmount: num(r, null, ["International Transaction Amount"]),
        oifIncome: num(r, null, ["OIF Income", "OIF Earned"]),
        domesticInterchange: num(r, null, ["Domestic Interchange Income"]),
        intlInterchange: num(r, null, ["International Interchange Income"]),
        mdrIncome: num(r, null, ["MDR Income"]),
        fxIncome: num(r, null, ["FX Income"])
      };
    }
    data.cardFinancials = { credit: buildFin(creditRow), debit: buildFin(debitRow) };
  }
  if (rawSheets["Spend_By_Product"] && rawSheets["Spend_By_Product"].length) {
    data.spendByProduct = rawSheets["Spend_By_Product"].map(function (row) {
      return {
        product: getAliasedValue(row, null, ["Product"]) || "Other",
        currentBn: num(row, "currentMonth", ["Current Month Spend"]),
        previousBn: num(row, "previousMonth", ["Previous Month Spend"])
      };
    });
  }
  if (rawSheets["Spend_By_Channel"] && rawSheets["Spend_By_Channel"].length) {
    data.spendByChannel = rawSheets["Spend_By_Channel"].map(function (row) {
      return {
        channel: getAliasedValue(row, null, ["Channel"]) || "Other",
        current: num(row, "currentMonth", ["Current Month Spend"]),
        previous: num(row, "previousMonth", ["Previous Month Spend"])
      };
    });
  }
  if (rawSheets["Top_Merchants"] && rawSheets["Top_Merchants"].length) {
    data.topMerchants = rawSheets["Top_Merchants"].slice(0, 5).map(function (row, i) {
      return {
        rank: i + 1,
        merchant: getAliasedValue(row, null, ["Merchant Name", "Merchant"]) || "N/A",
        channel: getAliasedValue(row, null, ["Channel"]) || "N/A",
        txnCount: num(row, "txnCount"),
        spend: num(row, null, ["Spend Amount"]),
        share: num(row, null, ["Share Percentage", "Share"])
      };
    });
  }

  if (rawSheets["Chargeback"] && rawSheets["Chargeback"].length) {
    const rows = rawSheets["Chargeback"];
    function findMetric(name) {
      const row = rows.find(function (r) { return normalizeHeader(getAliasedValue(r, null, ["Metric"])) === normalizeHeader(name); });
      if (!row) return null;
      return {
        count: num(row, null, ["Current Count"]), amount: num(row, null, ["Current Amount"]),
        prevCount: num(row, null, ["Previous Count"]), prevAmount: num(row, null, ["Previous Amount"])
      };
    }
    data.chargeback = {
      domestic: findMetric("Domestic Disputes"),
      international: findMetric("International Disputes"),
      pos: findMetric("POS Disputes"),
      ecommerce: findMetric("E-Commerce Disputes"),
      preArbRaised: findMetric("Pre-Arbitration Raised"),
      preArbReceived: findMetric("Pre-Arbitration Received"),
      highAging: findMetric("High-Aging Disputes")
    };
  }
  if (rawSheets["Chargeback_Merchants"] && rawSheets["Chargeback_Merchants"].length) {
    const rows = rawSheets["Chargeback_Merchants"];
    data.chargebackMerchantsByCount = rows.slice().sort(function (a, b) {
      return (num(b, null, ["Dispute Count"]) || 0) - (num(a, null, ["Dispute Count"]) || 0);
    }).slice(0, 5).map(function (row, i) {
      return {
        rank: i + 1, merchant: getAliasedValue(row, null, ["Merchant"]) || "N/A",
        disputeCount: num(row, null, ["Dispute Count"]), disputedAmount: num(row, null, ["Disputed Amount"]),
        share: num(row, null, ["Share Percentage", "Share"])
      };
    });
    data.chargebackMerchantsByAmount = rows.slice().sort(function (a, b) {
      return (num(b, null, ["Chargeback Amount"]) || 0) - (num(a, null, ["Chargeback Amount"]) || 0);
    }).slice(0, 5).map(function (row, i) {
      return {
        rank: i + 1, merchant: getAliasedValue(row, null, ["Merchant"]) || "N/A",
        chargebackCount: num(row, null, ["Chargeback Count", "Dispute Count"]), chargebackAmount: num(row, null, ["Chargeback Amount"]),
        share: num(row, null, ["Share Percentage", "Share"])
      };
    });
  }

  if (rawSheets["Reconciliation"] && rawSheets["Reconciliation"].length) {
    const rows = rawSheets["Reconciliation"];
    function reconRow(row) {
      return {
        gl: getAliasedValue(row, "gl") || "N/A",
        description: getAliasedValue(row, null, ["GL Description", "Description"]) || "",
        txnCount: num(row, "txnCount"), amount: num(row, "txnAmount"),
        bucket: getAliasedValue(row, null, ["Aging Bucket", "Bucket"]) || "Current"
      };
    }
    const receivables = rows.filter(function (r) { return normalizeHeader(getAliasedValue(r, null, ["Type"])) === "receivable"; });
    const payables = rows.filter(function (r) { return normalizeHeader(getAliasedValue(r, null, ["Type"])) === "payable"; });
    data.reconciliation = {
      receivables: receivables.map(reconRow),
      payables: payables.map(reconRow),
      agingBuckets: null
    };
  }
  if (rawSheets["Nostro"] && rawSheets["Nostro"].length) {
    data.nostro = rawSheets["Nostro"].map(function (row) {
      return {
        gl: getAliasedValue(row, "gl", ["Nostro GL"]) || "N/A",
        balance: num(row, null, ["Nostro Balance"]),
        fundingRequirement: num(row, null, ["Funding Requirement"]),
        buffer: num(row, null, ["Buffer Available"]),
        reportingDate: getAliasedValue(row, null, ["Reporting Date"]) || ""
      };
    });
  }
  if (rawSheets["Rejected_Transactions"] && rawSheets["Rejected_Transactions"].length) {
    const r = rawSheets["Rejected_Transactions"][0] || {};
    data.rejected = {
      gl: getAliasedValue(r, "gl") || "N/A",
      rejectedCount: num(r, null, ["Rejected Transaction Count"]),
      rejectedAmount: num(r, null, ["Rejected Transaction Amount"]),
      repostedCount: num(r, null, ["Reposted Count"]),
      repostedAmount: num(r, null, ["Reposted Amount"]),
      pendingCount: num(r, null, ["Pending Count"]),
      pendingAmount: num(r, null, ["Pending Amount"])
    };
  }

  if (missingSheets.length) {
    data.meta.dataQualityMessages.push(
      "The following sheets were not found in the uploaded workbook: " + missingSheets.join(", ") + ". Related sections show 'No data available'."
    );
  }
  return data;
}

function validateWorkbookData(data) {
  const issues = [];
  if (!data || Object.keys(data).length <= 1) {
    issues.push("No supported data sheets were found.");
  }
  return issues;
}

/* parseWorkbookOnce(): the single place workbook parsing happens. */
function parseWorkbookOnce(fileResult, fileName) {
  const isCSV = /\.csv$/i.test(fileName);
  let extraction;
  if (isCSV) {
    const rows = parseCSV(fileResult);
    extraction = extractRawSheets(rows, true);
  } else {
    if (typeof XLSX === "undefined") {
      throw new Error("XLSX_LIBRARY_MISSING");
    }
    const wb = XLSX.read(fileResult, { type: "array", cellDates: true });
    extraction = extractRawSheets(wb, false);
  }
  const normalized = normalizeWorkbookData(extraction.rawSheets, extraction.missingSheets);
  return { normalized: normalized, rawSheets: extraction.rawSheets };
}

/* loadWorkbook(): wires the file picker to parseWorkbookOnce + state update. */
function loadWorkbook(file) {
  if (!file) return;
  const isCSV = /\.csv$/i.test(file.name);
  const isExcel = /\.xlsx$|\.xls$/i.test(file.name);
  if (!isCSV && !isExcel) {
    showMessage("Unsupported file type. Please select a .xlsx, .xls or .csv file.", "error");
    return;
  }
  const reader = new FileReader();
  reader.onerror = function () {
    showMessage("The selected file could not be read.", "error");
  };
  reader.onload = function (e) {
    try {
      const result = isCSV ? new TextDecoder("utf-8").decode(new Uint8Array(e.target.result)) : new Uint8Array(e.target.result);
      const parsed = parseWorkbookOnce(result, file.name);
      const issues = validateWorkbookData(parsed.normalized);
      if (issues.length) {
        showMessage(issues.join(" "), "error");
        return;
      }
      appState.rawWorkbook = parsed.rawSheets;
      appState.processedData = parsed.normalized;
      appState.selectedFile = file.name;
      appState.lastUpdated = new Date();
      updateHeaderStatus();
      showMessage("File loaded successfully.", "success");
      renderActivePage();
    } catch (err) {
      if (err && err.message === "XLSX_LIBRARY_MISSING") {
        showMessage("The xlsx.min.js library was not found in the js/ folder, so .xlsx and .xls files cannot be parsed. CSV files work without it. See README.txt for how to add the library.", "error");
      } else {
        showMessage("The file could not be parsed. Please confirm it is a valid Excel or CSV workbook.", "error");
      }
    }
  };
  if (isCSV) reader.readAsArrayBuffer(file);
  else reader.readAsArrayBuffer(file);
}

/* ---------------------------------------------------------------------
   6. MESSAGING / STATUS
   --------------------------------------------------------------------- */

let messageTimer = null;
function showMessage(text, type) {
  if (!dom.globalMessage) return;
  dom.globalMessage.textContent = text;
  dom.globalMessage.className = "global-message " + (type || "info");
  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = setTimeout(function () {
    dom.globalMessage.textContent = "";
    dom.globalMessage.className = "global-message";
  }, 7000);
}

function updateHeaderStatus() {
  if (dom.dataStatus) {
    if (appState.processedData) {
      dom.dataStatus.textContent = "Excel Data Loaded";
      dom.dataStatus.className = "data-status loaded";
    } else {
      dom.dataStatus.textContent = "Illustrative Data";
      dom.dataStatus.className = "data-status illustrative";
    }
  }
  if (dom.loadedFileName) {
    dom.loadedFileName.textContent = appState.processedData && appState.selectedFile ? "File: " + appState.selectedFile : "";
  }
  if (dom.lastRefreshed) {
    dom.lastRefreshed.textContent = appState.lastUpdated
      ? "Last refreshed: " + appState.lastUpdated.toLocaleString("en-GB", { hour12: false })
      : "Last refreshed: \u2014";
  }
}

/* ---------------------------------------------------------------------
   7. NAVIGATION
   --------------------------------------------------------------------- */

const VALID_PAGES = ["overview", "adc-operations", "card-non-financials", "card-financials", "chargeback", "reconciliation"];

function navigateToPage(pageId) {
  if (VALID_PAGES.indexOf(pageId) === -1) pageId = "overview";
  if (window.location.hash !== "#" + pageId) {
    window.location.hash = "#" + pageId;
  } else {
    applyActivePage(pageId);
  }
}

function applyActivePage(pageId) {
  appState.activePage = pageId;
  VALID_PAGES.forEach(function (p) {
    const section = document.getElementById("page-" + p);
    if (section) section.classList.toggle("active", p === pageId);
    const navBtn = dom.sideNav.querySelector('[data-page="' + p + '"]');
    if (navBtn) navBtn.classList.toggle("active", p === pageId);
  });
  renderActivePage();
}

function handleHashChange() {
  const pageId = (window.location.hash || "#overview").replace("#", "");
  applyActivePage(VALID_PAGES.indexOf(pageId) !== -1 ? pageId : "overview");
}

/* ---------------------------------------------------------------------
   8. FILTERS
   --------------------------------------------------------------------- */

function applyFilters() {
  appState.filters = {
    reportingDate: dom.filterReportingDate.value,
    reportingMonth: dom.filterReportingMonth.value,
    period: dom.filterPeriod.value,
    creditDebit: dom.filterCreditDebit.value,
    domIntl: dom.filterDomIntl.value,
    issAcq: dom.filterIssAcq.value
  };
  renderActivePage();
}

function periodLabelText() {
  const f = appState.filters || {};
  const period = f.period === "mtd" ? "Month to Date" : "Today";
  const dateStr = f.reportingDate ? " \u2022 " + f.reportingDate : "";
  return period + dateStr;
}

/* ---------------------------------------------------------------------
   9. RENDER: ACTIVE PAGE DISPATCH
   --------------------------------------------------------------------- */

function currentData() {
  return appState.processedData || generateIllustrativeData();
}

function renderActivePage() {
  const data = currentData();
  document.querySelectorAll("[data-period-label]").forEach(function (n) { n.textContent = periodLabelText(); });
  evaluateAndShowToastAlerts(data);

  switch (appState.activePage) {
    case "overview": renderOverview(data); break;
    case "adc-operations": renderADCOperations(data); break;
    case "card-non-financials": renderCardNonFinancials(data); break;
    case "card-financials": renderCardFinancials(data); break;
    case "chargeback": renderChargeback(data); break;
    case "reconciliation": renderReconciliation(data); break;
  }
}

/* ---------------------------------------------------------------------
   8. ALERTS — BOTTOM-RIGHT NOTIFICATION SYSTEM (WITH SESSION STORAGE MEMORY)
   --------------------------------------------------------------------- */

function getDismissedAlerts() {
  try {
    return JSON.parse(sessionStorage.getItem("dismissed_toast_alerts") || "[]");
  } catch (e) {
    return [];
  }
}

function dismissAlert(alertId) {
  try {
    const list = getDismissedAlerts();
    if (list.indexOf(alertId) === -1) {
      list.push(alertId);
      sessionStorage.setItem("dismissed_toast_alerts", JSON.stringify(list));
    }
  } catch (e) {}
}

function evaluateAndShowToastAlerts(data) {
  if (!data) return;

  const rawAlerts = [];

  /* 1. Card Inventory Alerts */
  if (data.cardInventory) {
    data.cardInventory.forEach(function (item) {
      if (item.qty <= item.minStock) {
        rawAlerts.push({
          id: "toast_inv_" + String(item.category).replace(/\s+/g, "_"),
          severity: "CRITICAL",
          title: "Low Card Stock: " + item.category,
          detail: "Current: " + formatNumber(item.qty, 0) + " (Min: " + formatNumber(item.minStock, 0) + ")",
          page: "card-non-financials"
        });
      }
    });
  }

  /* 2. Card Stationery Alerts */
  if (data.cardStationery) {
    data.cardStationery.forEach(function (item) {
      if (item.qty <= item.minStock) {
        rawAlerts.push({
          id: "toast_stat_" + String(item.item).replace(/\s+/g, "_"),
          severity: "WARNING",
          title: "Low Stationery: " + item.item,
          detail: "Current: " + formatNumber(item.qty, 0) + " (Min: " + formatNumber(item.minStock, 0) + ")",
          page: "card-non-financials"
        });
      }
    });
  }

  /* 3. Reconciliation High Aging Receivables */
  if (data.reconciliation) {
    const highAgeRec = (data.reconciliation.receivables || []).filter(function (r) {
      return r.bucket === "60+" || r.bucket === "90+" || r.bucket === "120+";
    });
    if (highAgeRec.length > 0) {
      const totAmt = sumBy(highAgeRec, "amount");
      rawAlerts.push({
        id: "toast_recon_high_aging",
        severity: "HIGH AGING",
        title: "Recon Receivables Over 60 Days",
        detail: highAgeRec.length + " items outstanding totaling " + formatCurrency(totAmt),
        page: "reconciliation"
      });
    }
  }

  /* 4. Chargeback High Aging Disputes */
  if (data.chargeback && data.chargeback.highAging && data.chargeback.highAging.count > 0) {
    rawAlerts.push({
      id: "toast_cb_high_aging",
      severity: "WARNING",
      title: "High-Aging Chargeback Disputes",
      detail: data.chargeback.highAging.count + " pending cases (" + formatCurrency(data.chargeback.highAging.amount) + ")",
      page: "chargeback"
    });
  }

  /* 5. NOSTRO Deficit Alert */
  if (data.nostro) {
    data.nostro.forEach(function (n) {
      if (n.buffer < 0) {
        rawAlerts.push({
          id: "toast_nostro_" + String(n.gl).replace(/\s+/g, "_"),
          severity: "CRITICAL",
          title: "NOSTRO Deficit: " + n.gl,
          detail: "Balance: " + formatCurrency(n.balance) + " (Req: " + formatCurrency(n.fundingRequirement) + ")",
          page: "reconciliation"
        });
      }
    });
  }

  /* Filter out alerts dismissed during this session */
  const dismissed = getDismissedAlerts();
  const activeAlerts = rawAlerts.filter(function (a) { return dismissed.indexOf(a.id) === -1; });

  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    document.body.appendChild(container);
  }
  container.innerHTML = "";

  if (activeAlerts.length === 0) return;

  activeAlerts.forEach(function (a) {
    const toast = document.createElement("div");
    toast.className = "toast-notification " + a.severity.toLowerCase().replace(/\s+/g, "-");
    toast.setAttribute("role", "alert");

    const badgeCls = a.severity === "CRITICAL" ? "critical" : "warning";
    const badgeHtml = '<span class="status-badge ' + badgeCls + '">' + a.severity + '</span>';

    toast.innerHTML = '<div class="toast-body">'
      + '<div class="toast-header">' + badgeHtml + '<div class="toast-title">' + a.title + '</div></div>'
      + '<div class="toast-detail">' + a.detail + '</div>'
      + '<div class="toast-link">Investigate &rarr;</div>'
      + '</div>'
      + '<button class="toast-close" type="button" aria-label="Dismiss alert">&times;</button>';

    /* Clicking body navigates to page */
    toast.addEventListener("click", function (e) {
      if (e.target.classList.contains("toast-close")) return;
      navigateToPage(a.page);
    });

    /* Clicking close button dismisses and remembers in sessionStorage */
    const closeBtn = toast.querySelector(".toast-close");
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      dismissAlert(a.id);
      toast.style.opacity = "0";
      toast.style.transform = "translateY(10px)";
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 200);
    });

    container.appendChild(toast);
  });
}

/* =====================================================================
   10. PAGE 1 — OVERVIEW (EXECUTIVE COMMAND CENTER)
   ===================================================================== */

function renderOverview(data) {
  const root = document.getElementById("overview-body");
  root.innerHTML = "";

  if (data.meta && data.meta.dataQualityMessages.length) {
    data.meta.dataQualityMessages.forEach(function (m) { root.appendChild(dataQualityNote(m)); });
  }

  renderOvKpiStrip(root, data);   /* Level 1: Executive KPI strip       */
  renderOvNostro(root, data);     /* NOSTRO Position Status             */
  renderOvAdcSummary(root, data); /* Level 2: ADC operational table      */
  renderOvCharts(root, data);     /* Level 3: Visual management widgets */
  renderOvModules(root, data);    /* Level 4: Module summary panels     */
}

/* ── NOSTRO Position Status on Overview ────────────────────────────── */

function renderOvNostro(root, data) {
  if (!data.nostro || !data.nostro.length) return;

  const section = el("div", { class: "ov-section" });
  section.appendChild(el("div", { class: "ov-section-heading", text: "NOSTRO Account Positions & Reserve Buffer" }));

  const grid = el("div", { class: "kpi-grid" });
  data.nostro.forEach(function (n) {
    const sub = "Funding Req: " + formatCurrency(n.fundingRequirement) + " | Buffer: " + formatCurrency(n.buffer);
    const title = n.gl + " Position";
    grid.appendChild(kpiCard(title, formatCurrency(n.balance), sub));
  });

  section.appendChild(grid);
  root.appendChild(section);
}

/* ── Level 1: Executive KPI Strip ─────────────────────────────────── */

function renderOvKpiStrip(root, data) {
  const strip = el("div", { class: "ov-kpi-strip" });

  /* 1. ATM Uptime */
  const uptime    = data.atm ? data.atm.uptimeToday : null;
  const uptimeY   = data.atm ? data.atm.uptimeYesterday : null;
  strip.appendChild(ovExecCard("ATM Uptime", formatPercentage(uptime),
    indicatorHTML(uptime, uptimeY, true), "vs Yesterday", "DAILY",
    fullValueTitle(uptime)));

  /* 2. Total ADC Transaction Count */
  const adcCntTdy = (data.atm ? data.atm.withdrawalCountToday || 0 : 0)
                  + (data.raast ? data.raast.successCountToday || 0 : 0)
                  + (data.ibft ? data.ibft.successCountToday || 0 : 0);
  const adcCntY   = data.atm ? data.atm.withdrawalCountYesterday : null;
  strip.appendChild(ovExecCard("Total ADC Transactions", formatNumber(adcCntTdy, 0),
    indicatorHTML(adcCntTdy, adcCntY, true), "vs Yesterday", "DAILY"));

  /* 3. Total ADC Transaction Amount */
  const adcAmtTdy = (data.atm ? data.atm.withdrawalAmountToday || 0 : 0)
                  + (data.raast ? data.raast.successAmountToday || 0 : 0)
                  + (data.ibft ? data.ibft.successAmountToday || 0 : 0);
  const adcAmtY   = data.atm ? data.atm.withdrawalAmountYesterday : null;
  strip.appendChild(ovExecCard("Total ADC Amount", formatCurrency(adcAmtTdy),
    indicatorHTML(adcAmtTdy, adcAmtY, true), "vs Yesterday", "DAILY",
    fullValueTitle(adcAmtTdy, true)));

  /* 4. Active Cards */
  const activeTot = data.activeCards ? sumBy(data.activeCards, "count") : null;
  const activePrv = data.activeCards ? sumBy(data.activeCards, "prevMonth") : null;
  strip.appendChild(ovExecCard("Active Cards", formatNumber(activeTot, 0),
    indicatorHTML(activeTot, activePrv, true), "vs Last Month", "MONTHLY"));

  /* 5. Total Card Spend */
  const spend     = data.cardFinancials
    ? (data.cardFinancials.credit.spendCurrent || 0) + (data.cardFinancials.debit.spendCurrent || 0) : null;
  const spendPrv  = data.cardFinancials
    ? (data.cardFinancials.credit.spendPrevious || 0) + (data.cardFinancials.debit.spendPrevious || 0) : null;
  strip.appendChild(ovExecCard("Total Card Spend", formatCurrency(spend),
    indicatorHTML(spend, spendPrv, true), "vs Last Month", "MONTHLY",
    fullValueTitle(spend, true)));

  /* 6. Reconciliation Exposure > 30d */
  const exposure  = data.reconciliation
    ? sumBy(data.reconciliation.receivables, "amount") + sumBy(data.reconciliation.payables, "amount") : null;
  strip.appendChild(ovExecCard("Recon Exposure > 30d", formatCurrency(exposure),
    '<span class="indicator flat">\u2014</span>', "", "DAILY",
    fullValueTitle(exposure, true)));

  root.appendChild(strip);
}

function ovExecCard(label, value, indicHtml, vsLabel, freq, titleAttr) {
  const card = el("div", { class: "ov-kpi-card" });
  const valEl = el("div", { class: "ov-kpi-value", text: value });
  if (titleAttr) valEl.setAttribute("title", titleAttr);
  const compEl = el("div", { class: "ov-kpi-comparison" });
  compEl.innerHTML = indicHtml + (vsLabel ? '<span class="ov-kpi-vs"> ' + vsLabel + '</span>' : "");
  card.appendChild(el("div", { class: "ov-kpi-label", text: label }));
  card.appendChild(valEl);
  card.appendChild(compEl);
  card.appendChild(el("div", { class: "ov-kpi-freq", text: freq || "DAILY" }));
  return card;
}

/* ── Level 2: ADC Operations Summary ──────────────────────────────── */

function renderOvAdcSummary(root, data) {
  const section = el("div", { class: "ov-section" });
  section.appendChild(el("div", { class: "ov-section-heading", text: "ADC Operations Summary" }));

  if (!data.atm && !data.raast && !data.ibft) {
    section.appendChild(el("div", { class: "no-data-note", text: "No ADC data available." }));
    root.appendChild(section);
    return;
  }

  const rows = [];
  if (data.atm) {
    const a = data.atm;
    rows.push({ kpi: "ATM Withdrawals",   today: formatNumber(a.withdrawalCountToday, 0), mtd: formatNumber(a.withdrawalCountMTD, 0), change: indicatorHTML(a.withdrawalCountToday, a.withdrawalCountYesterday, true) });
    rows.push({ kpi: "ATM Disputes",      today: formatNumber(a.disputesToday, 0),         mtd: formatNumber(a.disputesMTD, 0),         change: indicatorHTML(a.disputesToday, a.disputesMTD > 0 ? a.disputesMTD / 30 : null, false) });
    rows.push({ kpi: "Cards Captured",    today: formatNumber(a.capturedCardsToday, 0),    mtd: formatNumber(a.capturedCardsMTD, 0),    change: "\u2014" });
  }
  if (data.raast) {
    const r = data.raast;
    rows.push({ kpi: "RAAST Transactions", today: formatNumber(r.successCountToday, 0), mtd: formatNumber(r.successCountMTD, 0), change: indicatorHTML(r.successRateToday, r.successRateMTD, true) });
  }
  if (data.ibft) {
    const i = data.ibft;
    rows.push({ kpi: "IBFT Transactions",  today: formatNumber(i.successCountToday, 0),  mtd: formatNumber(i.successCountMTD, 0),  change: indicatorHTML(i.successRateToday, i.successRateMTD, true) });
  }

  const wrap = el("div", { class: "ov-adc-table-wrap" });
  const table = el("table", { class: "ov-adc-table" });
  const thead = el("thead");
  const hr = el("tr");
  ["KPI", "Today", "MTD", "Change"].forEach(function (h, i) {
    hr.appendChild(el("th", { class: i > 0 ? "num" : "", text: h }));
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  rows.forEach(function (row) {
    const tr = el("tr");
    tr.appendChild(el("td", { text: row.kpi }));
    tr.appendChild(el("td", { class: "num", text: row.today }));
    tr.appendChild(el("td", { class: "num", text: row.mtd }));
    const changeTd = el("td", { class: "num" });
    changeTd.innerHTML = row.change;
    tr.appendChild(changeTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  section.appendChild(wrap);
  root.appendChild(section);
}

/* ── Level 3: Executive Visual Widgets ─────────────────────────────── */

function renderOvCharts(root, data) {
  const row = el("div", { class: "ov-charts-row" });
  row.appendChild(buildOvNostroChart(data));
  row.appendChild(buildOvSpendChart(data));
  row.appendChild(buildOvAgingChart(data));
  root.appendChild(row);
}

function ovChartCard(title, bodyEl) {
  const card = el("div", { class: "ov-chart-card" });
  card.appendChild(el("div", { class: "ov-chart-title", text: title }));
  card.appendChild(bodyEl);
  return card;
}

/* NOSTRO Position & Liquidity Buffer Widget (Replaces removed 7-Day trend chart) */
function buildOvNostroChart(data) {
  const body = el("div", { class: "ov-chart-body" });
  if (!data.nostro || !data.nostro.length) {
    body.appendChild(el("div", { class: "no-data-note", text: "No NOSTRO position data available." }));
    return ovChartCard("NOSTRO Position & Liquidity Buffer", body);
  }
  const items = data.nostro.map(function (n) {
    const statusCls = n.buffer >= 0 ? "ok" : "critical";
    const statusTxt = n.buffer >= 0 ? "Sufficient Buffer" : "Deficit Alert";
    return '<div class="nostro-card-item">'
      + '<div class="nostro-item-title"><strong>' + n.gl + '</strong> <span class="status-badge ' + statusCls + '">' + statusTxt + '</span></div>'
      + '<div class="nostro-item-row"><span>Balance:</span> <strong>' + formatCurrency(n.balance) + '</strong></div>'
      + '<div class="nostro-item-row"><span>Funding Req:</span> <span>' + formatCurrency(n.fundingRequirement) + '</span></div>'
      + '<div class="nostro-item-row"><span>Buffer Available:</span> <strong style="color:var(--brand-dark);">' + formatCurrency(n.buffer) + '</strong></div>'
      + '</div>';
  }).join("");
  body.innerHTML = '<div class="nostro-card-list">' + items + '</div>';
  return ovChartCard("NOSTRO Position & Liquidity Buffer", body);
}

/* Chart 2 — Card spend composition (stacked horizontal bar SVG) */
function buildOvSpendChart(data) {
  const body = el("div", { class: "ov-chart-body" });
  if (!data.cardFinancials) {
    body.appendChild(el("div", { class: "no-data-note", text: "No card financials data available." }));
    return ovChartCard("Card Spend Composition", body);
  }
  const debit  = data.cardFinancials.debit.spendCurrent  || 0;
  const credit = data.cardFinancials.credit.spendCurrent || 0;
  body.innerHTML = svgStackedBar(debit, credit);
  return ovChartCard("Card Spend \u2013 Current Month", body);
}

/* Chart 3 — Reconciliation aging composition (segmented bar SVG) */
function buildOvAgingChart(data) {
  const body = el("div", { class: "ov-chart-body" });
  const buckets = data.reconciliation && data.reconciliation.agingBuckets;
  if (!buckets || !buckets.length) {
    body.appendChild(el("div", { class: "no-data-note", text: "No reconciliation aging data available." }));
    return ovChartCard("Reconciliation Aging Composition", body);
  }
  const COLORS = { "Current": "#D0E5F3", "30+": "#90C4E4", "60+": "#6FAED2", "90+": "#117ABF", "120+": "#0D5F92" };
  /* 90+ and 120+ exceeding PKR 10 Mn are treated as alerts */
  const ALERT_THRESHOLD = 10000000;
  const mapped = buckets.map(function (b) {
    return {
      label:   b.bucket,
      amount:  Number(b.amount) || 0,
      color:   COLORS[b.bucket] || "#117ABF",
      isAlert: (b.bucket === "90+" || b.bucket === "120+") && Number(b.amount) >= ALERT_THRESHOLD
    };
  });
  body.innerHTML = svgAgingBar(mapped);
  return ovChartCard("Reconciliation Aging Composition", body);
}

/* ── SVG Chart Primitives ──────────────────────────────────────────── */

function svgLineChart(points, labels, chartId, ariaLabel) {
  var W = 340, H = 160, padL = 14, padR = 14, padT = 14, padB = 34;
  var cW = W - padL - padR, cH = H - padT - padB, n = points.length;
  var max = Math.max.apply(null, points), min = Math.min.apply(null, points);
  var range = (max - min) || 1;
  var yMin = min - range * 0.12, yRange = (max - yMin) || 1;
  var gradId = "ag_" + chartId;
  var xs = points.map(function (_, i) { return padL + (i / (n - 1)) * cW; });
  var ys = points.map(function (v) { return padT + cH - ((v - yMin) / yRange) * cH; });
  var linePts = xs.map(function (x, i) { return (i === 0 ? "M" : "L") + x.toFixed(1) + "," + ys[i].toFixed(1); }).join(" ");
  var areaPts = linePts + " L" + xs[n - 1].toFixed(1) + "," + (padT + cH) + " L" + padL.toFixed(1) + "," + (padT + cH) + " Z";
  var grids = [0.33, 0.67, 1.0].map(function (f) {
    var y = (padT + (1 - f) * cH).toFixed(1);
    return '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#E2E8F0" stroke-width="0.8" stroke-dasharray="3,3"/>';
  }).join("");
  var xlabels = xs.map(function (x, i) {
    if (n > 5 && i % 2 !== 0 && i !== n - 1) return "";
    return '<text x="' + x.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" font-weight="500" fill="#64748B">' + labels[i] + '</text>';
  }).join("");
  var dots = xs.map(function (x, i) {
    var valFmt = formatNumber(points[i]);
    var tooltipText = (labels[i] ? labels[i] + ": " : "") + valFmt + " txns";
    return '<circle cx="' + x.toFixed(1) + '" cy="' + ys[i].toFixed(1) + '" r="4" fill="#FFFFFF" stroke="#117ABF" stroke-width="2" class="chart-point-node"><title>' + tooltipText + '</title></circle>';
  }).join("");
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"'
    + ' role="img" aria-label="' + (ariaLabel || "Chart") + '" style="width:100%;max-height:160px;display:block;overflow:visible">'
    + '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0%" stop-color="#117ABF" stop-opacity="0.25"/>'
    + '<stop offset="100%" stop-color="#117ABF" stop-opacity="0.0"/></linearGradient></defs>'
    + grids
    + '<path d="' + areaPts + '" fill="url(#' + gradId + ')"/>'
    + '<path d="' + linePts + '" fill="none" stroke="#117ABF" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>'
    + dots
    + xlabels + '</svg>';
}

function svgStackedBar(debitVal, creditVal) {
  var total = (debitVal + creditVal) || 1;
  var W = 340, barH = 28, padX = 10, gapY = 12, legH = 18;
  var H = barH + gapY + legH * 2 + 4;
  var barW = W - 2 * padX;
  var dW = Math.max(2, (debitVal / total) * barW);
  var cX = padX + dW, cW = Math.max(2, barW - dW);
  var dPct = (debitVal / total * 100).toFixed(1), cPct = (creditVal / total * 100).toFixed(1);
  var ly1 = barH + gapY, ly2 = ly1 + legH;
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"'
    + ' role="img" aria-label="Card spend: Debit ' + formatCurrency(debitVal) + ' ' + dPct + '%, Credit ' + formatCurrency(creditVal) + ' ' + cPct + '%"'
    + ' style="width:100%;max-height:95px;display:block">'
    + '<rect x="' + padX + '" y="2" width="' + dW.toFixed(1) + '" height="' + (barH - 4) + '" fill="#117ABF" rx="4" class="chart-bar-seg"><title>Debit Card Spend: ' + formatCurrency(debitVal) + ' (' + dPct + '%)</title></rect>'
    + '<rect x="' + cX.toFixed(1) + '" y="2" width="' + cW.toFixed(1) + '" height="' + (barH - 4) + '" fill="#6FAED2" rx="4" class="chart-bar-seg"><title>Credit Card Spend: ' + formatCurrency(creditVal) + ' (' + cPct + '%)</title></rect>'
    /* Legend row 1 — Debit */
    + '<rect x="' + padX + '" y="' + ly1 + '" width="10" height="10" fill="#117ABF" rx="2"/>'
    + '<text x="' + (padX + 16) + '" y="' + (ly1 + 9) + '" font-size="11" fill="#334155" font-weight="600">Debit \u2014 ' + formatCurrency(debitVal) + ' (' + dPct + '%)</text>'
    /* Legend row 2 — Credit */
    + '<rect x="' + padX + '" y="' + ly2 + '" width="10" height="10" fill="#6FAED2" rx="2"/>'
    + '<text x="' + (padX + 16) + '" y="' + (ly2 + 9) + '" font-size="11" fill="#334155" font-weight="600">Credit \u2014 ' + formatCurrency(creditVal) + ' (' + cPct + '%)</text>'
    + '</svg>';
}

function svgAgingBar(buckets) {
  var total = buckets.reduce(function (s, b) { return s + b.amount; }, 0) || 1;
  var W = 340, barH = 26, padX = 10, gapY = 12, legItemH = 18;
  var H = barH + gapY + legItemH * buckets.length + 4;
  var barW = W - 2 * padX;
  var x = padX, rects = "";
  buckets.forEach(function (b) {
    var w = Math.max(2, (b.amount / total) * barW);
    var pct = (b.amount / total * 100).toFixed(1);
    rects += '<rect x="' + x.toFixed(1) + '" y="0" width="' + w.toFixed(1) + '" height="' + barH + '" fill="' + b.color + '" rx="2" class="chart-bar-seg"><title>' + b.label + ': ' + formatCurrency(b.amount) + ' (' + pct + '%)</title></rect>';
    x += w;
  });
  var legends = buckets.map(function (b, i) {
    var ly = barH + gapY + i * legItemH;
    var pct = (b.amount / total * 100).toFixed(1);
    var alertTxt = b.isAlert ? ' <tspan fill="#D97706" font-weight="700">\u25B2 Alert</tspan>' : "";
    return '<rect x="' + padX + '" y="' + ly + '" width="10" height="10" fill="' + b.color + '" rx="2"/>'
      + '<text x="' + (padX + 16) + '" y="' + (ly + 9) + '" font-size="11" fill="#0F172A" font-weight="600">' + b.label + '</text>'
      + '<text x="' + (padX + 70) + '" y="' + (ly + 9) + '" font-size="11" fill="#64748B">'
      + formatCurrency(b.amount) + ' (' + pct + '%)' + alertTxt + '</text>';
  }).join("");
  var ariaDesc = buckets.map(function (b) { return b.label + ": " + formatCurrency(b.amount); }).join(", ");
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"'
    + ' role="img" aria-label="Reconciliation aging: ' + ariaDesc + '" style="width:100%;display:block">'
    + rects + legends + '</svg>';
}

/* ── Level 4: Five Module Summary Panels ──────────────────────────── */

function renderOvModules(root, data) {
  root.appendChild(el("div", { class: "ov-section-heading", text: "Module Summaries" }));
  const grid = el("div", { class: "ov-modules-grid" });
  grid.appendChild(ovModuleCard("ADC Operations",     "adc-operations",      ovAdcRows(data)));
  grid.appendChild(ovModuleCard("Card Non-Financials","card-non-financials", ovCardNFRows(data)));
  grid.appendChild(ovModuleCard("Card Financials",    "card-financials",     ovCardFRows(data)));
  grid.appendChild(ovModuleCard("Chargeback",         "chargeback",          ovCbRows(data)));
  grid.appendChild(ovModuleCard("Reconciliation",     "reconciliation",      ovReconRows(data)));
  root.appendChild(grid);
}

/* Build one module panel. rows: array of [label, valueHTML, optionalCssClass] */
function ovModuleCard(title, page, rows) {
  const card = el("div", { class: "ov-module-card" });

  const hdr = el("div", { class: "ov-module-header" });
  hdr.appendChild(el("span", { class: "ov-module-title", text: title }));
  const btn = el("button", { class: "ov-view-details", type: "button", text: "View Details \u2192" });
  btn.addEventListener("click", function () { navigateToPage(page); });
  hdr.appendChild(btn);
  card.appendChild(hdr);

  if (!rows || rows.length === 0) {
    card.appendChild(el("div", { class: "no-data-note", text: "No data available." }));
    return card;
  }
  const rowsEl = el("div", { class: "ov-module-rows" });
  rows.forEach(function (r) {
    if (!r) return;
    const rowEl = el("div", { class: "ov-module-row" + (r[2] ? " " + r[2] : "") });
    const lblEl = el("span", { class: "ov-module-row-label", text: r[0] });
    const valEl = el("span", { class: "ov-module-row-value" });
    valEl.innerHTML = r[1];
    rowEl.appendChild(lblEl);
    rowEl.appendChild(valEl);
    rowsEl.appendChild(rowEl);
  });
  card.appendChild(rowsEl);
  return card;
}

function ovAdcRows(data) {
  if (!data.atm) return null;
  const a = data.atm;
  return [
    ["ATM Uptime",          formatPercentage(a.uptimeToday)],
    ["ATM Withdrawal Count",formatNumber(a.withdrawalCountToday)],
    ["ATM Withdrawal Amount",formatCurrency(a.withdrawalAmountToday)],
    ["RAAST Success Rate",  data.raast ? formatPercentage(data.raast.successRateToday)  : "N/A"],
    ["IBFT Success Rate",   data.ibft  ? formatPercentage(data.ibft.successRateToday)   : "N/A"]
  ];
}

function ovCardNFRows(data) {
  if (!data.cardInventory) return null;
  const inv = data.cardInventory.map(computeInventoryStatus);
  const lowest = inv.slice().sort(function (a, b) { return a.monthsCover - b.monthsCover; })[0];
  const stat = (data.cardStationery || []).map(computeStationeryStatus);
  const env  = stat.find(function (s) { return /envelope/i.test(s.item); });
  const mail = stat.find(function (s) { return /mailer/i.test(s.item) && !/pin/i.test(s.item); });
  return [
    ["Active Cards",           data.activeCards ? formatNumber(sumBy(data.activeCards, "count")) : "N/A"],
    ["Lowest Plastic Cover",   lowest ? lowest.monthsCover.toFixed(1) + " months" : "N/A"],
    ["Urgent Attention",       lowest ? statusBadge(lowest.status) + " " + lowest.category : "N/A"],
    ["Envelopes Cover",        env  ? env.monthsCover.toFixed(1)  + " months " + statusBadge(env.status)  : "N/A"],
    ["Mailers Cover",          mail ? mail.monthsCover.toFixed(1) + " months " + statusBadge(mail.status) : "N/A"]
  ];
}

function ovCardFRows(data) {
  if (!data.cardFinancials) return null;
  const c = data.cardFinancials.credit, d = data.cardFinancials.debit;
  return [
    ["Credit-Card Spend",  formatCurrency(c.spendCurrent)],
    ["Debit-Card Spend",   formatCurrency(d.spendCurrent)],
    ["Interchange Income", formatCurrency((c.domesticInterchange||0)+(c.intlInterchange||0)+(d.domesticInterchange||0)+(d.intlInterchange||0))],
    ["OIF Income",         formatCurrency((c.oifIncome||0)+(d.oifIncome||0))],
    ["MDR Income",         formatCurrency((c.mdrIncome||0)+(d.mdrIncome||0))]
  ];
}

function ovCbRows(data) {
  if (!data.chargeback) return null;
  const cb = data.chargeback;
  const tot = ["domestic","international"].reduce(function (s,k) { return s + (cb[k] ? cb[k].count||0 : 0); }, 0);
  const amt = ["domestic","international"].reduce(function (s,k) { return s + (cb[k] ? cb[k].amount||0 : 0); }, 0);
  return [
    ["Total Disputes",       formatNumber(tot)],
    ["Total Disputed Amount",formatCurrency(amt)],
    ["Pre-Arb Raised",       cb.preArbRaised   ? formatNumber(cb.preArbRaised.count)   : "N/A"],
    ["Pre-Arb Received",     cb.preArbReceived  ? formatNumber(cb.preArbReceived.count) : "N/A"],
    ["High-Aging Disputes",  cb.highAging       ? formatNumber(cb.highAging.count)      : "N/A"]
  ];
}

function ovReconRows(data) {
  if (!data.reconciliation) return null;
  const rec = data.reconciliation;
  return [
    ["Receivables > 30d",    formatCurrency(sumBy(rec.receivables, "amount"))],
    ["Payables > 30d",       formatCurrency(sumBy(rec.payables, "amount"))],
    ["Nostro Balance",       data.nostro ? formatCurrency(sumBy(data.nostro, "balance")) : "N/A"],
    ["Funding Requirement",  data.nostro ? formatCurrency(sumBy(data.nostro, "fundingRequirement")) : "N/A"],
    ["Available Buffer",     data.nostro ? formatCurrency(sumBy(data.nostro, "buffer")) : "N/A"]
  ];
}

function sumBy(arr, key) {
  return (arr || []).reduce(function (s, r) { return s + (Number(r[key]) || 0); }, 0);
}

/* ---------------------------------------------------------------------
   11. PAGE 2 — ADC OPERATIONS
   --------------------------------------------------------------------- */

function renderADCOperations(data) {
  const root = document.getElementById("adc-operations-body");
  root.innerHTML = "";

  root.appendChild(sectionTitle("ATM Operations"));
  if (data.atm) {
    const a = data.atm;
    const grid = el("div", { class: "kpi-grid" });
    grid.appendChild(kpiCard("Total ATMs", formatNumber(a.totalATMs)));
    grid.appendChild(kpiCard("ATM Uptime (Today)", formatPercentage(a.uptimeToday), calculateComparisons(a.uptimeToday, a.uptimeYesterday, true).html + " vs yesterday"));
    grid.appendChild(kpiCard("Withdrawal Count (Today)", formatNumber(a.withdrawalCountToday), calculateComparisons(a.withdrawalCountToday, a.withdrawalCountYesterday, true).html + " vs yesterday"));
    grid.appendChild(kpiCard("Withdrawal Count (MTD)", formatNumber(a.withdrawalCountMTD), calculateComparisons(a.withdrawalCountMTD, a.withdrawalCountPrevMTD, true).html + " vs prev. MTD"));
    grid.appendChild(kpiCard("Withdrawal Amount (Today)", formatCurrency(a.withdrawalAmountToday), calculateComparisons(a.withdrawalAmountToday, a.withdrawalAmountYesterday, true).html + " vs yesterday", fullValueTitle(a.withdrawalAmountToday, true)));
    grid.appendChild(kpiCard("Withdrawal Amount (MTD)", formatCurrency(a.withdrawalAmountMTD), calculateComparisons(a.withdrawalAmountMTD, a.withdrawalAmountPrevMTD, true).html + " vs prev. MTD", fullValueTitle(a.withdrawalAmountMTD, true)));
    grid.appendChild(kpiCard("Failed ATM Transactions (Today)", formatNumber(a.failedTxnToday), calculateComparisons(a.failedTxnToday, a.failedTxnYesterday, false).html + " vs yesterday"));
    grid.appendChild(kpiCard("ATM Disputes / Claims (MTD)", formatNumber(a.disputesMTD)));
    grid.appendChild(kpiCard("Cards Captured (MTD)", formatNumber(a.capturedCardsMTD)));
    grid.appendChild(kpiCard("Cash-Retract Transactions (MTD)", formatNumber(a.retractTxnMTD)));
    root.appendChild(grid);

    root.appendChild(sectionTitle("ATM Performance"));
    root.appendChild(buildTable("Top 5 Performing ATMs",
      [{ key: "rank", label: "Rank", numeric: true }, { key: "atmId", label: "ATM ID" }, { key: "location", label: "Location" },
       { key: "txnCount", label: "Txn Count", numeric: true }, { key: "successRate", label: "Success Rate", percent: true }, { key: "uptime", label: "Uptime", percent: true }],
      data.atmTop5Best));
    root.appendChild(buildTable("Top 5 Low-Performing ATMs",
      [{ key: "rank", label: "Rank", numeric: true }, { key: "atmId", label: "ATM ID" }, { key: "location", label: "Location" },
       { key: "txnCount", label: "Txn Count", numeric: true }, { key: "successRate", label: "Success Rate", percent: true }, { key: "uptime", label: "Uptime", percent: true }],
      data.atmBottom5));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "ATM sheet is missing. No data available for ATM Operations." }));
  }

  root.appendChild(sectionTitle("RAAST"));
  if (data.raast) {
    const r = data.raast;
    root.appendChild(buildTable(null,
      [{ key: "kpi", label: "KPI" }, { key: "today", label: "Today", numeric: true }, { key: "mtd", label: "MTD", numeric: true }, { key: "change", label: "Change" }],
      [
        { kpi: "Successful transaction count", today: r.successCountToday, mtd: r.successCountMTD, change: calculateComparisons(r.successCountMTD, r.successCountMTD * 0.9, true).html },
        { kpi: "Successful transaction amount (PKR)", today: r.successAmountToday, mtd: r.successAmountMTD, change: "\u2014" },
        { kpi: "Success rate (%)", today: r.successRateToday, mtd: r.successRateMTD, change: calculateComparisons(r.successRateToday, r.successRateMTD, true).html },
        { kpi: "Failed transaction count", today: r.failedCountToday, mtd: "\u2014", change: "\u2014" },
        { kpi: "Complaints", today: r.complaintsToday, mtd: r.complaintsMTD, change: "\u2014" }
      ]
    ));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "RAAST sheet is missing. No data available for RAAST." }));
  }

  root.appendChild(sectionTitle("IBFT"));
  if (data.ibft) {
    const i = data.ibft;
    root.appendChild(buildTable(null,
      [{ key: "kpi", label: "KPI" }, { key: "today", label: "Today", numeric: true }, { key: "mtd", label: "MTD", numeric: true }, { key: "change", label: "Change" }],
      [
        { kpi: "Successful transaction count", today: i.successCountToday, mtd: i.successCountMTD, change: "\u2014" },
        { kpi: "Successful transaction amount (PKR)", today: i.successAmountToday, mtd: i.successAmountMTD, change: "\u2014" },
        { kpi: "Success rate (%)", today: i.successRateToday, mtd: i.successRateMTD, change: calculateComparisons(i.successRateToday, i.successRateMTD, true).html },
        { kpi: "Failure count", today: i.failureCountToday, mtd: i.failureCountMTD, change: "\u2014" },
        { kpi: "Complaints", today: i.complaintsToday, mtd: i.complaintsMTD, change: "\u2014" }
      ]
    ));
    const totalMTD = sumBy(data.ibftFailures, "mtd") || 1;
    root.appendChild(buildTable("IBFT Failure Reasons",
      [{ key: "reason", label: "Failure Reason" }, { key: "today", label: "Today Count", numeric: true }, { key: "mtd", label: "MTD Count", numeric: true }, { key: "share", label: "Share %", percent: true }],
      (data.ibftFailures || []).map(function (f) { return { reason: f.reason, today: f.today, mtd: f.mtd, share: (f.mtd / totalMTD) * 100 }; })
    ));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "IBFT sheet is missing. No data available for IBFT." }));
  }
}

/* ---------------------------------------------------------------------
   12. PAGE 3 — CARD NON-FINANCIALS
   --------------------------------------------------------------------- */

function computeInventoryStatus(item) {
  const monthsCover = item.avgMonthlyUse ? item.qty / item.avgMonthlyUse : null;
  let status = "Sufficient";
  if (monthsCover !== null) {
    if (monthsCover <= CARD_INVENTORY_RULES.criticalMonths) status = "Critical";
    else if (monthsCover <= CARD_INVENTORY_RULES.warningMonths) status = "Warning";
  }
  return Object.assign({}, item, { monthsCover: monthsCover === null ? 0 : monthsCover, status: status });
}

function computeStationeryStatus(item) {
  const monthsCover = item.avgMonthlyUse ? item.qty / item.avgMonthlyUse : null;
  const status = monthsCover === null ? "Sufficient" : (monthsCover < STATIONERY_MIN_MONTHS ? "Critical" : (monthsCover < STATIONERY_MIN_MONTHS * 1.5 ? "Warning" : "Sufficient"));
  return Object.assign({}, item, { monthsCover: monthsCover === null ? 0 : monthsCover, status: status });
}

function renderCardNonFinancials(data) {
  const root = document.getElementById("card-non-financials-body");
  root.innerHTML = "";

  root.appendChild(sectionTitle("Card-Plastic Inventory"));
  if (data.cardInventory) {
    const rows = data.cardInventory.map(computeInventoryStatus);
    const urgent = rows.slice().sort(function (a, b) { return a.monthsCover - b.monthsCover; })[0];
    if (urgent) {
      root.appendChild(el("div", { class: "kpi-sub", html: "Requires urgent attention: <strong>" + urgent.category + "</strong> " + statusBadge(urgent.status) }));
    }
    const wrap = buildTable(null,
      [{ key: "category", label: "Plastic Category" }, { key: "qty", label: "Current Quantity", numeric: true },
       { key: "avgMonthlyUse", label: "Avg Monthly Consumption", numeric: true }, { key: "monthsCoverDisplay", label: "Months of Cover" },
       { key: "minStock", label: "Required Minimum Stock", numeric: true }, { key: "statusDisplay", label: "Status" }],
      rows.map(function (r) { return Object.assign({}, r, { monthsCoverDisplay: r.monthsCover.toFixed(1), statusDisplay: statusBadge(r.status) }); })
    );
    root.appendChild(wrap);
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "Card_Inventory sheet is missing. No data available for card-plastic inventory." }));
  }

  root.appendChild(sectionTitle("Card Stationery"));
  if (data.cardStationery) {
    const rows = data.cardStationery.map(computeStationeryStatus);
    const wrap = buildTable(null,
      [{ key: "item", label: "Item" }, { key: "qty", label: "Current Quantity", numeric: true },
       { key: "avgMonthlyUse", label: "Avg Monthly Usage", numeric: true }, { key: "monthsCoverDisplay", label: "Months of Cover" },
       { key: "minStock", label: "Minimum Requirement", numeric: true }, { key: "statusDisplay", label: "Status" }],
      rows.map(function (r) { return Object.assign({}, r, { monthsCoverDisplay: r.monthsCover.toFixed(1), statusDisplay: statusBadge(r.status) }); })
    );
    root.appendChild(wrap);
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "Card_Stationery sheet is missing. No data available for card stationery." }));
  }

  root.appendChild(sectionTitle("Cards in Force"));
  if (data.activeCards) {
    root.appendChild(buildTable(null,
      [{ key: "product", label: "Product" }, { key: "count", label: "Current Month", numeric: true },
       { key: "prevMonth", label: "Previous Month", numeric: true }, { key: "changeDisplay", label: "Change" },
       { key: "fee", label: "Annual Fee", currency: true }],
      data.activeCards.map(function (r) { return Object.assign({}, r, { changeDisplay: calculateComparisons(r.count, r.prevMonth, true).html }); })
    ));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "Active_Cards sheet is missing. No data available for cards in force." }));
  }
}

/* ---------------------------------------------------------------------
   13. PAGE 4 — CARD FINANCIALS
   --------------------------------------------------------------------- */

function financialsKPITable(f, isCredit) {
  const rows = [];
  if (isCredit) {
    rows.push({ kpi: "Credit-Card CIF", value: formatNumber(f.cif) });
    rows.push({ kpi: "Credit-Card AIF", value: formatNumber(f.aif) });
  }
  rows.push({ kpi: "Current-Month Spend", value: formatCurrency(f.spendCurrent) });
  rows.push({ kpi: "Previous-Month Spend", value: formatCurrency(f.spendPrevious) });
  rows.push({ kpi: "Month-on-Month Change", value: calculateComparisons(f.spendCurrent, f.spendPrevious, true).html });
  rows.push({ kpi: "Annual-Fee Income", value: formatCurrency(f.annualFeeIncome) });
  rows.push({ kpi: "Domestic Transaction Count", value: formatNumber(f.domesticTxnCount) });
  rows.push({ kpi: "Domestic Transaction Amount", value: formatCurrency(f.domesticTxnAmount) });
  rows.push({ kpi: "International Transaction Count", value: formatNumber(f.intlTxnCount) });
  rows.push({ kpi: "International Transaction Amount", value: formatCurrency(f.intlTxnAmount) });
  if (isCredit) rows.push({ kpi: "OIF Earned (International Txns)", value: formatCurrency(f.oifIncome) });
  else rows.push({ kpi: "OIF Income", value: formatCurrency(f.oifIncome) });
  rows.push({ kpi: "Domestic Interchange Income", value: formatCurrency(f.domesticInterchange) });
  rows.push({ kpi: "International Interchange Income", value: formatCurrency(f.intlInterchange) });
  if (f.mdrIncome) rows.push({ kpi: "MDR Income", value: formatCurrency(f.mdrIncome) });
  if (f.fxIncome) rows.push({ kpi: "FX Income", value: formatCurrency(f.fxIncome) });
  return rows;
}

function renderCardFinancials(data) {
  const root = document.getElementById("card-financials-body");
  root.innerHTML = "";

  if (!data.cardFinancials) {
    root.appendChild(el("div", { class: "no-data-note", text: "Card_Financials sheet is missing. No data available for Card Financials." }));
    return;
  }

  const cf = data.cardFinancials;
  const c = cf.credit || {};
  const d = cf.debit || {};

  /* Build ONE Comprehensive Management Financial Table */
  root.appendChild(sectionTitle("Comprehensive Card Financial Performance & Revenue Summary"));

  const compRows = [
    { item: "Credit Card Spend", current: c.spendCurrent, previous: c.spendPrevious },
    { item: "Debit Card Spend", current: d.spendCurrent, previous: d.spendPrevious },
    { item: "Total Card Spend", current: (c.spendCurrent || 0) + (d.spendCurrent || 0), previous: (c.spendPrevious || 0) + (d.spendPrevious || 0) },
    { item: "Interchange Income (Domestic)", current: (c.domesticInterchange || 0) + (d.domesticInterchange || 0), previous: data.revenueComposition ? (data.revenueComposition.find(function(r){ return r.item.indexOf("Domestic") !== -1; }) || {}).previous : null },
    { item: "Interchange Income (International)", current: (c.intlInterchange || 0) + (d.intlInterchange || 0), previous: data.revenueComposition ? (data.revenueComposition.find(function(r){ return r.item.indexOf("International") !== -1; }) || {}).previous : null },
    { item: "Annual Fee Income", current: (c.annualFeeIncome || 0) + (d.annualFeeIncome || 0), previous: data.revenueComposition ? (data.revenueComposition.find(function(r){ return r.item.indexOf("Annual") !== -1; }) || {}).previous : null },
    { item: "FX Income", current: (c.fxIncome || 0) + (d.fxIncome || 0), previous: data.revenueComposition ? (data.revenueComposition.find(function(r){ return r.item.indexOf("FX") !== -1; }) || {}).previous : null },
    { item: "OIF Income", current: (c.oifIncome || 0) + (d.oifIncome || 0), previous: data.revenueComposition ? (data.revenueComposition.find(function(r){ return r.item.indexOf("OIF") !== -1; }) || {}).previous : null },
    { item: "MDR Income", current: (c.mdrIncome || 0) + (d.mdrIncome || 0), previous: data.revenueComposition ? (data.revenueComposition.find(function(r){ return r.item.indexOf("MDR") !== -1; }) || {}).previous : null }
  ].map(function (row) {
    return {
      item: row.item,
      current: row.current,
      previous: row.previous,
      changeDisplay: calculateComparisons(row.current, row.previous, true).html
    };
  });

  root.appendChild(buildTable(null,
    [{ key: "item", label: "Financial Metric" }, { key: "current", label: "Current Period", currency: true },
     { key: "previous", label: "Previous Period", currency: true }, { key: "changeDisplay", label: "MoM Change" }],
    compRows
  ));

  if (data.netInterchange) {
    const grid = el("div", { class: "kpi-grid" });
    grid.appendChild(kpiCard("Total Interchange Income", formatCurrency(data.netInterchange.income)));
    grid.appendChild(kpiCard("Less: Interchange Expense", formatCurrency(data.netInterchange.expense)));
    grid.appendChild(kpiCard("Net Interchange Profit", formatCurrency(data.netInterchange.income - data.netInterchange.expense)));
    root.appendChild(grid);
  }

  /* Product-Specific Operational Details Tabs */
  root.appendChild(sectionTitle("Product Operational Metrics"));
  const tabs = el("div", { class: "subsection-tabs" });
  const creditBtn = el("button", { class: "subtab-btn active", type: "button", text: "Credit Cards" });
  const debitBtn = el("button", { class: "subtab-btn", type: "button", text: "Debit Cards" });
  tabs.appendChild(creditBtn); tabs.appendChild(debitBtn);
  root.appendChild(tabs);

  const creditPanel = el("div", { class: "subtab-panel active" });
  const wrapC = buildTable(null, [{ key: "kpi", label: "KPI" }, { key: "value", label: "Value" }], financialsKPITable(data.cardFinancials.credit, true));
  creditPanel.appendChild(wrapC);

  const debitPanel = el("div", { class: "subtab-panel" });
  const wrapD = buildTable(null, [{ key: "kpi", label: "KPI" }, { key: "value", label: "Value" }], financialsKPITable(data.cardFinancials.debit, false));
  debitPanel.appendChild(wrapD);

  root.appendChild(creditPanel);
  root.appendChild(debitPanel);

  creditBtn.addEventListener("click", function () {
    creditBtn.classList.add("active"); debitBtn.classList.remove("active");
    creditPanel.classList.add("active"); debitPanel.classList.remove("active");
  });
  debitBtn.addEventListener("click", function () {
    debitBtn.classList.add("active"); creditBtn.classList.remove("active");
    debitPanel.classList.add("active"); creditPanel.classList.remove("active");
  });

  root.appendChild(sectionTitle("Spend by Channel"));
  if (data.spendByChannel) {
    root.appendChild(buildTable(null,
      [{ key: "channel", label: "Channel" }, { key: "current", label: "Current Period", currency: true },
       { key: "previous", label: "Previous Period", currency: true }, { key: "changeDisplay", label: "MoM Change" }],
      data.spendByChannel.map(function (r) { return { channel: r.channel, current: r.current, previous: r.previous, changeDisplay: calculateComparisons(r.current, r.previous, true).html }; })
    ));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "Spend_By_Channel sheet is missing. No data available." }));
  }

  root.appendChild(sectionTitle("Top 5 Merchants by Spend"));
  root.appendChild(buildTable(null,
    [{ key: "rank", label: "Rank", numeric: true }, { key: "merchant", label: "Merchant" }, { key: "channel", label: "Channel" },
     { key: "txnCount", label: "Txn Count", numeric: true }, { key: "spend", label: "Spend", currency: true }, { key: "share", label: "Share %", percent: true }],
    data.topMerchants));

  root.appendChild(sectionTitle("SBP Cross-Border Monitoring (USD 30,000 threshold)"));
  if (data.sbpCrossBorder) {
    const grid = el("div", { class: "kpi-grid" });
    grid.appendChild(kpiCard("Customers Reaching Threshold (Current Period)", formatNumber(data.sbpCrossBorder.customerCountCurrent, 0)));
    grid.appendChild(kpiCard("Previous Period", formatNumber(data.sbpCrossBorder.customerCountPrevious, 0),
      calculateComparisons(data.sbpCrossBorder.customerCountCurrent, data.sbpCrossBorder.customerCountPrevious, false).html));
    root.appendChild(grid);
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "No data available for SBP cross-border monitoring." }));
  }
}

/* ---------------------------------------------------------------------
   14. PAGE 5 — CHARGEBACK
   --------------------------------------------------------------------- */

function renderChargeback(data) {
  const root = document.getElementById("chargeback-body");
  root.innerHTML = "";

  if (!data.chargeback) {
    root.appendChild(el("div", { class: "no-data-note", text: "Chargeback sheet is missing. No data available for Chargeback." }));
  } else {
    const cb = data.chargeback;
    function metricRow(label, m) {
      return {
        metric: label,
        currentCount: m ? m.count : null, currentAmount: m ? m.amount : null,
        prevCount: m ? m.prevCount : null, prevAmount: m ? m.prevAmount : null,
        changeDisplay: m ? calculateComparisons(m.count, m.prevCount, false).html : "N/A"
      };
    }
    const wrap = buildTable(null,
      [{ key: "metric", label: "Metric" }, { key: "currentCount", label: "Current Count", numeric: true }, { key: "currentAmount", label: "Current Amount", currency: true },
       { key: "prevCount", label: "Previous Count", numeric: true }, { key: "prevAmount", label: "Previous Amount", currency: true }, { key: "changeDisplay", label: "Change" }],
      [
        metricRow("Domestic Disputes", cb.domestic),
        metricRow("International Disputes", cb.international),
        metricRow("POS Disputes", cb.pos),
        metricRow("E-Commerce Disputes", cb.ecommerce),
        metricRow("Pre-Arbitration Raised", cb.preArbRaised),
        metricRow("Pre-Arbitration Received", cb.preArbReceived),
        metricRow("High-Aging Disputes", cb.highAging)
      ]
    );
    root.appendChild(wrap);
  }

  root.appendChild(sectionTitle("Top 5 Merchants by Dispute Count"));
  root.appendChild(buildTable(null,
    [{ key: "rank", label: "Rank", numeric: true }, { key: "merchant", label: "Merchant" }, { key: "disputeCount", label: "Dispute Count", numeric: true },
     { key: "disputedAmount", label: "Disputed Amount", currency: true }, { key: "share", label: "Share %", percent: true }],
    data.chargebackMerchantsByCount));

  root.appendChild(sectionTitle("Top 5 Merchants by Chargeback Amount"));
  root.appendChild(buildTable(null,
    [{ key: "rank", label: "Rank", numeric: true }, { key: "merchant", label: "Merchant" }, { key: "chargebackCount", label: "Chargeback Count", numeric: true },
     { key: "chargebackAmount", label: "Chargeback Amount", currency: true }, { key: "share", label: "Share %", percent: true }],
    data.chargebackMerchantsByAmount));

  root.appendChild(sectionTitle("Temporary-Credit GL Summary"));
  root.appendChild(buildTable(null,
    [{ key: "gl", label: "GL Number" }, { key: "txnCount", label: "Transaction Count", numeric: true }, { key: "amount", label: "Amount", currency: true }],
    data.chargebackGL, "No temporary-credit GL data available."));
}

/* ---------------------------------------------------------------------
   15. PAGE 6 — RECONCILIATION
   --------------------------------------------------------------------- */

function renderReconciliation(data) {
  const root = document.getElementById("reconciliation-body");
  root.innerHTML = "";

  root.appendChild(sectionTitle("Receivables Over 30 Days"));
  if (data.reconciliation && data.reconciliation.receivables) {
    root.appendChild(buildTable(null,
      [{ key: "gl", label: "GL Number" }, { key: "description", label: "GL Description" }, { key: "txnCount", label: "Transaction Count", numeric: true },
       { key: "amount", label: "Amount", currency: true }, { key: "bucket", label: "Aging Bucket" }],
      data.reconciliation.receivables));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "Reconciliation sheet is missing. No data available for receivables." }));
  }

  root.appendChild(sectionTitle("Payables Over 30 Days"));
  if (data.reconciliation && data.reconciliation.payables) {
    root.appendChild(buildTable(null,
      [{ key: "gl", label: "GL Number" }, { key: "description", label: "GL Description" }, { key: "txnCount", label: "Transaction Count", numeric: true },
       { key: "amount", label: "Amount", currency: true }, { key: "bucket", label: "Aging Bucket" }],
      data.reconciliation.payables));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "Reconciliation sheet is missing. No data available for payables." }));
  }

  root.appendChild(sectionTitle("Aging Buckets"));
  const agingSource = (data.reconciliation && data.reconciliation.agingBuckets)
    || (data.reconciliation && !data.reconciliation.agingBuckets ? deriveAgingBuckets(data.reconciliation) : null);
  if (agingSource) {
    const totalCount = sumBy(agingSource, "txnCount"), totalAmount = sumBy(agingSource, "amount");
    root.appendChild(buildTable(null,
      [{ key: "bucket", label: "Aging Bucket" }, { key: "txnCount", label: "Transaction Count", numeric: true },
       { key: "amount", label: "Amount", currency: true }, { key: "share", label: "Share %", percent: true }],
      agingSource.concat([{ bucket: "Total", txnCount: totalCount, amount: totalAmount, share: 100 }])));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "No data available for aging buckets." }));
  }

  root.appendChild(sectionTitle("Nostro Position"));
  root.appendChild(buildTable(null,
    [{ key: "gl", label: "Nostro GL" }, { key: "balance", label: "Nostro Balance", currency: true }, { key: "fundingRequirement", label: "Funding Requirement", currency: true },
     { key: "buffer", label: "Buffer Available", currency: true }, { key: "reportingDate", label: "Reporting Date" }],
    data.nostro, "Nostro sheet is missing. No data available for Nostro position."));

  root.appendChild(sectionTitle("Rejected Transactions and Reposting"));
  if (data.rejected) {
    const r = data.rejected;
    root.appendChild(buildTable(null,
      [{ key: "gl", label: "GL" }, { key: "rejectedCount", label: "Rejected Count", numeric: true }, { key: "rejectedAmount", label: "Rejected Amount", currency: true },
       { key: "repostedCount", label: "Reposted Count", numeric: true }, { key: "repostedAmount", label: "Reposted Amount", currency: true },
       { key: "pendingCount", label: "Pending Count", numeric: true }, { key: "pendingAmount", label: "Pending Amount", currency: true }],
      [r]));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "Rejected_Transactions sheet is missing. No data available." }));
  }

  root.appendChild(sectionTitle("OIF Monitoring"));
  if (data.oif) {
    const grid = el("div", { class: "kpi-grid" });
    grid.appendChild(kpiCard("OIF Case Count (Current Period)", formatNumber(data.oif.caseCountCurrent),
      calculateComparisons(data.oif.caseCountCurrent, data.oif.caseCountPrevious, false).html + " vs previous period"));
    grid.appendChild(kpiCard("OIF Value (Current Period)", formatCurrency(data.oif.valueCurrent),
      calculateComparisons(data.oif.valueCurrent, data.oif.valuePrevious, false).html + " vs previous period"));
    root.appendChild(grid);
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "No data available for OIF monitoring." }));
  }
}

function deriveAgingBuckets(rec) {
  const buckets = {};
  (rec.receivables || []).concat(rec.payables || []).forEach(function (r) {
    const b = r.bucket || "Current";
    if (!buckets[b]) buckets[b] = { bucket: b, txnCount: 0, amount: 0 };
    buckets[b].txnCount += Number(r.txnCount) || 0;
    buckets[b].amount += Number(r.amount) || 0;
  });
  const arr = Object.keys(buckets).map(function (k) { return buckets[k]; });
  const total = sumBy(arr, "amount") || 1;
  arr.forEach(function (b) { b.share = (b.amount / total) * 100; });
  return arr.length ? arr : null;
}

/* ---------------------------------------------------------------------
   16. INITIALIZATION
   --------------------------------------------------------------------- */

function cacheDom() {
  dom.dataStatus = document.getElementById("dataStatus");
  dom.loadedFileName = document.getElementById("loadedFileName");
  dom.lastRefreshed = document.getElementById("lastRefreshed");
  dom.globalMessage = document.getElementById("globalMessage");
  dom.btnLoadExcel = document.getElementById("btnLoadExcel");
  dom.fileInput = document.getElementById("fileInput");
  dom.btnRefresh = document.getElementById("btnRefresh");
  dom.btnReset = document.getElementById("btnReset");
  dom.sideNav = document.getElementById("sideNav");
  dom.filterReportingDate = document.getElementById("filterReportingDate");
  dom.filterReportingMonth = document.getElementById("filterReportingMonth");
  dom.filterPeriod = document.getElementById("filterPeriod");
  dom.filterCreditDebit = document.getElementById("filterCreditDebit");
  dom.filterDomIntl = document.getElementById("filterDomIntl");
  dom.filterIssAcq = document.getElementById("filterIssAcq");
}

function bindEvents() {
  dom.btnLoadExcel.addEventListener("click", function () { dom.fileInput.click(); });
  dom.fileInput.addEventListener("change", function (e) {
    if (e.target.files && e.target.files[0]) loadWorkbook(e.target.files[0]);
    e.target.value = "";
  });
  dom.btnRefresh.addEventListener("click", function () {
    appState.lastUpdated = new Date();
    updateHeaderStatus();
    renderActivePage();
    showMessage("Dashboard refreshed.", "success");
  });
  dom.btnReset.addEventListener("click", function () {
    appState.rawWorkbook = null;
    appState.processedData = null;
    appState.selectedFile = null;
    appState.lastUpdated = null;
    updateHeaderStatus();
    renderActivePage();
    showMessage("Data reset to illustrative values.", "info");
  });

  dom.sideNav.addEventListener("click", function (e) {
    const btn = e.target.closest(".nav-item");
    if (btn) navigateToPage(btn.getAttribute("data-page"));
  });

  [dom.filterReportingDate, dom.filterReportingMonth, dom.filterPeriod, dom.filterCreditDebit, dom.filterDomIntl, dom.filterIssAcq]
    .forEach(function (input) { input.addEventListener("change", applyFilters); });

  window.addEventListener("hashchange", handleHashChange);
}

function init() {
  cacheDom();
  bindEvents();
  updateHeaderStatus();
  if (!window.location.hash) window.location.hash = "#overview";
  handleHashChange();
  if (typeof XLSX === "undefined") {
    showMessage("Note: js/xlsx.min.js was not found, so only CSV files can be loaded until the library is added. See README.txt.", "info");
  }
}

document.addEventListener("DOMContentLoaded", init);
