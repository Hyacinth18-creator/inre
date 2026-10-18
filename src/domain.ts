export type PaymentMethod = 'M-Pesa' | 'Cash' | 'Bank transfer' | 'Other'
export type PaymentKind = 'payment' | 'refund' | 'adjustment'

export interface Guest {
  id: string
  name: string
  phone: string
  email?: string
  createdAt: string
}

export interface Unit {
  id: string
  name: string
  rate: number
  active: boolean
}

export interface Booking {
  id: string
  guestId: string
  unitId: string
  checkIn: string
  checkOut: string
  reference: string
}

export interface InvoiceLineItem {
  id: string
  description: string
  rate: number
  quantity: number
  quantityLabel: string
  total: number
}

export interface Invoice {
  id: string
  number: string
  status: 'draft' | 'issued' | 'void'
  guestId: string
  bookingId: string
  issueDate: string
  dueDate: string
  items: InvoiceLineItem[]
  discount: number
  additionalCharge: number
  notes?: string
  createdAt: string
  issuedAt?: string
}

export interface Payment {
  id: string
  invoiceId?: string
  bookingId?: string
  guestId: string
  kind: PaymentKind
  amount: number
  adjustmentDelta?: number
  method: PaymentMethod
  reference?: string
  mpesaSender?: string
  mpesaAccount?: string
  description?: string
  receivedAt: string
  createdAt: string
}

export interface Receipt {
  id: string
  number: string
  paymentId: string
  invoiceId?: string
  bookingId?: string
  issuedAt: string
  paidToDate?: number
  balanceAfter?: number | null
}

export interface BusinessSettings {
  name: string
  location: string
  email: string
  bookingsEmail: string
  supportEmail: string
  website: string
  postalAddress: string
  phone: string
  paybill: string
  accountName: string
  familyBankAccount: string
  familyBankName: string
  swiftCode: string
  vatNote: string
  terms: string
  invoicePrefix: string
  receiptPrefix: string
  currency: string
}

export interface AuditLog {
  id: string
  entityType: string
  entityId: string
  action: string
  detail: string
  createdAt: string
}

export interface AppData {
  guests: Guest[]
  units: Unit[]
  bookings: Booking[]
  invoices: Invoice[]
  payments: Payment[]
  receipts: Receipt[]
  auditLogs: AuditLog[]
  settings: BusinessSettings
}

export const defaultSettings: BusinessSettings = {
  name: 'Shwari Home Stays',
  location: '2km off Kisii town CBD along Kisii Kisumu highway at Nyamataro; Jaabs Suites',
  email: 'Info@shwarihomestays.com',
  bookingsEmail: 'Bookings@shwarihomestays.com',
  supportEmail: 'ShwariHomeStays@gmail.com',
  website: 'www.shwarihomestays.com',
  postalAddress: 'P.O.Box 418- 40202, Keroka',
  phone: '+254 724 31 31 31',
  paybill: '222 111',
  accountName: '242025',
  familyBankAccount: '0270 0008 0535',
  familyBankName: 'SHWARI HOME STAYS',
  swiftCode: 'FABLKENAXXX',
  vatNote: '(Exclusive of 16% VAT)',
  terms: 'Payments are non-refundable within 12 hours of check-in. Any discrepancies should be reported within seven days of receipt issuance.',
  invoicePrefix: 'SHS/INV',
  receiptPrefix: 'SHS',
  currency: 'KSh',
}

export function lineTotal(item: Pick<InvoiceLineItem, 'total'>): number {
  return roundMoney(item.total)
}

export function invoiceSubtotal(invoice: Pick<Invoice, 'items'>): number {
  return roundMoney(invoice.items.reduce((sum, item) => sum + lineTotal(item), 0))
}

export function invoiceTotal(invoice: Pick<Invoice, 'items' | 'discount' | 'additionalCharge'>): number {
  return Math.max(0, roundMoney(invoiceSubtotal(invoice) - invoice.discount + invoice.additionalCharge))
}

export function paymentTotals(invoiceId: string, payments: Payment[]) {
  const allocated = payments.filter((payment) => payment.invoiceId === invoiceId)
  const paid = allocated.filter((payment) => payment.kind === 'payment').reduce((sum, payment) => sum + payment.amount, 0)
  const refunded = allocated.filter((payment) => payment.kind === 'refund').reduce((sum, payment) => sum + payment.amount, 0)
  const adjustments = allocated.filter((payment) => payment.kind === 'adjustment').reduce((sum, payment) => sum + (payment.adjustmentDelta ?? 0), 0)
  return { paid: roundMoney(paid), refunded: roundMoney(refunded), adjustments: roundMoney(adjustments), netPaid: roundMoney(paid - refunded) }
}

export function invoiceBalance(invoice: Invoice, payments: Payment[]): number {
  const totals = paymentTotals(invoice.id, payments)
  return roundMoney(invoiceTotal(invoice) - totals.netPaid + totals.adjustments)
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function money(value: number, currency = 'KSh'): string {
  return `${currency} ${new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`
}

export function formatDate(value: string): string {
  if (!value) return ''
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`))
}

export function documentNumber(prefix: string, sequence: number, date = new Date()): string {
  return `${prefix}/${String(sequence).padStart(5, '0')}/${String(date.getFullYear()).slice(-2)}`
}

export function safeBalance(invoice: Invoice, payments: Payment[]): number {
  return Math.max(0, invoiceBalance(invoice, payments))
}