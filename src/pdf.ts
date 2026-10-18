import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { formatDate, invoiceSubtotal, invoiceTotal, money, paymentTotals, safeBalance, type Booking, type BusinessSettings, type Guest, type Invoice, type Payment, type Receipt, type Unit } from './domain'
import { formatNairobiDateTime } from './mpesa'

export interface DocumentContext {
  settings: BusinessSettings
  guest: Guest
  booking?: Booking
  unit?: Unit
  invoice?: Invoice
  receipt?: Receipt
  payment?: Payment
  payments: Payment[]
}

const green = [25, 67, 49] as const
const muted = [92, 101, 96] as const
const border = [203, 211, 205] as const

async function officialHeader(): Promise<string | undefined> {
  try {
    const response = await fetch('/assets/receipt-header.jpg')
    if (!response.ok) return undefined
    const blob = await response.blob()
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch {
    return undefined
  }
}

function setPageHeader(doc: jsPDF, title: string, settings: BusinessSettings, header?: string) {
  if (header) doc.addImage(header, 'JPEG', 25, 9, 160, 28.5)
  else {
    doc.setTextColor(...green)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(19)
    doc.text(settings.name.toUpperCase(), 25, 22)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.text(settings.location, 25, 28, { maxWidth: 160 })
    doc.text(`${settings.email}  |  ${settings.phone}`, 25, 33)
  }
  doc.setDrawColor(...green)
  doc.setLineWidth(0.35)
  doc.line(25, 41, 185, 41)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...green)
  doc.setFontSize(15)
  doc.text(title, 105, 52, { align: 'center' })
  doc.setFont('helvetica', 'normal')
}

function footer(doc: jsPDF, settings: BusinessSettings) {
  const pageCount = doc.getNumberOfPages()
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page)
    doc.setDrawColor(...border)
    doc.line(25, 279, 185, 279)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...muted)
    doc.text(`${settings.name}  |  ${settings.phone}  |  ${settings.email}`, 25, 284, { maxWidth: 160 })
    doc.text(`${page} / ${pageCount}`, 185, 284, { align: 'right' })
  }
}

function bookingDates(context: DocumentContext) {
  return context.booking
    ? `Check in: 1600 Hrs  ${formatDate(context.booking.checkIn)}      Check out: 1000 Hrs  ${formatDate(context.booking.checkOut)}`
    : 'Check in: ____________________      Check out: ____________________'
}

function chargeRows(context: DocumentContext) {
  if (context.invoice?.items.length) {
    return context.invoice.items.map((item) => [item.description, money(item.rate, context.settings.currency), `${item.quantityLabel || item.quantity}`, money(item.total, context.settings.currency)])
  }
  const payment = context.payment
  return [[payment?.description || 'Accommodation payment', '', '1 payment', money(payment?.amount ?? 0, context.settings.currency)]]
}

export async function createReceiptPdf(context: DocumentContext): Promise<jsPDF> {
  const doc = new jsPDF({ format: 'a4', unit: 'mm', orientation: 'portrait' })
  const header = await officialHeader()
  setPageHeader(doc, 'PAYMENT RECEIPT', context.settings, header)

  doc.setFontSize(8.7)
  doc.setTextColor(...muted)
  const reference = context.invoice?.number || context.booking?.reference || 'T.B.C'
  doc.text(`Our Ref: ${context.receipt?.number ?? 'DRAFT'}     Your Ref: ${reference}     Date: ${formatDate(context.receipt?.issuedAt ?? new Date().toISOString())}`, 25, 60)
  doc.setTextColor(30, 36, 32)
  doc.text(`Receipt ID: ${context.receipt?.number ?? 'DRAFT'}`, 25, 69)
  doc.text(`Date issued: ${formatDate(context.receipt?.issuedAt ?? new Date().toISOString())}`, 110, 69)
  doc.text(bookingDates(context), 25, 76)

  const totals = context.invoice ? paymentTotals(context.invoice.id, context.payments) : { paid: context.payment?.amount ?? 0, refunded: 0, netPaid: context.payment?.amount ?? 0 }
  const cumulativePaid = context.receipt?.paidToDate ?? totals.netPaid
  const balance = context.receipt && context.receipt.balanceAfter !== undefined
    ? context.receipt.balanceAfter
    : context.invoice ? safeBalance(context.invoice, context.payments) : null
  autoTable(doc, {
    startY: 82,
    margin: { left: 25, right: 25 },
    head: [['DESCRIPTION', 'RATE', 'QUANTITY', 'TOTAL']],
    body: chargeRows(context),
    foot: [[{ content: 'TOTAL AMOUNT PAID TO DATE', colSpan: 3 }, money(cumulativePaid, context.settings.currency)]],
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 2.6, lineColor: [...border], lineWidth: 0.15, textColor: [35, 43, 38] },
    headStyles: { fillColor: [...green], textColor: [255, 255, 255], fontStyle: 'bold' },
    footStyles: { fillColor: [235, 240, 236], textColor: [...green], fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 70 }, 1: { cellWidth: 30, halign: 'right' }, 2: { cellWidth: 27, halign: 'center' }, 3: { cellWidth: 33, halign: 'right' } },
  })
  let y = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 100
  y += 8
  doc.setFontSize(8.5)
  doc.setTextColor(35, 43, 38)
  const details = [
    `Amount paid this transaction: ${money(context.payment?.amount ?? 0, context.settings.currency)}`,
    `Balance: ${balance === null ? 'Not allocated to an invoice' : money(balance, context.settings.currency)}`,
    `Payment Mode: ${context.payment?.method ?? 'Not recorded'}    Paybill: ${context.settings.paybill || 'Not configured'}    Account Name: ${context.settings.accountName || 'Not configured'}`,
    `Reference code: ${context.payment?.reference || 'Not provided'}`,
    ...(context.payment ? [`Payment received: ${formatNairobiDateTime(context.payment.receivedAt)} (Kenya time)`] : []),
    ...(context.payment?.mpesaSender ? [`M-Pesa sender: ${context.payment.mpesaSender}    Message account: ${context.payment.mpesaAccount || 'Not provided'}`] : []),
    `Name: ${context.guest.name}    Contact: ${context.guest.phone}`,
  ]
  for (const line of details) {
    const wrapped = doc.splitTextToSize(line, 160) as string[]
    doc.text(wrapped, 25, y)
    y += wrapped.length * 4.6 + 2
  }
  y += 3
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...green)
  doc.text('Terms and conditions:', 25, y)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(35, 43, 38)
  y += 5
  const terms = doc.splitTextToSize(context.settings.terms, 160) as string[]
  doc.text(terms, 25, y)
  y += terms.length * 4.2 + 3
  const help = `For any assistance, please contact ${context.settings.name} management via ${context.settings.phone}  |  ${context.settings.email} or ${context.settings.supportEmail}`
  const helpLines = doc.splitTextToSize(help, 160) as string[]
  doc.text(helpLines, 25, y)
  y += helpLines.length * 4.2 + 3
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...green)
  doc.text('Thank you for doing business with us.', 25, Math.min(y, 268))
  return doc
}

