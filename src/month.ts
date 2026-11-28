export function currentMonth(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

export function nextMonth(month: string): string {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7);
}

export function selectedMonth(value: string | null): string {
  const current = currentMonth();
  return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value <= current && value >= "2020-01" ? value : current;
}

export function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));
}

export function monthDays(month: string): string[] {
  const count = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
}
