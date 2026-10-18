import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { defaultSettings, documentNumber, invoiceBalance, paymentTotals, safeBalance, type AppData, type AuditLog, type Booking, type BusinessSettings, type Guest, type Invoice, type Payment, type Receipt, type Unit } from './domain'

interface ShwariDatabase extends DBSchema {
  guests: { key: string; value: Guest }
  units: { key: string; value: Unit }
  bookings: { key: string; value: Booking }
  invoices: { key: string; value: Invoice }
  payments: { key: string; value: Payment }
  receipts: { key: string; value: Receipt }
  auditLogs: { key: string; value: AuditLog }
  settings: { key: string; value: BusinessSettings }
  counters: { key: string; value: number }
}

let databasePromise: Promise<IDBPDatabase<ShwariDatabase>> | undefined

function database() {
  databasePromise ??= openDB<ShwariDatabase>('shwari-home-stays', 1, {
    upgrade(db) {
      for (const store of ['guests', 'units', 'bookings', 'invoices', 'payments', 'receipts', 'auditLogs', 'settings', 'counters'] as const) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
      }
    },
  })
  return databasePromise
}

function audit(entityType: string, entityId: string, action: string, detail: string): AuditLog {
  return { id: crypto.randomUUID(), entityType, entityId, action, detail, createdAt: new Date().toISOString() }
}

function abortTransaction(tx: { abort: () => void; done: Promise<unknown> }, message: string): never {
  tx.abort()
  void tx.done.catch(() => undefined)
  throw new Error(message)
}

export async function loadData(): Promise<AppData> {
  const db = await database()
  const [guests, units, bookings, invoices, payments, receipts, auditLogs, savedSettings] = await Promise.all([
    db.getAll('guests'), db.getAll('units'), db.getAll('bookings'), db.getAll('invoices'),
    db.getAll('payments'), db.getAll('receipts'), db.getAll('auditLogs'), db.get('settings', 'business'),
  ])
  return { guests, units, bookings, invoices, payments, receipts, auditLogs, settings: { ...defaultSettings, ...savedSettings } }
}

export async function saveGuest(guest: Guest) {
  const db = await database()
  const tx = db.transaction(['guests', 'auditLogs'], 'readwrite')
  await Promise.all([tx.objectStore('guests').put(guest, guest.id), tx.objectStore('auditLogs').put(audit('guest', guest.id, 'created', guest.name), crypto.randomUUID())])
  await tx.done
}

export async function saveUnit(unit: Unit) {
  const db = await database()
  const tx = db.transaction(['units', 'auditLogs'], 'readwrite')
  await Promise.all([
    tx.objectStore('units').put(unit, unit.id),
    tx.objectStore('auditLogs').put(audit('unit', unit.id, 'created', unit.name), crypto.randomUUID()),
  ])
  await tx.done
}

export async function saveBooking(booking: Booking) {
  const db = await database()
  const tx = db.transaction(['bookings', 'auditLogs'], 'readwrite')
  await Promise.all([
    tx.objectStore('bookings').put(booking, booking.id),
    tx.objectStore('auditLogs').put(audit('booking', booking.id, 'created', booking.reference), crypto.randomUUID()),
  ])
  await tx.done
}

export async function saveInvoice(invoice: Invoice) {
  const db = await database()
  const tx = db.transaction(['invoices', 'auditLogs'], 'readwrite')
  await Promise.all([
    tx.objectStore('invoices').put(invoice, invoice.id),
    tx.objectStore('auditLogs').put(audit('invoice', invoice.id, 'created', 'Invoice draft created'), crypto.randomUUID()),
  ])
  await tx.done
}

export async function issueInvoice(invoiceId: string, prefix: string): Promise<Invoice> {
  const db = await database()
  const tx = db.transaction(['invoices', 'counters', 'auditLogs'], 'readwrite')
  const invoices = tx.objectStore('invoices')
  const invoice = await invoices.get(invoiceId)
  if (!invoice || invoice.status !== 'draft') throw new Error('Only draft invoices can be issued.')
  const counters = tx.objectStore('counters')
  const sequence = (await counters.get('invoice')) ?? 0
  const issuedAt = new Date().toISOString()
  const updated = { ...invoice, number: documentNumber(prefix, sequence + 1, new Date(issuedAt)), status: 'issued' as const, issuedAt }
  await Promise.all([
    counters.put(sequence + 1, 'invoice'),
    invoices.put(updated, invoice.id),
    tx.objectStore('auditLogs').put(audit('invoice', invoice.id, 'issued', updated.number), crypto.randomUUID()),
  ])
  await tx.done
  return updated
}

