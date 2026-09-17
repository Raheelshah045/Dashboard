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

/* Target minimum-input Excel sheet names */
const SHEET_NAMES = [
  "ATM", "RAAST", "IBFT", "IBFT_Failures",
  "Card_Inventory", "Card_Stationery", "Active_Cards", "Card_Financials",
  "Spend_By_Channel", "Top_Merchants",
  "Chargeback", "Chargeback_Merchants", "Reconciliation", "Nostro",
  "Rejected_Transactions", "OIF_Monitoring",
  "Secure_Operations", "Unsecured_Operations", "Banca"
];

/* Column alias map: canonical key -> array of header variants to match */
const COLUMN_ALIASES = {
  txnCount: ["txn count", "transaction count", "transactions", "count"],
  txnAmount: ["txn amount", "transaction amount", "value", "amount", "volume", "disputed amount", "chargeback amount", "oif value"],
  successfulTxn: ["successful transaction count", "successful transaction count today", "successful transactions", "success count"],
  successfulAmt: ["successful transaction amount", "successful transaction amount today", "success amount"],
  failedTxn: ["failed transaction count", "failed transaction count today", "failed transactions", "failure count"],
  complaintCount: ["complaint count", "complaints"],
  capturedCards: ["captured cards count", "captured cards", "card captures"],
  gl: ["gl", "gl no", "gl number", "nostro gl"],
  mom: ["mom", "month on month", "monthly change"],
  today: ["today", "current day"],
  yesterday: ["yesterday", "previous day"],
  mtd: ["mtd", "month to date", "current month"],
  prevMtd: ["previous mtd", "prev mtd", "pmtd", "previous month"],
  currentMonth: ["current month", "this month"],
  previousMonth: ["previous month", "last month"],
  enr: ["enr", "ending net receivables", "earning net revenue"],
  mcc: ["mcc", "merchant category code", "category code"],
  plasticCategory: ["plastic category", "category", "item", "product"],
  currentQty: ["current quantity", "quantity"],
  avgMonthlyConsumption: ["average monthly consumption", "average monthly usage", "avg monthly consumption", "avg monthly usage"],
  minStock: ["required minimum stock", "minimum requirement", "minimum stock"],
  recordType: ["record type", "type"],
  pendingItems: ["pending / exception items", "pending items", "exception items"]
};

/* ---------------------------------------------------------------------
   0.1 CALCULATION ENGINE HELPERS
   --------------------------------------------------------------------- */

function calculatePercentageChange(current, previous) {
  if (previous === null || previous === undefined || previous === 0 || isNaN(previous)) return null;
  if (current === null || current === undefined || isNaN(current)) return null;
  return ((Number(current) - Number(previous)) / Math.abs(Number(previous))) * 100;
}

function calculateSuccessRate(successful, failed) {
  const succ = Number(successful) || 0;
  const fail = Number(failed) || 0;
  const total = succ + fail;
  if (total === 0) return 0;
  return (succ / total) * 100;
}

function calculateTotalTransactions(successful, failed) {
  return (Number(successful) || 0) + (Number(failed) || 0);
}

function calculateTotalAmount(val1, val2) {
  return (Number(val1) || 0) + (Number(val2) || 0);
}

function calculateTotalInterchange(domestic, international) {
  return (Number(domestic) || 0) + (Number(international) || 0);
}

function calculateShare(value, total) {
  const tot = Number(total) || 0;
  if (tot === 0) return 0;
  return ((Number(value) || 0) / tot) * 100;
}

function calculateMonthsCover(quantity, monthlyUsage) {
  const usage = Number(monthlyUsage) || 0;
  if (usage === 0) return 0;
  return (Number(quantity) || 0) / usage;
}

function calculateInventoryStatus(monthsCover) {
  const m = Number(monthsCover) || 0;
  if (m <= CARD_INVENTORY_RULES.criticalMonths) return "Critical";
  if (m <= CARD_INVENTORY_RULES.warningMonths) return "Warning";
  return "Sufficient";
}

function calculateRank(rows, keySelector, isDescending) {
  if (!Array.isArray(rows)) return [];
  const desc = isDescending !== undefined ? isDescending : true;
  const sorted = rows.slice().sort(function (a, b) {
    const valA = Number(keySelector(a)) || 0;
    const valB = Number(keySelector(b)) || 0;
    return desc ? valB - valA : valA - valB;
  });
  sorted.forEach(function (row, idx) {
    row.rank = idx + 1;
  });
  return sorted;
}

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

let cardFinancialsActiveTab = "credit"; // "credit" | "debit"
let chargebackActiveTab = "credit";       // "credit" | "debit"

/* Cached DOM references */
const dom = {};

/* ---------------------------------------------------------------------
   2. FORMATTING HELPERS
   --------------------------------------------------------------------- */

function formatNumber(value, decimals) {
  if (value === null || value === undefined || isNaN(value)) return "\u2014";
  const n = Number(value);
  const abs = Math.abs(n);
  const d = decimals !== undefined ? decimals : (abs % 1 === 0 ? 0 : 2);
  if (abs >= 1e9) return (n / 1e9).toFixed(decimals !== undefined ? decimals : 2) + " Bn";
  if (abs >= 1e6) return (n / 1e6).toFixed(decimals !== undefined ? decimals : 2) + " Mn";
  return n.toLocaleString("en-US", { maximumFractionDigits: d });
}

function formatCurrency(value, currency) {
  if (value === null || value === undefined || isNaN(value)) return "\u2014";
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
  if (value === null || value === undefined || isNaN(value)) return "\u2014";
  return Number(value).toFixed(decimals !== undefined ? decimals : 2) + "%";
}

function fullValueTitle(value, isCurrency, currency) {
  if (value === null || value === undefined || isNaN(value)) return "";
  const n = Number(value);
  const formatted = n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return isCurrency ? (currency || "PKR") + " " + formatted : formatted;
}

function indicatorHTML(current, previous, higherIsBetter, isMoM) {
  if (previous === null || previous === undefined || previous === 0 || isNaN(previous)) {
    return '<span class="indicator flat">&mdash; 0.00%</span>';
  }
  if (current === null || current === undefined || isNaN(current)) {
    return '<span class="indicator flat">&mdash; 0.00%</span>';
  }
  const pct = calculatePercentageChange(current, previous);
  if (pct === null) return '<span class="indicator flat">&mdash; 0.00%</span>';
  
  const change = current - previous;
  const better = higherIsBetter === undefined ? true : higherIsBetter;
  if (Math.abs(change) < 1e-9) {
    return '<span class="indicator flat">&mdash; 0.00%</span>';
  }
  const isUp = change > 0;
  const goodDirection = isUp ? better : !better;
  const cls = (isUp ? "up" : "down") + " " + (goodDirection ? "positive" : "negative");
  const arrow = isUp ? "&#9650;" : "&#9660;";
  const sign = isUp ? "+" : "-";
  return '<span class="indicator ' + cls + '">' + arrow + ' ' + sign + Math.abs(pct).toFixed(2) + '%</span>';
}

function formatUptimeComparison(today, yesterday) {
  if (today === null || today === undefined || isNaN(today)) {
    return { todayStr: "\u2014", yesterdayStr: "\u2014", html: '<span class="indicator flat">&mdash; 0.00%</span>' };
  }
  const tStr = Number(today).toFixed(1) + "%";
  if (yesterday === null || yesterday === undefined || isNaN(yesterday)) {
    return { todayStr: tStr, yesterdayStr: "\u2014", html: '<span class="indicator flat">&mdash; 0.00%</span>' };
  }
  const yStr = Number(yesterday).toFixed(1) + "%";
  const diff = today - yesterday;
  const isUp = diff > 0;
  const isFlat = Math.abs(diff) < 0.01;
  if (isFlat) {
    return { todayStr: tStr, yesterdayStr: yStr, html: '<span class="indicator flat">&mdash; 0.00%</span>' };
  }
  const cls = (isUp ? "up" : "down") + " " + (isUp ? "positive" : "negative");
  const arrow = isUp ? "&#9650;" : "&#9660;";
  const sign = isUp ? "+" : "-";
  const diffStr = arrow + ' ' + sign + Math.abs(diff).toFixed(2) + "%";
  const html = '<span class="indicator ' + cls + '">' + diffStr + '</span>';
  return { todayStr: tStr, yesterdayStr: yStr, html: html };
}

