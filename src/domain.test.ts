import { describe, expect, it } from 'vitest'
import { documentNumber, formatDate, invoiceBalance, invoiceTotal, money, paymentTotals, type Invoice, type Payment } from './domain'

const invoice: Invoice = {
  id: 'invoice-1', number: 'SHS/INV/00001/26', status: 'issued', guestId: 'guest-1', bookingId: 'booking-1',
  issueDate: '2026-10-17', dueDate: '2026-10-20', discount: 0, additionalCharge: 0, createdAt: '2026-10-17T10:00:00Z',
  items: [{ id: 'line-1', description: 'Accommodation', rate: 9000, quantity: 1, quantityLabel: '3 nights', total: 9000 }],
}

const payment = (id: string, amount: number): Payment => ({
  id, invoiceId: invoice.id, guestId: invoice.guestId, kind: 'payment', amount, method: 'M-Pesa', receivedAt: '2026-10-17T10:00:00Z', createdAt: '2026-10-17T10:00:00Z',
})

describe('financial rules', () => {
  it('keeps entered line totals independent of the displayed rate and quantity', () => {
    const sample = { ...invoice, items: [{ ...invoice.items[0], rate: 2000, quantity: 1, total: 2500 }] }
    expect(invoiceTotal(sample)).toBe(2500)
  })

  it('tracks partial and multiple payments without treating an invoice as paid early', () => {
    expect(invoiceBalance(invoice, [payment('p1', 3000)])).toBe(6000)
    expect(invoiceBalance(invoice, [payment('p1', 3000), payment('p2', 6000)])).toBe(0)
    expect(paymentTotals(invoice.id, [payment('p1', 3000)]).paid).toBe(3000)
  })

  it('accounts for refunds and balance adjustments', () => {
    const records: Payment[] = [
      payment('p1', 3000),
      { ...payment('r1', 500), kind: 'refund' },
      { ...payment('a1', 1), kind: 'adjustment', adjustmentDelta: -250 },
    ]
    expect(invoiceBalance(invoice, records)).toBe(6250)
  })

  it('formats separate sequential document numbers and Kenyan shillings', () => {
    expect(documentNumber('SHS/INV', 1, new Date('2026-01-01T00:00:00Z'))).toBe('SHS/INV/00001/26')
    expect(documentNumber('SHS', 2, new Date('2026-01-01T00:00:00Z'))).toBe('SHS/00002/26')
    expect(money(2500)).toContain('2,500.00')
    expect(formatDate('2026-10-17')).toBe('17 Oct 2026')
  })
})