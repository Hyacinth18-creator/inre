import type { AppData, AuditLog, Booking, BusinessSettings, Guest, Invoice, Payment, Receipt, Unit } from '../src/domain.js'
import type { MaybePromise } from './databaseErrors.js'

export interface ShwariDatabase {
  hasRecords(): MaybePromise<boolean>
  saveGuest(guest: Guest): MaybePromise<void>
  saveUnit(unit: Unit): MaybePromise<void>
  saveBooking(booking: Booking): MaybePromise<void>
  saveInvoice(invoice: Invoice): MaybePromise<void>
  issueInvoice(invoiceId: string, prefix: string): MaybePromise<Invoice>
  recordPayment(payment: Payment, receiptPrefix: string): MaybePromise<Receipt>
  recordAdjustment(payment: Payment): MaybePromise<void>
  saveSettings(settings: BusinessSettings): MaybePromise<void>
  readData(): MaybePromise<AppData>
  exportBackup(): MaybePromise<unknown>
  importBackup(backup: unknown, onlyIfEmpty?: boolean): MaybePromise<void>
}
