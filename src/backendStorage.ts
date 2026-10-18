import { loadData as loadLegacyData } from './storage'
import type { AppData, Booking, BusinessSettings, Guest, Invoice, Payment, Receipt, Unit } from './domain'

const migrationKey = 'shwari-sqlite-migration-v1'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(result?.error ?? `Backend request failed (${response.status}).`)
  }
  const body = await response.text()
  return body ? JSON.parse(body) as T : undefined as T
}

async function migrateLegacyRecords() {
  if (localStorage.getItem(migrationKey)) return
  try {
    const legacy = await loadLegacyData()
    const hasRecords = legacy.guests.length + legacy.units.length + legacy.bookings.length
      + legacy.invoices.length + legacy.payments.length + legacy.receipts.length > 0
    if (hasRecords) await request('/api/migrate', { method: 'POST', body: JSON.stringify({ format: 'shwari-home-stays-backup', version: 1, data: legacy }) })
    localStorage.setItem(migrationKey, 'complete')
  } catch (error) {
    if (error instanceof Error && error.message.includes('Failed to fetch')) throw error
    localStorage.setItem(migrationKey, 'complete')
  }
}

export async function loadData(): Promise<AppData> {
  await migrateLegacyRecords()
  return request<AppData>('/api/data')
}

export async function saveGuest(guest: Guest) {
  await request('/api/guests', { method: 'POST', body: JSON.stringify(guest) })
}

export async function saveUnit(unit: Unit) {
  await request('/api/units', { method: 'POST', body: JSON.stringify(unit) })
}

export async function saveBooking(booking: Booking) {
  await request('/api/bookings', { method: 'POST', body: JSON.stringify(booking) })
}

export async function saveInvoice(invoice: Invoice) {
  await request('/api/invoices', { method: 'POST', body: JSON.stringify(invoice) })
}

export async function issueInvoice(invoiceId: string, prefix: string): Promise<Invoice> {
  return request<Invoice>(`/api/invoices/${encodeURIComponent(invoiceId)}/issue`, { method: 'POST', body: JSON.stringify({ prefix }) })
}

export async function recordPayment(payment: Payment, receiptPrefix: string): Promise<Receipt> {
  return request<Receipt>('/api/payments', { method: 'POST', body: JSON.stringify({ payment, receiptPrefix }) })
}

export async function recordAdjustment(payment: Payment) {
  await request('/api/adjustments', { method: 'POST', body: JSON.stringify(payment) })
}

export async function saveSettings(settings: BusinessSettings) {
  await request('/api/settings', { method: 'PUT', body: JSON.stringify(settings) })
}

export async function exportBackup(): Promise<Blob> {
  const backup = await request<unknown>('/api/backup')
  return new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
}

export async function importBackup(file: File): Promise<void> {
  const backup: unknown = JSON.parse(await file.text())
  await request('/api/backup/restore', { method: 'POST', body: JSON.stringify(backup) })
}