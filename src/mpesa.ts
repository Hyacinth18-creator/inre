export interface ParsedMpesaMessage {
  amount: number
  account: string
  sender: string
  reference: string
  receivedAt: string
}

export function parseMpesaMessage(message: string): ParsedMpesaMessage | null {
  const amountMatch = message.match(/\breceived\s+(?:KES|KSh)\s*([\d,]+(?:\.\d{1,2})?)/i)
  const referenceMatch = message.match(/\bMpesa\s+Ref\s*:\s*([A-Z0-9]+)\s+on\s+\d{1,2}-\d{1,2}-\d{4}/i)
  const detailsMatch = message.match(/\bfor\s+Account\s+([A-Z0-9_-]+)\s+from\s+(.+?)\.?\s*#?\s*Mpesa\s+Ref\s*:/i)
  const dateMatch = message.match(/\bon\s+(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})\s*Hrs\b/i)

  if (!amountMatch || !referenceMatch || !detailsMatch || !dateMatch) return null

  const amount = Number(amountMatch[1].replaceAll(',', ''))
  const [, dayText, monthText, yearText, hourText, minuteText] = dateMatch
  const day = Number(dayText)
  const month = Number(monthText)
  const year = Number(yearText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const localDate = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (
    !Number.isFinite(amount) || amount <= 0 || month < 1 || month > 12 || day < 1 || day > 31 ||
    hour > 23 || minute > 59 || localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month - 1 || localDate.getUTCDate() !== day
  ) return null

  return {
    amount,
    account: detailsMatch[1],
    sender: detailsMatch[2].trim().replace(/\.$/, ''),
    reference: referenceMatch[1].toUpperCase(),
    receivedAt: new Date(Date.UTC(year, month - 1, day, hour - 3, minute)).toISOString(),
  }
}

export function nairobiDateTimeInput(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '00'
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}

export function nairobiInputToIso(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!match) throw new Error('Enter a valid payment date and time.')
  const [, year, month, day, hour, minute] = match.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, hour - 3, minute))
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59) {
    throw new Error('Enter a valid payment date and time.')
  }
  return date.toISOString()
}

export function formatNairobiDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value))
}