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
  txnAmount: ["txn amount", "transaction amount", "value", "amount", "volume"],
  complaintCount: ["complaint count", "complaints"],
  capturedCards: ["captured cards", "card captures", "cards captured"],
  gl: ["gl", "gl no", "gl number"],
  mom: ["mom", "month on month", "monthly change"],
  today: ["today", "current day"],
  yesterday: ["yesterday", "previous day"],
  mtd: ["mtd", "month to date"],
  prevMtd: ["previous mtd", "prev mtd", "pmtd"],
  currentMonth: ["current month", "this month"],
  previousMonth: ["previous month", "last month"],
  enr: ["enr", "ending net receivables", "earning net revenue"],
  mcc: ["mcc", "merchant category code", "category code"]
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

let cardFinancialsActiveTab = "credit"; // "credit" | "debit" (NO "all")
let chargebackActiveTab = "credit";       // "credit" | "debit" (NO "all")

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
  if (abs >= 1e9) return (n / 1e9).toFixed(decimals !== undefined ? decimals : 2) + " Bn";
  if (abs >= 1e6) return (n / 1e6).toFixed(decimals !== undefined ? decimals : 2) + " Mn";
  return n.toLocaleString("en-US", { maximumFractionDigits: d });
}

function formatCurrency(value, currency) {
  if (value === null || value === undefined || isNaN(value)) return "N/A";
  const cur = currency || "PKR";
  const n = Number(value);
  const abs = Math.abs(n);
  let short;
  if (abs >= 1e9) short = (n / 1e9).toFixed(2) + " Bn";
  else if (abs >= 1e6) short = (n / 1e6).toFixed(2) + " Mn";
  else short = cur + " " + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
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
function indicatorHTML(current, previous, higherIsBetter, isMoM) {
  if (previous === null || previous === undefined || previous === 0 || isNaN(previous)) {
    return '<span class="indicator flat">&mdash;</span>N/A';
  }
  if (current === null || current === undefined || isNaN(current)) {
    return '<span class="indicator flat">&mdash;</span>N/A';
  }
  const change = current - previous;
  const pct = (change / Math.abs(previous)) * 100;
  const better = higherIsBetter === undefined ? true : higherIsBetter;
  const labelSuffix = isMoM ? " MoM" : "";
  if (Math.abs(change) < 1e-9) {
    return '<span class="indicator flat">&mdash;</span>0.00%' + labelSuffix;
  }
  const isUp = change > 0;
  const goodDirection = isUp ? better : !better;
  const cls = (isUp ? "up" : "down") + " " + (goodDirection ? "positive" : "negative");
  const arrow = isUp ? "&#9650;" : "&#9660;";
  const sign = isUp ? "+" : "-";
  return '<span class="indicator ' + cls + '">' + arrow + '</span>' + sign + Math.abs(pct).toFixed(2) + "%" + labelSuffix;
}

/* Specific helper for ATM Uptime Today vs Yesterday actuals + visual diff */
function formatUptimeComparison(today, yesterday) {
  if (today === null || today === undefined || isNaN(today)) {
    return { todayStr: "N/A", yesterdayStr: "N/A", html: '<span class="indicator flat">&mdash;</span>' };
  }
  const tStr = Number(today).toFixed(1) + "%";
  if (yesterday === null || yesterday === undefined || isNaN(yesterday)) {
    return { todayStr: tStr, yesterdayStr: "N/A", html: '<span class="indicator flat">&mdash;</span>' };
  }
  const yStr = Number(yesterday).toFixed(1) + "%";
  const diff = today - yesterday;
  const isUp = diff > 0;
  const isFlat = Math.abs(diff) < 0.01;
  if (isFlat) {
    return { todayStr: tStr, yesterdayStr: yStr, html: '<span class="indicator flat">&mdash; 0.0%</span>' };
  }
  const cls = (isUp ? "up" : "down") + " " + (isUp ? "positive" : "negative");
  const arrow = isUp ? "&#9650;" : "&#9660;";
  const sign = isUp ? "+" : "-";
  const diffStr = sign + Math.abs(diff).toFixed(1) + "%";
  const html = '<span class="indicator ' + cls + '">' + arrow + ' ' + diffStr + '</span>';
  return { todayStr: tStr, yesterdayStr: yStr, html: html };
}

/* Returns { change, changePct, indicatorHTML } for use in KPI cards */
function calculateComparisons(current, previous, higherIsBetter, isMoM) {
  const hasPrev = previous !== null && previous !== undefined && !isNaN(previous) && previous !== 0;
  const change = hasPrev ? current - previous : null;
  const changePct = hasPrev ? (change / Math.abs(previous)) * 100 : null;
  return {
    change: change,
    changePct: changePct,
    html: indicatorHTML(current, previous, higherIsBetter, isMoM)
  };
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

/* Renders a data table from column defs + rows into a wrapper div. */
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
      successCountToday: 41200, successCountYesterday: 39500, successCountMTD: 895000,
      successAmountToday: 1980000000, successAmountYesterday: 1880000000, successAmountMTD: 41200000000,
      successRateToday: 98.6, successRateYesterday: 98.1, successRateMTD: 98.2,
      failedCountToday: 590, failedCountYesterday: 640, failedCountMTD: 12800,
      complaintsToday: 14, complaintsYesterday: 18, complaintsMTD: 210
    },
    ibft: {
      successCountToday: 27800, successCountYesterday: 26400, successCountMTD: 601000,
      successAmountToday: 3120000000, successAmountYesterday: 2950000000, successAmountMTD: 66800000000,
      successRateToday: 97.9, successRateYesterday: 97.4, successRateMTD: 97.5,
      failureCountToday: 620, failureCountYesterday: 680, failureCountMTD: 11800,
      complaintsToday: 9, complaintsYesterday: 12, complaintsMTD: 158
    },
    ibftFailures: [
      { reason: "Beneficiary invalid", today: 180, yesterday: 195, mtd: 3550 },
      { reason: "Timeout", today: 150, yesterday: 162, mtd: 2890 },
      { reason: "Insufficient funds", today: 140, yesterday: 132, mtd: 2650 },
      { reason: "Core banking issue", today: 90, yesterday: 105, mtd: 1620 },
      { reason: "Network error", today: 60, yesterday: 68, mtd: 1090 }
    ],

    /* Card Non-Financials: explicit "Card" terminology (Rule 3) & preserved Personalized Ready Stock Card (Rule 4) */
    cardInventory: [
      { category: "Blank Debit Card", qty: 82000, avgMonthlyUse: 9500, minStock: 30000 },
      { category: "Blank Credit Card", qty: 21000, avgMonthlyUse: 4200, minStock: 12000 },
      { category: "Personalized Ready Stock Card", qty: 15500, avgMonthlyUse: 6100, minStock: 15000 },
      { category: "Debit Classic Card", qty: 40000, avgMonthlyUse: 7000, minStock: 18000 },
      { category: "Debit Gold Card", qty: 18000, avgMonthlyUse: 3100, minStock: 9000 },
      { category: "Debit Platinum Card", qty: 9200, avgMonthlyUse: 2600, minStock: 8000 },
      { category: "Credit Classic Card", qty: 12600, avgMonthlyUse: 2900, minStock: 9000 },
      { category: "Credit Gold Card", qty: 7100, avgMonthlyUse: 1800, minStock: 6000 },
      { category: "Credit Platinum Card", qty: 3200, avgMonthlyUse: 1450, minStock: 4500 },
      { category: "World Elite Card", qty: 640, avgMonthlyUse: 260, minStock: 800 }
    ],
    cardStationery: [
      { item: "Envelopes", qty: 96000, avgMonthlyUse: 21000, minStock: 63000 },
      { item: "Mailers", qty: 41000, avgMonthlyUse: 19500, minStock: 58500 },
      { item: "PIN mailers", qty: 88000, avgMonthlyUse: 20500, minStock: 61500 },
      { item: "Welcome packs", qty: 26000, avgMonthlyUse: 8600, minStock: 25800 }
    ],
    activeCards: [
      { product: "Debit Classic Card", count: 612000, prevMonth: 601500, fee: 0 },
      { product: "Debit Gold Card", count: 188000, prevMonth: 184200, fee: 1500 },
      { product: "Debit Platinum Card", count: 63500, prevMonth: 61900, fee: 3500 },
      { product: "Credit Classic Card", count: 94000, prevMonth: 92100, fee: 2500 },
      { product: "Credit Gold Card", count: 41200, prevMonth: 40100, fee: 6000 },
      { product: "Credit Platinum Card", count: 15800, prevMonth: 15200, fee: 12000 },
      { product: "World Elite Card", count: 2650, prevMonth: 2500, fee: 35000 }
    ],

    /* Card Financials data with full Current and Previous Month fields (No FX Income) */
    cardFinancials: {
      credit: {
        cif: 148600, cifPrevious: 142000,
        aif: 115200, aifPrevious: 111000,
        spendCurrent: 24600000000, spendPrevious: 23100000000,
        annualFeeIncome: 410000000, annualFeeIncomePrevious: 395000000,
        domesticTxnCount: 1850000, domesticTxnCountPrevious: 1780000,
        domesticTxnAmount: 19800000000, domesticTxnAmountPrevious: 18600000000,
        intlTxnCount: 96000, intlTxnCountPrevious: 91000,
        intlTxnAmount: 4800000000, intlTxnAmountPrevious: 4500000000,
        oifIncome: 62000000, oifIncomePrevious: 57000000,
        domesticInterchange: 288000000, domesticInterchangePrevious: 275000000,
        intlInterchange: 94000000, intlInterchangePrevious: 89000000,
        mdrIncome: 145000000, mdrIncomePrevious: 139000000,
        enr: 12500000000, enrPrevious: 11800000000
      },
      debit: {
        spendCurrent: 41200000000, spendPrevious: 39500000000,
        annualFeeIncome: 320000000, annualFeeIncomePrevious: 305000000,
        domesticTxnCount: 5250000, domesticTxnCountPrevious: 5010000,
        domesticTxnAmount: 38100000000, domesticTxnAmountPrevious: 36500000000,
        intlTxnCount: 61000, intlTxnCountPrevious: 58000,
        intlTxnAmount: 3100000000, intlTxnAmountPrevious: 3000000000,
        domesticInterchange: 198000000, domesticInterchangePrevious: 187000000,
        intlInterchange: 52000000, intlInterchangePrevious: 49000000,
        oifIncome: 28000000, oifIncomePrevious: 26000000,
        mdrIncome: 0, mdrIncomePrevious: 0,
        enr: null, enrPrevious: null
      }
    },
    spendByProduct: [
      { product: "Debit Card", currentBn: 41.2, previousBn: 39.5 },
      { product: "Credit Card", currentBn: 24.6, previousBn: 23.1 }
    ],
    spendByChannel: [
      { channel: "E-Commerce", current: 18600000000, previous: 17100000000 },
      { channel: "ATM", current: 17650000000, previous: 16920000000 },
      { channel: "POS", current: 29550000000, previous: 28580000000 }
    ],
    /* Merchant tables using MCC instead of Channel (Rule 2) */
    topMerchants: [
      { rank: 1, merchant: "Merchant Group A", mcc: "5411", txnCount: 92000, spend: 2100000000, share: 8.1 },
      { rank: 2, merchant: "Merchant Group B", mcc: "5812", txnCount: 78500, spend: 1850000000, share: 7.1 },
      { rank: 3, merchant: "Merchant Group C", mcc: "4722", txnCount: 65200, spend: 1520000000, share: 5.8 },
      { rank: 4, merchant: "Merchant Group D", mcc: "5311", txnCount: 54000, spend: 1210000000, share: 4.6 },
      { rank: 5, merchant: "Merchant Group E", mcc: "5541", txnCount: 48900, spend: 980000000, share: 3.8 }
    ],
    revenueComposition: [
      { item: "Interchange Income (Domestic)", current: 486000000, previous: 462000000 },
      { item: "Interchange Income (International)", current: 146000000, previous: 138000000 },
      { item: "Annual Fees", current: 730000000, previous: 715000000 },
      { item: "OIF Income", current: 90000000, previous: 83000000 },
      { item: "MDR Income", current: 145000000, previous: 139000000 }
    ],
    netInterchange: { income: 632000000, expense: 210000000 },
    sbpCrossBorder: { customerCountCurrent: 186, customerCountPrevious: 171 },

    /* Chargeback broken down by Credit vs Debit cards (Rule 13) */
    chargeback: {
      credit: {
        domestic: { count: 820, amount: 58000000, prevCount: 780, prevAmount: 54000000 },
        international: { count: 290, amount: 32000000, prevCount: 310, prevAmount: 34000000 },
        pos: { count: 420, amount: 35000000, prevCount: 400, prevAmount: 33000000 },
        ecommerce: { count: 690, amount: 55000000, prevCount: 690, prevAmount: 55000000 },
        preArbRaised: { count: 62, amount: 7800000, prevCount: 56, prevAmount: 7100000 },
        preArbReceived: { count: 42, amount: 5200000, prevCount: 45, prevAmount: 5600000 },
        highAging: { count: 32, amount: 5900000, prevCount: 36, prevAmount: 6400000 }
      },
      debit: {
        domestic: { count: 420, amount: 28000000, prevCount: 400, prevAmount: 27500000 },
        international: { count: 90, amount: 9000000, prevCount: 100, prevAmount: 10200000 },
        pos: { count: 270, amount: 17000000, prevCount: 255, prevAmount: 16800000 },
        ecommerce: { count: 240, amount: 20000000, prevCount: 245, prevAmount: 20800000 },
        preArbRaised: { count: 20, amount: 2000000, prevCount: 20, prevAmount: 2000000 },
        preArbReceived: { count: 16, amount: 1700000, prevCount: 18, prevAmount: 1800000 },
        highAging: { count: 15, amount: 2200000, prevCount: 16, prevAmount: 2500000 }
      }
    },
    chargebackMerchantsByCount: [
      { rank: 1, merchant: "Merchant Group F", mcc: "5999", disputeCount: 145, disputedAmount: 12100000, share: 9.2 },
      { rank: 2, merchant: "Merchant Group G", mcc: "5812", disputeCount: 118, disputedAmount: 10200000, share: 7.5 },
      { rank: 3, merchant: "Merchant Group H", mcc: "5411", disputeCount: 96, disputedAmount: 8600000, share: 6.1 },
      { rank: 4, merchant: "Merchant Group I", mcc: "4722", disputeCount: 84, disputedAmount: 7400000, share: 5.3 },
      { rank: 5, merchant: "Merchant Group J", mcc: "5311", disputeCount: 71, disputedAmount: 6300000, share: 4.5 }
    ],
    chargebackMerchantsByAmount: [
      { rank: 1, merchant: "Merchant Group F", mcc: "5999", chargebackCount: 145, chargebackAmount: 12100000, share: 9.2 },
      { rank: 2, merchant: "Merchant Group K", mcc: "5541", chargebackCount: 62, chargebackAmount: 11400000, share: 8.6 },
      { rank: 3, merchant: "Merchant Group G", mcc: "5812", chargebackCount: 118, chargebackAmount: 10200000, share: 7.5 },
      { rank: 4, merchant: "Merchant Group H", mcc: "5411", chargebackCount: 96, chargebackAmount: 8600000, share: 6.1 },
      { rank: 5, merchant: "Merchant Group L", mcc: "5732", chargebackCount: 54, chargebackAmount: 7900000, share: 5.9 }
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
      { currency: "USD", gl: "NOSTRO-USD-01", balance: 18600000, reportingDate: "" },
      { currency: "AED", gl: "NOSTRO-AED-01", balance: 6200000, reportingDate: "" }
    ],
    rejected: {
      gl: "GL-60010", rejectedCount: 62, rejectedAmount: 8900000,
      repostedCount: 48, repostedAmount: 6800000,
      pendingCount: 14, pendingAmount: 2100000
    },
    oif: { caseCountCurrent: 96, valueCurrent: 62000000, caseCountPrevious: 88, valuePrevious: 55500000 }
  };
}