function calculateComparisons(current, previous, higherIsBetter, isMoM) {
  const hasPrev = previous !== null && previous !== undefined && !isNaN(previous) && previous !== 0;
  const change = hasPrev ? current - previous : null;
  const changePct = calculatePercentageChange(current, previous);
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

function buildTable(caption, columns, rows, emptyMessage) {
  const wrap = el("div", { class: "table-wrap" });
  if (!rows || rows.length === 0) {
    wrap.appendChild(el("div", { class: "no-data-note", text: emptyMessage || ("No data available" + (caption ? " for " + caption : "")) }));
    return wrap;
  }
  if (caption) wrap.appendChild(el("div", { class: "table-caption", text: caption }));
  const table = el("table", { class: "data-table" });
  const thead = el("thead");
  const headRow = el("tr");
  columns.forEach(function (c) {
    const isNum = c.numeric || c.percent || c.currency || c.rightAlign;
    const attrs = { class: isNum ? "num" : "", text: c.label };
    if (c.title) attrs.title = c.title;
    headRow.appendChild(el("th", attrs));
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  rows.forEach(function (row) {
    const tr = el("tr");
    columns.forEach(function (c) {
      let text;
      const raw = row[c.key];
      const isHtmlStr = typeof raw === "string" && (raw.indexOf("<") !== -1 || raw === "\u2014");
      
      if (isHtmlStr) {
        text = raw;
      } else if (c.currency) {
        text = formatCurrency(raw);
      } else if (c.percent) {
        text = formatPercentage(raw);
      } else if (c.numeric) {
        text = formatNumber(raw, c.decimals);
      } else {
        text = (raw === null || raw === undefined || raw === "") ? "\u2014" : raw;
      }
      
      text = String(text);
      const isMarkup = text.indexOf("<") !== -1;
      const isNum = c.numeric || c.percent || c.currency || c.rightAlign;
      const td = el("td", isMarkup ? { class: isNum ? "num" : "", html: text } : { class: isNum ? "num" : "", text: text });
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
  const base = {
    meta: { missingSheets: [], dataQualityMessages: [], source: "illustrative" },

    atm: {
      totalATMs: 1240, uptimeToday: 97.8, uptimeYesterday: 97.1, uptimeMTD: 97.4, uptimePrevMTD: 96.9,
      withdrawalCountToday: 68450, withdrawalCountYesterday: 65210, withdrawalCountMTD: 1452000, withdrawalCountPrevMTD: 1398000,
      withdrawalAmountToday: 812000000, withdrawalAmountYesterday: 779000000, withdrawalAmountMTD: 17650000000, withdrawalAmountPrevMTD: 16920000000,
      failedTxnToday: 1120, failedTxnYesterday: 1340, failedTxnMTD: 24600,
      disputesToday: 42, disputesMTD: 610,
      capturedCardsToday: 18, capturedCardsMTD: 260,
      retractTxnToday: 65, retractTxnMTD: 940
    },
    atmTop5Best: [
      { rank: 1, atmId: "ATM-0142", location: "Gulberg Main, Lahore", txnCount: 2450, txnAmount: 28600000, successRate: 99.4, uptime: 99.8 },
      { rank: 2, atmId: "ATM-0087", location: "Clifton Block 5, Karachi", txnCount: 2310, txnAmount: 26800000, successRate: 99.1, uptime: 99.6 },
      { rank: 3, atmId: "ATM-0311", location: "F-10 Markaz, Islamabad", txnCount: 2185, txnAmount: 25100000, successRate: 98.9, uptime: 99.5 },
      { rank: 4, atmId: "ATM-0206", location: "DHA Phase 6, Lahore", txnCount: 2050, txnAmount: 23800000, successRate: 98.7, uptime: 99.3 },
      { rank: 5, atmId: "ATM-0455", location: "Saddar, Rawalpindi", txnCount: 1990, txnAmount: 22900000, successRate: 98.5, uptime: 99.1 }
    ],
    atmBottom5: [
      { rank: 1, atmId: "ATM-0902", location: "Korangi Industrial Area", txnCount: 180, txnAmount: 1900000, successRate: 82.1, uptime: 84.2 },
      { rank: 2, atmId: "ATM-0765", location: "Hub Chowki", txnCount: 210, txnAmount: 2300000, successRate: 84.5, uptime: 86.0 },
      { rank: 3, atmId: "ATM-0633", location: "Mianwali Cantt", txnCount: 240, txnAmount: 2700000, successRate: 86.2, uptime: 88.4 },
      { rank: 4, atmId: "ATM-0518", location: "Muzaffargarh Bypass", txnCount: 265, txnAmount: 3100000, successRate: 87.0, uptime: 89.1 },
      { rank: 5, atmId: "ATM-0399", location: "Kotli AJK", txnCount: 290, txnAmount: 3400000, successRate: 88.4, uptime: 90.0 }
    ],

    raast: {
      successCountToday: 41200, successCountYesterday: 39500, successCountMTD: 895000,
      successAmountToday: 1980000000, successAmountYesterday: 1880000000, successAmountMTD: 41200000000,
      successRateToday: 98.59, successRateYesterday: 98.41, successRateMTD: 98.59,
      failedCountToday: 590, failedCountYesterday: 640, failedCountMTD: 12800,
      complaintsToday: 14, complaintsYesterday: 18, complaintsMTD: 210
    },
    ibft: {
      successCountToday: 27800, successCountYesterday: 26400, successCountMTD: 601000,
      successAmountToday: 3120000000, successAmountYesterday: 2950000000, successAmountMTD: 66800000000,
      successRateToday: 97.82, successRateYesterday: 97.49, successRateMTD: 98.07,
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
      { product: "Debit Gold Card", count: 188000, prevMonth: 184200, fee: 0 },
      { product: "Debit Platinum Card", count: 63500, prevMonth: 61900, fee: 0 },
      { product: "Credit Classic Card", count: 94000, prevMonth: 92100, fee: 0 },
      { product: "Credit Gold Card", count: 41200, prevMonth: 40100, fee: 0 },
      { product: "Credit Platinum Card", count: 15800, prevMonth: 15200, fee: 0 },
      { product: "World Elite Card", count: 2650, prevMonth: 2500, fee: 0 }
    ],

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
        enr: 12500000000, enrPrevious: 11800000000,
        interchangeExpense: 120000000
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
        enr: null, enrPrevious: null,
        interchangeExpense: 90000000
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
    topMerchants: [
      { rank: 1, merchant: "Merchant Group A", mcc: "5411", txnCount: 92000, spend: 2100000000, share: 27.4 },
      { rank: 2, merchant: "Merchant Group B", mcc: "5812", txnCount: 78500, spend: 1850000000, share: 24.1 },
      { rank: 3, merchant: "Merchant Group C", mcc: "4722", txnCount: 65200, spend: 1520000000, share: 19.8 },
      { rank: 4, merchant: "Merchant Group D", mcc: "5311", txnCount: 54000, spend: 1210000000, share: 15.8 },
      { rank: 5, merchant: "Merchant Group E", mcc: "5541", txnCount: 48900, spend: 980000000, share: 12.8 }
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
      { rank: 1, merchant: "Merchant Group F", mcc: "5999", disputeCount: 145, disputedAmount: 12100000, share: 28.2 },
      { rank: 2, merchant: "Merchant Group G", mcc: "5812", disputeCount: 118, disputedAmount: 10200000, share: 23.0 },
      { rank: 3, merchant: "Merchant Group H", mcc: "5411", disputeCount: 96, disputedAmount: 8600000, share: 18.7 },
      { rank: 4, merchant: "Merchant Group I", mcc: "4722", disputeCount: 84, disputedAmount: 7400000, share: 16.3 },
      { rank: 5, merchant: "Merchant Group J", mcc: "5311", disputeCount: 71, disputedAmount: 6300000, share: 13.8 }
    ],
    chargebackMerchantsByAmount: [
      { rank: 1, merchant: "Merchant Group F", mcc: "5999", chargebackCount: 145, chargebackAmount: 12100000, share: 24.1 },
      { rank: 2, merchant: "Merchant Group K", mcc: "5541", chargebackCount: 62, chargebackAmount: 11400000, share: 22.7 },
      { rank: 3, merchant: "Merchant Group G", mcc: "5812", chargebackCount: 118, chargebackAmount: 10200000, share: 20.3 },
      { rank: 4, merchant: "Merchant Group H", mcc: "5411", chargebackCount: 96, chargebackAmount: 8600000, share: 17.1 },
      { rank: 5, merchant: "Merchant Group L", mcc: "5732", chargebackCount: 54, chargebackAmount: 7900000, share: 15.7 }
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
        { bucket: "Current", txnCount: 940, amount: 210000000, share: 60.5 },
        { bucket: "30+", txnCount: 160, amount: 77700000, share: 22.4 },
        { bucket: "60+", txnCount: 93, amount: 40900000, share: 11.8 },
        { bucket: "90+", txnCount: 29, amount: 12100000, share: 3.5 },
        { bucket: "120+", txnCount: 18, amount: 6400000, share: 1.8 }
      ]
    },
    nostro: [
      { currency: "USD", gl: "NOSTRO-USD", balance: 18600000, prevBalance: 17800000, reportingDate: "2026-09-15" },
      { currency: "AED", gl: "NOSTRO-AED", balance: 6200000, prevBalance: 5900000, reportingDate: "2026-09-15" }
    ],
    rejected: {
      gl: "GL-60010", rejectedCount: 62, rejectedAmount: 8900000,
      repostedCount: 48, repostedAmount: 6800000,
      pendingCount: 14, pendingAmount: 2100000
    },
    oif: { caseCountCurrent: 96, valueCurrent: 62000000, caseCountPrevious: 88, valuePrevious: 55500000 },

    secureOperations: {
      totalTxnToday: 34500, totalTxnYesterday: 33200, totalTxnMTD: 785000, totalTxnPrevMTD: 752000,
      successTxnToday: 33900, successTxnYesterday: 32550, successTxnMTD: 770500, successTxnPrevMTD: 738000,
      failedTxnToday: 600, failedTxnYesterday: 650, failedTxnMTD: 14500, failedTxnPrevMTD: 14000,
      successRateToday: 98.26, successRateYesterday: 98.04, successRateMTD: 98.15, successRatePrevMTD: 98.14,
      totalAmountToday: 2450000000, totalAmountYesterday: 2310000000, totalAmountMTD: 54200000000, totalAmountPrevMTD: 51800000000,
      pendingItemsToday: 45, pendingItemsYesterday: 52, pendingItemsMTD: 980, pendingItemsPrevMTD: 1050
    },
    secureOpsBreakdown: [
      { channel: "3DS 2.0 Mobile Biometric", txnCount: 18560, amount: 1350000000, successRate: 99.1, pendingItems: 12 },
      { channel: "3DS 2.0 Web OTP", txnCount: 11480, amount: 780000000, successRate: 97.5, pendingItems: 21 },
      { channel: "Chip & PIN Terminal", txnCount: 3540, amount: 250000000, successRate: 98.8, pendingItems: 8 },
      { channel: "Tokenized Contactless (NFC)", txnCount: 1410, amount: 70000000, successRate: 99.3, pendingItems: 4 }
    ],

    unsecuredOperations: {
      totalTxnToday: 22100, totalTxnYesterday: 21400, totalTxnMTD: 498000, totalTxnPrevMTD: 475000,
      successTxnToday: 21450, successTxnYesterday: 20720, successTxnMTD: 482500, successTxnPrevMTD: 460000,
      failedTxnToday: 650, failedTxnYesterday: 680, failedTxnMTD: 15500, failedTxnPrevMTD: 15000,
      successRateToday: 97.06, successRateYesterday: 96.82, successRateMTD: 96.89, successRatePrevMTD: 96.84,
      totalAmountToday: 1680000000, totalAmountYesterday: 1590000000, totalAmountMTD: 37500000000, totalAmountPrevMTD: 35600000000,
      pendingItemsToday: 82, pendingItemsYesterday: 90, pendingItemsMTD: 1840, pendingItemsPrevMTD: 1950
    },
    unsecuredOpsBreakdown: [
      { product: "Personal Instant Credit", txnCount: 9440, amount: 720000000, successRate: 97.4, pendingItems: 34 },
      { product: "Virtual Card E-Com", txnCount: 7640, amount: 510000000, successRate: 96.8, pendingItems: 28 },
      { product: "Digital Overdraft Ops", txnCount: 3220, amount: 310000000, successRate: 96.2, pendingItems: 14 },
      { product: "BNPL / Installments", txnCount: 1785, amount: 140000000, successRate: 98.0, pendingItems: 6 }
    ],

    banca: {
      totalTxnToday: 8450, totalTxnYesterday: 8100, totalTxnMTD: 186000, totalTxnPrevMTD: 178000,
      successTxnToday: 8240, successTxnYesterday: 7890, successTxnMTD: 181200, successTxnPrevMTD: 173400,
      failedTxnToday: 210, failedTxnYesterday: 210, failedTxnMTD: 4800, failedTxnPrevMTD: 4600,
      successRateToday: 97.51, successRateYesterday: 97.41, successRateMTD: 97.42, successRatePrevMTD: 97.42,
      totalAmountToday: 940000000, totalAmountYesterday: 890000000, totalAmountMTD: 20800000000, totalAmountPrevMTD: 19600000000,
      pendingItemsToday: 18, pendingItemsYesterday: 22, pendingItemsMTD: 410, pendingItemsPrevMTD: 440
    },
    bancaOpsBreakdown: [
      { product: "Life Insurance Premium Collect", txnCount: 3870, amount: 420000000, successRate: 98.1, pendingItems: 7 },
      { product: "Health & Takaful Plan Ops", txnCount: 2470, amount: 280000000, successRate: 97.1, pendingItems: 6 },
      { product: "Auto & Credit Shield Ops", txnCount: 1290, amount: 150000000, successRate: 96.8, pendingItems: 3 },
      { product: "Investment Assurance Ops", txnCount: 808, amount: 90000000, successRate: 97.7, pendingItems: 2 }
    ]
  };

  return base;
}

/* ---------------------------------------------------------------------
   5. EXCEL / CSV PARSING & DATA NORMALIZATION ENGINE
   --------------------------------------------------------------------- */

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function getAliasedValue(row, canonicalKey, directKeys) {
  if (!row) return undefined;
  const aliasList = COLUMN_ALIASES[canonicalKey] || [];
  const normalizedRowKeys = {};
  Object.keys(row).forEach(function (k) { normalizedRowKeys[normalizeHeader(k)] = row[k]; });
  const allCandidates = (directKeys || []).concat(aliasList, [canonicalKey]);
  for (let i = 0; i < allCandidates.length; i++) {
    if (!allCandidates[i]) continue;
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

function filterByPeriod(rows, periodNames) {
  if (!Array.isArray(rows)) return [];
  const targets = Array.isArray(periodNames) ? periodNames.map(normalizeHeader) : [normalizeHeader(periodNames)];
  return rows.filter(function (row) {
    const p = normalizeHeader(getAliasedValue(row, null, ["Period", "Reporting Period", "Timeframe"]));
    return targets.indexOf(p) !== -1;
  });
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
    rawSheets["ATM"] = workbookOrRows;
    SHEET_NAMES.forEach(function (name) { if (name !== "ATM") missingSheets.push(name); });
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
  function str(row, key, direct) {
    const val = getAliasedValue(row, key, direct);
    return val !== undefined && val !== null ? String(val).trim() : "";
  }

  // 1. ATM
  if (rawSheets["ATM"] && rawSheets["ATM"].length) {
    const rows = rawSheets["ATM"];
    const todayRows = filterByPeriod(rows, ["today"]);
    const yesterdayRows = filterByPeriod(rows, ["yesterday"]);
    const mtdRows = filterByPeriod(rows, ["current month", "mtd"]);
    const prevMtdRows = filterByPeriod(rows, ["previous month", "prev mtd", "pmtd"]);

    const individualTodayAtms = todayRows.filter(function (r) {
      const id = str(r, null, ["ATM ID"]);
      return id && id.toUpperCase() !== "ALL-ATMS";
    }).map(function (row) {
      const count = num(row, "txnCount", ["Transaction Count", "Withdrawal Count"]) || 0;
      const amount = num(row, "txnAmount", ["Transaction Amount", "Withdrawal Amount"]) || 0;
      const failed = num(row, "failedTxn", ["Failed Transaction Count", "Failed Count"]) || 0;
      const uptime = num(row, null, ["Uptime"]) || 0;
      const succRate = calculateSuccessRate(count - failed, failed);
      return {
        atmId: str(row, null, ["ATM ID"]) || "ATM-0000",
        location: str(row, null, ["ATM Location", "Location"]) || "Branch",
        txnCount: count,
        txnAmount: amount,
        successRate: succRate,
        uptime: uptime
      };
    });

    const netToday = filterByPeriod(rows, ["today"]).find(function (r) { return str(r, null, ["ATM ID"]).toUpperCase() === "ALL-ATMS"; }) || {};
    const netYest = filterByPeriod(rows, ["yesterday"]).find(function (r) { return str(r, null, ["ATM ID"]).toUpperCase() === "ALL-ATMS"; }) || {};
    const netMtd = filterByPeriod(rows, ["current month", "mtd"]).find(function (r) { return str(r, null, ["ATM ID"]).toUpperCase() === "ALL-ATMS"; }) || {};
    const netPrev = filterByPeriod(rows, ["previous month", "prev mtd", "pmtd"]).find(function (r) { return str(r, null, ["ATM ID"]).toUpperCase() === "ALL-ATMS"; }) || {};

    const sumTodayCount = individualTodayAtms.length ? individualTodayAtms.reduce(function(s, r){ return s + r.txnCount; }, 0) : num(netToday, "txnCount", ["Transaction Count"]);
    const sumTodayAmount = individualTodayAtms.length ? individualTodayAtms.reduce(function(s, r){ return s + r.txnAmount; }, 0) : num(netToday, "txnAmount", ["Transaction Amount"]);

    data.atm = {
      totalATMs: individualTodayAtms.length || 1240,
      uptimeToday: num(netToday, null, ["Uptime"]) || (individualTodayAtms.length ? individualTodayAtms.reduce(function(s,r){return s+r.uptime;},0)/individualTodayAtms.length : 97.8),
      uptimeYesterday: num(netYest, null, ["Uptime"]) || 97.1,
      uptimeMTD: num(netMtd, null, ["Uptime"]) || 97.4,
      uptimePrevMTD: num(netPrev, null, ["Uptime"]) || 96.9,

      withdrawalCountToday: sumTodayCount,
      withdrawalCountYesterday: num(netYest, "txnCount", ["Transaction Count"]) || 65210,
      withdrawalCountMTD: num(netMtd, "txnCount", ["Transaction Count"]) || 1452000,
      withdrawalCountPrevMTD: num(netPrev, "txnCount", ["Transaction Count"]) || 1398000,

      withdrawalAmountToday: sumTodayAmount,
      withdrawalAmountYesterday: num(netYest, "txnAmount", ["Transaction Amount"]) || 779000000,
      withdrawalAmountMTD: num(netMtd, "txnAmount", ["Transaction Amount"]) || 17650000000,
      withdrawalAmountPrevMTD: num(netPrev, "txnAmount", ["Transaction Amount"]) || 16920000000,

      failedTxnToday: num(netToday, "failedTxn", ["Failed Transaction Count"]) || 1120,
      failedTxnYesterday: num(netYest, "failedTxn", ["Failed Transaction Count"]) || 1340,
      failedTxnMTD: num(netMtd, "failedTxn", ["Failed Transaction Count"]) || 24600,

      disputesToday: num(netToday, null, ["Dispute Count"]) || 42,
      disputesMTD: num(netMtd, null, ["Dispute Count"]) || 610,
      capturedCardsToday: num(netToday, "capturedCards", ["Captured Cards Count"]) || 18,
      capturedCardsMTD: num(netMtd, "capturedCards", ["Captured Cards Count"]) || 260,
      retractTxnToday: num(netToday, null, ["Cash Retract Count"]) || 65,
      retractTxnMTD: num(netMtd, null, ["Cash Retract Count"]) || 940
    };

    if (individualTodayAtms.length > 0) {
      data.atmTop5Best = calculateRank(individualTodayAtms, function(r){ return r.txnCount; }, true).slice(0, 5);
      data.atmBottom5 = calculateRank(individualTodayAtms, function(r){ return r.txnCount; }, false).slice(0, 5);
    } else {
      data.atmTop5Best = generateIllustrativeData().atmTop5Best;
      data.atmBottom5 = generateIllustrativeData().atmBottom5;
    }
  }

  // 2. RAAST
  if (rawSheets["RAAST"] && rawSheets["RAAST"].length) {
    const rows = rawSheets["RAAST"];
    const tRow = filterByPeriod(rows, ["today"])[0] || rows[0] || {};
    const yRow = filterByPeriod(rows, ["yesterday"])[0] || rows[1] || {};
    const mRow = filterByPeriod(rows, ["current month", "mtd"])[0] || rows[2] || {};

    const succT = num(tRow, "successfulTxn", ["Successful Transaction Count"]) || 0;
    const failT = num(tRow, "failedTxn", ["Failed Transaction Count"]) || 0;
    const succY = num(yRow, "successfulTxn", ["Successful Transaction Count"]) || 0;
    const failY = num(yRow, "failedTxn", ["Failed Transaction Count"]) || 0;
    const succM = num(mRow, "successfulTxn", ["Successful Transaction Count"]) || 0;
    const failM = num(mRow, "failedTxn", ["Failed Transaction Count"]) || 0;

    data.raast = {
      successCountToday: succT,
      successAmountToday: num(tRow, "successfulAmt", ["Successful Transaction Amount"]),
      failedCountToday: failT,
      complaintsToday: num(tRow, "complaintCount", ["Complaints"]),
      successRateToday: calculateSuccessRate(succT, failT),

      successCountYesterday: succY,
      successAmountYesterday: num(yRow, "successfulAmt", ["Successful Transaction Amount"]),
      failedCountYesterday: failY,
      complaintsYesterday: num(yRow, "complaintCount", ["Complaints"]),
      successRateYesterday: calculateSuccessRate(succY, failY),

      successCountMTD: succM,
      successAmountMTD: num(mRow, "successfulAmt", ["Successful Transaction Amount"]),
      failedCountMTD: failM,
      complaintsMTD: num(mRow, "complaintCount", ["Complaints"]),
      successRateMTD: calculateSuccessRate(succM, failM)
    };
  }

  // 3. IBFT
  if (rawSheets["IBFT"] && rawSheets["IBFT"].length) {
    const rows = rawSheets["IBFT"];
    const tRow = filterByPeriod(rows, ["today"])[0] || rows[0] || {};
    const yRow = filterByPeriod(rows, ["yesterday"])[0] || rows[1] || {};
    const mRow = filterByPeriod(rows, ["current month", "mtd"])[0] || rows[2] || {};

    const succT = num(tRow, "successfulTxn", ["Successful Transaction Count"]) || 0;
    const failT = num(tRow, "failedTxn", ["Failed Transaction Count"]) || 0;
    const succY = num(yRow, "successfulTxn", ["Successful Transaction Count"]) || 0;
    const failY = num(yRow, "failedTxn", ["Failed Transaction Count"]) || 0;
    const succM = num(mRow, "successfulTxn", ["Successful Transaction Count"]) || 0;
    const failM = num(mRow, "failedTxn", ["Failed Transaction Count"]) || 0;

    data.ibft = {
      successCountToday: succT,
      successAmountToday: num(tRow, "successfulAmt", ["Successful Transaction Amount"]),
      failureCountToday: failT,
      complaintsToday: num(tRow, "complaintCount", ["Complaints"]),
      successRateToday: calculateSuccessRate(succT, failT),

      successCountYesterday: succY,
      successAmountYesterday: num(yRow, "successfulAmt", ["Successful Transaction Amount"]),
      failureCountYesterday: failY,
      complaintsYesterday: num(yRow, "complaintCount", ["Complaints"]),
      successRateYesterday: calculateSuccessRate(succY, failY),

      successCountMTD: succM,
      successAmountMTD: num(mRow, "successfulAmt", ["Successful Transaction Amount"]),
      failureCountMTD: failM,
      complaintsMTD: num(mRow, "complaintCount", ["Complaints"]),
      successRateMTD: calculateSuccessRate(succM, failM)
    };
  }

  // 4. IBFT_Failures
  if (rawSheets["IBFT_Failures"] && rawSheets["IBFT_Failures"].length) {
    const rows = rawSheets["IBFT_Failures"];
    const map = {};
    rows.forEach(function (r) {
      const reason = str(r, null, ["Failure Reason", "Reason"]) || "Other";
      if (!map[reason]) map[reason] = { reason: reason, today: 0, yesterday: 0, mtd: 0 };
      const period = normalizeHeader(str(r, null, ["Period"]));
      const cnt = num(r, "txnCount", ["Failure Count", "Count"]) || 0;
      if (period === "today") map[reason].today += cnt;
      else if (period === "yesterday") map[reason].yesterday += cnt;
      else map[reason].mtd += cnt;
    });
    data.ibftFailures = Object.keys(map).map(function(k){ return map[k]; });
  }

  // 5. Card_Inventory
  if (rawSheets["Card_Inventory"] && rawSheets["Card_Inventory"].length) {
    data.cardInventory = rawSheets["Card_Inventory"].map(function (row) {
      let rawCat = str(row, "plasticCategory", ["Plastic Category", "Category"]) || "Other";
      if (rawCat.indexOf("Card") === -1 && !/envelope|mailer|pack/i.test(rawCat)) {
        rawCat = rawCat + " Card";
      }
      return {
        category: rawCat,
        qty: num(row, "currentQty", ["Current Quantity", "Quantity"]),
        avgMonthlyUse: num(row, "avgMonthlyConsumption", ["Average Monthly Consumption", "Avg Monthly Consumption"]),
        minStock: num(row, "minStock", ["Required Minimum Stock", "Minimum Stock"])
      };
    });
  }

  // 6. Card_Stationery
  if (rawSheets["Card_Stationery"] && rawSheets["Card_Stationery"].length) {
    data.cardStationery = rawSheets["Card_Stationery"].map(function (row) {
      return {
        item: str(row, null, ["Item"]) || "Other",
        qty: num(row, "currentQty", ["Current Quantity", "Quantity"]),
        avgMonthlyUse: num(row, "avgMonthlyConsumption", ["Average Monthly Usage", "Avg Monthly Usage"]),
        minStock: num(row, "minStock", ["Minimum Requirement", "Minimum Stock"])
      };
    });
  }

  // 7. Active_Cards
  if (rawSheets["Active_Cards"] && rawSheets["Active_Cards"].length) {
    const rows = rawSheets["Active_Cards"];
    const map = {};
    rows.forEach(function (row) {
      let rawProd = str(row, null, ["Product"]) || "Other";
      if (rawProd.indexOf("Card") === -1) rawProd = rawProd + " Card";
      if (!map[rawProd]) map[rawProd] = { product: rawProd, count: 0, prevMonth: 0, fee: 0 };
      const period = normalizeHeader(str(row, null, ["Period"]));
      const cnt = num(row, null, ["Active Card Count", "Count"]) || 0;
      if (period === "previous month" || period === "prev month") {
        map[rawProd].prevMonth += cnt;
      } else {
        map[rawProd].count += cnt;
      }
    });
    data.activeCards = Object.keys(map).map(function(k){ return map[k]; });
  }

  // 8. Card_Financials
  if (rawSheets["Card_Financials"] && rawSheets["Card_Financials"].length) {
    const rows = rawSheets["Card_Financials"];
    function extractFin(typeStr) {
      const typeRows = rows.filter(function (r) {
        return normalizeHeader(str(r, null, ["Card Type", "Type"])) === normalizeHeader(typeStr);
      });
      const curRow = filterByPeriod(typeRows, ["current month", "mtd"])[0] || typeRows[0] || {};
      const prevRow = filterByPeriod(typeRows, ["previous month", "prev mtd"])[0] || typeRows[1] || {};

      const domTxnAmtCur = num(curRow, null, ["Domestic Transaction Amount"]) || 0;
      const intlTxnAmtCur = num(curRow, null, ["International Transaction Amount"]) || 0;
      const domTxnAmtPrev = num(prevRow, null, ["Domestic Transaction Amount"]) || 0;
      const intlTxnAmtPrev = num(prevRow, null, ["International Transaction Amount"]) || 0;

      const domTxnCntCur = num(curRow, null, ["Domestic Transaction Count"]) || 0;
      const intlTxnCntCur = num(curRow, null, ["International Transaction Count"]) || 0;
      const domTxnCntPrev = num(prevRow, null, ["Domestic Transaction Count"]) || 0;
      const intlTxnCntPrev = num(prevRow, null, ["International Transaction Count"]) || 0;

      const domInterCur = num(curRow, null, ["Domestic Interchange Income"]) || 0;
      const intlInterCur = num(curRow, null, ["International Interchange Income"]) || 0;
      const domInterPrev = num(prevRow, null, ["Domestic Interchange Income"]) || 0;
      const intlInterPrev = num(prevRow, null, ["International Interchange Income"]) || 0;

      return {
        cif: num(curRow, null, ["CIF"]),
        cifPrevious: num(prevRow, null, ["CIF"]),
        aif: num(curRow, null, ["AIF"]),
        aifPrevious: num(prevRow, null, ["AIF"]),
        spendCurrent: calculateTotalAmount(domTxnAmtCur, intlTxnAmtCur),
        spendPrevious: calculateTotalAmount(domTxnAmtPrev, intlTxnAmtPrev),
        domesticTxnCount: domTxnCntCur,
        domesticTxnCountPrevious: domTxnCntPrev,
        domesticTxnAmount: domTxnAmtCur,
        domesticTxnAmountPrevious: domTxnAmtPrev,
        intlTxnCount: intlTxnCntCur,
        intlTxnCountPrevious: intlTxnCntPrev,
        intlTxnAmount: intlTxnAmtCur,
        intlTxnAmountPrevious: intlTxnAmtPrev,
        annualFeeIncome: num(curRow, null, ["Annual Fee Income"]),
        annualFeeIncomePrevious: num(prevRow, null, ["Annual Fee Income"]),
        oifIncome: num(curRow, null, ["OIF Income"]),
        oifIncomePrevious: num(prevRow, null, ["OIF Income"]),
        domesticInterchange: domInterCur,
        domesticInterchangePrevious: domInterPrev,
        intlInterchange: intlInterCur,
        intlInterchangePrevious: intlInterPrev,
        mdrIncome: num(curRow, null, ["MDR Income"]),
        mdrIncomePrevious: num(prevRow, null, ["MDR Income"]),
        enr: num(curRow, "enr", ["ENR"]),
        enrPrevious: num(prevRow, "enr", ["ENR"]),
        interchangeExpense: num(curRow, null, ["Interchange Expense"]) || 0,
        interchangeExpensePrevious: num(prevRow, null, ["Interchange Expense"]) || 0
      };
    }

    const creditData = extractFin("Credit");
    const debitData = extractFin("Debit");

    data.cardFinancials = { credit: creditData, debit: debitData };

    // 9. Spend_By_Product (Derived from Card_Financials)
    data.spendByProduct = [
      { product: "Debit Card", currentBn: debitData.spendCurrent / 1e9, previousBn: debitData.spendPrevious / 1e9 },
      { product: "Credit Card", currentBn: creditData.spendCurrent / 1e9, previousBn: creditData.spendPrevious / 1e9 }
    ];

    const totInterIncome = (creditData.domesticInterchange + creditData.intlInterchange) + (debitData.domesticInterchange + debitData.intlInterchange);
    const totInterExpense = creditData.interchangeExpense + debitData.interchangeExpense;
    data.netInterchange = { income: totInterIncome, expense: totInterExpense };
  }

  // 10. Spend_By_Channel
  if (rawSheets["Spend_By_Channel"] && rawSheets["Spend_By_Channel"].length) {
    const rows = rawSheets["Spend_By_Channel"];
    const map = {};
    rows.forEach(function (row) {
      const channel = str(row, null, ["Channel"]) || "Other";
      if (!map[channel]) map[channel] = { channel: channel, current: 0, previous: 0 };
      const period = normalizeHeader(str(row, null, ["Period"]));
      const amt = num(row, "txnAmount", ["Transaction Amount"]) || 0;
      if (period === "previous month" || period === "prev month") {
        map[channel].previous += amt;
      } else {
        map[channel].current += amt;
      }
    });
    data.spendByChannel = Object.keys(map).map(function(k){ return map[k]; });
  }

  // 11. Top_Merchants
  if (rawSheets["Top_Merchants"] && rawSheets["Top_Merchants"].length) {
    const rows = rawSheets["Top_Merchants"];
    const totalSpend = rows.reduce(function (s, r) { return s + (num(r, "txnAmount", ["Transaction Amount"]) || 0); }, 0);
    const merchantList = rows.map(function (row) {
      const spendAmt = num(row, "txnAmount", ["Transaction Amount"]) || 0;
      return {
        merchant: str(row, null, ["Merchant Name", "Merchant"]) || "Merchant Group",
        mcc: str(row, "mcc", ["MCC", "Merchant Category Code"]) || "0000",
        txnCount: num(row, "txnCount", ["Transaction Count"]),
        spend: spendAmt,
        share: calculateShare(spendAmt, totalSpend)
      };
    });
    data.topMerchants = calculateRank(merchantList, function(r){ return r.spend; }, true).slice(0, 5);
  }

  // 12. Chargeback
  if (rawSheets["Chargeback"] && rawSheets["Chargeback"].length) {
    const rows = rawSheets["Chargeback"];
    function parseCbForType(cardType) {
      const typeRows = rows.filter(function (r) {
        return normalizeHeader(str(r, null, ["Card Type", "Type"])) === normalizeHeader(cardType);
      });
      function getMetric(name) {
        const mRows = typeRows.filter(function (r) {
          return normalizeHeader(str(r, null, ["Metric"])) === normalizeHeader(name);
        });
        const curRow = filterByPeriod(mRows, ["current month", "mtd"])[0] || mRows[0] || {};
        const prevRow = filterByPeriod(mRows, ["previous month", "prev mtd"])[0] || mRows[1] || {};
        return {
          count: num(curRow, null, ["Count"]) || 0,
          amount: num(curRow, null, ["Amount"]) || 0,
          prevCount: num(prevRow, null, ["Count"]) || 0,
          prevAmount: num(prevRow, null, ["Amount"]) || 0
        };
      }
      return {
        domestic: getMetric("Domestic Disputes"),
        international: getMetric("International Disputes"),
        pos: getMetric("POS Disputes"),
        ecommerce: getMetric("E-Commerce Disputes"),
        preArbRaised: getMetric("Pre-Arbitration Raised"),
        preArbReceived: getMetric("Pre-Arbitration Received"),
        highAging: getMetric("High-Aging Disputes")
      };
    }

    data.chargeback = {
      credit: parseCbForType("Credit"),
      debit: parseCbForType("Debit")
    };
  }

  // 13. Chargeback_Merchants
  if (rawSheets["Chargeback_Merchants"] && rawSheets["Chargeback_Merchants"].length) {
    const rows = rawSheets["Chargeback_Merchants"];
    const totalDisputes = rows.reduce(function (s, r) { return s + (num(r, null, ["Dispute Count"]) || 0); }, 0);
    const totalCbAmount = rows.reduce(function (s, r) { return s + (num(r, null, ["Chargeback Amount"]) || 0); }, 0);

    const parsedList = rows.map(function (row) {
      const dispCount = num(row, null, ["Dispute Count"]) || 0;
      const dispAmount = num(row, null, ["Disputed Amount"]) || 0;
      const cbCount = num(row, null, ["Chargeback Count"]) || dispCount;
      const cbAmount = num(row, null, ["Chargeback Amount"]) || dispAmount;
      return {
        merchant: str(row, null, ["Merchant"]) || "Merchant Group",
        mcc: str(row, "mcc", ["MCC", "Merchant Category Code"]) || "0000",
        disputeCount: dispCount,
        disputedAmount: dispAmount,
        chargebackCount: cbCount,
        chargebackAmount: cbAmount,
        countShare: calculateShare(dispCount, totalDisputes),
        amountShare: calculateShare(cbAmount, totalCbAmount)
      };
    });

    const byCount = calculateRank(parsedList, function(r){ return r.disputeCount; }, true).slice(0, 5).map(function(r){
      return Object.assign({}, r, { share: r.countShare });
    });
    const byAmount = calculateRank(parsedList, function(r){ return r.chargebackAmount; }, true).slice(0, 5).map(function(r){
      return Object.assign({}, r, { share: r.amountShare });
    });

    data.chargebackMerchantsByCount = byCount;
    data.chargebackMerchantsByAmount = byAmount;
  }

  // 14. Reconciliation
  if (rawSheets["Reconciliation"] && rawSheets["Reconciliation"].length) {
    const rows = rawSheets["Reconciliation"];
    function reconRow(row) {
      return {
        gl: str(row, "gl", ["GL"]) || "GL-0000",
        description: str(row, null, ["GL Description", "Description"]) || "",
        txnCount: num(row, "txnCount", ["Transaction Count"]),
        amount: num(row, "txnAmount", ["Transaction Amount"]),
        bucket: str(row, null, ["Aging Bucket", "Bucket"]) || "Current"
      };
    }
    const receivables = rows.filter(function (r) { return normalizeHeader(str(r, null, ["Type"])) === "receivable"; });
    const payables = rows.filter(function (r) { return normalizeHeader(str(r, null, ["Type"])) === "payable"; });
    data.reconciliation = {
      receivables: receivables.map(reconRow),
      payables: payables.map(reconRow),
      agingBuckets: null
    };
    data.reconciliation.agingBuckets = deriveAgingBuckets(data.reconciliation);
  }

  // 15. NOSTRO (USD & AED Only)
  if (rawSheets["Nostro"] && rawSheets["Nostro"].length) {
    const filteredNostro = rawSheets["Nostro"].filter(function (row) {
      const curStr = (str(row, null, ["Currency"]) + " " + str(row, "gl", ["Nostro GL"])).toUpperCase();
      return curStr.indexOf("USD") !== -1 || curStr.indexOf("AED") !== -1;
    });
    data.nostro = (filteredNostro.length ? filteredNostro : rawSheets["Nostro"].slice(0, 2)).map(function (row) {
      const rawGl = str(row, "gl", ["Nostro GL", "GL"]) || "NOSTRO-USD";
      const gl = rawGl.replace(/-01$/i, "").replace(/-01\b/i, "");
      const cur = /usd/i.test(gl) || /usd/i.test(str(row, null, ["Currency"])) ? "USD" : "AED";
      const curBal = num(row, null, ["Available Balance", "Balance"]);
      const prevBal = num(row, null, ["Previous Balance", "Prev Balance", "Previous Month Balance"]);
      return {
        currency: cur,
        gl: gl,
        balance: curBal !== null ? curBal : (cur === "USD" ? 18600000 : 6200000),
        prevBalance: prevBal !== null ? prevBal : (cur === "USD" ? 17800000 : 5900000),
        reportingDate: str(row, null, ["Reporting Date"]) || ""
      };
    });
  }

  // 16. Rejected_Transactions
  if (rawSheets["Rejected_Transactions"] && rawSheets["Rejected_Transactions"].length) {
    const r = rawSheets["Rejected_Transactions"][0] || {};
    data.rejected = {
      gl: str(r, "gl", ["GL"]) || "GL-60010",
      rejectedCount: num(r, null, ["Rejected Transaction Count"]),
      rejectedAmount: num(r, null, ["Rejected Transaction Amount"]),
      repostedCount: num(r, null, ["Reposted Count"]),
      repostedAmount: num(r, null, ["Reposted Amount"]),
      pendingCount: num(r, null, ["Pending Count"]),
      pendingAmount: num(r, null, ["Pending Amount"])
    };
  }

  // 17. OIF_Monitoring
  if (rawSheets["OIF_Monitoring"] && rawSheets["OIF_Monitoring"].length) {
    const rows = rawSheets["OIF_Monitoring"];
    const curRow = filterByPeriod(rows, ["current month", "mtd"])[0] || rows[0] || {};
    const prevRow = filterByPeriod(rows, ["previous month", "prev mtd"])[0] || rows[1] || {};
    data.oif = {
      caseCountCurrent: num(curRow, null, ["OIF Case Count"]),
      valueCurrent: num(curRow, "txnAmount", ["OIF Value"]),
      caseCountPrevious: num(prevRow, null, ["OIF Case Count"]),
      valuePrevious: num(prevRow, "txnAmount", ["OIF Value"])
    };
  }

  // Helper for operations sheets: Secure_Operations, Unsecured_Operations, Banca
  function parseOpsSheet(sheetName) {
    if (!rawSheets[sheetName] || !rawSheets[sheetName].length) return null;
    const rows = rawSheets[sheetName];
    const summaryRows = rows.filter(function (r) {
      return normalizeHeader(str(r, "recordType", ["Record Type"])) === "summary";
    });
    const breakdownRows = rows.filter(function (r) {
      return normalizeHeader(str(r, "recordType", ["Record Type"])) === "breakdown";
    });

    const tRow = filterByPeriod(summaryRows, ["today"])[0] || summaryRows[0] || {};
    const yRow = filterByPeriod(summaryRows, ["yesterday"])[0] || summaryRows[1] || {};
    const mRow = filterByPeriod(summaryRows, ["current month", "mtd"])[0] || summaryRows[2] || {};
    const pRow = filterByPeriod(summaryRows, ["previous month", "prev mtd"])[0] || summaryRows[3] || {};

    const succT = num(tRow, "successfulTxn", ["Successful Transaction Count"]) || 0;
    const failT = num(tRow, "failedTxn", ["Failed Transaction Count"]) || 0;
    const succY = num(yRow, "successfulTxn", ["Successful Transaction Count"]) || 0;
    const failY = num(yRow, "failedTxn", ["Failed Transaction Count"]) || 0;
    const succM = num(mRow, "successfulTxn", ["Successful Transaction Count"]) || 0;
    const failM = num(mRow, "failedTxn", ["Failed Transaction Count"]) || 0;
    const succP = num(pRow, "successfulTxn", ["Successful Transaction Count"]) || 0;
    const failP = num(pRow, "failedTxn", ["Failed Transaction Count"]) || 0;

    const execSummary = {
      totalTxnToday: calculateTotalTransactions(succT, failT),
      totalTxnYesterday: calculateTotalTransactions(succY, failY),
      totalTxnMTD: calculateTotalTransactions(succM, failM),
      totalTxnPrevMTD: calculateTotalTransactions(succP, failP),

      successTxnToday: succT,
      successTxnYesterday: succY,
      successTxnMTD: succM,
      successTxnPrevMTD: succP,

      failedTxnToday: failT,
      failedTxnYesterday: failY,
      failedTxnMTD: failM,
      failedTxnPrevMTD: failP,

      successRateToday: calculateSuccessRate(succT, failT),
      successRateYesterday: calculateSuccessRate(succY, failY),
      successRateMTD: calculateSuccessRate(succM, failM),
      successRatePrevMTD: calculateSuccessRate(succP, failP),

      totalAmountToday: num(tRow, "txnAmount", ["Transaction Amount"]) || 0,
      totalAmountYesterday: num(yRow, "txnAmount", ["Transaction Amount"]) || 0,
      totalAmountMTD: num(mRow, "txnAmount", ["Transaction Amount"]) || 0,
      totalAmountPrevMTD: num(pRow, "txnAmount", ["Transaction Amount"]) || 0,

      pendingItemsToday: num(tRow, "pendingItems", ["Pending / Exception Items"]) || 0,
      pendingItemsYesterday: num(yRow, "pendingItems", ["Pending / Exception Items"]) || 0,
      pendingItemsMTD: num(mRow, "pendingItems", ["Pending / Exception Items"]) || 0,
      pendingItemsPrevMTD: num(pRow, "pendingItems", ["Pending / Exception Items"]) || 0
    };

    const breakdownList = breakdownRows.map(function (r) {
      const succ = num(r, "successfulTxn", ["Successful Transaction Count"]) || 0;
      const fail = num(r, "failedTxn", ["Failed Transaction Count"]) || 0;
      const categoryName = str(r, null, ["Category", "Channel", "Product"]) || "Channel";
      return {
        channel: categoryName,
        product: categoryName,
        txnCount: calculateTotalTransactions(succ, fail),
        amount: num(r, "txnAmount", ["Transaction Amount"]) || 0,
        successRate: calculateSuccessRate(succ, fail),
        pendingItems: num(r, "pendingItems", ["Pending / Exception Items"]) || 0
      };
    });

    return { summary: execSummary, breakdown: breakdownList };
  }

  // 18. Secure_Operations
  const parsedSec = parseOpsSheet("Secure_Operations");
  if (parsedSec) {
    data.secureOperations = parsedSec.summary;
    data.secureOpsBreakdown = parsedSec.breakdown;
  }

  // 19. Unsecured_Operations
  const parsedUnsec = parseOpsSheet("Unsecured_Operations");
  if (parsedUnsec) {
    data.unsecuredOperations = parsedUnsec.summary;
    data.unsecuredOpsBreakdown = parsedUnsec.breakdown;
  }

  // 20. Banca
  const parsedBanca = parseOpsSheet("Banca");
  if (parsedBanca) {
    data.banca = parsedBanca.summary;
    data.bancaOpsBreakdown = parsedBanca.breakdown;
  }

  if (missingSheets.length) {
    data.meta.dataQualityMessages.push(
      "The following sheets were not found in the uploaded workbook: " + missingSheets.join(", ") + ". Related sections display default illustrative benchmarks."
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

const VALID_PAGES = ["overview", "adc-operations", "card-non-financials", "card-financials", "chargeback", "reconciliation", "secure-operations", "unsecured-operations", "banca"];

function navigateToPage(pageId, targetId) {
  if (VALID_PAGES.indexOf(pageId) === -1) pageId = "overview";

  const scrollToTarget = function () {
    if (targetId) {
      setTimeout(function () {
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 50);
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  if (window.location.hash !== "#" + pageId) {
    window.location.hash = "#" + pageId;
    scrollToTarget();
  } else {
    applyActivePage(pageId);
    scrollToTarget();
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
   8. FILTERS & GLOBAL DATA TRANSFORMER
   --------------------------------------------------------------------- */

function syncFilterControls(source) {
  if (!dom.filterPeriod) return;
  const now = new Date();
  const curYr = now.getFullYear();
  const curMo = String(now.getMonth() + 1).padStart(2, "0");
  const defaultMonth = curYr + "-" + curMo;

  if (source === "month") {
    if (dom.filterReportingMonth && dom.filterReportingMonth.value) {
      dom.filterPeriod.value = "month";
      const parts = dom.filterReportingMonth.value.split("-");
      const yr = parseInt(parts[0], 10);
      const mo = parseInt(parts[1], 10);
      const lastDay = new Date(yr, mo, 0).getDate();
      const moStr = String(mo).padStart(2, "0");
      if (dom.filterFromDate) dom.filterFromDate.value = yr + "-" + moStr + "-01";
      if (dom.filterToDate) dom.filterToDate.value = yr + "-" + moStr + "-" + String(lastDay).padStart(2, "0");
      if (dom.filterReportingDate) dom.filterReportingDate.value = dom.filterFromDate.value;
    }
  } else if (source === "date") {
    if (dom.filterFromDate && dom.filterToDate && dom.filterFromDate.value && dom.filterToDate.value) {
      dom.filterPeriod.value = "custom";
      if (dom.filterReportingDate) dom.filterReportingDate.value = dom.filterFromDate.value;
    }
  } else if (source === "period") {
    const val = dom.filterPeriod.value;
    if (val === "month") {
      if (dom.filterReportingMonth && !dom.filterReportingMonth.value) {
        dom.filterReportingMonth.value = defaultMonth;
      }
      if (dom.filterReportingMonth && dom.filterReportingMonth.value) {
        const parts = dom.filterReportingMonth.value.split("-");
        const yr = parseInt(parts[0], 10);
        const mo = parseInt(parts[1], 10);
        const lastDay = new Date(yr, mo, 0).getDate();
        const moStr = String(mo).padStart(2, "0");
        if (dom.filterFromDate) dom.filterFromDate.value = yr + "-" + moStr + "-01";
        if (dom.filterToDate) dom.filterToDate.value = yr + "-" + moStr + "-" + String(lastDay).padStart(2, "0");
        if (dom.filterReportingDate) dom.filterReportingDate.value = dom.filterFromDate.value;
      }
    } else if (val === "today") {
      const todayStr = curYr + "-" + curMo + "-" + String(now.getDate()).padStart(2, "0");
      if (dom.filterFromDate) dom.filterFromDate.value = todayStr;
      if (dom.filterToDate) dom.filterToDate.value = todayStr;
      if (dom.filterReportingDate) dom.filterReportingDate.value = todayStr;
    }
  }
}

function applyFilters(source) {
  if (typeof source === "string" || (source && source.target)) {
    const src = typeof source === "string" ? source : (source.target === dom.filterReportingMonth ? "month" : (source.target === dom.filterPeriod ? "period" : (source.target === dom.filterFromDate || source.target === dom.filterToDate ? "date" : null)));
    if (src) syncFilterControls(src);
  }

  const mode = dom.filterPeriod ? dom.filterPeriod.value : "today";
  const monthVal = dom.filterReportingMonth ? dom.filterReportingMonth.value : "";
  const fromVal = dom.filterFromDate ? dom.filterFromDate.value : "";
  const toVal = dom.filterToDate ? dom.filterToDate.value : "";

  let daysCount = 15;
  let daysInMonth = 31;
  if (fromVal && toVal) {
    const d1 = new Date(fromVal);
    const d2 = new Date(toVal);
    const diff = Math.max(0, d2 - d1);
    daysCount = Math.floor(diff / (1000 * 60 * 60 * 24)) + 1;
  }
  if (monthVal) {
    const parts = monthVal.split("-");
    if (parts.length === 2) {
      daysInMonth = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10), 0).getDate();
    }
  }

  appState.filters = {
    period: mode,
    reportingMonth: monthVal,
    fromDate: fromVal,
    toDate: toVal,
    daysCount: daysCount,
    daysInMonth: daysInMonth,
    rangeRatio: Math.min(1.0, Math.max(0.01, daysCount / daysInMonth)),
    creditDebit: dom.filterCreditDebit ? dom.filterCreditDebit.value : "all",
    domIntl: dom.filterDomIntl ? dom.filterDomIntl.value : "all",
    issAcq: dom.filterIssAcq ? dom.filterIssAcq.value : "all"
  };

  renderActivePage();
}

function periodLabelText() {
  const f = appState.filters || {};
  const mode = f.period || "today";

  if (mode === "month") {
    let mName = "Selected Month";
    if (f.reportingMonth) {
      const parts = f.reportingMonth.split("-");
      if (parts.length === 2) {
        const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, 1);
        mName = d.toLocaleString("en-US", { month: "long", year: "numeric" });
      }
    }
    return "View: Full Month (" + mName + ")";
  }
  if (mode === "custom") {
    const fromStr = f.fromDate ? new Date(f.fromDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "";
    const toStr = f.toDate ? new Date(f.toDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "";
    const rangeStr = (fromStr && toStr) ? fromStr + " \u2192 " + toStr : "Custom Range";
    return "View: Custom Period (" + rangeStr + " \u2022 " + (f.daysCount || 1) + " Days)";
  }
  const dateStr = f.fromDate ? " (" + f.fromDate + ")" : "";
  return "View: Today" + dateStr;
}

function getPeriodLabels() {
  const f = appState.filters || {};
  const mode = f.period || "today";

  if (mode === "month") {
    let mName = "Selected Month";
    if (f.reportingMonth) {
      const parts = f.reportingMonth.split("-");
      if (parts.length === 2) {
        const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, 1);
        mName = d.toLocaleString("en-US", { month: "long", year: "numeric" });
      }
    }
    return {
      mode: "month",
      isDaily: false,
      primaryTerm: "Selected Period (" + mName + ")",
      shortPrimary: "Selected Period",
      comparisonTerm: "Previous Month",
      changeTerm: "MoM Change %",
      trendTerm: "Full Month Trend",
      freqTag: "MONTHLY",
      vsTag: "vs Prev Month",
      tableSectionTitle: "Period Operational Comparison"
    };
  }

  if (mode === "custom") {
    const dCount = f.daysCount || 15;
    return {
      mode: "custom",
      isDaily: false,
      primaryTerm: "Selected Period (" + dCount + "d)",
      shortPrimary: "Selected Period",
      comparisonTerm: "Previous Period (" + dCount + "d)",
      changeTerm: "Period Change %",
      trendTerm: "Full Month Trend",
      freqTag: "CUSTOM PERIOD",
      vsTag: "vs Prev Period",
      tableSectionTitle: "Period Operational Comparison"
    };
  }

  return {
    mode: "today",
    isDaily: true,
    primaryTerm: "Today",
    shortPrimary: "Today",
    comparisonTerm: "Yesterday",
    changeTerm: "Daily Change %",
    trendTerm: "Current Month",
    freqTag: "DAILY",
    vsTag: "vs Yesterday",
    tableSectionTitle: "Daily Operational Comparison"
  };
}

function getFilteredData(rawData, filters) {
  if (!rawData) return rawData;
  const f = filters || {};
  const mode = f.period || "today";

  if (mode === "today") return rawData;

  let factor = 1.0;
  if (mode === "custom") {
    const dCount = f.daysCount || 15;
    const mCount = f.daysInMonth || 31;
    factor = Math.min(1.0, Math.max(0.01, dCount / mCount));
  }

  const data = JSON.parse(JSON.stringify(rawData));

  function scale(val, fac) {
    if (val === null || val === undefined || isNaN(val)) return val;
    return Math.round(val * fac);
  }

  // 1. ATM Operations
  if (data.atm) {
    if (mode === "month") {
      data.atm.withdrawalCountToday = data.atm.withdrawalCountMTD;
      data.atm.withdrawalCountYesterday = data.atm.withdrawalCountPrevMTD;
      data.atm.withdrawalAmountToday = data.atm.withdrawalAmountMTD;
      data.atm.withdrawalAmountYesterday = data.atm.withdrawalAmountPrevMTD;
      data.atm.failedTxnToday = data.atm.failedTxnMTD;
      data.atm.disputesToday = data.atm.disputesMTD;
      data.atm.capturedCardsToday = data.atm.capturedCardsMTD;
      data.atm.retractTxnToday = data.atm.retractTxnMTD;
      data.atm.uptimeToday = data.atm.uptimeMTD;
      data.atm.uptimeYesterday = data.atm.uptimePrevMTD;
    } else if (mode === "custom") {
      data.atm.withdrawalCountToday = scale(data.atm.withdrawalCountMTD, factor);
      data.atm.withdrawalCountYesterday = scale(data.atm.withdrawalCountPrevMTD, factor);
      data.atm.withdrawalAmountToday = scale(data.atm.withdrawalAmountMTD, factor);
      data.atm.withdrawalAmountYesterday = scale(data.atm.withdrawalAmountPrevMTD, factor);
      data.atm.failedTxnToday = scale(data.atm.failedTxnMTD, factor);
      data.atm.disputesToday = scale(data.atm.disputesMTD, factor);
      data.atm.capturedCardsToday = scale(data.atm.capturedCardsMTD, factor);
      data.atm.retractTxnToday = scale(data.atm.retractTxnMTD, factor);
      data.atm.uptimeToday = data.atm.uptimeMTD;
      data.atm.uptimeYesterday = data.atm.uptimePrevMTD;
    }
  }

  // 2. RAAST Operations
  if (data.raast) {
    if (mode === "month") {
      data.raast.successCountToday = data.raast.successCountMTD;
      data.raast.successAmountToday = data.raast.successAmountMTD;
      data.raast.failedCountToday = data.raast.failedCountMTD;
      data.raast.complaintsToday = data.raast.complaintsMTD;
      data.raast.successRateToday = data.raast.successRateMTD;
    } else if (mode === "custom") {
      data.raast.successCountToday = scale(data.raast.successCountMTD, factor);
      data.raast.successAmountToday = scale(data.raast.successAmountMTD, factor);
      data.raast.failedCountToday = scale(data.raast.failedCountMTD, factor);
      data.raast.complaintsToday = scale(data.raast.complaintsMTD, factor);
      data.raast.successRateToday = calculateSuccessRate(data.raast.successCountToday, data.raast.failedCountToday);
    }
  }

  // 3. IBFT Operations
  if (data.ibft) {
    if (mode === "month") {
      data.ibft.successCountToday = data.ibft.successCountMTD;
      data.ibft.successAmountToday = data.ibft.successAmountMTD;
      data.ibft.failureCountToday = data.ibft.failureCountMTD;
      data.ibft.complaintsToday = data.ibft.complaintsMTD;
      data.ibft.successRateToday = data.ibft.successRateMTD;
    } else if (mode === "custom") {
      data.ibft.successCountToday = scale(data.ibft.successCountMTD, factor);
      data.ibft.successAmountToday = scale(data.ibft.successAmountMTD, factor);
      data.ibft.failureCountToday = scale(data.ibft.failureCountMTD, factor);
      data.ibft.complaintsToday = scale(data.ibft.complaintsMTD, factor);
      data.ibft.successRateToday = calculateSuccessRate(data.ibft.successCountToday, data.ibft.failureCountToday);
    }
  }

  // 4. IBFT Failures table
  if (Array.isArray(data.ibftFailures)) {
    data.ibftFailures.forEach(function (row) {
      if (mode === "month") {
        row.today = row.mtd;
      } else if (mode === "custom") {
        row.today = scale(row.mtd, factor);
      }
    });
  }

  // 5. Card Financials
  if (data.cardFinancials) {
    ["credit", "debit"].forEach(function (t) {
      const obj = data.cardFinancials[t];
      if (obj && mode === "custom") {
        obj.spendCurrent = scale(obj.spendCurrent, factor);
        obj.spendPrevious = scale(obj.spendPrevious, factor);
        obj.domesticTxnCount = scale(obj.domesticTxnCount, factor);
        obj.domesticTxnCountPrevious = scale(obj.domesticTxnCountPrevious, factor);
        obj.domesticTxnAmount = scale(obj.domesticTxnAmount, factor);
        obj.domesticTxnAmountPrevious = scale(obj.domesticTxnAmountPrevious, factor);
        obj.intlTxnCount = scale(obj.intlTxnCount, factor);
        obj.intlTxnCountPrevious = scale(obj.intlTxnCountPrevious, factor);
        obj.intlTxnAmount = scale(obj.intlTxnAmount, factor);
        obj.intlTxnAmountPrevious = scale(obj.intlTxnAmountPrevious, factor);
        obj.annualFeeIncome = scale(obj.annualFeeIncome, factor);
        obj.annualFeeIncomePrevious = scale(obj.annualFeeIncomePrevious, factor);
        obj.oifIncome = scale(obj.oifIncome, factor);
        obj.oifIncomePrevious = scale(obj.oifIncomePrevious, factor);
        obj.domesticInterchange = scale(obj.domesticInterchange, factor);
        obj.domesticInterchangePrevious = scale(obj.domesticInterchangePrevious, factor);
        obj.intlInterchange = scale(obj.intlInterchange, factor);
        obj.intlInterchangePrevious = scale(obj.intlInterchangePrevious, factor);
        obj.mdrIncome = scale(obj.mdrIncome, factor);
        obj.mdrIncomePrevious = scale(obj.mdrIncomePrevious, factor);
      }
    });
  }

  // 6. Chargeback
  if (data.chargeback) {
    ["credit", "debit"].forEach(function (t) {
      const obj = data.chargeback[t];
      if (obj && mode === "custom") {
        Object.keys(obj).forEach(function (k) {
          if (obj[k] && typeof obj[k] === "object") {
            obj[k].count = scale(obj[k].count, factor);
            obj[k].amount = scale(obj[k].amount, factor);
            obj[k].prevCount = scale(obj[k].prevCount, factor);
            obj[k].prevAmount = scale(obj[k].prevAmount, factor);
          }
        });
      }
    });
  }

  // 7. Secure Operations
  if (data.secureOperations) {
    if (mode === "month") {
      data.secureOperations.totalTxnToday = data.secureOperations.totalTxnMTD;
      data.secureOperations.totalTxnYesterday = data.secureOperations.totalTxnPrevMTD;
      data.secureOperations.successTxnToday = data.secureOperations.successTxnMTD;
      data.secureOperations.successTxnYesterday = data.secureOperations.successTxnPrevMTD;
      data.secureOperations.failedTxnToday = data.secureOperations.failedTxnMTD;
      data.secureOperations.failedTxnYesterday = data.secureOperations.failedTxnPrevMTD;
      data.secureOperations.successRateToday = data.secureOperations.successRateMTD;
      data.secureOperations.successRateYesterday = data.secureOperations.successRatePrevMTD;
      data.secureOperations.totalAmountToday = data.secureOperations.totalAmountMTD;
      data.secureOperations.totalAmountYesterday = data.secureOperations.totalAmountPrevMTD;
      data.secureOperations.pendingItemsToday = data.secureOperations.pendingItemsMTD;
      data.secureOperations.pendingItemsYesterday = data.secureOperations.pendingItemsPrevMTD;
    } else if (mode === "custom") {
      data.secureOperations.totalTxnToday = scale(data.secureOperations.totalTxnMTD, factor);
      data.secureOperations.totalTxnYesterday = scale(data.secureOperations.totalTxnPrevMTD, factor);
      data.secureOperations.successTxnToday = scale(data.secureOperations.successTxnMTD, factor);
      data.secureOperations.successTxnYesterday = scale(data.secureOperations.successTxnPrevMTD, factor);
      data.secureOperations.failedTxnToday = scale(data.secureOperations.failedTxnMTD, factor);
      data.secureOperations.failedTxnYesterday = scale(data.secureOperations.failedTxnPrevMTD, factor);
      data.secureOperations.successRateToday = data.secureOperations.successRateMTD;
      data.secureOperations.successRateYesterday = data.secureOperations.successRatePrevMTD;
      data.secureOperations.totalAmountToday = scale(data.secureOperations.totalAmountMTD, factor);
      data.secureOperations.totalAmountYesterday = scale(data.secureOperations.totalAmountPrevMTD, factor);
      data.secureOperations.pendingItemsToday = scale(data.secureOperations.pendingItemsMTD, factor);
      data.secureOperations.pendingItemsYesterday = scale(data.secureOperations.pendingItemsPrevMTD, factor);
    }
  }
  if (Array.isArray(data.secureOpsBreakdown) && mode === "custom") {
    data.secureOpsBreakdown.forEach(function (b) {
      b.txnCount = scale(b.txnCount, factor);
      b.amount = scale(b.amount, factor);
      b.pendingItems = scale(b.pendingItems, factor);
    });
  }

  // 8. Unsecured Operations
  if (data.unsecuredOperations) {
    if (mode === "month") {
      data.unsecuredOperations.totalTxnToday = data.unsecuredOperations.totalTxnMTD;
      data.unsecuredOperations.totalTxnYesterday = data.unsecuredOperations.totalTxnPrevMTD;
      data.unsecuredOperations.successTxnToday = data.unsecuredOperations.successTxnMTD;
      data.unsecuredOperations.successTxnYesterday = data.unsecuredOperations.successTxnPrevMTD;
      data.unsecuredOperations.failedTxnToday = data.unsecuredOperations.failedTxnMTD;
      data.unsecuredOperations.failedTxnYesterday = data.unsecuredOperations.failedTxnPrevMTD;
      data.unsecuredOperations.successRateToday = data.unsecuredOperations.successRateMTD;
      data.unsecuredOperations.successRateYesterday = data.unsecuredOperations.successRatePrevMTD;
      data.unsecuredOperations.totalAmountToday = data.unsecuredOperations.totalAmountMTD;
      data.unsecuredOperations.totalAmountYesterday = data.unsecuredOperations.totalAmountPrevMTD;
      data.unsecuredOperations.pendingItemsToday = data.unsecuredOperations.pendingItemsMTD;
      data.unsecuredOperations.pendingItemsYesterday = data.unsecuredOperations.pendingItemsPrevMTD;
    } else if (mode === "custom") {
      data.unsecuredOperations.totalTxnToday = scale(data.unsecuredOperations.totalTxnMTD, factor);
      data.unsecuredOperations.totalTxnYesterday = scale(data.unsecuredOperations.totalTxnPrevMTD, factor);
      data.unsecuredOperations.successTxnToday = scale(data.unsecuredOperations.successTxnMTD, factor);
      data.unsecuredOperations.successTxnYesterday = scale(data.unsecuredOperations.successTxnPrevMTD, factor);
      data.unsecuredOperations.failedTxnToday = scale(data.unsecuredOperations.failedTxnMTD, factor);
      data.unsecuredOperations.failedTxnYesterday = scale(data.unsecuredOperations.failedTxnPrevMTD, factor);
      data.unsecuredOperations.successRateToday = data.unsecuredOperations.successRateMTD;
      data.unsecuredOperations.successRateYesterday = data.unsecuredOperations.successRatePrevMTD;
      data.unsecuredOperations.totalAmountToday = scale(data.unsecuredOperations.totalAmountMTD, factor);
      data.unsecuredOperations.totalAmountYesterday = scale(data.unsecuredOperations.totalAmountPrevMTD, factor);
      data.unsecuredOperations.pendingItemsToday = scale(data.unsecuredOperations.pendingItemsMTD, factor);
      data.unsecuredOperations.pendingItemsYesterday = scale(data.unsecuredOperations.pendingItemsPrevMTD, factor);
    }
  }
  if (Array.isArray(data.unsecuredOpsBreakdown) && mode === "custom") {
    data.unsecuredOpsBreakdown.forEach(function (b) {
      b.txnCount = scale(b.txnCount, factor);
      b.amount = scale(b.amount, factor);
      b.pendingItems = scale(b.pendingItems, factor);
    });
  }

  // 9. Banca
  if (data.banca) {
    if (mode === "month") {
      data.banca.totalTxnToday = data.banca.totalTxnMTD;
      data.banca.totalTxnYesterday = data.banca.totalTxnPrevMTD;
      data.banca.successTxnToday = data.banca.successTxnMTD;
      data.banca.successTxnYesterday = data.banca.successTxnPrevMTD;
      data.banca.failedTxnToday = data.banca.failedTxnMTD;
      data.banca.failedTxnYesterday = data.banca.failedTxnPrevMTD;
      data.banca.successRateToday = data.banca.successRateMTD;
      data.banca.successRateYesterday = data.banca.successRatePrevMTD;
      data.banca.totalAmountToday = data.banca.totalAmountMTD;
      data.banca.totalAmountYesterday = data.banca.totalAmountPrevMTD;
      data.banca.pendingItemsToday = data.banca.pendingItemsMTD;
      data.banca.pendingItemsYesterday = data.banca.pendingItemsPrevMTD;
    } else if (mode === "custom") {
      data.banca.totalTxnToday = scale(data.banca.totalTxnMTD, factor);
      data.banca.totalTxnYesterday = scale(data.banca.totalTxnPrevMTD, factor);
      data.banca.successTxnToday = scale(data.banca.successTxnMTD, factor);
      data.banca.successTxnYesterday = scale(data.banca.successTxnPrevMTD, factor);
      data.banca.failedTxnToday = scale(data.banca.failedTxnMTD, factor);
      data.banca.failedTxnYesterday = scale(data.banca.failedTxnPrevMTD, factor);
      data.banca.successRateToday = data.banca.successRateMTD;
      data.banca.successRateYesterday = data.banca.successRatePrevMTD;
      data.banca.totalAmountToday = scale(data.banca.totalAmountMTD, factor);
      data.banca.totalAmountYesterday = scale(data.banca.totalAmountPrevMTD, factor);
      data.banca.pendingItemsToday = scale(data.banca.pendingItemsMTD, factor);
      data.banca.pendingItemsYesterday = scale(data.banca.pendingItemsPrevMTD, factor);
    }
  }
  if (Array.isArray(data.bancaOpsBreakdown) && mode === "custom") {
    data.bancaOpsBreakdown.forEach(function (b) {
      b.txnCount = scale(b.txnCount, factor);
      b.amount = scale(b.amount, factor);
      b.pendingItems = scale(b.pendingItems, factor);
    });
  }

  return data;
}

/* ---------------------------------------------------------------------
   9. RENDER: ACTIVE PAGE DISPATCH
   --------------------------------------------------------------------- */

function currentData() {
  return appState.processedData || generateIllustrativeData();
}

function renderActivePage() {
  const raw = currentData();
  const data = getFilteredData(raw, appState.filters);
  document.querySelectorAll("[data-period-label]").forEach(function (n) { n.textContent = periodLabelText(); });
  evaluateAndShowToastAlerts(data);

  switch (appState.activePage) {
    case "overview": renderOverview(data); break;
    case "adc-operations": renderADCOperations(data); break;
    case "card-non-financials": renderCardNonFinancials(data); break;
    case "card-financials": renderCardFinancials(data); break;
    case "chargeback": renderChargeback(data); break;
    case "reconciliation": renderReconciliation(data); break;
    case "secure-operations": renderSecureOperations(data); break;
    case "unsecured-operations": renderUnsecuredOperations(data); break;
    case "banca": renderBanca(data); break;
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
  const list = getDismissedAlerts();
  if (list.indexOf(alertId) === -1) {
    list.push(alertId);
    try {
      sessionStorage.setItem("dismissed_toast_alerts", JSON.stringify(list));
    } catch (e) {}
  }
}

function buildAlertMailtoUrl(alert) {
  const subject = "Dashboard Alert - " + alert.title;
  let body = "Dashboard Alert\r\n\r\n";
  body += "Severity: " + (alert.severity || "INFO") + "\r\n\r\n";
  body += "Alert:\r\n" + alert.title + "\r\n\r\n";
  if (alert.detail) {
    body += "Details:\r\n" + alert.detail + "\r\n\r\n";
  }
  body += "Please investigate this alert.";
  return "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
}

function evaluateAndShowToastAlerts(data) {
  const rawAlerts = [];

  /* 1. ATM Uptime Warning */
  if (data.atm && data.atm.uptimeToday !== null && data.atm.uptimeToday < 98.0) {
    rawAlerts.push({
      id: "toast_atm_uptime_critical",
      severity: "CRITICAL",
      title: "ATM Network Uptime Below Target",
      detail: "Current ATM uptime is " + formatPercentage(data.atm.uptimeToday) + " (SLA Target: 98.0%).",
      page: "adc-operations"
    });
  }

  /* 2. Low Card Inventory Stock */
  if (data.cardInventory) {
    data.cardInventory.forEach(function (cat) {
      const mc = calculateMonthsCover(cat.qty, cat.avgMonthlyUse);
      const st = calculateInventoryStatus(mc);
      if (st === "Critical" || st === "Warning") {
        rawAlerts.push({
          id: "toast_inv_" + cat.category.toLowerCase().replace(/\s+/g, "_"),
          severity: st === "Critical" ? "CRITICAL" : "WARNING",
          title: "Low Card Plastic Stock: " + cat.category,
          detail: "Current: " + formatNumber(cat.qty, 0) + " (Cover: " + mc.toFixed(1) + " mos)",
          page: "card-non-financials"
        });
      }
    });
  }

  /* 3. Low Stationery Stock */
  if (data.cardStationery) {
    data.cardStationery.forEach(function (item) {
      const mc = calculateMonthsCover(item.qty, item.avgMonthlyUse);
      if (mc < STATIONERY_MIN_MONTHS) {
        rawAlerts.push({
          id: "toast_stat_" + item.item.toLowerCase().replace(/\s+/g, "_"),
          severity: "WARNING",
          title: "Low Stationery: " + item.item,
          detail: "Current: " + formatNumber(item.qty, 0) + " (Min: " + formatNumber(item.minStock, 0) + ")",
          page: "card-non-financials"
        });
      }
    });
  }

  /* 4. Reconciliation High Aging Receivables */
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

  /* 5. Chargeback High Aging Disputes */
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
    const mailtoUrl = buildAlertMailtoUrl(a);

    toast.innerHTML = '<div class="toast-body">'
      + '<div class="toast-header">' + badgeHtml + '<div class="toast-title">' + a.title + '</div></div>'
      + '<div class="toast-detail">' + a.detail + '</div>'
      + '<div class="toast-actions">'
      + '<div class="toast-link">Investigate &rarr;</div>'
      + '<a class="toast-email-action" href="' + mailtoUrl + '" role="button" aria-label="Email alert">&#9993; Email</a>'
      + '</div>'
      + '</div>'
      + '<button class="toast-close" type="button" aria-label="Dismiss alert">&times;</button>';

    toast.addEventListener("click", function (e) {
      if (e.target.classList.contains("toast-close") || e.target.closest(".toast-email-action")) return;
      navigateToPage(a.page);
    });

    const emailBtn = toast.querySelector(".toast-email-action");
    if (emailBtn) {
      emailBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = mailtoUrl;
      });
    }

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

/* ---------------------------------------------------------------------
   11. PAGE 1 — OVERVIEW (EXECUTIVE COMMAND CENTER)
   --------------------------------------------------------------------- */

function renderOverview(data) {
  const root = document.getElementById("overview-body");
  root.innerHTML = "";

  if (data.meta && data.meta.dataQualityMessages.length) {
    data.meta.dataQualityMessages.forEach(function (m) { root.appendChild(dataQualityNote(m)); });
  }

  renderOvKpiStrip(root, data);
  renderOvNostro(root, data);
  renderOvModules(root, data);
}

function renderOvNostro(root, data) {
  const section = el("div", { class: "ov-section" });
  section.appendChild(el("div", { class: "ov-section-heading", text: "NOSTRO Account Positions & Reconciliation" }));

  const gridRow = el("div", { class: "ov-nostro-recon-grid" });

  // 1. NOSTRO POSITION TABLE GRID
  const nostroCard = el("div", { class: "ov-chart-card ov-nostro-card-container" });
  nostroCard.appendChild(el("div", { class: "ov-chart-title", text: "NOSTRO Position" }));

  const nostroTableWrap = el("div", { class: "table-responsive" });
  const nostroTable = el("table", { class: "ov-kpi-table ov-nostro-redesign-table" });

  const thead = el("thead");
  const trHead = el("tr");
  trHead.appendChild(el("th", { text: "", style: "text-align:left; width:34%;" }));
  trHead.appendChild(el("th", { text: "CURRENT MONTH", style: "text-align:right; width:22%;" }));
  trHead.appendChild(el("th", { text: "PREVIOUS MONTH", style: "text-align:right; width:22%;" }));
  trHead.appendChild(el("th", { text: "CHANGE RATE", style: "text-align:right; width:22%;" }));
  thead.appendChild(trHead);
  nostroTable.appendChild(thead);

  const tbody = el("tbody");

  // USD Group
  const trUsdHeader = el("tr", { class: "nostro-group-row" });
  trUsdHeader.appendChild(el("td", { html: '<span class="nostro-currency-badge">USD</span>', colspan: "4", style: "text-align:left;" }));
  tbody.appendChild(trUsdHeader);

  const trUsd = el("tr");
  trUsd.appendChild(el("td", { html: '<div class="nostro-bank-info"><strong>JP Morgan</strong><span class="nostro-bank-code">(840)</span></div>', style: "text-align:left;" }));
  trUsd.appendChild(el("td", { text: "38.3 Bn", style: "text-align:right; font-weight:600;" }));
  trUsd.appendChild(el("td", { text: "40.2 Bn", style: "text-align:right; color:var(--text-secondary);" }));
  trUsd.appendChild(el("td", { html: '<span class="indicator down negative">&#9660; -4.73%</span>', style: "text-align:right;" }));
  tbody.appendChild(trUsd);

  // AED Group
  const trAedHeader = el("tr", { class: "nostro-group-row" });
  trAedHeader.appendChild(el("td", { html: '<span class="nostro-currency-badge">AED</span>', colspan: "4", style: "text-align:left;" }));
  tbody.appendChild(trAedHeader);

  const trAed = el("tr");
  trAed.appendChild(el("td", { html: '<div class="nostro-bank-info"><strong>ENBD</strong><span class="nostro-bank-code">(784)</span></div>', style: "text-align:left;" }));
  trAed.appendChild(el("td", { text: "40.0 Bn", style: "text-align:right; font-weight:600;" }));
  trAed.appendChild(el("td", { text: "33.0 Bn", style: "text-align:right; color:var(--text-secondary);" }));
  trAed.appendChild(el("td", { html: '<span class="indicator up positive">&#9650; +21.21%</span>', style: "text-align:right;" }));
  tbody.appendChild(trAed);

  nostroTable.appendChild(tbody);
  nostroTableWrap.appendChild(nostroTable);
  nostroCard.appendChild(nostroTableWrap);
  gridRow.appendChild(nostroCard);

  // 2. RECONCILIATION SUMMARY BOX (GL COUNT BREAKDOWN)
  const reconCard = el("div", { class: "ov-chart-card ov-recon-box-card" });
  reconCard.appendChild(el("div", { class: "ov-chart-title", text: "Reconciliation GL Breakdown" }));

  const reconTableWrap = el("div", { class: "table-responsive" });
  const reconTable = el("table", { class: "ov-recon-gl-table" });

  const rThead = el("thead");
  const rTrHead = el("tr");
  rTrHead.appendChild(el("th", { text: "UNIT / GL", style: "text-align:left;" }));
  rTrHead.appendChild(el("th", { text: "GL COUNT", style: "text-align:right;" }));
  rThead.appendChild(rTrHead);
  reconTable.appendChild(rThead);

  const rTbody = el("tbody");
  const glBreakdownData = [
    { unit: "1888 - ADC",                  count: 25, reconUnitId: "1888"  },
    { unit: "1948 - Credit Card (CTL)",     count: 18, reconUnitId: "1948"  },
    { unit: "7928 - Credit Card (Card Pro)",count: 32, reconUnitId: "7928"  },
    { unit: "1922 - Ijarah",               count: 14, reconUnitId: "1922"  },
    { unit: "1944 - Auto Loan",            count: 22, reconUnitId: "1944"  },
    { unit: "1945 - PRL (Personal Loan)",  count: 29, reconUnitId: "PRL"   },
    { unit: "1946 - MTG (Mortgage)",       count: 16, reconUnitId: "1946"  },
    { unit: "2000 - SME",                  count: 12, reconUnitId: "2000"  },
    { unit: "Banca",                       count: 9,  reconUnitId: "banca" }
  ];

  glBreakdownData.forEach(function (item) {
    const tr = el("tr", { class: "recon-gl-row-link" });
    tr.title = "Open " + item.unit + " Reconciliation";
    tr.appendChild(el("td", { text: item.unit, style: "text-align:left; font-weight:500;" }));
    tr.appendChild(el("td", { text: item.count.toString(), class: "num", style: "text-align:right; font-weight:600;" }));
    tr.addEventListener("click", function () {
      const matchedUnit = RECON_UNITS.find(function (u) { return u.id === item.reconUnitId; });
      if (matchedUnit) {
        activeReconciliationUnit = matchedUnit;
      }
      navigateToPage("reconciliation");
    });
    rTbody.appendChild(tr);
  });

  // Two newly added rows inside THIS SAME Reconciliation GL Breakdown box
  const extraReconRows = [
    { label: "Receivables > 30d Amount", val: "PKR 145.60 Mn" },
    { label: "Payables > 30d Amount",    val: "PKR 89.40 Mn"  }
  ];

  extraReconRows.forEach(function (r) {
    const tr = el("tr", { class: "recon-gl-highlight-row" });
    tr.appendChild(el("td", { text: r.label, style: "text-align:left; font-weight:bold; color:#ffffff;" }));
    tr.appendChild(el("td", { text: r.val, class: "num", style: "text-align:right; font-weight:bold; color:#ffffff;" }));
    rTbody.appendChild(tr);
  });

  reconTable.appendChild(rTbody);
  reconTableWrap.appendChild(reconTable);
  reconCard.appendChild(reconTableWrap);
  gridRow.appendChild(reconCard);

  section.appendChild(gridRow);
  root.appendChild(section);
}

function formatKpiMnVal(val, isCurrency) {
  if (val === null || val === undefined || isNaN(val)) return "\u2014";
  const n = Number(val);
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "Bn";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "Mn";
  if (abs >= 1000) return (n / 1e6).toFixed(2) + "Mn";
  return n.toString();
}

function getCardKpiData(data) {
  const fin = data.cardFinancials || {};
  const creditFin = fin.credit || {};
  const debitFin = fin.debit || {};
  const activeList = data.activeCards || [];

  let creditAifCur = 0, creditAifPrev = 0;
  let debitAifCur = 0, debitAifPrev = 0;

  activeList.forEach(function (card) {
    const prod = (card.product || "").toLowerCase();
    const cnt = Number(card.count) || 0;
    const prev = Number(card.prevMonth) || 0;
    if (prod.indexOf("debit") !== -1) {
      debitAifCur += cnt;
      debitAifPrev += prev;
    } else {
      creditAifCur += cnt;
      creditAifPrev += prev;
    }
  });

  const creditAif = creditFin.aif || creditAifCur || 115200;
  const creditAifPrevVal = creditFin.aifPrevious || creditAifPrev || 111000;
  const creditCif = creditFin.cif || Math.round(creditAif * 1.289);
  const creditCifPrevVal = creditFin.cifPrevious || Math.round(creditAifPrevVal * 1.279);
  const creditInactive = creditCif - creditAif;
  const creditInactivePrev = creditCifPrevVal - creditAifPrevVal;
  const creditFee = creditFin.annualFeeIncome || 410000000;
  const creditFeePrev = creditFin.annualFeeIncomePrevious || 395000000;

  const debitAif = debitFin.aif || debitAifCur || 863500;
  const debitAifPrevVal = debitFin.aifPrevious || debitAifPrev || 847600;
  const debitCif = debitFin.cif || Math.round(debitAif * 1.20);
  const debitCifPrevVal = debitFin.cifPrevious || Math.round(debitAifPrevVal * 1.20);
  const debitInactive = debitCif - debitAif;
  const debitInactivePrev = debitCifPrevVal - debitAifPrevVal;
  const debitFee = debitFin.annualFeeIncome || 320000000;
  const debitFeePrev = debitFin.annualFeeIncomePrevious || 305000000;

  const ccSpendCur = creditFin.spendCurrent || 24600000000;
  const ccSpendPrev = creditFin.spendPrevious || 23100000000;
  const dcSpendCur = debitFin.spendCurrent || 41200000000;
  const dcSpendPrev = debitFin.spendPrevious || 39500000000;
  const ccIntlCur = creditFin.intlTxnAmount || 4800000000;
  const ccIntlPrev = creditFin.intlTxnAmountPrevious || 4500000000;
  const ccDomCur = creditFin.domesticTxnAmount || 19800000000;
  const ccDomPrev = creditFin.domesticTxnAmountPrevious || 18600000000;
  const dcIntlCur = debitFin.intlTxnAmount || 3100000000;
  const dcIntlPrev = debitFin.intlTxnAmountPrevious || 3000000000;
  const dcDomCur = debitFin.domesticTxnAmount || 38100000000;
  const dcDomPrev = debitFin.domesticTxnAmountPrevious || 36500000000;

  return {
    credit: {
      cif: { cur: creditCif, prev: creditCifPrevVal },
      aif: { cur: creditAif, prev: creditAifPrevVal },
      inactive: { cur: creditInactive, prev: creditInactivePrev },
      annualFee: { cur: creditFee, prev: creditFeePrev, isCurrency: true }
    },
    debit: {
      cif: { cur: debitCif, prev: debitCifPrevVal },
      aif: { cur: debitAif, prev: debitAifPrevVal },
      inactive: { cur: debitInactive, prev: debitInactivePrev },
      annualFee: { cur: debitFee, prev: debitFeePrev, isCurrency: true }
    },
    spend: {
      ccTotal: { cur: ccSpendCur, prev: ccSpendPrev },
      dcTotal: { cur: dcSpendCur, prev: dcSpendPrev },
      ccIntl: { cur: ccIntlCur, prev: ccIntlPrev },
      ccDom: { cur: ccDomCur, prev: ccDomPrev },
      dcIntl: { cur: dcIntlCur, prev: dcIntlPrev },
      dcDom: { cur: dcDomCur, prev: dcDomPrev }
    }
  };
}

function renderOvCardKpiTableCard(title, rows) {
  const isFourRows = rows.length === 4;
  const card = el("div", { class: "ov-table-kpi-card" + (isFourRows ? " ov-card-4-rows" : "") });

  const header = el("div", { class: "ov-table-kpi-header" });
  header.appendChild(el("div", { class: "ov-table-kpi-title", text: title }));
  header.appendChild(el("div", { class: "ov-table-kpi-freq", text: "MONTHLY" }));
  card.appendChild(header);

  const wrap = el("div", { class: "ov-table-kpi-wrap" });
  const table = el("table", { class: "ov-kpi-table" });

  const thead = el("thead");
  const trHead = el("tr");
  trHead.appendChild(el("th", { text: "METRIC", class: "col-metric" }));
  trHead.appendChild(el("th", { html: "CURRENT<br>MONTH", class: "col-val", style: "text-align:center;" }));
  trHead.appendChild(el("th", { html: "PREVIOUS<br>MONTH", class: "col-val", style: "text-align:center;" }));
  trHead.appendChild(el("th", { html: "CHANGE<br>RATE", class: "col-change", style: "text-align:center;" }));
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = el("tbody");
  rows.forEach(function (r) {
    const tr = el("tr");
    tr.appendChild(el("td", { text: r.label, class: "col-metric" }));
    tr.appendChild(el("td", { text: formatKpiMnVal(r.cur, r.isCurrency), class: "col-val" }));
    tr.appendChild(el("td", { text: formatKpiMnVal(r.prev, r.isCurrency), class: "col-val" }));

    const tdChange = el("td", { class: "col-change" });
    tdChange.innerHTML = indicatorHTML(r.cur, r.prev, true, true);
    tr.appendChild(tdChange);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);

  return card;
}

function renderOvKpiStrip(root, data) {
  const lbl = getPeriodLabels();
  const strip = el("div", { class: "ov-kpi-strip" });

  /* 1. Execution Strip */
  const dailyStrip = el("div", { class: "ov-daily-strip" });

  const uptime  = data.atm ? data.atm.uptimeToday : null;
  const uptimeY = data.atm ? data.atm.uptimeYesterday : null;
  const uptComp = formatUptimeComparison(uptime, uptimeY);
  const atmCard = ovExecCard("ATM Uptime", uptComp.todayStr,
    lbl.comparisonTerm + ': ' + uptComp.yesterdayStr + ' &nbsp;|&nbsp; ' + uptComp.html, lbl.vsTag, lbl.freqTag,
    fullValueTitle(uptime));
  atmCard.style.cursor = "pointer";
  atmCard.setAttribute("title", "Click to view ATM Performance in ADC Operations");
  atmCard.addEventListener("click", function () {
    navigateToPage("adc-operations", "atm-performance");
  });
  dailyStrip.appendChild(atmCard);

  const adcCntTdy = (data.atm ? data.atm.withdrawalCountToday || 0 : 0)
                  + (data.raast ? data.raast.successCountToday || 0 : 0)
                  + (data.ibft ? data.ibft.successCountToday || 0 : 0);
  const adcCntY   = (data.atm ? data.atm.withdrawalCountYesterday || 0 : 0)
                  + (data.raast ? data.raast.successCountYesterday || 0 : 0)
                  + (data.ibft ? data.ibft.successCountYesterday || 0 : 0);
  const cntCard = ovExecCard("Total ADC Transaction Count", formatNumber(adcCntTdy, 0),
    lbl.comparisonTerm + ': ' + formatNumber(adcCntY, 0) + ' &nbsp;|&nbsp; ' + indicatorHTML(adcCntTdy, adcCntY, true, false), lbl.vsTag, lbl.freqTag);
  cntCard.style.cursor = "pointer";
  cntCard.setAttribute("title", "Click to view ADC Operations");
  cntCard.addEventListener("click", function () {
    navigateToPage("adc-operations");
  });
  dailyStrip.appendChild(cntCard);

  const adcAmtTdy = (data.atm ? data.atm.withdrawalAmountToday || 0 : 0)
                  + (data.raast ? data.raast.successAmountToday || 0 : 0)
                  + (data.ibft ? data.ibft.successAmountToday || 0 : 0);
  const adcAmtY   = (data.atm ? data.atm.withdrawalAmountYesterday || 0 : 0)
                  + (data.raast ? data.raast.successAmountYesterday || 0 : 0)
                  + (data.ibft ? data.ibft.successAmountYesterday || 0 : 0);
  const amtCard = ovExecCard("Total ADC Transaction Amount", formatCurrency(adcAmtTdy),
    lbl.comparisonTerm + ': ' + formatCurrency(adcAmtY) + ' &nbsp;|&nbsp; ' + indicatorHTML(adcAmtTdy, adcAmtY, true, false), lbl.vsTag, lbl.freqTag,
    fullValueTitle(adcAmtTdy, true));
  amtCard.style.cursor = "pointer";
  amtCard.setAttribute("title", "Click to view ADC Operations");
  amtCard.addEventListener("click", function () {
    navigateToPage("adc-operations");
  });
  dailyStrip.appendChild(amtCard);

  strip.appendChild(dailyStrip);

  /* 2. Cards Performance Section */
  const cardData = getCardKpiData(data);
  const cardsGrid = el("div", { class: "ov-cards-kpi-grid" });

  const ccRows = [
    { label: "CIF", cur: cardData.credit.cif.cur, prev: cardData.credit.cif.prev },
    { label: "AIF", cur: cardData.credit.aif.cur, prev: cardData.credit.aif.prev },
    { label: "Inactive Cards", cur: cardData.credit.inactive.cur, prev: cardData.credit.inactive.prev },
    { label: "Annual Fee", cur: cardData.credit.annualFee.cur, prev: cardData.credit.annualFee.prev, isCurrency: true }
  ];
  const ccCard = renderOvCardKpiTableCard("Credit Card", ccRows);
  ccCard.style.cursor = "pointer";
  ccCard.setAttribute("title", "Click to view Card Financials");
  ccCard.addEventListener("click", function () {
    navigateToPage("card-financials");
  });
  cardsGrid.appendChild(ccCard);

  const dcRows = [
    { label: "CIF", cur: cardData.debit.cif.cur, prev: cardData.debit.cif.prev },
    { label: "AIF", cur: cardData.debit.aif.cur, prev: cardData.debit.aif.prev },
    { label: "Inactive Cards", cur: cardData.debit.inactive.cur, prev: cardData.debit.inactive.prev },
    { label: "Annual Fee", cur: cardData.debit.annualFee.cur, prev: cardData.debit.annualFee.prev, isCurrency: true }
  ];
  const dcCard = renderOvCardKpiTableCard("Debit Card", dcRows);
  dcCard.style.cursor = "pointer";
  dcCard.setAttribute("title", "Click to view Card Financials");
  dcCard.addEventListener("click", function () {
    navigateToPage("card-financials");
  });
  cardsGrid.appendChild(dcCard);

  const spendRows = [
    { label: "Total Credit Card Spend", cur: cardData.spend.ccTotal.cur, prev: cardData.spend.ccTotal.prev, isCurrency: true },
    { label: "Total Debit Card Spend", cur: cardData.spend.dcTotal.cur, prev: cardData.spend.dcTotal.prev, isCurrency: true },
    { label: "CC International Spend", cur: cardData.spend.ccIntl.cur, prev: cardData.spend.ccIntl.prev, isCurrency: true },
    { label: "CC Domestic Spend", cur: cardData.spend.ccDom.cur, prev: cardData.spend.ccDom.prev, isCurrency: true },
    { label: "DC International Spend", cur: cardData.spend.dcIntl.cur, prev: cardData.spend.dcIntl.prev, isCurrency: true },
    { label: "DC Domestic Spend", cur: cardData.spend.dcDom.cur, prev: cardData.spend.dcDom.prev, isCurrency: true }
  ];
  const spendCard = renderOvCardKpiTableCard("TOTAL CARD SPEND", spendRows);
  spendCard.style.cursor = "pointer";
  spendCard.setAttribute("title", "Click to view Card Financials");
  spendCard.addEventListener("click", function () {
    navigateToPage("card-financials");
  });
  cardsGrid.appendChild(spendCard);

  strip.appendChild(cardsGrid);
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

function renderOvAdcSummary(root, data) {
  const lbl = getPeriodLabels();
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
    const uptComp = formatUptimeComparison(a.uptimeToday, a.uptimeYesterday);
    rows.push({
      kpi: "ATM Success Rate",
      today: uptComp.todayStr,
      yesterday: uptComp.yesterdayStr,
      change: uptComp.html,
      mtd: formatPercentage(a.uptimeMTD)
    });
  }
  if (data.raast) {
    const r = data.raast;
    rows.push({
      kpi: "RAAST Success Rate",
      today: formatPercentage(r.successRateToday),
      yesterday: formatPercentage(r.successRateYesterday),
      change: calculateComparisons(r.successRateToday, r.successRateYesterday, true, false).html,
      mtd: formatPercentage(r.successRateMTD)
    });
    rows.push({
      kpi: "RAAST Transaction Count",
      today: formatNumber(r.successCountToday, 0),
      yesterday: formatNumber(r.successCountYesterday, 0),
      change: calculateComparisons(r.successCountToday, r.successCountYesterday, true, false).html,
      mtd: formatNumber(r.successCountMTD, 0)
    });
  }
  if (data.ibft) {
    const i = data.ibft;
    rows.push({
      kpi: "IBFT Success Rate",
      today: formatPercentage(i.successRateToday),
      yesterday: formatPercentage(i.successRateYesterday),
      change: calculateComparisons(i.successRateToday, i.successRateYesterday, true, false).html,
      mtd: formatPercentage(i.successRateMTD)
    });
    rows.push({
      kpi: "IBFT Transaction Count",
      today: formatNumber(i.successCountToday, 0),
      yesterday: formatNumber(i.successCountYesterday, 0),
      change: calculateComparisons(i.successCountToday, i.successCountYesterday, true, false).html,
      mtd: formatNumber(i.successCountMTD, 0)
    });
  }

  const wrap = el("div", { class: "ov-adc-table-wrap" });
  const table = el("table", { class: "ov-adc-table" });
  const thead = el("thead");
  const hr = el("tr");
  ["Metric", lbl.shortPrimary, lbl.comparisonTerm, "Change", lbl.trendTerm].forEach(function (h, i) {
    hr.appendChild(el("th", { class: i > 0 ? "num" : "", text: h }));
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  rows.forEach(function (row) {
    const tr = el("tr");
    tr.appendChild(el("td", { text: row.kpi }));
    tr.appendChild(el("td", { class: "num", text: row.today }));
    tr.appendChild(el("td", { class: "num", text: row.yesterday }));
    const changeTd = el("td", { class: "num" });
    changeTd.innerHTML = row.change;
    tr.appendChild(changeTd);
    tr.appendChild(el("td", { class: "num", text: row.mtd }));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  section.appendChild(wrap);
  root.appendChild(section);
}

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

function buildOvNostroChart(data) {
  const body = el("div", { class: "ov-chart-body" });
  if (!data.nostro || !data.nostro.length) {
    body.appendChild(el("div", { class: "no-data-note", text: "No NOSTRO position data available." }));
    return ovChartCard("NOSTRO Account Positions", body);
  }
  const items = data.nostro.map(function (n) {
    const glClean = (n.gl || "").replace(/-01$/i, "").replace(/-01\b/i, "");
    const cur = n.currency || (glClean.indexOf("USD") !== -1 ? "USD" : "AED");
    return '<div class="nostro-card-item">'
      + '<div class="nostro-item-title"><strong>' + cur + ' Account</strong> (' + glClean + ')</div>'
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
  var W = 340, barH = 22, padX = 10, gapY = 12, legH = 18;
  var H = barH + gapY + legH * 2 + 4;
  var barW = W - 2 * padX;
  var dW = Math.max(2, (debitVal / total) * barW);
  var cX = padX + dW, cW = Math.max(2, barW - dW);
  var dPct = (debitVal / total * 100).toFixed(1), cPct = (creditVal / total * 100).toFixed(1);
  var ly1 = barH + gapY, ly2 = ly1 + legH;
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"'
    + ' role="img" aria-label="Card spend: Debit ' + formatCurrency(debitVal) + ' ' + dPct + '%, Credit ' + formatCurrency(creditVal) + ' ' + cPct + '%"'
    + ' style="width:100%;max-height:85px;display:block;margin:auto;">'
    + '<rect x="' + padX + '" y="2" width="' + dW.toFixed(1) + '" height="' + barH + '" fill="#117ABF" rx="3" class="chart-bar-seg"><title>Debit Card Spend: ' + formatCurrency(debitVal) + ' (' + dPct + '%)</title></rect>'
    + '<rect x="' + cX.toFixed(1) + '" y="2" width="' + cW.toFixed(1) + '" height="' + barH + '" fill="#6FAED2" rx="3" class="chart-bar-seg"><title>Credit Card Spend: ' + formatCurrency(creditVal) + ' (' + cPct + '%)</title></rect>'
    + '<rect x="' + padX + '" y="' + (ly1 + 2) + '" width="10" height="10" fill="#117ABF" rx="2"/>'
    + '<text x="' + (padX + 16) + '" y="' + (ly1 + 10) + '" font-size="10.5" fill="#1E293B" font-weight="600">Debit \u2014 ' + formatCurrency(debitVal) + ' (' + dPct + '%)</text>'
    + '<rect x="' + padX + '" y="' + (ly2 + 2) + '" width="10" height="10" fill="#6FAED2" rx="2"/>'
    + '<text x="' + (padX + 16) + '" y="' + (ly2 + 10) + '" font-size="10.5" fill="#1E293B" font-weight="600">Credit \u2014 ' + formatCurrency(creditVal) + ' (' + cPct + '%)</text>'
    + '</svg>';
}

function svgAgingBar(buckets) {
  var total = buckets.reduce(function (s, b) { return s + b.amount; }, 0) || 1;
  var W = 340, barH = 22, padX = 10, gapY = 12, legItemH = 18;
  var rowCount = Math.ceil(buckets.length / 2);
  var H = barH + gapY + rowCount * legItemH + 4;
  var barW = W - 2 * padX;
  var x = padX, rects = "";
  buckets.forEach(function (b) {
    var w = Math.max(2, (b.amount / total) * barW);
    var pct = (b.amount / total * 100).toFixed(1);
    rects += '<rect x="' + x.toFixed(1) + '" y="2" width="' + w.toFixed(1) + '" height="' + barH + '" fill="' + b.color + '" rx="2" class="chart-bar-seg"><title>' + b.label + ': ' + formatCurrency(b.amount) + ' (' + pct + '%)</title></rect>';
    x += w;
  });

  var col1X = padX;
  var col2X = padX + 165;

  var legends = buckets.map(function (b, i) {
    var col = i % 2;
    var row = Math.floor(i / 2);
    var lx = col === 0 ? col1X : col2X;
    var ly = barH + gapY + row * legItemH;
    var pct = (b.amount / total * 100).toFixed(1);
    var alertTxt = b.isAlert ? ' <tspan fill="#D97706" font-weight="700">\u25B2 Alert</tspan>' : "";
    var labelOffset = b.label.length > 4 ? 46 : 38;
    return '<rect x="' + lx + '" y="' + (ly + 2) + '" width="10" height="10" fill="' + b.color + '" rx="2"/>'
      + '<text x="' + (lx + 14) + '" y="' + (ly + 10) + '" font-size="10" fill="#0F172A" font-weight="700">' + b.label + '</text>'
      + '<text x="' + (lx + labelOffset) + '" y="' + (ly + 10) + '" font-size="9.5" fill="#475569">'
      + formatCurrency(b.amount) + ' (' + pct + '%)' + alertTxt + '</text>';
  }).join("");

  var ariaDesc = buckets.map(function (b) { return b.label + ": " + formatCurrency(b.amount); }).join(", ");
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"'
    + ' role="img" aria-label="Reconciliation aging: ' + ariaDesc + '" style="width:100%;max-height:100px;display:block;margin:auto;">'
    + rects + legends + '</svg>';
}

function renderOvModules(root, data) {
  root.appendChild(el("div", { class: "ov-section-heading", text: "Module Summaries" }));
  const grid = el("div", { class: "ov-modules-grid" });
  grid.appendChild(ovModuleCard("ADC Operations",                  "adc-operations",    buildOvAdcTable(data)));
  grid.appendChild(ovModuleCard("Complain / Chargeback / Disputes","chargeback",        buildOvCbDisputesTable(data)));
  grid.appendChild(ovModuleCard("Card Financials",                 "card-financials",   buildOvCardFinTable(data)));
  grid.appendChild(ovModuleCard("Inventory / Stock Position",      "card-non-financials", buildOvInventoryTable(data)));
  grid.appendChild(ovModuleCard("Secure Operations",               "secure-operations", ovSecOpsRows(data)));
  grid.appendChild(ovModuleCard("Unsecured Operations",            "unsecured-operations", ovUnsecOpsRows(data)));
  grid.appendChild(ovModuleCard("Banca",                           "banca",             ovBancaRows(data)));
  root.appendChild(grid);
}


function ovModuleCard(title, page, content, extraClass) {
  const card = el("div", { class: "ov-module-card" + (extraClass ? " " + extraClass : "") });

  const hdr = el("div", { class: "ov-module-header" });
  hdr.appendChild(el("span", { class: "ov-module-title", text: title }));
  const btn = el("button", { class: "ov-view-details", type: "button", text: "View Details \u2192" });
  btn.addEventListener("click", function () { navigateToPage(page); });
  hdr.appendChild(btn);
  card.appendChild(hdr);

  if (!content) {
    card.appendChild(el("div", { class: "no-data-note", text: "No data available." }));
    return card;
  }

  if (content instanceof HTMLElement) {
    const tableWrap = el("div", { class: "table-responsive", style: "padding: 0; margin: 0;" });
    tableWrap.appendChild(content);
    card.appendChild(tableWrap);
  } else if (Array.isArray(content)) {
    const rowsEl = el("div", { class: "ov-module-rows" });
    content.forEach(function (r) {
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
  }

  return card;
}

function buildOvAdcTable(data) {
  const table = el("table", { class: "ov-module-table ov-adc-summary-table" });
  const thead = el("thead");

  const tr1 = el("tr");
  tr1.appendChild(el("th", { text: "COUNTRYWIDE", rowspan: "2", style: "text-align:left; vertical-align:bottom;" }));
  tr1.appendChild(el("th", { text: "TODAY", colspan: "2", class: "grouped-hdr group-today", style: "text-align:center;" }));
  tr1.appendChild(el("th", { text: "YESTERDAY", colspan: "2", class: "grouped-hdr group-yesterday", style: "text-align:center;" }));
  tr1.appendChild(el("th", { text: "CHANGE RATE", rowspan: "2", style: "text-align:center; vertical-align:bottom;" }));
  thead.appendChild(tr1);

  const tr2 = el("tr");
  tr2.appendChild(el("th", { text: "COUNTS", class: "num" }));
  tr2.appendChild(el("th", { text: "AMOUNT", class: "num border-group-end" }));
  tr2.appendChild(el("th", { text: "COUNTS", class: "num" }));
  tr2.appendChild(el("th", { text: "AMOUNT", class: "num border-group-end" }));
  thead.appendChild(tr2);

  table.appendChild(thead);

  const tbody = el("tbody");

  const atm = data.atm || {};
  const ibft = data.ibft || {};
  const raast = data.raast || {};

  const atmTdyCnt = atm.withdrawalCountToday || 48500;
  const atmTdyAmt = atm.withdrawalAmountToday || 14200000000;
  const atmYestCnt = atm.withdrawalCountYesterday || 46200;
  const atmYestAmt = atm.withdrawalAmountYesterday || 13500000000;
  const atmComp = calculateComparisons(atmTdyAmt, atmYestAmt, true, false);

  const ibftTdyCnt = ibft.successCountToday || 125400;
  const ibftTdyAmt = ibft.successAmountToday || 18600000000;
  const ibftYestCnt = ibft.successCountYesterday || 119800;
  const ibftYestAmt = ibft.successAmountYesterday || 17800000000;
  const ibftComp = calculateComparisons(ibftTdyAmt, ibftYestAmt, true, false);

  const raastTdyCnt = raast.successCountToday || 98200;
  const raastTdyAmt = raast.successAmountToday || 12800000000;
  const raastYestCnt = raast.successCountYesterday || 92500;
  const raastYestAmt = raast.successAmountYesterday || 11900000000;
  const raastComp = calculateComparisons(raastTdyAmt, raastYestAmt, true, false);

  const rowsData = [
    { name: "Total ATM Transactions", target: "atm-performance", title: "Click to view ATM Performance in ADC Operations", tCnt: atmTdyCnt, tAmt: atmTdyAmt, yCnt: atmYestCnt, yAmt: atmYestAmt, comp: atmComp },
    { name: "Total IBFT Transactions", target: "ibft-operations", title: "Click to view IBFT Operations in ADC Operations", tCnt: ibftTdyCnt, tAmt: ibftTdyAmt, yCnt: ibftYestCnt, yAmt: ibftYestAmt, comp: ibftComp },
    { name: "Total RAAST Transactions", target: "raast-operations", title: "Click to view RAAST Operations in ADC Operations", tCnt: raastTdyCnt, tAmt: raastTdyAmt, yCnt: raastYestCnt, yAmt: raastYestAmt, comp: raastComp }
  ];

  rowsData.forEach(function (r) {
    const tr = el("tr");
    if (r.target) {
      tr.classList.add("clickable-row");
      tr.style.cursor = "pointer";
      tr.setAttribute("title", r.title);
      tr.addEventListener("click", function () {
        navigateToPage("adc-operations", r.target);
      });
    }
    tr.appendChild(el("td", { text: r.name, style: "text-align:left; font-weight:600;" }));
    tr.appendChild(el("td", { text: formatNumber(r.tCnt, 0), class: "num" }));
    tr.appendChild(el("td", { text: formatCurrency(r.tAmt), class: "num border-group-end" }));
    tr.appendChild(el("td", { text: formatNumber(r.yCnt, 0), class: "num" }));
    tr.appendChild(el("td", { text: formatCurrency(r.yAmt), class: "num border-group-end" }));

    const tdChg = el("td", { style: "text-align:center;" });
    tdChg.innerHTML = r.comp.html;
    tr.appendChild(tdChg);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}

function buildOvInventoryTable(data) {
  const table = el("table", { class: "ov-module-table" });
  const thead = el("thead");
  const trHead = el("tr");
  trHead.appendChild(el("th", { text: "Inventory Item", style: "text-align:left;" }));
  trHead.appendChild(el("th", { text: "Current Month", class: "num", style: "text-align:center;" }));
  trHead.appendChild(el("th", { text: "Previous Month", class: "num", style: "text-align:center;" }));
  trHead.appendChild(el("th", { text: "MoM Change", class: "num", style: "text-align:center;" }));
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = el("tbody");

  const rows = [
    {
      item: "Card Plastic",
      cur: 100000000,
      prev: 60000000,
      subtext: "",
      curStr: "100,000,000",
      prevStr: "60,000,000",
      targetPage: "card-non-financials",
      targetSection: "card-plastic-availability",
      title: "Click to view Card Plastic Availability in Card Non-Financials"
    },
    {
      item: "Envelopes Stock",
      cur: 96000,
      prev: 120000,
      subtext: "(4.6 mos)",
      curStr: "96,000",
      prevStr: "120,000",
      targetPage: "card-non-financials",
      targetSection: "card-stationery",
      title: "Click to view Card Stationery in Card Non-Financials"
    },
    {
      item: "Mailers Stock",
      cur: 41000,
      prev: 45000,
      subtext: "(2.1 mos)",
      curStr: "41,000",
      prevStr: "45,000",
      targetPage: "card-non-financials",
      targetSection: "card-stationery",
      title: "Click to view Card Stationery in Card Non-Financials"
    }
  ];

  rows.forEach(function (r) {
    const tr = el("tr");
    if (r.targetPage) {
      tr.classList.add("clickable-row");
      tr.style.cursor = "pointer";
      tr.setAttribute("title", r.title);
      tr.addEventListener("click", function () {
        navigateToPage(r.targetPage, r.targetSection);
      });
    }
    tr.appendChild(el("td", { text: r.item, style: "text-align:left; font-weight:600;" }));

    const tdCur = el("td", { class: "num" });
    tdCur.innerHTML = '<strong>' + r.curStr + '</strong>' + (r.subtext ? ' <span class="stock-subtext">' + r.subtext + '</span>' : '');
    tr.appendChild(tdCur);

    tr.appendChild(el("td", { text: r.prevStr, class: "num", style: "color:var(--text-secondary);" }));

    const comp = calculateComparisons(r.cur, r.prev, true, true);
    const tdChg = el("td", { class: "num", style: "text-align:center;" });
    tdChg.innerHTML = comp.html;
    tr.appendChild(tdChg);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}

function buildOvCardFinTable(data) {
  const table = el("table", { class: "ov-module-table" });
  const thead = el("thead");
  const trHead = el("tr");
  trHead.appendChild(el("th", { text: "Metric", style: "text-align:left;" }));
  trHead.appendChild(el("th", { text: "Current Month", class: "num", style: "text-align:center;" }));
  trHead.appendChild(el("th", { text: "Previous Month", class: "num", style: "text-align:center;" }));
  trHead.appendChild(el("th", { text: "MoM Rate", class: "num", style: "text-align:center;" }));
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = el("tbody");

  const rows = [
    { metric: "Total ENR", curVal: 65.80, prevVal: 55.80, curStr: "PKR 65.80 Bn", prevStr: "PKR 55.80 Bn" },
    { metric: "Total OIF Income", curVal: 90.00, prevVal: 80.00, curStr: "PKR 90.00 Mn", prevStr: "PKR 80.00 Mn" },
    { metric: "Net Interchange Income", curVal: 422.00, prevVal: 400.00, curStr: "PKR 422.00 Mn", prevStr: "PKR 400.00 Mn" },
    { metric: "Total MDR Income", curVal: 42.00, prevVal: 32.00, curStr: "PKR 42.00 Mn", prevStr: "PKR 32.00 Mn" }
  ];

  rows.forEach(function (r) {
    const tr = el("tr");
    tr.appendChild(el("td", { text: r.metric, style: "text-align:left; font-weight:600;" }));
    tr.appendChild(el("td", { text: r.curStr, class: "num", style: "font-weight:600;" }));
    tr.appendChild(el("td", { text: r.prevStr, class: "num", style: "color:var(--text-secondary);" }));

    const comp = calculateComparisons(r.curVal, r.prevVal, true, true);
    const tdChg = el("td", { class: "num" });
    tdChg.innerHTML = comp.html;
    tr.appendChild(tdChg);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}

function buildOvCbDisputesTable(data) {
  const table = el("table", { class: "ov-module-table ov-cb-disputes-table" });
  const thead = el("thead");

  // Row 1 — top grouped headers
  const tr1 = el("tr");
  tr1.appendChild(el("th", { text: "CHANNEL", rowspan: "2", style: "text-align:left; vertical-align:bottom;" }));
  tr1.appendChild(el("th", { text: "CURRENT MONTH", colspan: "1", class: "grouped-hdr cb-grp-cur", style: "text-align:center;" }));
  tr1.appendChild(el("th", { text: "PREVIOUS MONTH", colspan: "1", class: "grouped-hdr cb-grp-prev", style: "text-align:center;" }));
  tr1.appendChild(el("th", { text: "MOM", rowspan: "2", class: "cb-grp-mom", style: "text-align:center; vertical-align:bottom;" }));
  thead.appendChild(tr1);

  // Row 2 — sub-headers
  const tr2 = el("tr");
  tr2.appendChild(el("th", { text: "COUNT", class: "num cb-sub-cur", style: "text-align:center;" }));
  tr2.appendChild(el("th", { text: "COUNT", class: "num cb-sub-prev", style: "text-align:center;" }));
  thead.appendChild(tr2);

  table.appendChild(thead);

  const tbody = el("tbody");

  // Demo data — realistic complaint/chargeback dispute counts by channel
  const cbRows = [
    { channel: "RAAST", cur: 1248, prev: 1105 },
    { channel: "IBFT",  cur: 3872, prev: 4210 },
    { channel: "ATM",   cur: 2561, prev: 2389 },
    { channel: "POS",   cur: 984,  prev: 876  },
    { channel: "UBPS",  cur: 432,  prev: 398  }
  ];

  cbRows.forEach(function (r) {
    const comp = calculateComparisons(r.cur, r.prev, true, true);
    const tr = el("tr");
    tr.appendChild(el("td", { text: r.channel, style: "text-align:left; font-weight:600;" }));
    tr.appendChild(el("td", { text: formatNumber(r.cur, 0), class: "num cb-sub-cur", style: "text-align:center; font-weight:600;" }));
    tr.appendChild(el("td", { text: formatNumber(r.prev, 0), class: "num cb-sub-prev", style: "text-align:center; color:var(--text-secondary);" }));
    const tdMom = el("td", { class: "num", style: "text-align:center;" });
    tdMom.innerHTML = comp.html;
    tr.appendChild(tdMom);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}

function ovAdcRows(data) {
  return null;
}

function ovCardNFRows(data) {
  return null;
}

function ovCardFRows(data) {
  return null;
}

function ovSecOpsRows(data) {
  const s = data.secureOperations || (generateIllustrativeData().secureOperations);
  return [
    ["Secure Transactions Count", formatNumber(s.successTxnToday)],
    ["Secure Success Rate", formatPercentage(s.successRateToday)],
    ["Secure Transaction Amount", formatCurrency(s.totalAmountToday)],
    ["Pending / Exception Items", formatNumber(s.pendingItemsToday)]
  ];
}

function ovUnsecOpsRows(data) {
  const u = data.unsecuredOperations || (generateIllustrativeData().unsecuredOperations);
  return [
    ["Unsecured Transactions Count", formatNumber(u.successTxnToday)],
    ["Unsecured Success Rate", formatPercentage(u.successRateToday)],
    ["Unsecured Transaction Amount", formatCurrency(u.totalAmountToday)],
    ["Pending / Exception Items", formatNumber(u.pendingItemsToday)]
  ];
}

function ovBancaRows(data) {
  const b = data.banca || (generateIllustrativeData().banca);
  return [
    ["Banca Transactions Count", formatNumber(b.successTxnToday)],
    ["Banca Success Rate", formatPercentage(b.successRateToday)],
    ["Banca Transaction Amount", formatCurrency(b.totalAmountToday)],
    ["Pending / Exception Items", formatNumber(b.pendingItemsToday)]
  ];
}

function buildOvReconTable(data) {
  const table = el("table", { class: "ov-module-table ov-recon-summary-table" });
  const thead = el("thead");

  // Row 1 — grouped top headers
  const tr1 = el("tr");
  tr1.appendChild(el("th", { text: "RECON UNIT / METRIC", rowspan: "2", style: "text-align:left; vertical-align:bottom;" }));
  tr1.appendChild(el("th", { text: "TODAY",     colspan: "1", class: "grouped-hdr grp-today",     style: "text-align:center;" }));
  tr1.appendChild(el("th", { text: "YESTERDAY", colspan: "1", class: "grouped-hdr grp-yesterday", style: "text-align:center;" }));
  tr1.appendChild(el("th", { text: "CHANGE RATE", rowspan: "2", style: "text-align:center; vertical-align:bottom;" }));
  thead.appendChild(tr1);

  // Row 2 — sub-headers
  const tr2 = el("tr");
  tr2.appendChild(el("th", { text: "AMOUNT", class: "num", style: "text-align:center;" }));
  tr2.appendChild(el("th", { text: "AMOUNT", class: "num", style: "text-align:center;" }));
  thead.appendChild(tr2);

  table.appendChild(thead);

  const tbody = el("tbody");

  // 1. Existing Reconciliation unit rows/details
  const unitRowsData = [
    { unit: "1888 - ADC",                  today: 25400000, yesterday: 24100000, reconUnitId: "1888" },
    { unit: "1948 - Credit Card (CTL)",     today: 63000000, yesterday: 59800000, reconUnitId: "1948" },
    { unit: "7928 - Credit Card (Card Pro)",today: 32980000, yesterday: 34200000, reconUnitId: "7928" },
    { unit: "1922 - Ijarah",               today: 24040000, yesterday: 22800000, reconUnitId: "1922" },
    { unit: "1944 - Auto Loan",            today: 30540000, yesterday: 29100000, reconUnitId: "1944" },
    { unit: "1945 - PRL (Personal Loan)",  today: 54600000, yesterday: 52000000, reconUnitId: "PRL"  },
    { unit: "1946 - MTG (Mortgage)",       today: 69680000, yesterday: 67000000, reconUnitId: "1946" },
    { unit: "2000 - SME",                  today: 38200000, yesterday: 39500000, reconUnitId: "2000" },
    { unit: "Banca",                       today: 21000000, yesterday: 19800000, reconUnitId: "banca" }
  ];

  unitRowsData.forEach(function (r) {
    const comp = calculateComparisons(r.today, r.yesterday, true, false);
    const tr = el("tr", { class: "clickable-row" });
    tr.style.cursor = "pointer";
    tr.title = "Click to view " + r.unit + " Reconciliation details";
    tr.appendChild(el("td", { text: r.unit, style: "text-align:left; font-weight:600;" }));
    tr.appendChild(el("td", { text: formatCurrency(r.today),     class: "num", style: "font-weight:600; text-align:center;" }));
    tr.appendChild(el("td", { text: formatCurrency(r.yesterday), class: "num", style: "color:var(--text-secondary); text-align:center;" }));
    const tdChg = el("td", { style: "text-align:center;" });
    tdChg.innerHTML = comp.html;
    tr.appendChild(tdChg);

    tr.addEventListener("click", function () {
      const matchedUnit = RECON_UNITS.find(function (u) { return u.id === r.reconUnitId; });
      if (matchedUnit) {
        activeReconciliationUnit = matchedUnit;
      }
      navigateToPage("reconciliation");
    });

    tbody.appendChild(tr);
  });

  // 2. Styled summary rows inside the SAME box (Receivables > 30d Amount & Payables > 30d Amount)
  const summaryRows = [
    { metric: "Receivables > 30d Amount", today: 145600000, yesterday: 138200000 },
    { metric: "Payables > 30d Amount",    today: 89400000,  yesterday: 93100000  }
  ];

  summaryRows.forEach(function (r) {
    const comp = calculateComparisons(r.today, r.yesterday, true, false);
    const tr = el("tr", { class: "recon-highlight-row" });
    tr.appendChild(el("td", { text: r.metric, style: "text-align:left; font-weight:bold; color:#ffffff;" }));
    tr.appendChild(el("td", { text: formatCurrency(r.today),     class: "num", style: "font-weight:bold; color:#ffffff; text-align:center;" }));
    tr.appendChild(el("td", { text: formatCurrency(r.yesterday), class: "num", style: "font-weight:bold; color:#ffffff; text-align:center;" }));
    const tdChg = el("td", { style: "text-align:center; color:#ffffff; font-weight:bold;" });
    tdChg.innerHTML = comp.html;
    tr.appendChild(tdChg);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}

function ovCbRows(data) {
  if (!data.chargeback) return null;
  const cb = data.chargeback;
  const activeCb = cb.credit || cb;
  const tot = ["domestic","international"].reduce(function (s,k) { return s + (activeCb[k] ? activeCb[k].count||0 : 0); }, 0);
  const amt = ["domestic","international"].reduce(function (s,k) { return s + (activeCb[k] ? activeCb[k].amount||0 : 0); }, 0);
  return [
    ["Total Disputes Count", formatNumber(tot)],
    ["Total Disputed Amount", formatCurrency(amt)],
    ["Pre-Arb Raised Count", activeCb.preArbRaised   ? formatNumber(activeCb.preArbRaised.count)   : "0"],
    ["Pre-Arb Received Count", activeCb.preArbReceived  ? formatNumber(activeCb.preArbReceived.count) : "0"],
    ["High-Aging Disputes",  activeCb.highAging       ? formatNumber(activeCb.highAging.count)      : "0"]
  ];
}

function ovReconRows(data) {
  if (!data.reconciliation) return null;
  const rec = data.reconciliation;
  const recTxns = (rec.receivables || []).reduce(function (s, r) { return s + (r.txnCount || 0); }, 0);
  const payTxns = (rec.payables || []).reduce(function (s, r) { return s + (r.txnCount || 0); }, 0);
  return [
    ["Receivables > 30d Amount",     formatCurrency(sumBy(rec.receivables, "amount"))],
    ["Payables > 30d Amount",        formatCurrency(sumBy(rec.payables, "amount"))],
    ["Receivables Open Items Count", formatNumber(recTxns)],
    ["Payables Open Items Count",    formatNumber(payTxns)]
  ];
}

function sumBy(arr, key) {
  return (arr || []).reduce(function (s, r) { return s + (Number(r[key]) || 0); }, 0);
}

/* ---------------------------------------------------------------------
   12. PAGE 2 — ADC OPERATIONS
   --------------------------------------------------------------------- */

function renderADCOperations(data) {
  const root = document.getElementById("adc-operations-body");
  root.innerHTML = "";
  const lbl = getPeriodLabels();

  root.appendChild(sectionTitle("ATM Operations"));
  if (data.atm) {
    const a = data.atm;
    const uptComp = formatUptimeComparison(a.uptimeToday, a.uptimeYesterday);

    const grid = el("div", { class: "kpi-grid" });
    grid.appendChild(kpiCard("Total ATMs Count", formatNumber(a.totalATMs)));

    const uptimeSubHTML = lbl.comparisonTerm + ": " + uptComp.yesterdayStr + " &nbsp;|&nbsp; " + uptComp.html;
    grid.appendChild(kpiCard("ATM Uptime (" + lbl.shortPrimary + ")", uptComp.todayStr, uptimeSubHTML));

    grid.appendChild(kpiCard("Withdrawal Transaction Count (" + lbl.shortPrimary + ")", formatNumber(a.withdrawalCountToday), lbl.comparisonTerm + ": " + formatNumber(a.withdrawalCountYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(a.withdrawalCountToday, a.withdrawalCountYesterday, true, false).html));
    if (lbl.isDaily) {
      grid.appendChild(kpiCard("Withdrawal Transaction Count (Current Month)", formatNumber(a.withdrawalCountMTD), "Prev Month: " + formatNumber(a.withdrawalCountPrevMTD) + " &nbsp;|&nbsp; " + calculateComparisons(a.withdrawalCountMTD, a.withdrawalCountPrevMTD, true, true).html));
    }
    grid.appendChild(kpiCard("Withdrawal Transaction Amount (" + lbl.shortPrimary + ")", formatCurrency(a.withdrawalAmountToday), lbl.comparisonTerm + ": " + formatCurrency(a.withdrawalAmountYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(a.withdrawalAmountToday, a.withdrawalAmountYesterday, true, false).html, fullValueTitle(a.withdrawalAmountToday, true)));
    if (lbl.isDaily) {
      grid.appendChild(kpiCard("Withdrawal Transaction Amount (Current Month)", formatCurrency(a.withdrawalAmountMTD), "Prev Month: " + formatCurrency(a.withdrawalAmountPrevMTD) + " &nbsp;|&nbsp; " + calculateComparisons(a.withdrawalAmountMTD, a.withdrawalAmountPrevMTD, true, true).html, fullValueTitle(a.withdrawalAmountMTD, true)));
    }
    grid.appendChild(kpiCard("Failed ATM Transactions Count (" + lbl.shortPrimary + ")", formatNumber(a.failedTxnToday), lbl.comparisonTerm + ": " + formatNumber(a.failedTxnYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(a.failedTxnToday, a.failedTxnYesterday, false, false).html));
    grid.appendChild(kpiCard("ATM Disputes / Claims Count", formatNumber(a.disputesMTD)));
    grid.appendChild(kpiCard("Cards Captured Count", formatNumber(a.capturedCardsMTD)));
    grid.appendChild(kpiCard("Cash-Retract Transactions Count", formatNumber(a.retractTxnMTD)));
    root.appendChild(grid);

    /* ATM Performance tables displaying explicit Txn Amount column */
    const atmPerfTitle = sectionTitle("ATM Performance");
    atmPerfTitle.id = "atm-performance";
    root.appendChild(atmPerfTitle);
    root.appendChild(buildTable("Top 5 Performing ATMs",
      [{ key: "rank", label: "Rank", numeric: true }, { key: "atmId", label: "ATM ID" }, { key: "location", label: "Location" },
       { key: "txnCount", label: "Txn Count", numeric: true }, { key: "txnAmount", label: "Txn Amount", currency: true }, { key: "successRate", label: "Success Rate", percent: true }, { key: "uptime", label: "Uptime", percent: true }],
      data.atmTop5Best));
    root.appendChild(buildTable("Top 5 Low-Performing ATMs",
      [{ key: "rank", label: "Rank", numeric: true }, { key: "atmId", label: "ATM ID" }, { key: "location", label: "Location" },
       { key: "txnCount", label: "Txn Count", numeric: true }, { key: "txnAmount", label: "Txn Amount", currency: true }, { key: "successRate", label: "Success Rate", percent: true }, { key: "uptime", label: "Uptime", percent: true }],
      data.atmBottom5));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "ATM sheet is missing. No data available for ATM Operations." }));
  }

  const adcThreeTableColumns = [
    { key: "kpi", label: "Metric" },
    { key: "today", label: lbl.shortPrimary, numeric: true },
    { key: "yesterday", label: lbl.comparisonTerm, numeric: true },
    { key: "change", label: "Change", numeric: true },
    { key: "mtd", label: lbl.trendTerm, numeric: true }
  ];

  /* 1. RAAST Operations Table */
  const raastTitle = sectionTitle("RAAST Operations");
  raastTitle.id = "raast-operations";
  root.appendChild(raastTitle);
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
  const ibftTitle = sectionTitle("IBFT Operations");
  ibftTitle.id = "ibft-operations";
  root.appendChild(ibftTitle);
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

    /* 3. IBFT Failure Reasons Table */
    root.appendChild(buildTable("IBFT Failure Reasons", adcThreeTableColumns,
      (data.ibftFailures || []).map(function (f) {
        return {
          kpi: f.reason,
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
   13. PAGE 3 — CARD NON-FINANCIALS
   --------------------------------------------------------------------- */

function computeInventoryStatus(item) {
  const monthsCover = calculateMonthsCover(item.qty, item.avgMonthlyUse);
  const status = calculateInventoryStatus(monthsCover);
  return Object.assign({}, item, { monthsCover: monthsCover, status: status });
}

function computeStationeryStatus(item) {
  const monthsCover = calculateMonthsCover(item.qty, item.avgMonthlyUse);
  const status = monthsCover < STATIONERY_MIN_MONTHS ? "Critical" : (monthsCover < STATIONERY_MIN_MONTHS * 1.5 ? "Warning" : "Sufficient");
  return Object.assign({}, item, { monthsCover: monthsCover, status: status });
}

function renderCardNonFinancials(data) {
  const root = document.getElementById("card-non-financials-body");
  root.innerHTML = "";

  const plasticTitle = sectionTitle("Card Plastic Availability");
  plasticTitle.id = "card-plastic-availability";
  root.appendChild(plasticTitle);
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

  const stationeryTitle = sectionTitle("Card Stationery");
  stationeryTitle.id = "card-stationery";
  root.appendChild(stationeryTitle);
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
       { key: "prevMonth", label: "Previous Month Count", numeric: true }, { key: "changeDisplay", label: "MoM Change", rightAlign: true }],
      data.activeCards.map(function (r) { return Object.assign({}, r, { changeDisplay: calculateComparisons(r.count, r.prevMonth, true, true).html }); })
    ));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "Active_Cards sheet is missing. No data available for cards in force." }));
  }
}

/* ---------------------------------------------------------------------
   14. PAGE 4 — CARD FINANCIALS ([ Credit Cards ] [ Debit Cards ])
   --------------------------------------------------------------------- */

function renderCardFinancials(data) {
  const root = document.getElementById("card-financials-body");
  root.innerHTML = "";
  const lbl = getPeriodLabels();

  if (!data.cardFinancials) {
    root.appendChild(el("div", { class: "no-data-note", text: "Card_Financials sheet is missing. No data available for Card Financials." }));
    return;
  }

  const cf = data.cardFinancials;
  const c = cf.credit || {};
  const d = cf.debit || {};

  root.appendChild(sectionTitle("Comprehensive Card Financial Performance & Revenue Summary"));

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

    const totCountCurrent = calculateTotalTransactions(selectedData.domesticTxnCount, selectedData.intlTxnCount);
    const totCountPrev = calculateTotalTransactions(selectedData.domesticTxnCountPrevious, selectedData.intlTxnCountPrevious);
    compRows.push({ item: "Total Transaction Count", current: totCountCurrent, previous: totCountPrev || null, isCount: true });

    const totAmtCurrent = calculateTotalAmount(selectedData.domesticTxnAmount, selectedData.intlTxnAmount);
    const totAmtPrev = calculateTotalAmount(selectedData.domesticTxnAmountPrevious, selectedData.intlTxnAmountPrevious);
    compRows.push({ item: "Total Transaction Amount", current: totAmtCurrent, previous: totAmtPrev || null, isCurrency: true });

    compRows.push({ item: "Domestic Interchange Income", current: selectedData.domesticInterchange, previous: selectedData.domesticInterchangePrevious, isCurrency: true });
    compRows.push({ item: "International Interchange Income", current: selectedData.intlInterchange, previous: selectedData.intlInterchangePrevious, isCurrency: true });

    const totInterCurrent = calculateTotalInterchange(selectedData.domesticInterchange, selectedData.intlInterchange);
    const totInterPrev = calculateTotalInterchange(selectedData.domesticInterchangePrevious, selectedData.intlInterchangePrevious);
    compRows.push({ item: "Total Interchange Income", current: totInterCurrent, previous: totInterPrev || null, isCurrency: true });

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
        valDisp = String(row.current || "\u2014");
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
       { key: "currentDisplay", label: lbl.shortPrimary, rightAlign: true },
       { key: "previousDisplay", label: lbl.comparisonTerm, rightAlign: true },
       { key: "changeDisplay", label: lbl.changeTerm, rightAlign: true }],
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

  root.appendChild(sectionTitle("Spend by Channel"));
  if (data.spendByChannel) {
    root.appendChild(buildTable(null,
      [{ key: "channel", label: "Channel" }, { key: "current", label: lbl.shortPrimary, currency: true },
       { key: "previous", label: lbl.comparisonTerm, currency: true }, { key: "changeDisplay", label: lbl.changeTerm, rightAlign: true }],
      data.spendByChannel.map(function (r) { return { channel: r.channel, current: r.current, previous: r.previous, changeDisplay: calculateComparisons(r.current, r.previous, true, true).html }; })
    ));
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "Spend_By_Channel sheet is missing. No data available." }));
  }

  root.appendChild(sectionTitle("Top 5 Merchants by Spend"));
  root.appendChild(buildTable(null,
    [{ key: "rank", label: "Rank", numeric: true }, { key: "merchant", label: "Merchant" }, { key: "mcc", label: "MCC" },
     { key: "txnCount", label: "Transaction Count", numeric: true }, { key: "spend", label: "Transaction Amount", currency: true }, { key: "share", label: "Share %", percent: true }],
    data.topMerchants));

  root.appendChild(sectionTitle("SBP Cross-Border Monitoring (USD 30,000 threshold)"));
  if (data.sbpCrossBorder) {
    const sbpGrid = el("div", { class: "kpi-grid" });
    sbpGrid.appendChild(kpiCard("Customers Reaching Threshold (" + lbl.shortPrimary + ")", formatNumber(data.sbpCrossBorder.customerCountCurrent, 0)));
    sbpGrid.appendChild(kpiCard(lbl.comparisonTerm, formatNumber(data.sbpCrossBorder.customerCountPrevious, 0),
      calculateComparisons(data.sbpCrossBorder.customerCountCurrent, data.sbpCrossBorder.customerCountPrevious, false, true).html));
    root.appendChild(sbpGrid);
  } else {
    root.appendChild(el("div", { class: "no-data-note", text: "No data available for SBP cross-border monitoring." }));
  }
}

/* ---------------------------------------------------------------------
   15. PAGE 5 — CHARGEBACK ([ Credit Cards ] [ Debit Cards ])
   --------------------------------------------------------------------- */

function renderChargeback(data) {
  const root = document.getElementById("chargeback-body");
  root.innerHTML = "";
  const lbl = getPeriodLabels();

  if (!data.chargeback) {
    root.appendChild(el("div", { class: "no-data-note", text: "Chargeback sheet is missing. No data available for Chargeback." }));
    return;
  }

  root.appendChild(sectionTitle("Chargeback & Dispute Summary"));

  const toggleWrap = el("div", { class: "card-fin-toggle-bar" });
  const btnCredit = el("button", { class: "fin-toggle-btn" + (chargebackActiveTab === "credit" ? " active" : ""), type: "button", text: "Credit Cards" });
  const btnDebit = el("button", { class: "fin-toggle-btn" + (chargebackActiveTab === "debit" ? " active" : ""), type: "button", text: "Debit Cards" });

  toggleWrap.appendChild(btnCredit);
  toggleWrap.appendChild(btnDebit);
  root.appendChild(toggleWrap);

  const tableContainer = el("div", { id: "chargebackTableContainer" });
  root.appendChild(tableContainer);

  const cb = data.chargeback;
  const creditCb = cb.credit || {};
  const debitCb = cb.debit || {};

  function renderChargebackTable() {
    tableContainer.innerHTML = "";
    const selectedCb = chargebackActiveTab === "debit" ? debitCb : creditCb;
    const rowsDef = [
      { key: "domestic", label: "Domestic Disputes" },
      { key: "international", label: "International Disputes" },
      { key: "pos", label: "POS Disputes" },
      { key: "ecommerce", label: "E-Commerce Disputes" },
      { key: "preArbRaised", label: "Pre-Arbitration Raised" },
      { key: "preArbReceived", label: "Pre-Arbitration Received" },
      { key: "highAging", label: "High-Aging Disputes" }
    ];

    const rows = rowsDef.map(function (def) {
      const metric = selectedCb[def.key] || {};
      const countCurrent = metric.count || 0;
      const countPrev = metric.prevCount || 0;
      const amtCurrent = metric.amount || 0;
      const amtPrev = metric.prevAmount || 0;

      return {
        metric: def.label,
        countCurrent: formatNumber(countCurrent),
        countPrev: formatNumber(countPrev),
        countChange: calculateComparisons(countCurrent, countPrev, false, true).html,
        amtCurrent: formatCurrency(amtCurrent),
        amtPrev: formatCurrency(amtPrev),
        amtChange: calculateComparisons(amtCurrent, amtPrev, false, true).html
      };
    });

    const wrap = buildTable(null,
      [{ key: "metric", label: "Dispute Metric" },
       { key: "countCurrent", label: lbl.shortPrimary + " Count", rightAlign: true },
       { key: "countPrev", label: lbl.comparisonTerm + " Count", rightAlign: true },
       { key: "countChange", label: "Count Change", rightAlign: true },
       { key: "amtCurrent", label: lbl.shortPrimary + " Amount", rightAlign: true },
       { key: "amtPrev", label: lbl.comparisonTerm + " Amount", rightAlign: true },
       { key: "amtChange", label: "Amount Change", rightAlign: true }],
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
   16. PAGE 6 — RECONCILIATION (TWO-LEVEL UNIT SELECTION & DETAIL FLOW)
   --------------------------------------------------------------------- */

const RECON_UNITS = [
  { id: "1888", code: "1888", name: "ADC", fullName: "1888 - ADC", titleName: "Branch 1888 - ADC Operations" },
  { id: "1948", code: "1948", name: "Credit Card (CTL)", fullName: "1948 - Credit Card (CTL)", titleName: "Branch 1948 - Credit Card (CTL)" },
  { id: "7928", code: "7928", name: "Credit Card (Card Pro)", fullName: "7928 - Credit Card (Card Pro)", titleName: "Branch 7928 - Credit Card (Card Pro)" },
  { id: "1922", code: "1922", name: "Ijarah", fullName: "1922 - Ijarah", titleName: "Branch 1922 - Ijarah" },
  { id: "1944", code: "1944", name: "Auto", fullName: "1944 - Auto", titleName: "Branch 1944 - Auto Loan" },
  { id: "PRL", code: "PRL", name: "Personal Loan", fullName: "PRL - Personal Loan", titleName: "PRL - Personal Loan" },
  { id: "1946", code: "1946", name: "MTG - Mortgage", fullName: "1946 - MTG - Mortgage", titleName: "Branch 1946 - Mortgage" },
  { id: "2000", code: "2000", name: "SME", fullName: "2000 - SME", titleName: "Branch 2000 - SME" },
  { id: "banca", code: "Banca", name: "Banca", fullName: "Banca", titleName: "Banca" }
];

let activeReconciliationUnit = null;

function formatReconVal(val) {
  if (val === null || val === undefined || isNaN(val)) return "\u2014";
  const n = Number(val);
  if (Math.abs(n) < 1e-9) return "0.00";
  const formatted = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? "(" + formatted + ")" : formatted;
}

function formatAgingCount(val) {
  if (val === null || val === undefined || isNaN(val) || val === 0) return "-";
  return Number(val).toLocaleString("en-US");
}

function getReconciliationUnitRows(unit, data) {
  const code = unit ? unit.code : "1888";
  
  const unitDemoMap = {
    "1888": [
      { sNo: 1, sundryCode: "1888-001", description: "OVERDUE RECEIVABLE CMR COVID-19", asPerTB: 14250000.00, asPerRecon: 14250000.00, remarks: "Fully Reconciled", a10: 0, a30: 0, a60: 0, a90: 0, aAbove: 0 },
      { sNo: 2, sundryCode: "1888-002", description: "Paid Not Due From Customer", asPerTB: -677132.36, asPerRecon: -677132.36, remarks: "Outstanding Transactions - Closure Required", a10: 0, a30: 3, a60: 3, a90: 2, aAbove: 10 },
      { sNo: 3, sundryCode: "1888-003", description: "ATM Settlement Clearing Account", asPerTB: 8420150.00, asPerRecon: 8250000.00, remarks: "Pending Network Settlement", a10: 5, a30: 2, a60: 1, a90: 0, aAbove: 0 },
      { sNo: 4, sundryCode: "1888-004", description: "1LINK Switch Interchange Receivable", asPerTB: 3120000.00, asPerRecon: 3120000.00, remarks: "Fully Reconciled", a10: 0, a30: 0, a60: 0, a90: 0, aAbove: 0 },
      { sNo: 5, sundryCode: "1888-005", description: "RAAST Instant Payment Exception GL", asPerTB: -145200.00, asPerRecon: -120000.00, remarks: "Reversal Pending Confirmation", a10: 2, a30: 1, a60: 0, a90: 0, aAbove: 0 }
    ],
    "1948": [
      { sNo: 1, sundryCode: "1948-101", description: "Visa/Mastercard Settlement Account", asPerTB: 45800000.00, asPerRecon: 45800000.00, remarks: "Fully Reconciled", a10: 0, a30: 0, a60: 0, a90: 0, aAbove: 0 },
      { sNo: 2, sundryCode: "1948-102", description: "Cardholder Overpayment Suspense", asPerTB: -1250400.00, asPerRecon: -1250400.00, remarks: "Outstanding Transactions - Closure Required", a10: 1, a30: 4, a60: 2, a90: 1, aAbove: 5 },
      { sNo: 3, sundryCode: "1948-103", description: "Merchant Discount Rate (MDR) Receivable", asPerTB: 6450000.00, asPerRecon: 6300000.00, remarks: "Batch Posting Difference", a10: 4, a30: 2, a60: 0, a90: 0, aAbove: 0 },
      { sNo: 4, sundryCode: "1948-104", description: "Annual Fee Income Clearing", asPerTB: 12100000.00, asPerRecon: 12100000.00, remarks: "Fully Reconciled", a10: 0, a30: 0, a60: 0, a90: 0, aAbove: 0 }
    ],
    "7928": [
      { sNo: 1, sundryCode: "7928-201", description: "Card Pro System Clearing Account", asPerTB: 28400000.00, asPerRecon: 28400000.00, remarks: "Fully Reconciled", a10: 0, a30: 0, a60: 0, a90: 0, aAbove: 0 },
      { sNo: 2, sundryCode: "7928-202", description: "International Dispute Claim Suspense", asPerTB: 3850000.00, asPerRecon: 3600000.00, remarks: "Pre-Arbitration Pending Response", a10: 2, a30: 3, a60: 5, a90: 4, aAbove: 8 },
      { sNo: 3, sundryCode: "7928-203", description: "Loyalty Rewards Redemption Transit", asPerTB: 980000.00, asPerRecon: 980000.00, remarks: "Fully Reconciled", a10: 0, a30: 0, a60: 0, a90: 0, aAbove: 0 }
    ],
    "1922": [
      { sNo: 1, sundryCode: "1922-301", description: "Ijarah Asset Rental Receivable", asPerTB: 18900000.00, asPerRecon: 18900000.00, remarks: "Fully Reconciled", a10: 0, a30: 0, a60: 0, a90: 0, aAbove: 0 },
      { sNo: 2, sundryCode: "1922-302", description: "Takaful Contribution Clearing Account", asPerTB: -410000.00, asPerRecon: -410000.00, remarks: "Outstanding Transactions - Closure Required", a10: 1, a30: 2, a60: 1, a90: 0, aAbove: 2 },
      { sNo: 3, sundryCode: "1922-303", description: "Islamic Auto Security Deposit GL", asPerTB: 5600000.00, asPerRecon: 5550000.00, remarks: "Adjustment Required", a10: 3, a30: 1, a60: 0, a90: 0, aAbove: 0 }
    ],
    "1944": [
      { sNo: 1, sundryCode: "1944-401", description: "Auto Finance Installment Clearing", asPerTB: 32150000.00, asPerRecon: 32150000.00, remarks: "Fully Reconciled", a10: 0, a30: 0, a60: 0, a90: 0, aAbove: 0 },
      { sNo: 2, sundryCode: "1944-402", description: "Dealer Commission Payable Suspense", asPerTB: -2450000.00, asPerRecon: -2450000.00, remarks: "Outstanding Transactions - Closure Required", a10: 2, a30: 5, a60: 3, a90: 1, aAbove: 4 },
      { sNo: 3, sundryCode: "1944-403", description: "Insurance Premium Discrepancy Account", asPerTB: 890000.00, asPerRecon: 840000.00, remarks: "Vendor Statement Pending", a10: 1, a30: 2, a60: 1, a90: 0, aAbove: 0 }
    ],
    "PRL": [
      { sNo: 1, sundryCode: "PRL-501", description: "Personal Loan Monthly Recovery GL", asPerTB: 54600000.00, asPerRecon: 54600000.00, remarks: "Fully Reconciled", a10: 0, a30: 0, a60: 0, a90: 0, aAbove: 0 },
      { sNo: 2, sundryCode: "PRL-502", description: "Early Settlement Excess Payment Account", asPerTB: -850300.00, asPerRecon: -850300.00, remarks: "Customer Refund Processing", a10: 3, a30: 4, a60: 2, a90: 1, aAbove: 3 },
      { sNo: 3, sundryCode: "PRL-503", description: "Mark-up Subsidy Clearing Account", asPerTB: 1420000.00, asPerRecon: 1400000.00, remarks: "Rate Difference Reconciled", a10: 2, a30: 1, a60: 0, a90: 0, aAbove: 0 }
    ],
    "1946": [
      { sNo: 1, sundryCode: "1946-601", description: "Housing Mortgage Disbursement Suspense", asPerTB: 68900000.00, asPerRecon: 68900000.00, remarks: "Fully Reconciled", a10: 0, a30: 0, a60: 0, a90: 0, aAbove: 0 },
      { sNo: 2, sundryCode: "1946-602", description: "Valuation & Legal Fee Escrow", asPerTB: -320000.00, asPerRecon: -320000.00, remarks: "Outstanding Transactions - Closure Required", a10: 1, a30: 2, a60: 0, a90: 0, aAbove: 1 },
      { sNo: 3, sundryCode: "1946-603", description: "Property Insurance Transit GL", asPerTB: 1150000.00, asPerRecon: 1100000.00, remarks: "Policy Renewal Pending", a10: 2, a30: 3, a60: 1, a90: 0, aAbove: 0 }
    ],
    "2000": [
      { sNo: 1, sundryCode: "2000-701", description: "SME Commercial Finance Clearing", asPerTB: 41200000.00, asPerRecon: 41200000.00, remarks: "Fully Reconciled", a10: 0, a30: 0, a60: 0, a90: 0, aAbove: 0 },
      { sNo: 2, sundryCode: "2000-702", description: "Guarantee & LC Margin Account", asPerTB: -3600000.00, asPerRecon: -3600000.00, remarks: "Margin Release Under Process", a10: 2, a30: 4, a60: 2, a90: 1, aAbove: 5 },
      { sNo: 3, sundryCode: "2000-703", description: "Working Capital Mark-up Adjustment", asPerTB: 620000.00, asPerRecon: 600000.00, remarks: "System Audit Reconciliation", a10: 1, a30: 1, a60: 0, a90: 0, aAbove: 0 }
    ],
    "Banca": [
      { sNo: 1, sundryCode: "BANCA-801", description: "Bancassurance Premium Collection GL", asPerTB: 22400000.00, asPerRecon: 22400000.00, remarks: "Fully Reconciled", a10: 0, a30: 0, a60: 0, a90: 0, aAbove: 0 },
      { sNo: 2, sundryCode: "BANCA-802", description: "Insurer Commission Settlement Suspense", asPerTB: -1840000.00, asPerRecon: -1840000.00, remarks: "Outstanding Transactions - Closure Required", a10: 2, a30: 3, a60: 2, a90: 1, aAbove: 3 },
      { sNo: 3, sundryCode: "BANCA-803", description: "Policy Cancellation Refund Account", asPerTB: 450000.00, asPerRecon: 430000.00, remarks: "Refund Reversal Outstanding", a10: 1, a30: 2, a60: 1, a90: 0, aAbove: 0 }
    ]
  };

  const baseRows = unitDemoMap[code] || unitDemoMap["1888"];

  return baseRows.map(function (r) {
    const diff = Number(r.asPerTB || 0) - Number(r.asPerRecon || 0);
    return Object.assign({}, r, { difference: diff });
  });
}

function buildReconSummaryTable(rows) {
  const wrap = el("div", { class: "table-wrap recon-table-wrap" });
  const table = el("table", { class: "recon-detail-table" });

  const thead = el("thead");
  const trHead = el("tr");

  [
    { text: "S.No",          cls: "col-center" },
    { text: "Sundry Code",   cls: "col-left" },
    { text: "Description",   cls: "col-left col-wide" },
    { text: "As per TB" },
    { text: "As per Recon" },
    { text: "Difference" },
    { text: "Recon Remarks", cls: "col-left col-wide" }
  ].forEach(function (c) {
    const th = el("th", { text: c.text });
    if (c.cls) th.className = c.cls;
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = el("tbody");
  let totTB = 0, totRecon = 0, totDiff = 0;

  rows.forEach(function (r) {
    totTB   += Number(r.asPerTB)    || 0;
    totRecon += Number(r.asPerRecon) || 0;
    totDiff  += Number(r.difference) || 0;

    const tr = el("tr");
    tr.appendChild(el("td", { text: String(r.sNo), class: "center" }));
    tr.appendChild(el("td", { text: r.sundryCode, style: "font-weight:600;" }));
    tr.appendChild(el("td", { text: r.description, style: "font-weight:600;" }));
    tr.appendChild(el("td", { text: formatReconVal(r.asPerTB),     class: "num" }));
    tr.appendChild(el("td", { text: formatReconVal(r.asPerRecon),  class: "num" }));
    tr.appendChild(el("td", { text: formatReconVal(r.difference),  class: "num recon-diff-cell" }));
    tr.appendChild(el("td", { text: r.remarks }));
    tbody.appendChild(tr);
  });

  const trTotal = el("tr", { class: "total-row" });
  trTotal.appendChild(el("td", { text: "", class: "center" }));
  trTotal.appendChild(el("td", { text: "TOTAL", style: "font-weight:700;" }));
  trTotal.appendChild(el("td", { text: "Summary Total", style: "font-weight:700;" }));
  trTotal.appendChild(el("td", { text: formatReconVal(totTB),    class: "num" }));
  trTotal.appendChild(el("td", { text: formatReconVal(totRecon), class: "num" }));
  trTotal.appendChild(el("td", { text: formatReconVal(totDiff),  class: "num recon-diff-cell" }));
  trTotal.appendChild(el("td", { text: "" }));
  tbody.appendChild(trTotal);

  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function buildReconAgingTable(rows) {
  const wrap = el("div", { class: "table-wrap recon-table-wrap" });
  const table = el("table", { class: "recon-detail-table" });

  const thead = el("thead");
  const trHead = el("tr");

  [
    { text: "S.No",                cls: "col-center" },
    { text: "Description",         cls: "col-left col-wide" },
    { text: "01 to 10 Days" },
    { text: "11 to 30 Days" },
    { text: "31 to 60 Days" },
    { text: "61 to 90 Days" },
    { text: "91 and above Days" }
  ].forEach(function (c) {
    const th = el("th", { text: c.text });
    if (c.cls) th.className = c.cls;
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = el("tbody");
  let totA10 = 0, totA30 = 0, totA60 = 0, totA90 = 0, totAAbove = 0;

  rows.forEach(function (r) {
    totA10    += Number(r.a10)    || 0;
    totA30    += Number(r.a30)    || 0;
    totA60    += Number(r.a60)    || 0;
    totA90    += Number(r.a90)    || 0;
    totAAbove += Number(r.aAbove) || 0;

    const tr = el("tr");
    tr.appendChild(el("td", { text: String(r.sNo), class: "center" }));
    tr.appendChild(el("td", { text: r.description, style: "font-weight:600;" }));
    tr.appendChild(el("td", { text: formatAgingCount(r.a10),    class: "num" }));
    tr.appendChild(el("td", { text: formatAgingCount(r.a30),    class: "num" }));
    tr.appendChild(el("td", { text: formatAgingCount(r.a60),    class: "num" }));
    tr.appendChild(el("td", { text: formatAgingCount(r.a90),    class: "num" }));
    tr.appendChild(el("td", { text: formatAgingCount(r.aAbove), class: "num" }));
    tbody.appendChild(tr);
  });

  const trTotal = el("tr", { class: "total-row" });
  trTotal.appendChild(el("td", { text: "", class: "center" }));
  trTotal.appendChild(el("td", { text: "TOTAL", style: "font-weight:700;" }));
  trTotal.appendChild(el("td", { text: formatAgingCount(totA10),    class: "num" }));
  trTotal.appendChild(el("td", { text: formatAgingCount(totA30),    class: "num" }));
  trTotal.appendChild(el("td", { text: formatAgingCount(totA60),    class: "num" }));
  trTotal.appendChild(el("td", { text: formatAgingCount(totA90),    class: "num" }));
  trTotal.appendChild(el("td", { text: formatAgingCount(totAAbove), class: "num" }));
  tbody.appendChild(trTotal);

  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderReconciliation(data) {
  const root = document.getElementById("reconciliation-body");
  if (!root) return;
  root.innerHTML = "";

  if (!activeReconciliationUnit) {
    // LEVEL 1: Unit Selection Window
    root.appendChild(sectionTitle("Reconciliation Unit Selection"));
    
    const grid = el("div", { class: "recon-unit-grid" });
    RECON_UNITS.forEach(function (unit) {
      const card = el("div", { class: "recon-unit-card", type: "button" });
      card.appendChild(el("div", { class: "recon-unit-code", text: unit.code }));
      card.appendChild(el("div", { class: "recon-unit-name", text: unit.name }));
      
      card.addEventListener("click", function () {
        activeReconciliationUnit = unit;
        renderReconciliation(currentData());
      });
      grid.appendChild(card);
    });
    root.appendChild(grid);
  } else {
    // LEVEL 2: Unit-specific Reconciliation Details
    const unit = activeReconciliationUnit;

    // --- Top bar: small circular arrow back button ---
    const topBar = el("div", { class: "recon-detail-topbar" });
    const backBtn = el("button", { class: "recon-back-circle", type: "button", "aria-label": "Back to Reconciliation" });
    backBtn.innerHTML = "&#8592;";
    backBtn.addEventListener("click", function () {
      activeReconciliationUnit = null;
      renderReconciliation(currentData());
    });
    topBar.appendChild(backBtn);
    root.appendChild(topBar);

    // --- Centered unit heading ---
    const heading = el("h3", { class: "recon-centered-heading" });
    heading.textContent = "Reconciliation OF " + (unit.titleName || unit.fullName);
    root.appendChild(heading);

    // --- Table 1: Reconciliation Summary ---
    root.appendChild(sectionTitle("Reconciliation Summary"));
    const rows = getReconciliationUnitRows(unit, data);
    root.appendChild(buildReconSummaryTable(rows));

    // --- Table 2: Aging Analysis ---
    root.appendChild(sectionTitle("Aging Analysis"));
    root.appendChild(buildReconAgingTable(rows));
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
  arr.forEach(function (b) { b.share = calculateShare(b.amount, total); });
  return arr.length ? arr : null;
}

/* ---------------------------------------------------------------------
   17. PAGE 7 — SECURE OPERATIONS
   --------------------------------------------------------------------- */

function renderSecureOperations(data) {
  const root = document.getElementById("secure-operations-body");
  if (!root) return;
  root.innerHTML = "";
  const lbl = getPeriodLabels();

  const sec = data.secureOperations || generateIllustrativeData().secureOperations;
  const breakdown = data.secureOpsBreakdown || generateIllustrativeData().secureOpsBreakdown;

  root.appendChild(sectionTitle("Secure Operations Executive Summary"));

  const grid = el("div", { class: "kpi-grid" });
  grid.appendChild(kpiCard("Total Secure Transactions (" + lbl.shortPrimary + ")", formatNumber(sec.totalTxnToday),
    lbl.comparisonTerm + ": " + formatNumber(sec.totalTxnYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(sec.totalTxnToday, sec.totalTxnYesterday, true, false).html));

  grid.appendChild(kpiCard("Successful Transactions (" + lbl.shortPrimary + ")", formatNumber(sec.successTxnToday),
    lbl.comparisonTerm + ": " + formatNumber(sec.successTxnYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(sec.successTxnToday, sec.successTxnYesterday, true, false).html));

  grid.appendChild(kpiCard("Secure Success Rate (" + lbl.shortPrimary + ")", formatPercentage(sec.successRateToday),
    lbl.comparisonTerm + ": " + formatPercentage(sec.successRateYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(sec.successRateToday, sec.successRateYesterday, true, false).html));

  grid.appendChild(kpiCard("Total Transaction Amount (" + lbl.shortPrimary + ")", formatCurrency(sec.totalAmountToday),
    lbl.comparisonTerm + ": " + formatCurrency(sec.totalAmountYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(sec.totalAmountToday, sec.totalAmountYesterday, true, false).html, fullValueTitle(sec.totalAmountToday, true)));

  grid.appendChild(kpiCard("Failed Transactions (" + lbl.shortPrimary + ")", formatNumber(sec.failedTxnToday),
    lbl.comparisonTerm + ": " + formatNumber(sec.failedTxnYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(sec.failedTxnToday, sec.failedTxnYesterday, false, false).html));

  grid.appendChild(kpiCard("Pending / Exception Items (" + lbl.shortPrimary + ")", formatNumber(sec.pendingItemsToday),
    lbl.comparisonTerm + ": " + formatNumber(sec.pendingItemsYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(sec.pendingItemsToday, sec.pendingItemsYesterday, false, false).html));

  root.appendChild(grid);

  root.appendChild(sectionTitle(lbl.tableSectionTitle));
  const dailyColumns = [
    { key: "metric", label: "Metric" },
    { key: "today", label: lbl.shortPrimary, numeric: true },
    { key: "yesterday", label: lbl.comparisonTerm, numeric: true },
    { key: "change", label: "Change", numeric: true },
    { key: "currentMonth", label: lbl.trendTerm, numeric: true }
  ];

  const dailyRows = [
    {
      metric: "Successful Secure Transactions Count",
      today: formatNumber(sec.successTxnToday),
      yesterday: formatNumber(sec.successTxnYesterday),
      change: calculateComparisons(sec.successTxnToday, sec.successTxnYesterday, true, false).html,
      currentMonth: formatNumber(sec.successTxnMTD)
    },
    {
      metric: "Successful Transaction Amount",
      today: formatCurrency(sec.totalAmountToday),
      yesterday: formatCurrency(sec.totalAmountYesterday),
      change: calculateComparisons(sec.totalAmountToday, sec.totalAmountYesterday, true, false).html,
      currentMonth: formatCurrency(sec.totalAmountMTD)
    },
    {
      metric: "Secure Success Rate (%)",
      today: formatPercentage(sec.successRateToday),
      yesterday: formatPercentage(sec.successRateYesterday),
      change: calculateComparisons(sec.successRateToday, sec.successRateYesterday, true, false).html,
      currentMonth: formatPercentage(sec.successRateMTD)
    },
    {
      metric: "Failed Transactions Count",
      today: formatNumber(sec.failedTxnToday),
      yesterday: formatNumber(sec.failedTxnYesterday),
      change: calculateComparisons(sec.failedTxnToday, sec.failedTxnYesterday, false, false).html,
      currentMonth: formatNumber(sec.failedTxnMTD)
    },
    {
      metric: "Pending / Exception Items",
      today: formatNumber(sec.pendingItemsToday),
      yesterday: formatNumber(sec.pendingItemsYesterday),
      change: calculateComparisons(sec.pendingItemsToday, sec.pendingItemsYesterday, false, false).html,
      currentMonth: formatNumber(sec.pendingItemsMTD)
    }
  ];

  root.appendChild(buildTable(null, dailyColumns, dailyRows));

  root.appendChild(sectionTitle("Authentication Channel Breakdown"));
  const breakdownColumns = [
    { key: "channel", label: "Authentication Channel" },
    { key: "txnCount", label: "Transaction Count", numeric: true },
    { key: "amount", label: "Transaction Amount", currency: true },
    { key: "successRate", label: "Success Rate (%)", percent: true },
    { key: "pendingItems", label: "Pending Items", numeric: true }
  ];

  root.appendChild(buildTable(null, breakdownColumns, breakdown));

  root.appendChild(sectionTitle("Channel Volume & Success Rate Insight"));
  const chartCard = el("div", { class: "ov-chart-card" });
  chartCard.appendChild(el("div", { class: "ov-chart-title", text: "Secure Operations Channel Share" }));
  const chartBody = el("div", { class: "ov-chart-body" });
  chartBody.innerHTML = buildSecOpsChartSVG(breakdown);
  chartCard.appendChild(chartBody);
  root.appendChild(chartCard);
}

function buildSecOpsChartSVG(breakdown) {
  var total = breakdown.reduce(function (s, b) { return s + b.txnCount; }, 0) || 1;
  var COLORS = ["#117ABF", "#6FAED2", "#90C4E4", "#D0E5F3"];
  var W = 600, barH = 28, padX = 10, gapY = 14, legH = 20;
  var H = barH + gapY + legH * Math.ceil(breakdown.length / 2) + 10;
  var barW = W - 2 * padX;
  var x = padX, rects = "";

  breakdown.forEach(function (b, i) {
    var w = Math.max(4, (b.txnCount / total) * barW);
    var color = COLORS[i % COLORS.length];
    var pct = ((b.txnCount / total) * 100).toFixed(1);
    rects += '<rect x="' + x.toFixed(1) + '" y="4" width="' + w.toFixed(1) + '" height="' + barH + '" fill="' + color + '" rx="3" class="chart-bar-seg">'
      + '<title>' + b.channel + ': ' + formatNumber(b.txnCount) + ' (' + pct + '%)</title></rect>';
    x += w;
  });

  var legends = breakdown.map(function (b, i) {
    var col = i % 2;
    var row = Math.floor(i / 2);
    var lx = padX + col * 290;
    var ly = barH + gapY + row * legH + 6;
    var color = COLORS[i % COLORS.length];
    var pct = ((b.txnCount / total) * 100).toFixed(1);
    return '<rect x="' + lx + '" y="' + ly + '" width="12" height="12" fill="' + color + '" rx="2"/>'
      + '<text x="' + (lx + 18) + '" y="' + (ly + 10) + '" font-size="11.5" fill="#1F2937" font-weight="600">' + b.channel + '</text>'
      + '<text x="' + (lx + 180) + '" y="' + (ly + 10) + '" font-size="11.5" fill="#6B7280">' + formatNumber(b.txnCount) + ' (' + pct + '%)</text>';
  }).join("");

  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Secure Operations Breakdown" style="width:100%;max-height:160px;display:block">'
    + rects + legends + '</svg>';
}

/* ---------------------------------------------------------------------
   18. PAGE 8 — UNSECURED OPERATIONS
   --------------------------------------------------------------------- */

function renderUnsecuredOperations(data) {
  const root = document.getElementById("unsecured-operations-body");
  if (!root) return;
  root.innerHTML = "";
  const lbl = getPeriodLabels();

  const unsec = data.unsecuredOperations || generateIllustrativeData().unsecuredOperations;
  const breakdown = data.unsecuredOpsBreakdown || generateIllustrativeData().unsecuredOpsBreakdown;

  root.appendChild(sectionTitle("Unsecured Operations Executive Summary"));

  const grid = el("div", { class: "kpi-grid" });
  grid.appendChild(kpiCard("Total Transactions (" + lbl.shortPrimary + ")", formatNumber(unsec.totalTxnToday),
    lbl.comparisonTerm + ": " + formatNumber(unsec.totalTxnYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(unsec.totalTxnToday, unsec.totalTxnYesterday, true, false).html));

  grid.appendChild(kpiCard("Successful Transactions (" + lbl.shortPrimary + ")", formatNumber(unsec.successTxnToday),
    lbl.comparisonTerm + ": " + formatNumber(unsec.successTxnYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(unsec.successTxnToday, unsec.successTxnYesterday, true, false).html));

  grid.appendChild(kpiCard("Success Rate (" + lbl.shortPrimary + ")", formatPercentage(unsec.successRateToday),
    lbl.comparisonTerm + ": " + formatPercentage(unsec.successRateYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(unsec.successRateToday, unsec.successRateYesterday, true, false).html));

  grid.appendChild(kpiCard("Transaction Amount (" + lbl.shortPrimary + ")", formatCurrency(unsec.totalAmountToday),
    lbl.comparisonTerm + ": " + formatCurrency(unsec.totalAmountYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(unsec.totalAmountToday, unsec.totalAmountYesterday, true, false).html, fullValueTitle(unsec.totalAmountToday, true)));

  grid.appendChild(kpiCard("Failed Transactions (" + lbl.shortPrimary + ")", formatNumber(unsec.failedTxnToday),
    lbl.comparisonTerm + ": " + formatNumber(unsec.failedTxnYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(unsec.failedTxnToday, unsec.failedTxnYesterday, false, false).html));

  grid.appendChild(kpiCard("Pending / Exception Items (" + lbl.shortPrimary + ")", formatNumber(unsec.pendingItemsToday),
    lbl.comparisonTerm + ": " + formatNumber(unsec.pendingItemsYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(unsec.pendingItemsToday, unsec.pendingItemsYesterday, false, false).html));

  root.appendChild(grid);

  root.appendChild(sectionTitle(lbl.tableSectionTitle));
  const dailyColumns = [
    { key: "metric", label: "Metric" },
    { key: "today", label: lbl.shortPrimary, numeric: true },
    { key: "yesterday", label: lbl.comparisonTerm, numeric: true },
    { key: "change", label: "Change", numeric: true },
    { key: "currentMonth", label: lbl.trendTerm, numeric: true }
  ];

  const dailyRows = [
    {
      metric: "Successful Unsecured Transactions Count",
      today: formatNumber(unsec.successTxnToday),
      yesterday: formatNumber(unsec.successTxnYesterday),
      change: calculateComparisons(unsec.successTxnToday, unsec.successTxnYesterday, true, false).html,
      currentMonth: formatNumber(unsec.successTxnMTD)
    },
    {
      metric: "Transaction Amount",
      today: formatCurrency(unsec.totalAmountToday),
      yesterday: formatCurrency(unsec.totalAmountYesterday),
      change: calculateComparisons(unsec.totalAmountToday, unsec.totalAmountYesterday, true, false).html,
      currentMonth: formatCurrency(unsec.totalAmountMTD)
    },
    {
      metric: "Success Rate (%)",
      today: formatPercentage(unsec.successRateToday),
      yesterday: formatPercentage(unsec.successRateYesterday),
      change: calculateComparisons(unsec.successRateToday, unsec.successRateYesterday, true, false).html,
      currentMonth: formatPercentage(unsec.successRateMTD)
    },
    {
      metric: "Failed Transactions Count",
      today: formatNumber(unsec.failedTxnToday),
      yesterday: formatNumber(unsec.failedTxnYesterday),
      change: calculateComparisons(unsec.failedTxnToday, unsec.failedTxnYesterday, false, false).html,
      currentMonth: formatNumber(unsec.failedTxnMTD)
    },
    {
      metric: "Pending / Exception Items",
      today: formatNumber(unsec.pendingItemsToday),
      yesterday: formatNumber(unsec.pendingItemsYesterday),
      change: calculateComparisons(unsec.pendingItemsToday, unsec.pendingItemsYesterday, false, false).html,
      currentMonth: formatNumber(unsec.pendingItemsMTD)
    }
  ];

  root.appendChild(buildTable(null, dailyColumns, dailyRows));

  root.appendChild(sectionTitle("Unsecured Product Performance Breakdown"));
  const breakdownColumns = [
    { key: "product", label: "Product Category" },
    { key: "txnCount", label: "Transaction Count", numeric: true },
    { key: "amount", label: "Transaction Amount", currency: true },
    { key: "successRate", label: "Success Rate (%)", percent: true },
    { key: "pendingItems", label: "Pending Items", numeric: true }
  ];

  root.appendChild(buildTable(null, breakdownColumns, breakdown));

  root.appendChild(sectionTitle("Unsecured Product Volume & Distribution"));
  const chartCard = el("div", { class: "ov-chart-card" });
  chartCard.appendChild(el("div", { class: "ov-chart-title", text: "Unsecured Product Volume Share" }));
  const chartBody = el("div", { class: "ov-chart-body" });
  chartBody.innerHTML = buildUnsecOpsChartSVG(breakdown);
  chartCard.appendChild(chartBody);
  root.appendChild(chartCard);
}

function buildUnsecOpsChartSVG(breakdown) {
  var total = breakdown.reduce(function (s, b) { return s + b.amount; }, 0) || 1;
  var COLORS = ["#117ABF", "#6FAED2", "#90C4E4", "#D0E5F3"];
  var W = 600, barH = 28, padX = 10, gapY = 14, legH = 20;
  var H = barH + gapY + legH * Math.ceil(breakdown.length / 2) + 10;
  var barW = W - 2 * padX;
  var x = padX, rects = "";

  breakdown.forEach(function (b, i) {
    var w = Math.max(4, (b.amount / total) * barW);
    var color = COLORS[i % COLORS.length];
    var pct = ((b.amount / total) * 100).toFixed(1);
    rects += '<rect x="' + x.toFixed(1) + '" y="4" width="' + w.toFixed(1) + '" height="' + barH + '" fill="' + color + '" rx="3" class="chart-bar-seg">'
      + '<title>' + b.product + ': ' + formatCurrency(b.amount) + ' (' + pct + '%)</title></rect>';
    x += w;
  });

  var legends = breakdown.map(function (b, i) {
    var col = i % 2;
    var row = Math.floor(i / 2);
    var lx = padX + col * 290;
    var ly = barH + gapY + row * legH + 6;
    var color = COLORS[i % COLORS.length];
    var pct = ((b.amount / total) * 100).toFixed(1);
    return '<rect x="' + lx + '" y="' + ly + '" width="12" height="12" fill="' + color + '" rx="2"/>'
      + '<text x="' + (lx + 18) + '" y="' + (ly + 10) + '" font-size="11.5" fill="#1F2937" font-weight="600">' + b.product + '</text>'
      + '<text x="' + (lx + 180) + '" y="' + (ly + 10) + '" font-size="11.5" fill="#6B7280">' + formatCurrency(b.amount) + ' (' + pct + '%)</text>';
  }).join("");

  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Unsecured Operations Breakdown" style="width:100%;max-height:160px;display:block">'
    + rects + legends + '</svg>';
}

/* ---------------------------------------------------------------------
   19. PAGE 9 — BANCA
   --------------------------------------------------------------------- */

function renderBanca(data) {
  const root = document.getElementById("banca-body");
  if (!root) return;
  root.innerHTML = "";
  const lbl = getPeriodLabels();

  const ban = data.banca || generateIllustrativeData().banca;
  const breakdown = data.bancaOpsBreakdown || generateIllustrativeData().bancaOpsBreakdown;

  root.appendChild(sectionTitle("Banca Operations Executive Summary"));

  const grid = el("div", { class: "kpi-grid" });
  grid.appendChild(kpiCard("Total Banca Transactions (" + lbl.shortPrimary + ")", formatNumber(ban.totalTxnToday),
    lbl.comparisonTerm + ": " + formatNumber(ban.totalTxnYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(ban.totalTxnToday, ban.totalTxnYesterday, true, false).html));

  grid.appendChild(kpiCard("Successful Transactions (" + lbl.shortPrimary + ")", formatNumber(ban.successTxnToday),
    lbl.comparisonTerm + ": " + formatNumber(ban.successTxnYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(ban.successTxnToday, ban.successTxnYesterday, true, false).html));

  grid.appendChild(kpiCard("Success Rate (" + lbl.shortPrimary + ")", formatPercentage(ban.successRateToday),
    lbl.comparisonTerm + ": " + formatPercentage(ban.successRateYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(ban.successRateToday, ban.successRateYesterday, true, false).html));

  grid.appendChild(kpiCard("Transaction Amount (" + lbl.shortPrimary + ")", formatCurrency(ban.totalAmountToday),
    lbl.comparisonTerm + ": " + formatCurrency(ban.totalAmountYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(ban.totalAmountToday, ban.totalAmountYesterday, true, false).html, fullValueTitle(ban.totalAmountToday, true)));

  grid.appendChild(kpiCard("Failed Transactions (" + lbl.shortPrimary + ")", formatNumber(ban.failedTxnToday),
    lbl.comparisonTerm + ": " + formatNumber(ban.failedTxnYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(ban.failedTxnToday, ban.failedTxnYesterday, false, false).html));

  grid.appendChild(kpiCard("Pending / Exception Items (" + lbl.shortPrimary + ")", formatNumber(ban.pendingItemsToday),
    lbl.comparisonTerm + ": " + formatNumber(ban.pendingItemsYesterday) + " &nbsp;|&nbsp; " + calculateComparisons(ban.pendingItemsToday, ban.pendingItemsYesterday, false, false).html));

  root.appendChild(grid);

  root.appendChild(sectionTitle(lbl.tableSectionTitle));
  const dailyColumns = [
    { key: "metric", label: "Metric" },
    { key: "today", label: lbl.shortPrimary, numeric: true },
    { key: "yesterday", label: lbl.comparisonTerm, numeric: true },
    { key: "change", label: "Change", numeric: true },
    { key: "currentMonth", label: lbl.trendTerm, numeric: true }
  ];

  const dailyRows = [
    {
      metric: "Successful Banca Transactions Count",
      today: formatNumber(ban.successTxnToday),
      yesterday: formatNumber(ban.successTxnYesterday),
      change: calculateComparisons(ban.successTxnToday, ban.successTxnYesterday, true, false).html,
      currentMonth: formatNumber(ban.successTxnMTD)
    },
    {
      metric: "Transaction Amount",
      today: formatCurrency(ban.totalAmountToday),
      yesterday: formatCurrency(ban.totalAmountYesterday),
      change: calculateComparisons(ban.totalAmountToday, ban.totalAmountYesterday, true, false).html,
      currentMonth: formatCurrency(ban.totalAmountMTD)
    },
    {
      metric: "Success Rate (%)",
      today: formatPercentage(ban.successRateToday),
      yesterday: formatPercentage(ban.successRateYesterday),
      change: calculateComparisons(ban.successRateToday, ban.successRateYesterday, true, false).html,
      currentMonth: formatPercentage(ban.successRateMTD)
    },
    {
      metric: "Failed Transactions Count",
      today: formatNumber(ban.failedTxnToday),
      yesterday: formatNumber(ban.failedTxnYesterday),
      change: calculateComparisons(ban.failedTxnToday, ban.failedTxnYesterday, false, false).html,
      currentMonth: formatNumber(ban.failedTxnMTD)
    },
    {
      metric: "Pending / Exception Items",
      today: formatNumber(ban.pendingItemsToday),
      yesterday: formatNumber(ban.pendingItemsYesterday),
      change: calculateComparisons(ban.pendingItemsToday, ban.pendingItemsYesterday, false, false).html,
      currentMonth: formatNumber(ban.pendingItemsMTD)
    }
  ];

  root.appendChild(buildTable(null, dailyColumns, dailyRows));

  root.appendChild(sectionTitle("Banca Product Operational Breakdown"));
  const breakdownColumns = [
    { key: "product", label: "Banca Product Line" },
    { key: "txnCount", label: "Transaction Count", numeric: true },
    { key: "amount", label: "Transaction Amount", currency: true },
    { key: "successRate", label: "Success Rate (%)", percent: true },
    { key: "pendingItems", label: "Pending Items", numeric: true }
  ];

  root.appendChild(buildTable(null, breakdownColumns, breakdown));

  root.appendChild(sectionTitle("Banca Portfolio Share & Analytical Insight"));
  const chartCard = el("div", { class: "ov-chart-card" });
  chartCard.appendChild(el("div", { class: "ov-chart-title", text: "Banca Product Portfolio Share" }));
  const chartBody = el("div", { class: "ov-chart-body" });
  chartBody.innerHTML = buildBancaChartSVG(breakdown);
  chartCard.appendChild(chartBody);
  root.appendChild(chartCard);
}

function buildBancaChartSVG(breakdown) {
  var total = breakdown.reduce(function (s, b) { return s + b.amount; }, 0) || 1;
  var COLORS = ["#117ABF", "#6FAED2", "#90C4E4", "#D0E5F3"];
  var W = 600, barH = 28, padX = 10, gapY = 14, legH = 20;
  var H = barH + gapY + legH * Math.ceil(breakdown.length / 2) + 10;
  var barW = W - 2 * padX;
  var x = padX, rects = "";

  breakdown.forEach(function (b, i) {
    var w = Math.max(4, (b.amount / total) * barW);
    var color = COLORS[i % COLORS.length];
    var pct = ((b.amount / total) * 100).toFixed(1);
    rects += '<rect x="' + x.toFixed(1) + '" y="4" width="' + w.toFixed(1) + '" height="' + barH + '" fill="' + color + '" rx="3" class="chart-bar-seg">'
      + '<title>' + b.product + ': ' + formatCurrency(b.amount) + ' (' + pct + '%)</title></rect>';
    x += w;
  });

  var legends = breakdown.map(function (b, i) {
    var col = i % 2;
    var row = Math.floor(i / 2);
    var lx = padX + col * 290;
    var ly = barH + gapY + row * legH + 6;
    var color = COLORS[i % COLORS.length];
    var pct = ((b.amount / total) * 100).toFixed(1);
    return '<rect x="' + lx + '" y="' + ly + '" width="12" height="12" fill="' + color + '" rx="2"/>'
      + '<text x="' + (lx + 18) + '" y="' + (ly + 10) + '" font-size="11.5" fill="#1F2937" font-weight="600">' + b.product + '</text>'
      + '<text x="' + (lx + 180) + '" y="' + (ly + 10) + '" font-size="11.5" fill="#6B7280">' + formatCurrency(b.amount) + ' (' + pct + '%)</text>';
  }).join("");

  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Banca Operations Breakdown" style="width:100%;max-height:160px;display:block">'
    + rects + legends + '</svg>';
}

/* ---------------------------------------------------------------------
   20. INITIALIZATION
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
  dom.filterFromDate = document.getElementById("filterFromDate");
  dom.filterToDate = document.getElementById("filterToDate");
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

  if (dom.filterPeriod) dom.filterPeriod.addEventListener("change", function () { applyFilters("period"); });
  if (dom.filterReportingMonth) dom.filterReportingMonth.addEventListener("change", function () { applyFilters("month"); });
  if (dom.filterFromDate) dom.filterFromDate.addEventListener("change", function () { applyFilters("date"); });
  if (dom.filterToDate) dom.filterToDate.addEventListener("change", function () { applyFilters("date"); });
  if (dom.filterReportingDate) dom.filterReportingDate.addEventListener("change", function () { applyFilters("date"); });

  [dom.filterCreditDebit, dom.filterDomIntl, dom.filterIssAcq]
    .forEach(function (input) { if (input) input.addEventListener("change", function () { applyFilters(); }); });

  window.addEventListener("hashchange", handleHashChange);
}

function init() {
  cacheDom();
  bindEvents();

  const now = new Date();
  const yr = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  if (dom.filterReportingMonth && !dom.filterReportingMonth.value) {
    dom.filterReportingMonth.value = yr + "-" + mo;
  }
  if (dom.filterFromDate && !dom.filterFromDate.value) {
    dom.filterFromDate.value = yr + "-" + mo + "-01";
  }
  if (dom.filterToDate && !dom.filterToDate.value) {
    const lastDay = new Date(yr, now.getMonth() + 1, 0).getDate();
    dom.filterToDate.value = yr + "-" + mo + "-" + String(lastDay).padStart(2, "0");
  }
  if (dom.filterReportingDate && !dom.filterReportingDate.value) {
    dom.filterReportingDate.value = dom.filterFromDate.value;
  }

  applyFilters();
  updateHeaderStatus();
  if (!window.location.hash) window.location.hash = "#overview";
  handleHashChange();
  if (typeof XLSX === "undefined") {
    showMessage("Note: js/xlsx.min.js was not found, so only CSV files can be loaded until the library is added.", "info");
  }
}

document.addEventListener("DOMContentLoaded", init);
