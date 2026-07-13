// Shared export helpers for Executive Reports / Reports / Review Explorer.
//
// CSV is dependency-free and opens natively in Excel, Google Sheets, and
// Numbers -- it covers the "Excel export" need without adding a binary
// .xlsx-writing library. (xlsx/SheetJS ships unpatched high-severity
// prototype-pollution/ReDoS advisories on npm; exceljs avoids those but
// pulls in ~100 packages for marginal benefit over CSV for this app's
// export sizes, so neither was worth the added supply-chain surface here.)
// PDF is handled by printReport() -- open the browser print dialog against
// a page styled with @media print rules (see index.css) and save as PDF,
// rather than rendering a PDF client-side.

export function exportCSV(filename, headers, rows) {
  const escape = v => `"${(v ?? '').toString().replace(/"/g, '""')}"`
  const lines = [headers.join(','), ...rows.map(row => row.map(escape).join(','))]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: filename.endsWith('.csv') ? filename : `${filename}.csv`,
  })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(a.href)
}

export function printReport() {
  window.print()
}