/* ---------------------------------------------------------------------
   5. EXCEL / CSV PARSING
   --------------------------------------------------------------------- */

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/* Resolves a normalized column key from a raw row object using COLUMN_ALIASES */
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
  const cleaned = String(v).replace(/[,%\s]/g, "").replace(/^PKR|USD|AED/i, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

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

function extractRawSheets(workbookOrRows, isCSV) {
  const rawSheets = {};
  const missingSheets = [];
  if (isCSV) {
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

function normalizeWorkbookData(rawSheets, missingSheets) {
  const data = { meta: { missingSheets: missingSheets, dataQualityMessages: [], source: "excel" } };

  function num(row, key, direct) { return toNumber(getAliasedValue(row, key, direct)); }

  if (rawSheets["ATM"] && rawSheets["ATM"].length) {
    const r = rawSheets["ATM"][0] || {};
    data.atm = {
      totalATMs: num(r, "totalATMs", ["Total ATMs"]),
      uptimeToday: num(r, "uptimeToday", ["Uptime Today", "ATM Uptime"]),
      uptimeYesterday: num(r, "uptimeYesterday", ["Uptime Yesterday"]),
      withdrawalCountToday: num(r, "today", ["Withdrawal Count Today", "Withdrawal Count"]),
      withdrawalCountYesterday: num(r, "yesterday", ["Withdrawal Count Yesterday"]),
      withdrawalCountMTD: num(r, "mtd", ["Withdrawal Count MTD"]),
      withdrawalCountPrevMTD: num(r, "prevMtd", ["Withdrawal Count Previous MTD"]),
      withdrawalAmountToday: num(r, "txnAmount", ["Withdrawal Amount Today", "Withdrawal Amount"]),
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
      successCountYesterday: num(r, "yesterday", ["Successful Transaction Count Yesterday"]),
      successAmountToday: num(r, null, ["Successful Transaction Amount Today"]),
      successAmountYesterday: num(r, null, ["Successful Transaction Amount Yesterday"]),
      successCountMTD: num(r, "mtd", ["Successful Transaction Count MTD"]),
      successAmountMTD: num(r, null, ["Successful Transaction Amount MTD"]),
      successCountPrevMTD: num(r, "prevMtd", ["Successful Transaction Count Previous MTD"]),
      successAmountPrevMTD: num(r, null, ["Successful Transaction Amount Previous MTD"]),
      successRateToday: num(r, null, ["Success Rate Today"]),
      successRateYesterday: num(r, null, ["Success Rate Yesterday"]),
      successRateMTD: num(r, null, ["Success Rate MTD"]),
      failedCountToday: num(r, null, ["Failed Transaction Count Today"]),
      failedCountYesterday: num(r, null, ["Failed Transaction Count Yesterday"]),
      failedCountMTD: num(r, null, ["Failed Transaction Count MTD"]),
      complaintsToday: num(r, "complaintCount", ["Complaints Today"]),
      complaintsYesterday: num(r, null, ["Complaints Yesterday"]),
      complaintsMTD: num(r, null, ["Complaints MTD"])
    };
  }

  if (rawSheets["IBFT"] && rawSheets["IBFT"].length) {
    const r = rawSheets["IBFT"][0] || {};
    data.ibft = {
      successCountToday: num(r, "today", ["Successful Transaction Count Today"]),
      successCountYesterday: num(r, "yesterday", ["Successful Transaction Count Yesterday"]),
      successAmountToday: num(r, null, ["Successful Transaction Amount Today"]),
      successAmountYesterday: num(r, null, ["Successful Transaction Amount Yesterday"]),
      successCountMTD: num(r, "mtd", ["Successful Transaction Count MTD"]),
      successAmountMTD: num(r, null, ["Successful Transaction Amount MTD"]),
      successCountPrevMTD: num(r, "prevMtd", ["Successful Transaction Count Previous MTD"]),
      successAmountPrevMTD: num(r, null, ["Successful Transaction Amount Previous MTD"]),
      successRateToday: num(r, null, ["Success Rate Today"]),
      successRateYesterday: num(r, null, ["Success Rate Yesterday"]),
      successRateMTD: num(r, null, ["Success Rate MTD"]),
      failureCountToday: num(r, null, ["Failure Count Today"]),
      failureCountYesterday: num(r, null, ["Failure Count Yesterday"]),
      failureCountMTD: num(r, null, ["Failure Count MTD"]),
      complaintsToday: num(r, "complaintCount", ["Complaints Today"]),
      complaintsYesterday: num(r, null, ["Complaints Yesterday"]),
      complaintsMTD: num(r, null, ["Complaints MTD"])
    };
  }
  if (rawSheets["IBFT_Failures"] && rawSheets["IBFT_Failures"].length) {
    data.ibftFailures = rawSheets["IBFT_Failures"].map(function (row) {
      return {
        reason: getAliasedValue(row, null, ["Failure Reason"]) || "Other",
        today: num(row, null, ["Today Count"]),
        yesterday: num(row, null, ["Yesterday Count"]),
        mtd: num(row, null, ["MTD Count"])
      };
    });
  }

  if (rawSheets["Card_Inventory"] && rawSheets["Card_Inventory"].length) {
    data.cardInventory = rawSheets["Card_Inventory"].map(function (row) {
      let rawCat = getAliasedValue(row, null, ["Plastic Category", "Category"]) || "Other";
      if (rawCat.indexOf("Card") === -1 && !/envelope|mailer|pack/i.test(rawCat)) {
        rawCat = rawCat + " Card";
      }
      return {
        category: rawCat,
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
      let rawProd = getAliasedValue(row, null, ["Product"]) || "Other";
      if (rawProd.indexOf("Card") === -1) rawProd = rawProd + " Card";
      return {
        product: rawProd,
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
        cifPrevious: num(r, null, ["Credit Card CIF Previous", "CIF Previous"]),
        aif: num(r, null, ["Credit Card AIF", "AIF"]),
        aifPrevious: num(r, null, ["Credit Card AIF Previous", "AIF Previous"]),
        spendCurrent: num(r, "currentMonth", ["Current Month Spend", "Spend Current"]),
        spendPrevious: num(r, "previousMonth", ["Previous Month Spend", "Spend Previous"]),
        annualFeeIncome: num(r, null, ["Annual Fee Income"]),
        annualFeeIncomePrevious: num(r, null, ["Annual Fee Income Previous"]),
        domesticTxnCount: num(r, null, ["Domestic Transaction Count"]),
        domesticTxnCountPrevious: num(r, null, ["Domestic Transaction Count Previous"]),
        domesticTxnAmount: num(r, null, ["Domestic Transaction Amount"]),
        domesticTxnAmountPrevious: num(r, null, ["Domestic Transaction Amount Previous"]),
        intlTxnCount: num(r, null, ["International Transaction Count"]),
        intlTxnCountPrevious: num(r, null, ["International Transaction Count Previous"]),
        intlTxnAmount: num(r, null, ["International Transaction Amount"]),
        intlTxnAmountPrevious: num(r, null, ["International Transaction Amount Previous"]),
        oifIncome: num(r, null, ["OIF Income", "OIF Earned"]),
        oifIncomePrevious: num(r, null, ["OIF Income Previous"]),
        domesticInterchange: num(r, null, ["Domestic Interchange Income"]),
        domesticInterchangePrevious: num(r, null, ["Domestic Interchange Income Previous"]),
        intlInterchange: num(r, null, ["International Interchange Income"]),
        intlInterchangePrevious: num(r, null, ["International Interchange Income Previous"]),
        mdrIncome: num(r, null, ["MDR Income"]),
        mdrIncomePrevious: num(r, null, ["MDR Income Previous"]),
        enr: num(r, "enr", ["ENR", "Ending Net Receivables", "Earning Net Revenue"]),
        enrPrevious: num(r, null, ["ENR Previous", "Ending Net Receivables Previous"])
      };
    }
    data.cardFinancials = { credit: buildFin(creditRow), debit: buildFin(debitRow) };
  }
  if (rawSheets["Spend_By_Product"] && rawSheets["Spend_By_Product"].length) {
    data.spendByProduct = rawSheets["Spend_By_Product"].map(function (row) {
      let rawP = getAliasedValue(row, null, ["Product"]) || "Other";
      if (rawP.indexOf("Card") === -1) rawP = rawP + " Card";
      return {
        product: rawP,
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
        mcc: getAliasedValue(row, "mcc", ["MCC", "Merchant Category Code"]) || "N/A",
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
    const baseCb = {
      domestic: findMetric("Domestic Disputes"),
      international: findMetric("International Disputes"),
      pos: findMetric("POS Disputes"),
      ecommerce: findMetric("E-Commerce Disputes"),
      preArbRaised: findMetric("Pre-Arbitration Raised"),
      preArbReceived: findMetric("Pre-Arbitration Received"),
      highAging: findMetric("High-Aging Disputes")
    };
    data.chargeback = { credit: baseCb, debit: baseCb };
  }
  if (rawSheets["Chargeback_Merchants"] && rawSheets["Chargeback_Merchants"].length) {
    const rows = rawSheets["Chargeback_Merchants"];
    data.chargebackMerchantsByCount = rows.slice().sort(function (a, b) {
      return (num(b, null, ["Dispute Count"]) || 0) - (num(a, null, ["Dispute Count"]) || 0);
    }).slice(0, 5).map(function (row, i) {
      return {
        rank: i + 1, merchant: getAliasedValue(row, null, ["Merchant"]) || "N/A",
        mcc: getAliasedValue(row, "mcc", ["MCC", "Merchant Category Code"]) || "N/A",
        disputeCount: num(row, null, ["Dispute Count"]), disputedAmount: num(row, null, ["Disputed Amount"]),
        share: num(row, null, ["Share Percentage", "Share"])
      };
    });
    data.chargebackMerchantsByAmount = rows.slice().sort(function (a, b) {
      return (num(b, null, ["Chargeback Amount"]) || 0) - (num(a, null, ["Chargeback Amount"]) || 0);
    }).slice(0, 5).map(function (row, i) {
      return {
        rank: i + 1, merchant: getAliasedValue(row, null, ["Merchant"]) || "N/A",
        mcc: getAliasedValue(row, "mcc", ["MCC", "Merchant Category Code"]) || "N/A",
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

  /* NOSTRO: Restricted strictly to USD and AED available balances */
  if (rawSheets["Nostro"] && rawSheets["Nostro"].length) {
    const filteredNostro = rawSheets["Nostro"].filter(function (row) {
      const glStr = String(getAliasedValue(row, "gl", ["Nostro GL", "GL", "Currency"]) || "").toUpperCase();
      return glStr.indexOf("USD") !== -1 || glStr.indexOf("AED") !== -1;
    });
    data.nostro = (filteredNostro.length ? filteredNostro : rawSheets["Nostro"].slice(0, 2)).map(function (row) {
      const gl = getAliasedValue(row, "gl", ["Nostro GL", "GL"]) || "N/A";
      const cur = /usd/i.test(gl) ? "USD" : (/aed/i.test(gl) ? "AED" : "USD");
      return {
        currency: cur,
        gl: gl,
        balance: num(row, null, ["Nostro Balance", "Available Balance", "Balance"]),
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
        showMessage("The xlsx.min.js library was not found in the js/ folder, so .xlsx and .xls files cannot be parsed. CSV files work without it.", "error");
      } else {
        showMessage("The file could not be parsed. Please confirm it is a valid Excel or CSV workbook.", "error");
      }
    }
  };
  reader.readAsArrayBuffer(file);
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
   10. ALERTS — BOTTOM-RIGHT NOTIFICATION SYSTEM
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
  const activeCb = data.chargeback ? (data.chargeback.credit || data.chargeback) : null;
  if (activeCb && activeCb.highAging && activeCb.highAging.count > 0) {
    rawAlerts.push({
      id: "toast_cb_high_aging",
      severity: "WARNING",
      title: "High-Aging Chargeback Disputes",
      detail: activeCb.highAging.count + " pending cases (" + formatCurrency(activeCb.highAging.amount) + ")",
      page: "chargeback"
    });
  }

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

    toast.addEventListener("click", function (e) {
      if (e.target.classList.contains("toast-close")) return;
      navigateToPage(a.page);
    });

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
   11. PAGE 1 — OVERVIEW (EXECUTIVE COMMAND CENTER)
   ===================================================================== */

function renderOverview(data) {
  const root = document.getElementById("overview-body");
  root.innerHTML = "";

  if (data.meta && data.meta.dataQualityMessages.length) {
    data.meta.dataQualityMessages.forEach(function (m) { root.appendChild(dataQualityNote(m)); });
  }

  renderOvKpiStrip(root, data);   /* Executive KPI strip */
  renderOvNostro(root, data);     /* NOSTRO Available Balances (USD & AED) */
  renderOvAdcSummary(root, data); /* ADC Operational summary */
  renderOvCharts(root, data);     /* Visual management widgets */
  renderOvModules(root, data);    /* Module summary panels */
}

/* NOSTRO Position Status on Overview (USD & AED Available Balances Only) */
function renderOvNostro(root, data) {
  if (!data.nostro || !data.nostro.length) return;

  const section = el("div", { class: "ov-section" });
  section.appendChild(el("div", { class: "ov-section-heading", text: "NOSTRO Account Positions" }));

  const grid = el("div", { class: "kpi-grid" });
  data.nostro.forEach(function (n) {
    const cur = n.currency || (n.gl.indexOf("USD") !== -1 ? "USD" : "AED");
    const title = cur + " Available Balance";
    grid.appendChild(kpiCard(title, formatCurrency(n.balance, cur), "GL: " + n.gl));
  });

  section.appendChild(grid);
  root.appendChild(section);
}

/* Executive KPI Strip */
function renderOvKpiStrip(root, data) {
  const strip = el("div", { class: "ov-kpi-strip" });

  /* 1. ATM Uptime Today vs Yesterday */
  const uptime  = data.atm ? data.atm.uptimeToday : null;
  const uptimeY = data.atm ? data.atm.uptimeYesterday : null;
  const uptComp = formatUptimeComparison(uptime, uptimeY);
  strip.appendChild(ovExecCard("ATM Uptime", uptComp.todayStr,
    'Yesterday: ' + uptComp.yesterdayStr + ' &nbsp;|&nbsp; ' + uptComp.html, "vs Yesterday", "DAILY",
    fullValueTitle(uptime)));

  /* 2. Total ADC Transaction Count */
  const adcCntTdy = (data.atm ? data.atm.withdrawalCountToday || 0 : 0)
                  + (data.raast ? data.raast.successCountToday || 0 : 0)
                  + (data.ibft ? data.ibft.successCountToday || 0 : 0);
  const adcCntY   = data.atm ? data.atm.withdrawalCountYesterday : null;
  strip.appendChild(ovExecCard("Total ADC Transaction Count", formatNumber(adcCntTdy, 0),
    indicatorHTML(adcCntTdy, adcCntY, true, false), "vs Yesterday", "DAILY"));

  /* 3. Total ADC Transaction Amount */
  const adcAmtTdy = (data.atm ? data.atm.withdrawalAmountToday || 0 : 0)
                  + (data.raast ? data.raast.successAmountToday || 0 : 0)
                  + (data.ibft ? data.ibft.successAmountToday || 0 : 0);
  const adcAmtY   = data.atm ? data.atm.withdrawalAmountYesterday : null;
  strip.appendChild(ovExecCard("Total ADC Transaction Amount", formatCurrency(adcAmtTdy),
    indicatorHTML(adcAmtTdy, adcAmtY, true, false), "vs Yesterday", "DAILY",
    fullValueTitle(adcAmtTdy, true)));

  /* 4. Active Cards */
  const activeTot = data.activeCards ? sumBy(data.activeCards, "count") : null;
  const activePrv = data.activeCards ? sumBy(data.activeCards, "prevMonth") : null;
  strip.appendChild(ovExecCard("Active Cards Count", formatNumber(activeTot, 0),
    indicatorHTML(activeTot, activePrv, true, true), "vs Previous Month", "MONTHLY"));

  /* 5. Total Card Spend */
  const spend     = data.cardFinancials
    ? (data.cardFinancials.credit.spendCurrent || 0) + (data.cardFinancials.debit.spendCurrent || 0) : null;
  const spendPrv  = data.cardFinancials
    ? (data.cardFinancials.credit.spendPrevious || 0) + (data.cardFinancials.debit.spendPrevious || 0) : null;
  strip.appendChild(ovExecCard("Total Card Spend", formatCurrency(spend),
    indicatorHTML(spend, spendPrv, true, true), "vs Previous Month", "MONTHLY",
    fullValueTitle(spend, true)));

  /* 6. Reconciliation Exposure > 30d */
  const exposure  = data.reconciliation
    ? sumBy(data.reconciliation.receivables, "amount") + sumBy(data.reconciliation.payables, "amount") : null;
  strip.appendChild(ovExecCard("Recon Exposure > 30d", formatCurrency(exposure),
    '<span class="indicator flat">&mdash;</span>', "", "DAILY",
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

/* ADC Operations Summary */
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
    rows.push({ kpi: "ATM Withdrawals Count", today: formatNumber(a.withdrawalCountToday, 0), mtd: formatNumber(a.withdrawalCountMTD, 0), change: indicatorHTML(a.withdrawalCountToday, a.withdrawalCountYesterday, true, false) });
    rows.push({ kpi: "ATM Withdrawal Amount", today: formatCurrency(a.withdrawalAmountToday), mtd: formatCurrency(a.withdrawalAmountMTD), change: indicatorHTML(a.withdrawalAmountToday, a.withdrawalAmountYesterday, true, false) });
    rows.push({ kpi: "ATM Disputes Count",    today: formatNumber(a.disputesToday, 0),         mtd: formatNumber(a.disputesMTD, 0),         change: indicatorHTML(a.disputesToday, a.disputesMTD > 0 ? a.disputesMTD / 30 : null, false, false) });
    rows.push({ kpi: "Cards Captured Count",  today: formatNumber(a.capturedCardsToday, 0),    mtd: formatNumber(a.capturedCardsMTD, 0),    change: "\u2014" });
  }
  if (data.raast) {
    const r = data.raast;
    rows.push({ kpi: "RAAST Transaction Count", today: formatNumber(r.successCountToday, 0), mtd: formatNumber(r.successCountMTD, 0), change: indicatorHTML(r.successRateToday, r.successRateMTD, true, false) });
  }
  if (data.ibft) {
    const i = data.ibft;
    rows.push({ kpi: "IBFT Transaction Count",  today: formatNumber(i.successCountToday, 0),  mtd: formatNumber(i.successCountMTD, 0),  change: indicatorHTML(i.successRateToday, i.successRateMTD, true, false) });
  }

  const wrap = el("div", { class: "ov-adc-table-wrap" });
  const table = el("table", { class: "ov-adc-table" });
  const thead = el("thead");
  const hr = el("tr");
  ["KPI", "Today", "Current Month", "Change"].forEach(function (h, i) {
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

/* Executive Visual Widgets */
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

/* NOSTRO Position Widget (USD & AED Available Balances) */
function buildOvNostroChart(data) {
  const body = el("div", { class: "ov-chart-body" });
  if (!data.nostro || !data.nostro.length) {
    body.appendChild(el("div", { class: "no-data-note", text: "No NOSTRO position data available." }));
    return ovChartCard("NOSTRO Account Positions", body);
  }
  const items = data.nostro.map(function (n) {
    const cur = n.currency || (n.gl.indexOf("USD") !== -1 ? "USD" : "AED");
    return '<div class="nostro-card-item">'
      + '<div class="nostro-item-title"><strong>' + cur + ' Account</strong> (' + n.gl + ')</div>'
      + '<div class="nostro-item-row"><span>Available Balance:</span> <strong>' + formatCurrency(n.balance, cur) + '</strong></div>'
      + '</div>';
  }).join("");
  body.innerHTML = '<div class="nostro-card-list">' + items + '</div>';
  return ovChartCard("NOSTRO Account Positions", body);
}

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

function buildOvAgingChart(data) {
  const body = el("div", { class: "ov-chart-body" });
  const buckets = data.reconciliation && data.reconciliation.agingBuckets;
  if (!buckets || !buckets.length) {
    body.appendChild(el("div", { class: "no-data-note", text: "No reconciliation aging data available." }));
    return ovChartCard("Reconciliation Aging Composition", body);
  }
  const COLORS = { "Current": "#D0E5F3", "30+": "#90C4E4", "60+": "#6FAED2", "90+": "#117ABF", "120+": "#0D5F92" };
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
    + '<rect x="' + padX + '" y="' + ly1 + '" width="10" height="10" fill="#117ABF" rx="2"/>'
    + '<text x="' + (padX + 16) + '" y="' + (ly1 + 9) + '" font-size="11" fill="#334155" font-weight="600">Debit \u2014 ' + formatCurrency(debitVal) + ' (' + dPct + '%)</text>'
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

/* Module Summary Panels */
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
  const uptComp = formatUptimeComparison(a.uptimeToday, a.uptimeYesterday);
  return [
    ["ATM Uptime Today",        uptComp.todayStr + " (Yesterday: " + uptComp.yesterdayStr + ")"],
    ["ATM Withdrawal Count",    formatNumber(a.withdrawalCountToday)],
    ["ATM Withdrawal Amount",   formatCurrency(a.withdrawalAmountToday)],
    ["RAAST Success Rate",      data.raast ? formatPercentage(data.raast.successRateToday)  : "N/A"],
    ["IBFT Success Rate",       data.ibft  ? formatPercentage(data.ibft.successRateToday)   : "N/A"]
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
    ["Active Cards Count",              data.activeCards ? formatNumber(sumBy(data.activeCards, "count")) : "N/A"],
    ["Lowest Card Plastic Availability", lowest ? lowest.monthsCover.toFixed(1) + " months" : "N/A"],
    ["Urgent Attention",                lowest ? statusBadge(lowest.status) + " " + lowest.category : "N/A"],
    ["Envelopes Cover",                 env  ? env.monthsCover.toFixed(1)  + " months " + statusBadge(env.status)  : "N/A"],
    ["Mailers Cover",                   mail ? mail.monthsCover.toFixed(1) + " months " + statusBadge(mail.status) : "N/A"]
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
  const activeCb = cb.credit || cb;
  const tot = ["domestic","international"].reduce(function (s,k) { return s + (activeCb[k] ? activeCb[k].count||0 : 0); }, 0);
  const amt = ["domestic","international"].reduce(function (s,k) { return s + (activeCb[k] ? activeCb[k].amount||0 : 0); }, 0);
  return [
    ["Total Disputes Count", formatNumber(tot)],
    ["Total Disputed Amount",formatCurrency(amt)],
    ["Pre-Arb Raised Count", activeCb.preArbRaised   ? formatNumber(activeCb.preArbRaised.count)   : "N/A"],
    ["Pre-Arb Received Count",activeCb.preArbReceived  ? formatNumber(activeCb.preArbReceived.count) : "N/A"],
    ["High-Aging Disputes",  activeCb.highAging       ? formatNumber(activeCb.highAging.count)      : "N/A"]
  ];
}

function ovReconRows(data) {
  if (!data.reconciliation) return null;
  const rec = data.reconciliation;
  const usdBal = data.nostro ? (data.nostro.find(function(n){ return n.currency === "USD"; }) || {}).balance : null;
  const aedBal = data.nostro ? (data.nostro.find(function(n){ return n.currency === "AED"; }) || {}).balance : null;
  return [
    ["Receivables > 30d Amount", formatCurrency(sumBy(rec.receivables, "amount"))],
    ["Payables > 30d Amount",    formatCurrency(sumBy(rec.payables, "amount"))],
    ["USD Available Balance",    usdBal !== null && usdBal !== undefined ? formatCurrency(usdBal, "USD") : "N/A"],
    ["AED Available Balance",    aedBal !== null && aedBal !== undefined ? formatCurrency(aedBal, "AED") : "N/A"]
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
    const uptComp = formatUptimeComparison(a.uptimeToday, a.uptimeYesterday);

    const grid = el("div", { class: "kpi-grid" });
    grid.appendChild(kpiCard("Total ATMs Count", formatNumber(a.totalATMs)));

    /* ATM Uptime Card rendering Today vs Yesterday actuals + visual change */
    const uptimeSubHTML = "Yesterday: " + uptComp.yesterdayStr + " &nbsp;|&nbsp; " + uptComp.html;
    grid.appendChild(kpiCard("ATM Uptime (Today vs Yesterday)", uptComp.todayStr + " (Today)", uptimeSubHTML));

    grid.appendChild(kpiCard("Withdrawal Transaction Count (Today)", formatNumber(a.withdrawalCountToday), calculateComparisons(a.withdrawalCountToday, a.withdrawalCountYesterday, true, false).html + " vs Yesterday"));
    grid.appendChild(kpiCard("Withdrawal Transaction Count (Month to Date)", formatNumber(a.withdrawalCountMTD), calculateComparisons(a.withdrawalCountMTD, a.withdrawalCountPrevMTD, true, true).html + " vs Previous Month"));
    grid.appendChild(kpiCard("Withdrawal Transaction Amount (Today)", formatCurrency(a.withdrawalAmountToday), calculateComparisons(a.withdrawalAmountToday, a.withdrawalAmountYesterday, true, false).html + " vs Yesterday", fullValueTitle(a.withdrawalAmountToday, true)));
    grid.appendChild(kpiCard("Withdrawal Transaction Amount (Month to Date)", formatCurrency(a.withdrawalAmountMTD), calculateComparisons(a.withdrawalAmountMTD, a.withdrawalAmountPrevMTD, true, true).html + " vs Previous Month", fullValueTitle(a.withdrawalAmountMTD, true)));
    grid.appendChild(kpiCard("Failed ATM Transactions Count (Today)", formatNumber(a.failedTxnToday), calculateComparisons(a.failedTxnToday, a.failedTxnYesterday, false, false).html + " vs Yesterday"));
    grid.appendChild(kpiCard("ATM Disputes / Claims Count (Month to Date)", formatNumber(a.disputesMTD)));
    grid.appendChild(kpiCard("Cards Captured Count (Month to Date)", formatNumber(a.capturedCardsMTD)));
    grid.appendChild(kpiCard("Cash-Retract Transactions Count (Month to Date)", formatNumber(a.retractTxnMTD)));
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

  /* Shared Column Structure for 3 Target ADC Tables: Metric | Today | Yesterday | Change | Current Month */
  const adcThreeTableColumns = [
    { key: "kpi", label: "Metric" },
    { key: "today", label: "Today", numeric: true },
    { key: "yesterday", label: "Yesterday", numeric: true },
    { key: "change", label: "Change", numeric: true },
    { key: "mtd", label: "Current Month", numeric: true }
  ];

  /* 1. RAAST Operations Table */
  root.appendChild(sectionTitle("RAAST Operations"));
  if (data.raast) {
    const r = data.raast;
    const raastRows = [
      {
        kpi: "Successful Transaction Count",
        today: formatNumber(r.successCountToday),
        yesterday: formatNumber(r.successCountYesterday),
        change: calculateComparisons(r.successCountToday, r.successCountYesterday, true, false).html,
        mtd: formatNumber(r.successCountMTD)
      },
      {
        kpi: "Successful Transaction Amount",
        today: formatCurrency(r.successAmountToday),
        yesterday: formatCurrency(r.successAmountYesterday),
        change: calculateComparisons(r.successAmountToday, r.successAmountYesterday, true, false).html,
        mtd: formatCurrency(r.successAmountMTD)
      },
      {
        kpi: "Success Rate (%)",
        today: formatPercentage(r.successRateToday),
        yesterday: formatPercentage(r.successRateYesterday),
        change: calculateComparisons(r.successRateToday, r.successRateYesterday, true, false).html,
        mtd: formatPercentage(r.successRateMTD)
      },
      {
        kpi: "Failed Transaction Count",
        today: formatNumber(r.failedCountToday),
        yesterday: formatNumber(r.failedCountYesterday),
        change: calculateComparisons(r.failedCountToday, r.failedCountYesterday, false, false).html,
        mtd: formatNumber(r.failedCountMTD)
      },
      {
        kpi: "Complaints Count",
        today: formatNumber(r.complaintsToday),
        yesterday: formatNumber(r.complaintsYesterday),
        change: calculateComparisons(r.complaintsToday, r.complaintsYesterday, false, false).html,
        mtd: formatNumber(r.complaintsMTD)
      }
    ];

    root.appendChild(buildTable(null, adcThreeTableColumns, raastRows));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "RAAST sheet is missing. No data available for RAAST." }));
  }

  /* 2. IBFT Operations Table */
  root.appendChild(sectionTitle("IBFT Operations"));
  if (data.ibft) {
    const i = data.ibft;
    const ibftRows = [
      {
        kpi: "Successful Transaction Count",
        today: formatNumber(i.successCountToday),
        yesterday: formatNumber(i.successCountYesterday),
        change: calculateComparisons(i.successCountToday, i.successCountYesterday, true, false).html,
        mtd: formatNumber(i.successCountMTD)
      },
      {
        kpi: "Successful Transaction Amount",
        today: formatCurrency(i.successAmountToday),
        yesterday: formatCurrency(i.successAmountYesterday),
        change: calculateComparisons(i.successAmountToday, i.successAmountYesterday, true, false).html,
        mtd: formatCurrency(i.successAmountMTD)
      },
      {
        kpi: "Success Rate (%)",
        today: formatPercentage(i.successRateToday),
        yesterday: formatPercentage(i.successRateYesterday),
        change: calculateComparisons(i.successRateToday, i.successRateYesterday, true, false).html,
        mtd: formatPercentage(i.successRateMTD)
      },
      {
        kpi: "Failure Count",
        today: formatNumber(i.failureCountToday),
        yesterday: formatNumber(i.failureCountYesterday),
        change: calculateComparisons(i.failureCountToday, i.failureCountYesterday, false, false).html,
        mtd: formatNumber(i.failureCountMTD)
      },
      {
        kpi: "Complaints Count",
        today: formatNumber(i.complaintsToday),
        yesterday: formatNumber(i.complaintsYesterday),
        change: calculateComparisons(i.complaintsToday, i.complaintsYesterday, false, false).html,
        mtd: formatNumber(i.complaintsMTD)
      }
    ];

    root.appendChild(buildTable(null, adcThreeTableColumns, ibftRows));

    /* 3. IBFT Failure Reasons Table (Same Column Structure: Metric | Today | Yesterday | Change | Current Month) */
    const failureCols = [
      { key: "reason", label: "Failure Reason Category" },
      { key: "today", label: "Today", numeric: true },
      { key: "yesterday", label: "Yesterday", numeric: true },
      { key: "change", label: "Change", numeric: true },
      { key: "mtd", label: "Current Month", numeric: true }
    ];

    root.appendChild(buildTable("IBFT Failure Reasons", failureCols,
      (data.ibftFailures || []).map(function (f) {
        return {
          reason: f.reason,
          today: formatNumber(f.today),
          yesterday: formatNumber(f.yesterday),
          change: calculateComparisons(f.today, f.yesterday, false, false).html,
          mtd: formatNumber(f.mtd)
        };
      })
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

  /* Card Plastic Availability terminology (Rule 3) */
  root.appendChild(sectionTitle("Card Plastic Availability"));
  if (data.cardInventory) {
    const rows = data.cardInventory.map(computeInventoryStatus);
    const urgent = rows.slice().sort(function (a, b) { return a.monthsCover - b.monthsCover; })[0];
    if (urgent) {
      root.appendChild(el("div", { class: "kpi-sub", html: "Requires urgent attention (Lowest Card Plastic Availability): <strong>" + urgent.category + "</strong> " + statusBadge(urgent.status) }));
    }
    const wrap = buildTable(null,
      [{ key: "category", label: "Plastic Category" }, { key: "qty", label: "Current Quantity", numeric: true },
       { key: "avgMonthlyUse", label: "Avg Monthly Consumption", numeric: true }, { key: "monthsCoverDisplay", label: "Months of Cover" },
       { key: "minStock", label: "Required Minimum Stock", numeric: true }, { key: "statusDisplay", label: "Status" }],
      rows.map(function (r) { return Object.assign({}, r, { monthsCoverDisplay: r.monthsCover.toFixed(1), statusDisplay: statusBadge(r.status) }); })
    );
    root.appendChild(wrap);
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "Card_Inventory sheet is missing. No data available for card plastic availability." }));
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
      [{ key: "product", label: "Product" }, { key: "count", label: "Current Month Count", numeric: true },
       { key: "prevMonth", label: "Previous Month Count", numeric: true }, { key: "changeDisplay", label: "MoM Change" },
       { key: "fee", label: "Annual Fee", currency: true }],
      data.activeCards.map(function (r) { return Object.assign({}, r, { changeDisplay: calculateComparisons(r.count, r.prevMonth, true, true).html }); })
    ));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "Active_Cards sheet is missing. No data available for cards in force." }));
  }
}

/* ---------------------------------------------------------------------
   13. PAGE 4 — CARD FINANCIALS ([ Credit Cards ] [ Debit Cards ] ONLY)
   --------------------------------------------------------------------- */

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

  root.appendChild(sectionTitle("Comprehensive Card Financial Performance & Revenue Summary"));

  /* Tabs: ONLY Credit Cards and Debit Cards (Rule 11 - NO "All Cards" button) */
  const toggleWrap = el("div", { class: "card-fin-toggle-bar" });
  const btnCredit = el("button", { class: "fin-toggle-btn" + (cardFinancialsActiveTab === "credit" ? " active" : ""), type: "button", text: "Credit Cards" });
  const btnDebit = el("button", { class: "fin-toggle-btn" + (cardFinancialsActiveTab === "debit" ? " active" : ""), type: "button", text: "Debit Cards" });

  toggleWrap.appendChild(btnCredit);
  toggleWrap.appendChild(btnDebit);
  root.appendChild(toggleWrap);

  const tableContainer = el("div", { id: "comprehensiveFinancialTableContainer" });
  root.appendChild(tableContainer);

  function renderComprehensiveTable() {
    tableContainer.innerHTML = "";
    const tab = cardFinancialsActiveTab === "debit" ? "debit" : "credit";
    const selectedData = tab === "debit" ? d : c;
    const isCredit = tab === "credit";
    const compRows = [];

    if (isCredit) {
      if (c.cif !== undefined && c.cif !== null) compRows.push({ item: "Credit Card CIF", current: c.cif, previous: c.cifPrevious, isCount: true });
      if (c.aif !== undefined && c.aif !== null) compRows.push({ item: "Credit Card AIF", current: c.aif, previous: c.aifPrevious, isCount: true });
      compRows.push({ item: "Credit Card Spend", current: c.spendCurrent, previous: c.spendPrevious, isCurrency: true });
    } else {
      compRows.push({ item: "Debit Card Spend", current: d.spendCurrent, previous: d.spendPrevious, isCurrency: true });
    }

    compRows.push({ item: "Domestic Transaction Count", current: selectedData.domesticTxnCount, previous: selectedData.domesticTxnCountPrevious, isCount: true });
    compRows.push({ item: "Domestic Transaction Amount", current: selectedData.domesticTxnAmount, previous: selectedData.domesticTxnAmountPrevious, isCurrency: true });
    compRows.push({ item: "International Transaction Count", current: selectedData.intlTxnCount, previous: selectedData.intlTxnCountPrevious, isCount: true });
    compRows.push({ item: "International Transaction Amount", current: selectedData.intlTxnAmount, previous: selectedData.intlTxnAmountPrevious, isCurrency: true });

    const totCountCurrent = (selectedData.domesticTxnCount || 0) + (selectedData.intlTxnCount || 0);
    const totCountPrev = (selectedData.domesticTxnCountPrevious || 0) + (selectedData.intlTxnCountPrevious || 0);
    compRows.push({ item: "Total Transaction Count", current: totCountCurrent, previous: totCountPrev || null, isCount: true });

    const totAmtCurrent = (selectedData.domesticTxnAmount || 0) + (selectedData.intlTxnAmount || 0);
    const totAmtPrev = (selectedData.domesticTxnAmountPrevious || 0) + (selectedData.intlTxnAmountPrevious || 0);
    compRows.push({ item: "Total Transaction Amount", current: totAmtCurrent, previous: totAmtPrev || null, isCurrency: true });

    compRows.push({ item: "Domestic Interchange Income", current: selectedData.domesticInterchange, previous: selectedData.domesticInterchangePrevious, isCurrency: true });
    compRows.push({ item: "International Interchange Income", current: selectedData.intlInterchange, previous: selectedData.intlInterchangePrevious, isCurrency: true });

    const totInterCurrent = (selectedData.domesticInterchange || 0) + (selectedData.intlInterchange || 0);
    const totInterPrev = (selectedData.domesticInterchangePrevious || 0) + (selectedData.intlInterchangePrevious || 0);
    compRows.push({ item: "Total Interchange Income", current: totInterCurrent, previous: totInterPrev || null, isCurrency: true });

    compRows.push({ item: "Annual Fee Income", current: selectedData.annualFeeIncome, previous: selectedData.annualFeeIncomePrevious, isCurrency: true });
    compRows.push({ item: "OIF Income", current: selectedData.oifIncome, previous: selectedData.oifIncomePrevious, isCurrency: true });
    compRows.push({ item: "MDR Income", current: selectedData.mdrIncome, previous: selectedData.mdrIncomePrevious, isCurrency: true });
    if (selectedData.enr !== undefined && selectedData.enr !== null) compRows.push({ item: "ENR (Ending Net Receivables)", current: selectedData.enr, previous: selectedData.enrPrevious, isCurrency: true });

    const formattedRows = compRows.map(function (row) {
      let valDisp, prevDisp;
      if (row.isCount) {
        valDisp = formatNumber(row.current);
        prevDisp = row.previous !== undefined && row.previous !== null ? formatNumber(row.previous) : "\u2014";
      } else if (row.isCurrency) {
        valDisp = formatCurrency(row.current);
        prevDisp = row.previous !== undefined && row.previous !== null ? formatCurrency(row.previous) : "\u2014";
      } else {
        valDisp = String(row.current || "N/A");
        prevDisp = row.previous ? String(row.previous) : "\u2014";
      }

      return {
        item: row.item,
        currentDisplay: valDisp,
        previousDisplay: prevDisp,
        changeDisplay: calculateComparisons(row.current, row.previous, true, true).html
      };
    });

    const wrap = buildTable(null,
      [{ key: "item", label: "Financial / Performance Metric" },
       { key: "currentDisplay", label: "Current Month", numeric: true },
       { key: "previousDisplay", label: "Previous Month", numeric: true },
       { key: "changeDisplay", label: "MoM Change", numeric: true }],
      formattedRows
    );
    tableContainer.appendChild(wrap);
  }

  renderComprehensiveTable();

  btnCredit.addEventListener("click", function () {
    cardFinancialsActiveTab = "credit";
    btnCredit.classList.add("active"); btnDebit.classList.remove("active");
    renderComprehensiveTable();
  });
  btnDebit.addEventListener("click", function () {
    cardFinancialsActiveTab = "debit";
    btnDebit.classList.add("active"); btnCredit.classList.remove("active");
    renderComprehensiveTable();
  });

  /* Small Combined Summary Boxes with Full Narration (Rule 11) */
  root.appendChild(sectionTitle("Combined Card Performance Summaries"));
  const totSpendBoth = (c.spendCurrent || 0) + (d.spendCurrent || 0);
  const totOifBoth   = (c.oifIncome || 0) + (d.oifIncome || 0);
  const netProfitBoth = data.netInterchange ? data.netInterchange.income - data.netInterchange.expense : null;

  const grid = el("div", { class: "kpi-grid" });
  grid.appendChild(kpiCard("Total Spend Across Both Cards", formatCurrency(totSpendBoth)));
  grid.appendChild(kpiCard("Total OIF Earned Across Both Cards", formatCurrency(totOifBoth)));
  if (netProfitBoth !== null) {
    grid.appendChild(kpiCard("Total Net Interchange Profit Across Both Cards", formatCurrency(netProfitBoth)));
  }
  root.appendChild(grid);

  /* Spend by Channel */
  root.appendChild(sectionTitle("Spend by Channel"));
  if (data.spendByChannel) {
    root.appendChild(buildTable(null,
      [{ key: "channel", label: "Channel" }, { key: "current", label: "Current Month", currency: true },
       { key: "previous", label: "Previous Month", currency: true }, { key: "changeDisplay", label: "MoM Change" }],
      data.spendByChannel.map(function (r) { return { channel: r.channel, current: r.current, previous: r.previous, changeDisplay: calculateComparisons(r.current, r.previous, true, true).html }; })
    ));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "Spend_By_Channel sheet is missing. No data available." }));
  }

  /* Top 5 Merchants by Spend: MCC Column (Rule 2) */
  root.appendChild(sectionTitle("Top 5 Merchants by Spend"));
  root.appendChild(buildTable(null,
    [{ key: "rank", label: "Rank", numeric: true }, { key: "merchant", label: "Merchant" }, { key: "mcc", label: "MCC" },
     { key: "txnCount", label: "Transaction Count", numeric: true }, { key: "spend", label: "Transaction Amount", currency: true }, { key: "share", label: "Share %", percent: true }],
    data.topMerchants));

  /* SBP Cross-Border Monitoring */
  root.appendChild(sectionTitle("SBP Cross-Border Monitoring (USD 30,000 threshold)"));
  if (data.sbpCrossBorder) {
    const sbpGrid = el("div", { class: "kpi-grid" });
    sbpGrid.appendChild(kpiCard("Customers Reaching Threshold (Current Month)", formatNumber(data.sbpCrossBorder.customerCountCurrent, 0)));
    sbpGrid.appendChild(kpiCard("Previous Month", formatNumber(data.sbpCrossBorder.customerCountPrevious, 0),
      calculateComparisons(data.sbpCrossBorder.customerCountCurrent, data.sbpCrossBorder.customerCountPrevious, false, true).html));
    root.appendChild(sbpGrid);
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "No data available for SBP cross-border monitoring." }));
  }
}

/* ---------------------------------------------------------------------
   14. PAGE 5 — CHARGEBACK ([ Credit Cards ] [ Debit Cards ] ONLY)
   --------------------------------------------------------------------- */

function renderChargeback(data) {
  const root = document.getElementById("chargeback-body");
  root.innerHTML = "";

  if (!data.chargeback) {
    root.appendChild(el("div", { class: "no-data-note", text: "Chargeback sheet is missing. No data available for Chargeback." }));
    return;
  }

  root.appendChild(sectionTitle("Chargeback & Dispute Summary"));

  /* Tabs: ONLY Credit Cards and Debit Cards (Rule 13 - NO "All Cards" button) */
  const toggleWrap = el("div", { class: "card-fin-toggle-bar" });
  const btnCredit = el("button", { class: "fin-toggle-btn" + (chargebackActiveTab === "credit" ? " active" : ""), type: "button", text: "Credit Cards" });
  const btnDebit = el("button", { class: "fin-toggle-btn" + (chargebackActiveTab === "debit" ? " active" : ""), type: "button", text: "Debit Cards" });

  toggleWrap.appendChild(btnCredit);
  toggleWrap.appendChild(btnDebit);
  root.appendChild(toggleWrap);

  const tableContainer = el("div", { id: "chargebackTableContainer" });
  root.appendChild(tableContainer);

  const cbData = data.chargeback;
  const creditCb = cbData.credit || cbData;
  const debitCb  = cbData.debit || cbData;

  function renderChargebackTable() {
    tableContainer.innerHTML = "";
    const activeCb = chargebackActiveTab === "debit" ? debitCb : creditCb;

    function metricRow(label, m) {
      return {
        metric: label,
        currentCount: m ? m.count : null, currentAmount: m ? m.amount : null,
        prevCount: m ? m.prevCount : null, prevAmount: m ? m.prevAmount : null,
        changeDisplay: m ? calculateComparisons(m.count, m.prevCount, false, true).html : "N/A"
      };
    }

    const rows = [
      metricRow("Domestic Disputes", activeCb.domestic),
      metricRow("International Disputes", activeCb.international),
      metricRow("POS Disputes", activeCb.pos),
      metricRow("E-Commerce Disputes", activeCb.ecommerce),
      metricRow("Pre-Arbitration Raised", activeCb.preArbRaised),
      metricRow("Pre-Arbitration Received", activeCb.preArbReceived),
      metricRow("High-Aging Disputes", activeCb.highAging)
    ];

    const wrap = buildTable(null,
      [{ key: "metric", label: "Dispute / Claim Metric" },
       { key: "currentCount", label: "Current Month Count", numeric: true },
       { key: "currentAmount", label: "Current Month Amount", currency: true },
       { key: "prevCount", label: "Previous Month Count", numeric: true },
       { key: "prevAmount", label: "Previous Month Amount", currency: true },
       { key: "changeDisplay", label: "MoM Change", numeric: true }],
      rows
    );
    tableContainer.appendChild(wrap);
  }

  renderChargebackTable();

  btnCredit.addEventListener("click", function () {
    chargebackActiveTab = "credit";
    btnCredit.classList.add("active"); btnDebit.classList.remove("active");
    renderChargebackTable();
  });
  btnDebit.addEventListener("click", function () {
    chargebackActiveTab = "debit";
    btnDebit.classList.add("active"); btnCredit.classList.remove("active");
    renderChargebackTable();
  });

  /* Small Combined Credit + Debit Summary Boxes below table (Rule 13) */
  root.appendChild(sectionTitle("Combined Dispute Summaries"));
  const totDisputesBoth = (creditCb.domestic ? creditCb.domestic.count || 0 : 0)
                        + (creditCb.international ? creditCb.international.count || 0 : 0)
                        + (debitCb.domestic ? debitCb.domestic.count || 0 : 0)
                        + (debitCb.international ? debitCb.international.count || 0 : 0);
  const totDisputedAmtBoth = (creditCb.domestic ? creditCb.domestic.amount || 0 : 0)
                           + (creditCb.international ? creditCb.international.amount || 0 : 0)
                           + (debitCb.domestic ? debitCb.domestic.amount || 0 : 0)
                           + (debitCb.international ? debitCb.international.amount || 0 : 0);

  const grid = el("div", { class: "kpi-grid" });
  grid.appendChild(kpiCard("Total Disputes Count Across Both Cards", formatNumber(totDisputesBoth)));
  grid.appendChild(kpiCard("Total Disputed Amount Across Both Cards", formatCurrency(totDisputedAmtBoth)));
  root.appendChild(grid);

  /* Merchant tables with MCC column (Rule 2) */
  root.appendChild(sectionTitle("Top 5 Merchants by Dispute Count"));
  root.appendChild(buildTable(null,
    [{ key: "rank", label: "Rank", numeric: true }, { key: "merchant", label: "Merchant" }, { key: "mcc", label: "MCC" },
     { key: "disputeCount", label: "Dispute Count", numeric: true }, { key: "disputedAmount", label: "Disputed Amount", currency: true },
     { key: "share", label: "Share %", percent: true }],
    data.chargebackMerchantsByCount));

  root.appendChild(sectionTitle("Top 5 Merchants by Chargeback Amount"));
  root.appendChild(buildTable(null,
    [{ key: "rank", label: "Rank", numeric: true }, { key: "merchant", label: "Merchant" }, { key: "mcc", label: "MCC" },
     { key: "chargebackCount", label: "Chargeback Count", numeric: true }, { key: "chargebackAmount", label: "Chargeback Amount", currency: true },
     { key: "share", label: "Share %", percent: true }],
    data.chargebackMerchantsByAmount));

  root.appendChild(sectionTitle("Temporary-Credit GL Summary"));
  root.appendChild(buildTable(null,
    [{ key: "gl", label: "GL Number" }, { key: "txnCount", label: "Transaction Count", numeric: true }, { key: "amount", label: "Transaction Amount", currency: true }],
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
       { key: "amount", label: "Transaction Amount", currency: true }, { key: "bucket", label: "Aging Bucket" }],
      data.reconciliation.receivables));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "Reconciliation sheet is missing. No data available for receivables." }));
  }

  root.appendChild(sectionTitle("Payables Over 30 Days"));
  if (data.reconciliation && data.reconciliation.payables) {
    root.appendChild(buildTable(null,
      [{ key: "gl", label: "GL Number" }, { key: "description", label: "GL Description" }, { key: "txnCount", label: "Transaction Count", numeric: true },
       { key: "amount", label: "Transaction Amount", currency: true }, { key: "bucket", label: "Aging Bucket" }],
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
       { key: "amount", label: "Transaction Amount", currency: true }, { key: "share", label: "Share %", percent: true }],
      agingSource.concat([{ bucket: "Total", txnCount: totalCount, amount: totalAmount, share: 100 }])));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "No data available for aging buckets." }));
  }

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
    grid.appendChild(kpiCard("OIF Case Count (Current Month)", formatNumber(data.oif.caseCountCurrent),
      calculateComparisons(data.oif.caseCountCurrent, data.oif.caseCountPrevious, false, true).html + " vs Previous Month"));
    grid.appendChild(kpiCard("OIF Value (Current Month)", formatCurrency(data.oif.valueCurrent),
      calculateComparisons(data.oif.valueCurrent, data.oif.valuePrevious, false, true).html + " vs Previous Month"));
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
    showMessage("Note: js/xlsx.min.js was not found, so only CSV files can be loaded until the library is added.", "info");
  }
}

document.addEventListener("DOMContentLoaded", init);