export async function recordPayment(payment: Payment, receiptPrefix: string): Promise<Receipt> {
  const db = await database()
  if (!Number.isFinite(payment.amount) || payment.amount <= 0) throw new Error('Payment amount must be greater than zero.')
  const tx = db.transaction(['payments', 'receipts', 'counters', 'auditLogs', 'invoices'], 'readwrite')
  const payments = tx.objectStore('payments')
  const reference = payment.reference?.trim().toLocaleLowerCase()
  if (reference) {
    const previous = await payments.getAll()
    if (previous.some((item) => item.reference?.trim().toLocaleLowerCase() === reference)) {
      abortTransaction(tx, 'That payment reference has already been recorded.')
    }
  }
  const previousPayments = await payments.getAll()
  let paidToDate = payment.amount
  let balanceAfter: number | null = null
  if (payment.invoiceId) {
    const invoice = await tx.objectStore('invoices').get(payment.invoiceId)
    if (!invoice || invoice.status !== 'issued') {
      abortTransaction(tx, 'Payments can only be allocated to an issued invoice.')
    }
    if (payment.amount > safeBalance(invoice, previousPayments)) {
      abortTransaction(tx, 'Payment amount exceeds the current invoice balance.')
    }
    const afterPayment = [...previousPayments, payment]
    paidToDate = paymentTotals(invoice.id, afterPayment).netPaid
    balanceAfter = Math.max(0, invoiceBalance(invoice, afterPayment))
  }
  const counters = tx.objectStore('counters')
  const sequence = (await counters.get('receipt')) ?? 0
  const receipt: Receipt = {
    id: crypto.randomUUID(),
    number: documentNumber(receiptPrefix, sequence + 1, new Date(payment.receivedAt)),
    paymentId: payment.id,
    invoiceId: payment.invoiceId,
    bookingId: payment.bookingId,
    issuedAt: new Date().toISOString(),
    paidToDate,
    balanceAfter,
  }
  await Promise.all([
    payments.put(payment, payment.id),
    tx.objectStore('receipts').put(receipt, receipt.id),
    counters.put(sequence + 1, 'receipt'),
    tx.objectStore('auditLogs').put(audit('payment', payment.id, 'recorded', `${payment.kind}: ${payment.amount} ${payment.method}`), crypto.randomUUID()),
  ])
  await tx.done
  return receipt
}

export async function recordAdjustment(payment: Payment): Promise<void> {
  if (!Number.isFinite(payment.amount) || payment.amount <= 0) throw new Error('Adjustment amount must be greater than zero.')
  if (payment.kind === 'adjustment' && !Number.isFinite(payment.adjustmentDelta)) throw new Error('A balance adjustment needs a signed amount.')
  const db = await database()
  const tx = db.transaction(['payments', 'auditLogs', 'invoices'], 'readwrite')
  const payments = tx.objectStore('payments')
  const reference = payment.reference?.trim().toLocaleLowerCase()
  if (reference && (await payments.getAll()).some((item) => item.reference?.trim().toLocaleLowerCase() === reference)) {
    abortTransaction(tx, 'That reference has already been recorded.')
  }
  if (payment.kind === 'refund' && payment.invoiceId) {
    const totals = paymentTotals(payment.invoiceId, await payments.getAll())
    if (payment.amount > totals.paid - totals.refunded) {
      abortTransaction(tx, 'A refund cannot exceed payments received for this invoice.')
    }
  }
  if (payment.kind === 'adjustment' && payment.invoiceId) {
    const invoice = await tx.objectStore('invoices').get(payment.invoiceId)
    if (!invoice || invoice.status !== 'issued') {
      abortTransaction(tx, 'Adjustments can only be made to an issued invoice.')
    }
    if (invoiceBalance(invoice, [...await payments.getAll(), payment]) < 0) {
      abortTransaction(tx, 'The adjustment cannot reduce the invoice below zero.')
    }
  }
  await Promise.all([
    payments.put(payment, payment.id),
    tx.objectStore('auditLogs').put(audit('payment', payment.id, payment.kind, payment.description ?? ''), crypto.randomUUID()),
  ])
  await tx.done
}

export async function saveSettings(settings: BusinessSettings) {
  const db = await database()
  const tx = db.transaction(['settings', 'auditLogs'], 'readwrite')
  await Promise.all([
    tx.objectStore('settings').put(settings, 'business'),
    tx.objectStore('auditLogs').put(audit('settings', 'business', 'updated', 'Business document details updated'), crypto.randomUUID()),
  ])
  await tx.done
}

export async function exportBackup(): Promise<Blob> {
  const data = await loadData()
  return new Blob([JSON.stringify({ format: 'shwari-home-stays-backup', version: 1, exportedAt: new Date().toISOString(), data }, null, 2)], { type: 'application/json' })
}

export async function importBackup(file: File): Promise<void> {
  const parsed: unknown = JSON.parse(await file.text())
  if (!parsed || typeof parsed !== 'object' || !('data' in parsed)) throw new Error('This file is not a Shwari Home Stays backup.')
  const data = (parsed as { data: Partial<AppData> }).data
  const collections = ['guests', 'units', 'bookings', 'invoices', 'payments', 'receipts', 'auditLogs'] as const
  if (!collections.every((key) => Array.isArray(data[key])) || !data.settings) throw new Error('Backup is missing required records.')
  const db = await database()
  const tx = db.transaction([...collections, 'settings', 'counters'], 'readwrite')
  for (const name of collections) {
    const store = tx.objectStore(name)
    await store.clear()
    for (const item of data[name] ?? []) await store.put(item as never, (item as { id: string }).id)
  }
  await tx.objectStore('settings').put({ ...defaultSettings, ...data.settings }, 'business')
  for (const [kind, numbers] of [
    ['invoice', data.invoices?.map((item) => item.number) ?? []],
    ['receipt', data.receipts?.map((item) => item.number) ?? []],
  ] as const) {
    const highest = numbers.reduce((max, number) => Math.max(max, Number(number.split('/').at(-2)) || 0), 0)
    await tx.objectStore('counters').put(highest, kind)
  }
  await tx.done
}