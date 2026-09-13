UBL ADC & CARDS OPERATIONS DASHBOARD
=====================================

WHAT IT DOES
------------
A management-level analytics dashboard for ADC (Alternate Delivery Channels)
and Cards Operations. It processes an Excel (.xlsx) data file and displays
live KPIs, charts, alerts, and operational summaries across six pages:

  1. Overview          - High-level KPIs, ADC usage trends, NOSTRO positions,
                         and system-wide alert notifications.
  2. ADC Operations    - ATM/CDM/POS performance, channel uptime, fault trends,
                         and replenishment status.
  3. Card Non-Financials - Card lifecycle stats (CIF, AIF, issued, active, blocked,
                           inactive) and operational metrics by product.
  4. Card Financials   - Comprehensive revenue summary, transaction volumes,
                         and product-level financial performance.
  5. Chargeback        - Chargeback case tracking, aging buckets, and resolution status.
  6. Reconciliation    - Nostro GL reconciliation, funding requirements, and buffers.

HOW TO USE
----------
1. Double-click Dashboard.bat  OR  open Dashboard.html directly in Chrome/Edge.
2. Click "Load Excel File" in the top-right and select your .xlsx data file.
3. Use the date/filter controls to narrow the view as needed.
4. Navigate pages using the top menu tabs.
5. Click any alert toast (bottom-left) to jump to the relevant page.
6. Click "Refresh" to reload data from the same file.

REQUIREMENTS
------------
- Modern browser: Chrome 90+ or Edge 90+ recommended.
- Excel file must follow the expected sheet/column structure.
- No internet connection required - fully offline.
