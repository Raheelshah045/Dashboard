UBL Consumer & ADC Operations Dashboard

A management-level analytics dashboard for Alternate Delivery Channels (ADC) and Cards Operations. The dashboard processes Excel (`.xlsx`) data and presents operational KPIs, charts, alerts, trends, and management summaries through a browser-based interface.

1. Dashboard Overview

The dashboard provides a consolidated view of ADC and Cards Operations across six main pages.

Dashboard Modules

1. Overview
   - High-level operational KPIs
   - ADC usage trends
   - NOSTRO account positions
   - System-wide operational alerts

2. ADC Operations
   - ATM, CDM, and POS performance
   - Channel uptime and availability
   - Fault and operational trends
   - Cash replenishment status

3. Card Non-Financials
   - CIF and AIF statistics
   - Card issuance and activation
   - Blocked and inactive cards
   - Product-level operational metrics

4. Card Financials
   - Revenue summaries
   - Transaction volumes
   - Product-level financial performance
   - Financial KPI analysis

5. Chargeback
   - Chargeback case tracking
   - Case aging buckets
   - Resolution status
   - Outstanding case monitoring

6. Reconciliation
   - NOSTRO general ledger (GL) reconciliation
   - Funding requirements
   - Account balances and buffers
   - Reconciliation status monitoring

 2. How to Run the Dashboard

 Option A: Using the Batch File

1. Navigate to the dashboard project folder.
2. Double-click `Dashboard.bat`.
3. Follow any instructions displayed by the batch file.

 Option B: Using a Web Browser

1. Locate `Dashboard.html`.
2. Open it in Google Chrome or Microsoft Edge.
3. Wait for the dashboard to load.

 3. How to Use the Dashboard

1. Click Load Excel File in the top-right corner.
2. Select the required `.xlsx` data file.
3. Use the available date and filter controls to refine the displayed information.
4. Navigate between dashboard modules using the top menu tabs.
5. Click an alert notification in the bottom-left corner to navigate to its relevant page, where supported.
6. Click Refresh to reload data from the selected file, where supported.

 4. System Requirements

- Operating System: Windows recommended for the batch-file launcher.
- Browser: A modern version of Google Chrome or Microsoft Edge.
- Input Data: An Excel workbook in `.xlsx` format.
- Connectivity: No internet connection is required for normal use, provided all required application assets are available locally.

 5. Excel Data Requirements

The dashboard expects an Excel workbook that follows its configured worksheet and column structure.

Before loading a workbook, ensure that:

- Required worksheets are present.
- Column names match the expected structure.
- Data is entered in the appropriate columns.
- Dates, numerical values, and other fields use compatible formats.
- The workbook contains the data required by the dashboard modules.

The exact worksheet names, column mappings, and validation rules should be confirmed against the current application code or its sample workbook.

 6. Project Files

The primary files referenced by the current usage instructions are:

| `Dashboard.html` | Browser-based dashboard interface |
| `Dashboard.bat` | Windows launcher for the dashboard |

Other files, scripts, libraries, and assets may be required depending on the project implementation. Keep the existing project files together unless the application has been configured to use different paths.

 7. Data Handling and Privacy

- Load only authorized operational data.
- Follow applicable bank policies for handling confidential customer and transaction information.
- Store and share Excel files only in approved locations.
- Avoid including customer-identifiable information in screenshots, logs, or shared documentation.
- Confirm where data is processed and whether it is retained before using sensitive production data.

 8. Troubleshooting

The dashboard does not open
- Confirm that `Dashboard.html` exists.
- Try opening it directly in Chrome or Edge.
- Check whether the browser displays any errors.

The Excel file does not load
- Confirm that the workbook is an `.xlsx` file.
- Verify the expected worksheet names and column headers.
- Check that the file is not corrupted or password-protected.
- Review the browser console for application errors if necessary.

KPIs or charts show missing or unexpected values
- Verify the source data and required columns.
- Check date formats and numerical values.
- Confirm that the selected filters are not excluding the expected records.

Refresh does not update the dashboard
- Try selecting the Excel file again.
- Confirm that the workbook contains the latest data.
- Check for browser errors if the issue persists.

The batch file does not run
- Confirm that `Dashboard.bat` exists.
- Check whether Windows security settings or file permissions are blocking execution.
- Try opening `Dashboard.html` directly.

 9. Current Scope and Future Enhancements

The dashboard's documented workflow currently covers browser-based analytics using an Excel workbook.

Potential future enhancements, subject to implementation and approval, include:

- Automated Excel ingestion and validation
- SQL Server or bank data-warehouse integration
- Staging and production database tables
- Data-quality and rejection logs
- Scheduled data refreshes
- Role-based access control and audit logging
- Deployment on an approved bank server

These enhancements should be considered planned functionality unless verified in the current project.

 10. Important Notes

- Dashboard results depend on the quality and structure of the uploaded workbook.
- Validate operational and financial figures against approved source systems before using them for official reporting or decisions.
- Do not use this README as confirmation that database integration, automated ingestion, authentication, or server deployment is already available.



Project: UBL ADC & Cards Operations Dashboard  
Purpose: Management-level monitoring and analytics for ADC and Cards Operations  
Data Input: Excel (`.xlsx`)  
Interface: Browser-based  
Operating Mode: Local/offline, subject to availability of required application assets
