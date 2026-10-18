import { DatabaseSync } from 'node:sqlite'
import {
  defaultSettings,
  documentNumber,
  invoiceBalance,
  paymentTotals,
  safeBalance,
  type AppData,
  type AuditLog,
  type Booking,
  type BusinessSettings,
  type Guest,
  type Invoice,
  type Payment,
  type Receipt,
  type Unit,
} from '../src/domain.js'
import { DatabaseError } from './databaseErrors.js'

type Row = Record<string, unknown>

export function createDatabase(path = './data/shwari.sqlite') {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS guests (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS units (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, rate REAL NOT NULL CHECK (rate >= 0), active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, guest_id TEXT NOT NULL REFERENCES guests(id), unit_id TEXT REFERENCES units(id),
      check_in TEXT NOT NULL, check_out TEXT NOT NULL, reference TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, number TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft','issued','void')),
      guest_id TEXT NOT NULL REFERENCES guests(id), booking_id TEXT NOT NULL REFERENCES bookings(id),
      issue_date TEXT NOT NULL, due_date TEXT NOT NULL, discount REAL NOT NULL DEFAULT 0,
      additional_charge REAL NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL, issued_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS issued_invoice_number ON invoices(number) WHERE status = 'issued';
    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, description TEXT NOT NULL, rate REAL NOT NULL, quantity REAL NOT NULL,
      quantity_label TEXT NOT NULL, total REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, invoice_id TEXT REFERENCES invoices(id), booking_id TEXT REFERENCES bookings(id),
      guest_id TEXT NOT NULL REFERENCES guests(id), kind TEXT NOT NULL CHECK (kind IN ('payment','refund','adjustment')),
      amount REAL NOT NULL CHECK (amount > 0), adjustment_delta REAL, method TEXT NOT NULL, reference TEXT,
      mpesa_sender TEXT, mpesa_account TEXT, description TEXT, received_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS unique_payment_reference ON payments(lower(trim(reference)))
      WHERE reference IS NOT NULL AND length(trim(reference)) > 0;
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
      invoice_id TEXT REFERENCES invoices(id), booking_id TEXT REFERENCES bookings(id), issued_at TEXT NOT NULL,
      paid_to_date REAL NOT NULL, balance_after REAL
    );
    CREATE TABLE IF NOT EXISTS business_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
      detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS counters (kind TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
  `)
  db.prepare('INSERT OR IGNORE INTO business_settings(key, value) VALUES (?, ?)').run('business', JSON.stringify(defaultSettings))

  function transaction<T>(action: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        throw new DatabaseError('That document number or payment reference has already been recorded.', 409)
      }
      throw error
    }
  }

  function audit(entityType: string, entityId: string, action: string, detail: string): AuditLog {
    return { id: crypto.randomUUID(), entityType, entityId, action, detail, createdAt: new Date().toISOString() }
  }

  function insertAudit(entry: AuditLog) {
    db.prepare('INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?)').run(entry.id, entry.entityType, entry.entityId, entry.action, entry.detail, entry.createdAt)
  }

  function readInvoice(id: string): Invoice | undefined {
    const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as Row | undefined
    if (!row) return undefined
    const items = db.prepare('SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY position').all(id) as Row[]
    return {
      id: String(row.id), number: String(row.number), status: row.status as Invoice['status'],
      guestId: String(row.guest_id), bookingId: String(row.booking_id), issueDate: String(row.issue_date), dueDate: String(row.due_date),
      items: items.map((item) => ({
        id: String(item.id), description: String(item.description), rate: Number(item.rate), quantity: Number(item.quantity),
        quantityLabel: String(item.quantity_label), total: Number(item.total),
      })),
      discount: Number(row.discount), additionalCharge: Number(row.additional_charge), notes: row.notes == null ? undefined : String(row.notes),
      createdAt: String(row.created_at), issuedAt: row.issued_at == null ? undefined : String(row.issued_at),
    }
  }

  function readPayments(): Payment[] {
    return (db.prepare('SELECT * FROM payments ORDER BY received_at').all() as Row[]).map((row) => ({
      id: String(row.id), invoiceId: row.invoice_id == null ? undefined : String(row.invoice_id),
      bookingId: row.booking_id == null ? undefined : String(row.booking_id), guestId: String(row.guest_id),
      kind: row.kind as Payment['kind'], amount: Number(row.amount),
      adjustmentDelta: row.adjustment_delta == null ? undefined : Number(row.adjustment_delta), method: row.method as Payment['method'],
      reference: row.reference == null ? undefined : String(row.reference), mpesaSender: row.mpesa_sender == null ? undefined : String(row.mpesa_sender),
      mpesaAccount: row.mpesa_account == null ? undefined : String(row.mpesa_account), description: row.description == null ? undefined : String(row.description),
      receivedAt: String(row.received_at), createdAt: String(row.created_at),
    }))
  }

  function insertPayment(payment: Payment) {
    db.prepare(`INSERT INTO payments
      (id, invoice_id, booking_id, guest_id, kind, amount, adjustment_delta, method, reference, mpesa_sender, mpesa_account, description, received_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(payment.id, payment.invoiceId ?? null, payment.bookingId ?? null, payment.guestId, payment.kind, payment.amount,
        payment.adjustmentDelta ?? null, payment.method, payment.reference?.trim() || null, payment.mpesaSender ?? null,
        payment.mpesaAccount ?? null, payment.description ?? null, payment.receivedAt, payment.createdAt)
  }

  function insertReceipt(receipt: Receipt) {
    db.prepare(`INSERT INTO receipts (id, number, payment_id, invoice_id, booking_id, issued_at, paid_to_date, balance_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(receipt.id, receipt.number, receipt.paymentId, receipt.invoiceId ?? null, receipt.bookingId ?? null,
        receipt.issuedAt, receipt.paidToDate ?? 0, receipt.balanceAfter ?? null)
  }

  function saveGuest(guest: Guest) {
    transaction(() => {
      db.prepare('INSERT INTO guests VALUES (?, ?, ?, ?, ?)').run(guest.id, guest.name, guest.phone, guest.email ?? null, guest.createdAt)
      insertAudit(audit('guest', guest.id, 'created', guest.name))
    })
  }

  function saveUnit(unit: Unit) {
    transaction(() => {
      db.prepare('INSERT INTO units VALUES (?, ?, ?, ?)').run(unit.id, unit.name, unit.rate, unit.active ? 1 : 0)
      insertAudit(audit('unit', unit.id, 'created', unit.name))
    })
  }

  function saveBooking(booking: Booking) {
    transaction(() => {
      db.prepare('INSERT INTO bookings VALUES (?, ?, ?, ?, ?, ?)').run(booking.id, booking.guestId, booking.unitId || null, booking.checkIn, booking.checkOut, booking.reference)
      insertAudit(audit('booking', booking.id, 'created', booking.reference))
    })
  }

  function saveInvoice(invoice: Invoice) {
    if (invoice.status !== 'draft') throw new DatabaseError('New invoices must be saved as drafts.')
    if (invoice.items.length === 0) throw new DatabaseError('An invoice needs at least one charge line.')
    const number = invoice.number?.trim() || 'DRAFT'
    transaction(() => {
      db.prepare(`INSERT INTO invoices
        (id, number, status, guest_id, booking_id, issue_date, due_date, discount, additional_charge, notes, created_at, issued_at)
        VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(invoice.id, number, invoice.guestId, invoice.bookingId, invoice.issueDate, invoice.dueDate, invoice.discount, invoice.additionalCharge, invoice.notes ?? null, invoice.createdAt)
      const line = db.prepare('INSERT INTO invoice_line_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      invoice.items.forEach((item, position) => line.run(item.id, invoice.id, position, item.description, item.rate, item.quantity, item.quantityLabel, item.total))
      insertAudit(audit('invoice', invoice.id, 'created', 'Invoice draft created'))
    })
  }

  function issueInvoice(invoiceId: string, prefix: string): Invoice {
    return transaction(() => {
      const invoice = readInvoice(invoiceId)
      if (!invoice || invoice.status !== 'draft') throw new DatabaseError('Only draft invoices can be issued.', 404)
      const current = db.prepare('SELECT value FROM counters WHERE kind = ?').get('invoice') as Row | undefined
      const sequence = Number(current?.value ?? 0) + 1
      const issuedAt = new Date().toISOString()
      const number = documentNumber(prefix, sequence, new Date(issuedAt))
      db.prepare("UPDATE invoices SET number = ?, status = 'issued', issued_at = ? WHERE id = ?").run(number, issuedAt, invoiceId)
      db.prepare('INSERT INTO counters(kind, value) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET value = excluded.value').run('invoice', sequence)
      insertAudit(audit('invoice', invoiceId, 'issued', number))
      return readInvoice(invoiceId)!
    })
  }

  function recordPayment(payment: Payment, receiptPrefix: string): Receipt {
    if (!Number.isFinite(payment.amount) || payment.amount <= 0) throw new DatabaseError('Payment amount must be greater than zero.')
    return transaction(() => {
      const previousPayments = readPayments()
      const invoice = payment.invoiceId ? readInvoice(payment.invoiceId) : undefined
      if (payment.invoiceId && (!invoice || invoice.status !== 'issued')) throw new DatabaseError('Payments can only be allocated to an issued invoice.')
      if (invoice && payment.amount > safeBalance(invoice, previousPayments)) throw new DatabaseError('Payment amount exceeds the current invoice balance.')
      insertPayment(payment)
      const afterPayment = [...previousPayments, payment]
      const paidToDate = invoice ? paymentTotals(invoice.id, afterPayment).netPaid : payment.amount
      const balanceAfter = invoice ? Math.max(0, invoiceBalance(invoice, afterPayment)) : null
      const current = db.prepare('SELECT value FROM counters WHERE kind = ?').get('receipt') as Row | undefined
      const sequence = Number(current?.value ?? 0) + 1
      const receipt: Receipt = {
        id: crypto.randomUUID(), number: documentNumber(receiptPrefix, sequence, new Date(payment.receivedAt)),
        paymentId: payment.id, invoiceId: payment.invoiceId, bookingId: payment.bookingId, issuedAt: new Date().toISOString(), paidToDate, balanceAfter,
      }
      insertReceipt(receipt)
      db.prepare('INSERT INTO counters(kind, value) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET value = excluded.value').run('receipt', sequence)
      insertAudit(audit('payment', payment.id, 'recorded', `${payment.kind}: ${payment.amount} ${payment.method}`))
      return receipt
    })
  }

  function recordAdjustment(payment: Payment) {
    if (!Number.isFinite(payment.amount) || payment.amount <= 0) throw new DatabaseError('Adjustment amount must be greater than zero.')
    if (payment.kind === 'adjustment' && !Number.isFinite(payment.adjustmentDelta)) throw new DatabaseError('A balance adjustment needs a signed amount.')
    transaction(() => {
      const previous = readPayments()
      const invoice = payment.invoiceId ? readInvoice(payment.invoiceId) : undefined
      if (payment.invoiceId && (!invoice || invoice.status !== 'issued')) throw new DatabaseError('Adjustments can only be made to an issued invoice.')
      if (payment.kind === 'refund' && payment.invoiceId) {
        const totals = paymentTotals(payment.invoiceId, previous)
        if (payment.amount > totals.paid - totals.refunded) throw new DatabaseError('A refund cannot exceed payments received for this invoice.')
      }
      if (invoice && payment.kind === 'adjustment' && invoiceBalance(invoice, [...previous, payment]) < 0) {
        throw new DatabaseError('The adjustment cannot reduce the invoice below zero.')
      }
      insertPayment(payment)
      insertAudit(audit('payment', payment.id, payment.kind, payment.description ?? ''))
    })
  }

  function saveSettings(settings: BusinessSettings) {
    transaction(() => {
      db.prepare('INSERT INTO business_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('business', JSON.stringify(settings))
      insertAudit(audit('settings', 'business', 'updated', 'Business document details updated'))
    })
  }

  function readData(): AppData {
    const guests = (db.prepare('SELECT * FROM guests ORDER BY name').all() as Row[]).map((row) => ({
      id: String(row.id), name: String(row.name), phone: String(row.phone), email: row.email == null ? undefined : String(row.email), createdAt: String(row.created_at),
    }))
    const units = (db.prepare('SELECT * FROM units ORDER BY name').all() as Row[]).map((row) => ({
      id: String(row.id), name: String(row.name), rate: Number(row.rate), active: Boolean(row.active),
    }))
    const bookings = (db.prepare('SELECT * FROM bookings ORDER BY check_in DESC').all() as Row[]).map((row) => ({
      id: String(row.id), guestId: String(row.guest_id), unitId: row.unit_id == null ? '' : String(row.unit_id),
      checkIn: String(row.check_in), checkOut: String(row.check_out), reference: String(row.reference),
    }))
    const invoices = (db.prepare('SELECT id FROM invoices ORDER BY created_at DESC').all() as Row[]).map((row) => readInvoice(String(row.id))!)
    const payments = readPayments()
    const receipts = (db.prepare('SELECT * FROM receipts ORDER BY issued_at DESC').all() as Row[]).map((row) => ({
      id: String(row.id), number: String(row.number), paymentId: String(row.payment_id),
      invoiceId: row.invoice_id == null ? undefined : String(row.invoice_id), bookingId: row.booking_id == null ? undefined : String(row.booking_id),
      issuedAt: String(row.issued_at), paidToDate: Number(row.paid_to_date), balanceAfter: row.balance_after == null ? null : Number(row.balance_after),
    }))
    const auditLogs = (db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC').all() as Row[]).map((row) => ({
      id: String(row.id), entityType: String(row.entity_type), entityId: String(row.entity_id), action: String(row.action), detail: String(row.detail), createdAt: String(row.created_at),
    }))
    const settingsRow = db.prepare('SELECT value FROM business_settings WHERE key = ?').get('business') as { value: string } | undefined
    return { guests, units, bookings, invoices, payments, receipts, auditLogs, settings: { ...defaultSettings, ...(settingsRow ? JSON.parse(settingsRow.value) as BusinessSettings : {}) } }
  }

  function exportBackup() {
    return { format: 'shwari-home-stays-backup', version: 1, exportedAt: new Date().toISOString(), data: readData() }
  }

  function importBackup(backup: unknown, onlyIfEmpty = false) {
    if (!backup || typeof backup !== 'object' || !('data' in backup)) throw new DatabaseError('This file is not a Shwari Home Stays backup.')
    const data = (backup as { data: Partial<AppData> }).data
    const collections = ['guests', 'units', 'bookings', 'invoices', 'payments', 'receipts', 'auditLogs'] as const
    if (!collections.every((key) => Array.isArray(data[key])) || !data.settings) throw new DatabaseError('Backup is missing required records.')
    transaction(() => {
      const existing = Number((db.prepare('SELECT count(*) AS count FROM guests').get() as { count: number }).count)
        + Number((db.prepare('SELECT count(*) AS count FROM invoices').get() as { count: number }).count)
        + Number((db.prepare('SELECT count(*) AS count FROM payments').get() as { count: number }).count)
      if (onlyIfEmpty && existing > 0) return
      db.exec('DELETE FROM receipts; DELETE FROM payments; DELETE FROM invoice_line_items; DELETE FROM invoices; DELETE FROM bookings; DELETE FROM units; DELETE FROM guests; DELETE FROM audit_logs; DELETE FROM counters;')
      for (const guest of data.guests ?? []) db.prepare('INSERT INTO guests VALUES (?, ?, ?, ?, ?)').run(guest.id, guest.name, guest.phone, guest.email ?? null, guest.createdAt)
      for (const unit of data.units ?? []) db.prepare('INSERT INTO units VALUES (?, ?, ?, ?)').run(unit.id, unit.name, unit.rate, unit.active ? 1 : 0)
      for (const booking of data.bookings ?? []) db.prepare('INSERT INTO bookings VALUES (?, ?, ?, ?, ?, ?)').run(booking.id, booking.guestId, booking.unitId || null, booking.checkIn, booking.checkOut, booking.reference)
      for (const invoice of data.invoices ?? []) {
        db.prepare(`INSERT INTO invoices (id, number, status, guest_id, booking_id, issue_date, due_date, discount, additional_charge, notes, created_at, issued_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(invoice.id, invoice.number, invoice.status, invoice.guestId, invoice.bookingId, invoice.issueDate, invoice.dueDate,
            invoice.discount, invoice.additionalCharge, invoice.notes ?? null, invoice.createdAt, invoice.issuedAt ?? null)
        const line = db.prepare('INSERT INTO invoice_line_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        invoice.items.forEach((item, position) => line.run(item.id, invoice.id, position, item.description, item.rate, item.quantity, item.quantityLabel, item.total))
      }
      for (const payment of data.payments ?? []) insertPayment(payment)
      for (const receipt of data.receipts ?? []) insertReceipt(receipt)
      for (const entry of data.auditLogs ?? []) insertAudit(entry)
      db.prepare('INSERT INTO business_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('business', JSON.stringify({ ...defaultSettings, ...data.settings }))
      const invoiceSequence = Math.max(0, ...(data.invoices ?? []).map((invoice) => Number(invoice.number.split('/').at(-2)) || 0))
      const receiptSequence = Math.max(0, ...(data.receipts ?? []).map((receipt) => Number(receipt.number.split('/').at(-2)) || 0))
      db.prepare('INSERT INTO counters(kind, value) VALUES (?, ?)').run('invoice', invoiceSequence)
      db.prepare('INSERT INTO counters(kind, value) VALUES (?, ?)').run('receipt', receiptSequence)
    })
  }

  return {
    close: () => db.close(),
    hasRecords: () => Number((db.prepare('SELECT count(*) AS count FROM guests').get() as { count: number }).count) > 0
      || Number((db.prepare('SELECT count(*) AS count FROM invoices').get() as { count: number }).count) > 0,
    saveGuest, saveUnit, saveBooking, saveInvoice, issueInvoice, recordPayment, recordAdjustment, saveSettings,
    readData, exportBackup, importBackup,
  }
}

export type ShwariDatabase = ReturnType<typeof createDatabase>