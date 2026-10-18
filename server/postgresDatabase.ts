import { Pool, type PoolClient, type QueryResultRow } from 'pg'
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
import type { ShwariDatabase } from './databaseTypes.js'

interface Row extends QueryResultRow {
  [column: string]: unknown
}

function audit(entityType: string, entityId: string, action: string, detail: string): AuditLog {
  return { id: crypto.randomUUID(), entityType, entityId, action, detail, createdAt: new Date().toISOString() }
}

export function createPostgresDatabase(connectionString: string): ShwariDatabase {
  const pool = new Pool({ connectionString, max: 1, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 })

  async function transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await action(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      if (error instanceof Error && 'code' in error && error.code === '23505') {
        throw new DatabaseError('That document number or payment reference has already been recorded.', 409)
      }
      throw error
    } finally {
      client.release()
    }
  }

  async function readInvoice(client: PoolClient, id: string): Promise<Invoice | undefined> {
    const result = await client.query<Row>('SELECT * FROM invoices WHERE id = $1', [id])
    const row = result.rows[0]
    if (!row) return undefined
    const items = await client.query<Row>('SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position', [id])
    return {
      id: String(row.id),
      number: String(row.number),
      status: row.status as Invoice['status'],
      guestId: String(row.guest_id),
      bookingId: String(row.booking_id),
      issueDate: String(row.issue_date),
      dueDate: String(row.due_date),
      items: items.rows.map((item) => ({
        id: String(item.id),
        description: String(item.description),
        rate: Number(item.rate),
        quantity: Number(item.quantity),
        quantityLabel: String(item.quantity_label),
        total: Number(item.total),
      })),
      discount: Number(row.discount),
      additionalCharge: Number(row.additional_charge),
      notes: row.notes == null ? undefined : String(row.notes),
      createdAt: String(row.created_at),
      issuedAt: row.issued_at == null ? undefined : String(row.issued_at),
    }
  }

  async function readPayments(client: PoolClient): Promise<Payment[]> {
    const result = await client.query<Row>('SELECT * FROM payments ORDER BY received_at')
    return result.rows.map((row) => ({
      id: String(row.id),
      invoiceId: row.invoice_id == null ? undefined : String(row.invoice_id),
      bookingId: row.booking_id == null ? undefined : String(row.booking_id),
      guestId: String(row.guest_id),
      kind: row.kind as Payment['kind'],
      amount: Number(row.amount),
      adjustmentDelta: row.adjustment_delta == null ? undefined : Number(row.adjustment_delta),
      method: row.method as Payment['method'],
      reference: row.reference == null ? undefined : String(row.reference),
      mpesaSender: row.mpesa_sender == null ? undefined : String(row.mpesa_sender),
      mpesaAccount: row.mpesa_account == null ? undefined : String(row.mpesa_account),
      description: row.description == null ? undefined : String(row.description),
      receivedAt: String(row.received_at),
      createdAt: String(row.created_at),
    }))
  }

  async function insertPayment(client: PoolClient, payment: Payment) {
    await client.query(`INSERT INTO payments
      (id, invoice_id, booking_id, guest_id, kind, amount, adjustment_delta, method, reference, mpesa_sender, mpesa_account, description, received_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [payment.id, payment.invoiceId ?? null, payment.bookingId ?? null, payment.guestId, payment.kind, payment.amount,
      payment.adjustmentDelta ?? null, payment.method, payment.reference?.trim() || null, payment.mpesaSender ?? null,
      payment.mpesaAccount ?? null, payment.description ?? null, payment.receivedAt, payment.createdAt])
  }

  async function insertReceipt(client: PoolClient, receipt: Receipt) {
    await client.query(`INSERT INTO receipts
      (id, number, payment_id, invoice_id, booking_id, issued_at, paid_to_date, balance_after)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [receipt.id, receipt.number, receipt.paymentId, receipt.invoiceId ?? null, receipt.bookingId ?? null,
      receipt.issuedAt, receipt.paidToDate ?? 0, receipt.balanceAfter ?? null])
  }

  async function insertAudit(client: PoolClient, entry: AuditLog) {
    await client.query(`INSERT INTO audit_logs (id, entity_type, entity_id, action, detail, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [entry.id, entry.entityType, entry.entityId, entry.action, entry.detail, entry.createdAt])
  }

  async function nextCounter(client: PoolClient, kind: 'invoice' | 'receipt'): Promise<number> {
    const result = await client.query<Row>(`INSERT INTO counters(kind, value) VALUES ($1, 1)
      ON CONFLICT(kind) DO UPDATE SET value = counters.value + 1 RETURNING value`, [kind])
    return Number(result.rows[0].value)
  }

  async function saveGuest(guest: Guest) {
    await transaction(async (client) => {
      await client.query('INSERT INTO guests VALUES ($1, $2, $3, $4, $5)',
        [guest.id, guest.name, guest.phone, guest.email ?? null, guest.createdAt])
      await insertAudit(client, audit('guest', guest.id, 'created', guest.name))
    })
  }

  async function saveUnit(unit: Unit) {
    await transaction(async (client) => {
      await client.query('INSERT INTO units VALUES ($1, $2, $3, $4)', [unit.id, unit.name, unit.rate, unit.active])
      await insertAudit(client, audit('unit', unit.id, 'created', unit.name))
    })
  }

  async function saveBooking(booking: Booking) {
    await transaction(async (client) => {
      await client.query('INSERT INTO bookings VALUES ($1, $2, $3, $4, $5, $6)',
        [booking.id, booking.guestId, booking.unitId || null, booking.checkIn, booking.checkOut, booking.reference])
      await insertAudit(client, audit('booking', booking.id, 'created', booking.reference))
    })
  }

  async function saveInvoice(invoice: Invoice) {
    if (invoice.status !== 'draft') throw new DatabaseError('New invoices must be saved as drafts.')
    if (invoice.items.length === 0) throw new DatabaseError('An invoice needs at least one charge line.')
    const number = invoice.number?.trim() || 'DRAFT'
    await transaction(async (client) => {
      await client.query(`INSERT INTO invoices
        (id, number, status, guest_id, booking_id, issue_date, due_date, discount, additional_charge, notes, created_at, issued_at)
        VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10, NULL)`,
      [invoice.id, number, invoice.guestId, invoice.bookingId, invoice.issueDate, invoice.dueDate,
        invoice.discount, invoice.additionalCharge, invoice.notes ?? null, invoice.createdAt])
      for (const [position, item] of invoice.items.entries()) {
        await client.query('INSERT INTO invoice_line_items VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [item.id, invoice.id, position, item.description, item.rate, item.quantity, item.quantityLabel, item.total])
      }
      await insertAudit(client, audit('invoice', invoice.id, 'created', 'Invoice draft created'))
    })
  }

  async function issueInvoice(invoiceId: string, prefix: string): Promise<Invoice> {
    return transaction(async (client) => {
      await client.query('SELECT id FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId])
      const invoice = await readInvoice(client, invoiceId)
      if (!invoice || invoice.status !== 'draft') throw new DatabaseError('Only draft invoices can be issued.', 404)
      const sequence = await nextCounter(client, 'invoice')
      const issuedAt = new Date().toISOString()
      const number = documentNumber(prefix, sequence, new Date(issuedAt))
      await client.query("UPDATE invoices SET number = $1, status = 'issued', issued_at = $2 WHERE id = $3",
        [number, issuedAt, invoiceId])
      await insertAudit(client, audit('invoice', invoiceId, 'issued', number))
      return (await readInvoice(client, invoiceId))!
    })
  }

  async function recordPayment(payment: Payment, receiptPrefix: string): Promise<Receipt> {
    if (!Number.isFinite(payment.amount) || payment.amount <= 0) throw new DatabaseError('Payment amount must be greater than zero.')
    return transaction(async (client) => {
      if (payment.invoiceId) await client.query('SELECT id FROM invoices WHERE id = $1 FOR UPDATE', [payment.invoiceId])
      const previousPayments = await readPayments(client)
      const invoice = payment.invoiceId ? await readInvoice(client, payment.invoiceId) : undefined
      if (payment.invoiceId && (!invoice || invoice.status !== 'issued')) {
        throw new DatabaseError('Payments can only be allocated to an issued invoice.')
      }
      if (invoice && payment.amount > safeBalance(invoice, previousPayments)) {
        throw new DatabaseError('Payment amount exceeds the current invoice balance.')
      }
      await insertPayment(client, payment)
      const afterPayment = [...previousPayments, payment]
      const paidToDate = invoice ? paymentTotals(invoice.id, afterPayment).netPaid : payment.amount
      const balanceAfter = invoice ? Math.max(0, invoiceBalance(invoice, afterPayment)) : null
      const sequence = await nextCounter(client, 'receipt')
      const receipt: Receipt = {
        id: crypto.randomUUID(),
        number: documentNumber(receiptPrefix, sequence, new Date(payment.receivedAt)),
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        bookingId: payment.bookingId,
        issuedAt: new Date().toISOString(),
        paidToDate,
        balanceAfter,
      }
      await insertReceipt(client, receipt)
      await insertAudit(client, audit('payment', payment.id, 'recorded', `${payment.kind}: ${payment.amount} ${payment.method}`))
      return receipt
    })
  }

  async function recordAdjustment(payment: Payment) {
    if (!Number.isFinite(payment.amount) || payment.amount <= 0) throw new DatabaseError('Adjustment amount must be greater than zero.')
    if (payment.kind === 'adjustment' && !Number.isFinite(payment.adjustmentDelta)) {
      throw new DatabaseError('A balance adjustment needs a signed amount.')
    }
    await transaction(async (client) => {
      if (payment.invoiceId) await client.query('SELECT id FROM invoices WHERE id = $1 FOR UPDATE', [payment.invoiceId])
      const previous = await readPayments(client)
      const invoice = payment.invoiceId ? await readInvoice(client, payment.invoiceId) : undefined
      if (payment.invoiceId && (!invoice || invoice.status !== 'issued')) {
        throw new DatabaseError('Adjustments can only be made to an issued invoice.')
      }
      if (payment.kind === 'refund' && payment.invoiceId) {
        const totals = paymentTotals(payment.invoiceId, previous)
        if (payment.amount > totals.paid - totals.refunded) {
          throw new DatabaseError('A refund cannot exceed payments received for this invoice.')
        }
      }
      if (invoice && payment.kind === 'adjustment' && invoiceBalance(invoice, [...previous, payment]) < 0) {
        throw new DatabaseError('The adjustment cannot reduce the invoice below zero.')
      }
      await insertPayment(client, payment)
      await insertAudit(client, audit('payment', payment.id, payment.kind, payment.description ?? ''))
    })
  }

  async function saveSettings(settings: BusinessSettings) {
    await transaction(async (client) => {
      await client.query(`INSERT INTO business_settings(key, value) VALUES ('business', $1)
        ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(settings)])
      await insertAudit(client, audit('settings', 'business', 'updated', 'Business document details updated'))
    })
  }

  async function readData(): Promise<AppData> {
    const [guestsResult, unitsResult, bookingsResult, invoicesResult, paymentsResult, receiptsResult, auditResult, settingsResult] = await Promise.all([
      pool.query<Row>('SELECT * FROM guests ORDER BY name'),
      pool.query<Row>('SELECT * FROM units ORDER BY name'),
      pool.query<Row>('SELECT * FROM bookings ORDER BY check_in DESC'),
      pool.query<Row>('SELECT id FROM invoices ORDER BY created_at DESC'),
      pool.query<Row>('SELECT * FROM payments ORDER BY received_at'),
      pool.query<Row>('SELECT * FROM receipts ORDER BY issued_at DESC'),
      pool.query<Row>('SELECT * FROM audit_logs ORDER BY created_at DESC'),
      pool.query<Row>("SELECT value FROM business_settings WHERE key = 'business'"),
    ])
    const guests: Guest[] = guestsResult.rows.map((row) => ({
      id: String(row.id), name: String(row.name), phone: String(row.phone),
      email: row.email == null ? undefined : String(row.email), createdAt: String(row.created_at),
    }))
    const units: Unit[] = unitsResult.rows.map((row) => ({
      id: String(row.id), name: String(row.name), rate: Number(row.rate), active: Boolean(row.active),
    }))
    const bookings: Booking[] = bookingsResult.rows.map((row) => ({
      id: String(row.id), guestId: String(row.guest_id), unitId: row.unit_id == null ? '' : String(row.unit_id),
      checkIn: String(row.check_in), checkOut: String(row.check_out), reference: String(row.reference),
    }))
    const client = await pool.connect()
    let invoices: Invoice[]
    let payments: Payment[]
    try {
      invoices = (await Promise.all(invoicesResult.rows.map((row) => readInvoice(client, String(row.id)))))
        .filter((invoice): invoice is Invoice => invoice !== undefined)
      payments = await readPayments(client)
    } finally {
      client.release()
    }
    const receipts: Receipt[] = receiptsResult.rows.map((row) => ({
      id: String(row.id), number: String(row.number), paymentId: String(row.payment_id),
      invoiceId: row.invoice_id == null ? undefined : String(row.invoice_id),
      bookingId: row.booking_id == null ? undefined : String(row.booking_id),
      issuedAt: String(row.issued_at), paidToDate: Number(row.paid_to_date),
      balanceAfter: row.balance_after == null ? null : Number(row.balance_after),
    }))
    const auditLogs: AuditLog[] = auditResult.rows.map((row) => ({
      id: String(row.id), entityType: String(row.entity_type), entityId: String(row.entity_id),
      action: String(row.action), detail: String(row.detail), createdAt: String(row.created_at),
    }))
    return {
      guests, units, bookings, invoices, payments, receipts, auditLogs,
      settings: { ...defaultSettings, ...(settingsResult.rows[0]?.value as Partial<BusinessSettings> | undefined) },
    }
  }

  async function exportBackup() {
    return { format: 'shwari-home-stays-backup', version: 1, exportedAt: new Date().toISOString(), data: await readData() }
  }

  async function importBackup(backup: unknown, onlyIfEmpty = false) {
    if (!backup || typeof backup !== 'object' || !('data' in backup)) {
      throw new DatabaseError('This file is not a Shwari Home Stays backup.')
    }
    const data = (backup as { data: Partial<AppData> }).data
    const collections = ['guests', 'units', 'bookings', 'invoices', 'payments', 'receipts', 'auditLogs'] as const
    if (!collections.every((key) => Array.isArray(data[key])) || !data.settings) {
      throw new DatabaseError('Backup is missing required records.')
    }
    await transaction(async (client) => {
      const existing = await client.query<Row>(`SELECT
        (SELECT count(*) FROM guests) + (SELECT count(*) FROM invoices) + (SELECT count(*) FROM payments) AS count`)
      if (onlyIfEmpty && Number(existing.rows[0].count) > 0) return
      await client.query(`DELETE FROM receipts; DELETE FROM payments; DELETE FROM invoice_line_items; DELETE FROM invoices;
        DELETE FROM bookings; DELETE FROM units; DELETE FROM guests; DELETE FROM audit_logs; DELETE FROM counters`)
      for (const guest of data.guests ?? []) {
        await client.query('INSERT INTO guests VALUES ($1, $2, $3, $4, $5)',
          [guest.id, guest.name, guest.phone, guest.email ?? null, guest.createdAt])
      }
      for (const unit of data.units ?? []) {
        await client.query('INSERT INTO units VALUES ($1, $2, $3, $4)', [unit.id, unit.name, unit.rate, unit.active])
      }
      for (const booking of data.bookings ?? []) {
        await client.query('INSERT INTO bookings VALUES ($1, $2, $3, $4, $5, $6)',
          [booking.id, booking.guestId, booking.unitId || null, booking.checkIn, booking.checkOut, booking.reference])
      }
      for (const invoice of data.invoices ?? []) {
        await client.query(`INSERT INTO invoices
          (id, number, status, guest_id, booking_id, issue_date, due_date, discount, additional_charge, notes, created_at, issued_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [invoice.id, invoice.number, invoice.status, invoice.guestId, invoice.bookingId, invoice.issueDate, invoice.dueDate,
          invoice.discount, invoice.additionalCharge, invoice.notes ?? null, invoice.createdAt, invoice.issuedAt ?? null])
        for (const [position, item] of invoice.items.entries()) {
          await client.query('INSERT INTO invoice_line_items VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [item.id, invoice.id, position, item.description, item.rate, item.quantity, item.quantityLabel, item.total])
        }
      }
      for (const payment of data.payments ?? []) await insertPayment(client, payment)
      for (const receipt of data.receipts ?? []) await insertReceipt(client, receipt)
      for (const entry of data.auditLogs ?? []) await insertAudit(client, entry)
      await client.query(`INSERT INTO business_settings(key, value) VALUES ('business', $1)
        ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ ...defaultSettings, ...data.settings })])
      const invoiceSequence = Math.max(0, ...(data.invoices ?? []).map((invoice) => Number(invoice.number.split('/').at(-2)) || 0))
      const receiptSequence = Math.max(0, ...(data.receipts ?? []).map((receipt) => Number(receipt.number.split('/').at(-2)) || 0))
      await client.query('INSERT INTO counters(kind, value) VALUES ($1, $2), ($3, $4)',
        ['invoice', invoiceSequence, 'receipt', receiptSequence])
    })
  }

  async function hasRecords(): Promise<boolean> {
    const result = await pool.query<Row>(`SELECT
      (SELECT count(*) FROM guests) + (SELECT count(*) FROM invoices) + (SELECT count(*) FROM payments) AS count`)
    return Number(result.rows[0].count) > 0
  }

  return {
    hasRecords,
    saveGuest,
    saveUnit,
    saveBooking,
    saveInvoice,
    issueInvoice,
    recordPayment,
    recordAdjustment,
    saveSettings,
    readData,
    exportBackup,
    importBackup,
  }
}