export async function createInvoicePdf(context: DocumentContext): Promise<jsPDF> {
  if (!context.invoice) throw new Error('Invoice details are required.')
  const doc = new jsPDF({ format: 'a4', unit: 'mm', orientation: 'portrait' })
  const header = await officialHeader()
  setPageHeader(doc, 'INVOICE', context.settings, header)
  const invoice = context.invoice
  const subtotal = invoiceSubtotal(invoice)
  const total = invoiceTotal(invoice)
  const paid = paymentTotals(invoice.id, context.payments).netPaid
  const balance = safeBalance(invoice, context.payments)
  doc.setFontSize(9)
  doc.setTextColor(35, 43, 38)
  doc.text(`Invoice number: ${invoice.number}`, 25, 63)
  doc.text(`Issue date: ${formatDate(invoice.issueDate)}`, 110, 63)
  doc.text(`Due date: ${formatDate(invoice.dueDate)}`, 110, 69)
  doc.setFont('helvetica', 'bold')
  doc.text('BILL TO', 25, 76)
  doc.setFont('helvetica', 'normal')
  doc.text(context.guest.name, 25, 82)
  doc.text(context.guest.phone, 25, 87)
  doc.text(`Unit: ${context.unit?.name ?? 'Not specified'}`, 110, 82)
  doc.text(bookingDates(context), 110, 87)
  autoTable(doc, {
    startY: 95,
    margin: { left: 25, right: 25 },
    head: [['DESCRIPTION', 'RATE', 'QUANTITY', 'AMOUNT']],
    body: invoice.items.map((item) => [item.description, money(item.rate, context.settings.currency), item.quantityLabel || String(item.quantity), money(item.total, context.settings.currency)]),
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 3, lineColor: [...border], lineWidth: 0.15, textColor: [35, 43, 38] },
    headStyles: { fillColor: [...green], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 70 }, 1: { cellWidth: 30, halign: 'right' }, 2: { cellWidth: 27, halign: 'center' }, 3: { cellWidth: 33, halign: 'right' } },
  })
  let y = ((doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 115) + 8
  doc.setFontSize(9)
  doc.text(`Subtotal: ${money(subtotal, context.settings.currency)}`, 185, y, { align: 'right' }); y += 6
  if (invoice.discount) { doc.text(`Discount: -${money(invoice.discount, context.settings.currency)}`, 185, y, { align: 'right' }); y += 6 }
  if (invoice.additionalCharge) { doc.text(`Additional charge: ${money(invoice.additionalCharge, context.settings.currency)}`, 185, y, { align: 'right' }); y += 6 }
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...green)
  doc.text(`TOTAL PAYABLE: ${money(total, context.settings.currency)}`, 185, y, { align: 'right' }); y += 8
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(35, 43, 38)
  doc.text(`Amount already paid: ${money(paid, context.settings.currency)}`, 185, y, { align: 'right' }); y += 6
  doc.setFont('helvetica', 'bold')
  doc.text(`BALANCE DUE: ${money(balance, context.settings.currency)}`, 185, y, { align: 'right' })
  if (invoice.notes) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.text(doc.splitTextToSize(invoice.notes, 160), 25, Math.min(y + 13, 263))
  }
  footer(doc, context.settings)
  return doc
}

export function pdfBlobUrl(doc: jsPDF): string {
  return URL.createObjectURL(doc.output('blob'))
}

export function downloadPdf(doc: jsPDF, fileName: string) {
  doc.save(fileName)
}

export function receiptSummary(context: DocumentContext) {
  return `Payment received: ${money(context.payment?.amount ?? 0, context.settings.currency)}${context.receipt ? `, receipt ${context.receipt.number}` : ''}`
}