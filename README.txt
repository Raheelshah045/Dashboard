ADC & CARDS OPERATIONS DASHBOARD — README
==========================================

WHAT THIS IS
------------
A fully offline, portable management dashboard for ADC Operations and Cards
Operations, built with plain HTML, CSS and JavaScript. It runs directly in
your web browser from the local folder — nothing is installed, no server is
started, and no internet connection is used.

HOW TO START THE DASHBOARD
---------------------------
1. Extract "Dashboard.zip" to any folder on your computer (Desktop, a USB
   drive, a shared drive — anywhere you have write access is fine, though
   write access is not actually required to run it).
2. Open the extracted "Dashboard" folder.
3. Double-click "Dashboard.bat".
4. Your default web browser (Microsoft Edge or Google Chrome recommended)
   will open the dashboard automatically. No command window stays open.
5. Use the six menu options on the left to move between the independent
   dashboard pages: Overview, ADC Operations, Card Non-Financials, Card
   Financials, Chargeback, Reconciliation.

LOADING YOUR OWN DATA
----------------------
6. Click "Load Excel File" in the header.
7. Select the required workbook (.xlsx, .xls or .csv) from the standard
   file picker. Browsers do not allow a webpage to read local files
   automatically, so this manual step is required every time you want to
   load a new file.
8. Click "Refresh Dashboard" any time after updating the selected data if
   you want to re-stamp the "Last refreshed" time without reloading a new
   file.
9. Click "Reset Data" to return to illustrative (sample) data at any time.

WHAT YOU SEE BEFORE LOADING A FILE
------------------------------------
The dashboard opens with illustrative (sample) data so every page is
immediately usable for demonstration or training. The header shows
"Illustrative Data" until a real file is loaded, at which point it changes
to "Excel Data Loaded" along with the file name and refresh time.

IMPORTANT NOTE ABOUT .xlsx / .xls FILES
------------------------------------------
This dashboard uses a small third-party library (xlsx.min.js) to read
.xlsx and .xls workbooks in the browser. A working placeholder file has
been included at js/xlsx.min.js with step-by-step instructions for adding
the real library (a one-time copy-paste, no installation). Until that file
is replaced, .xlsx/.xls uploads will show an on-screen message explaining
this — the rest of the dashboard, including illustrative data and .csv
uploads, works immediately with no setup. See js/xlsx.min.js for details.

REQUIREMENTS
------------
- No installation is required.
- No administrator access is required.
- No internet connection is required.
- No server, service or background process is started.
- All data you load stays on your local computer for the duration of the
  browser session only; nothing is uploaded, transmitted, or written to
  disk by the dashboard itself.
- The folder is fully portable — you can move, rename, copy to a USB
  drive, or run it from any path (including paths with spaces).

TROUBLESHOOTING
----------------
- "No supported data sheets were found": the selected file does not match
  any of the expected sheet names (see data/README.txt for the full list
  and accepted naming variations).
- A page shows "No data available" for one section: the corresponding
  sheet was missing from your workbook. Every other page and section
  keeps working normally.
- Nothing happens when double-clicking Dashboard.bat: right-click it and
  choose "Open", or manually double-click Dashboard.html inside the same
  folder.
