DATA REFERENCE — EXPECTED WORKBOOK LAYOUT
============================================

This dashboard reads a single Excel workbook (.xlsx or .xls) or a single
.csv file. For .csv files only one table can be supplied, so a full
multi-sheet .xlsx workbook is recommended for complete coverage of all six
pages.

Missing sheets never crash the dashboard — the affected section simply
shows "No data available" while everything else keeps working.

SUPPORTED SHEET NAMES (case-insensitive, exact spelling preferred)
---------------------------------------------------------------------
ATM                     — ATM Operations KPIs + top/bottom performing ATMs
RAAST                   — RAAST KPIs
IBFT                    — IBFT KPIs
IBFT_Failures           — IBFT failure-reason breakdown
Card_Inventory          — Card-plastic stock by category
Card_Stationery         — Envelopes, mailers, PIN mailers, welcome packs
Active_Cards            — Cards in force by product
Card_Financials         — Credit and debit card financial KPIs
Spend_By_Product        — Debit vs credit monthly spend
Spend_By_Channel        — E-Commerce / ATM / POS monthly spend
Top_Merchants           — Top merchants by card spend
Chargeback              — Chargeback/dispute metrics by category
Chargeback_Merchants    — Per-merchant dispute and chargeback detail
Reconciliation          — Receivables and payables by GL and aging bucket
Nostro                  — Daily Nostro position
Rejected_Transactions   — Rejected transactions and reposting status
Overview                — Optional; not required, since the Overview page
                          is auto-generated from the other sheets

ACCEPTED COLUMN NAME VARIATIONS (a few examples)
----------------------------------------------------
Txn Count / Transaction Count / Transactions / Count
Txn Amount / Transaction Amount / Value / Amount
Complaint Count / Complaints
Captured Cards / Card Captures / Cards Captured
GL / GL No / GL Number
MoM / Month on Month / Monthly Change

Column names are matched case-insensitively and ignore extra spaces.

DATE FORMATS
------------
Standard Excel date cells are supported. If supplying dates as text, use
YYYY-MM-DD for best results.

NUMBER FORMATS
--------------
Plain numbers are expected in amount/count columns. Currency symbols,
thousands separators and percentage signs in text cells (e.g. "PKR 1,250"
or "98.5%") are automatically cleaned before use.

CARD-PLASTIC INVENTORY THRESHOLDS (Card_Inventory sheet)
-------------------------------------------------------------
Planning horizon: 8 months
Status = Sufficient   when months of cover > 6
Status = Warning      when months of cover is > 3 and <= 6
Status = Critical     when months of cover <= 3
Months of cover = Current Quantity / Average Monthly Consumption

Stationery items (Card_Stationery sheet) are expected to maintain a
minimum of 3 months of cover (Envelopes and Mailers in particular).

REQUIRED VS OPTIONAL FIELDS
-------------------------------
- Every sheet is optional — the dashboard degrades gracefully per section.
- Within a sheet, all listed columns are optional at the parser level;
  columns that are absent display as "N/A" or are omitted from the
  relevant comparison, rather than causing an error.
- Rows with entirely blank values are ignored automatically.

PRIVACY
-------
Do not include customer names, full card numbers, account numbers or
CNIC/national ID numbers in any sheet. The dashboard is designed to work
with aggregated, non-identifying operational and financial figures only.
