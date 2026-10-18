import { describe, expect, it } from 'vitest'
import { formatNairobiDateTime, nairobiDateTimeInput, nairobiInputToIso, parseMpesaMessage } from './mpesa'

const message = 'Confirmed. You have received KES 2500.00 for Account 242025 from GERALD ENDIEGO. # Mpesa Ref:UJHLP9YDVS on 17-10-2026 09:59Hrs'

describe('M-Pesa confirmation parsing', () => {
  it('extracts amount, account, sender, reference and Nairobi transaction time', () => {
    const parsed = parseMpesaMessage(message)
    expect(parsed).toEqual({
      amount: 2500,
      account: '242025',
      sender: 'GERALD ENDIEGO',
      reference: 'UJHLP9YDVS',
      receivedAt: '2026-10-17T06:59:00.000Z',
    })
    expect(nairobiDateTimeInput(parsed!.receivedAt)).toBe('2026-10-17T09:59')
    expect(nairobiInputToIso('2026-10-17T09:59')).toBe(parsed!.receivedAt)
    expect(formatNairobiDateTime(parsed!.receivedAt)).toBe('17/10/2026, 09:59')
  })

  it('handles grouped amounts and refuses incomplete or invalid messages', () => {
    expect(parseMpesaMessage(message.replace('2500.00', '2,500.00'))?.amount).toBe(2500)
    expect(parseMpesaMessage(message.replace('UJHLP9YDVS', ''))).toBeNull()
    expect(parseMpesaMessage(message.replace('17-10-2026', '31-02-2026'))).toBeNull()
  })
})