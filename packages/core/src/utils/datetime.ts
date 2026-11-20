import { config } from "@/config/index.js";

export function getDayOfWeekCode(dateISO: string): string {
  const date = new Date(dateISO + "T00:00:00Z");
  const dayIndex = date.getUTCDay();
  const dayMap = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return dayMap[dayIndex];
}

export function getDaysOfWeekInRange(startDateISO: string, endDateISO: string): string[] {
  const start = new Date(startDateISO + "T00:00:00Z");
  const end = new Date(endDateISO + "T00:00:00Z");
  const days = new Set<string>();

  const current = new Date(start);
  while (current <= end) {
    const dayCode = getDayOfWeekCode(current.toISOString().split("T")[0]);
    days.add(dayCode);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return Array.from(days);
}

export function matchesTimeOfDay(
  timeStr: string | null,
  bucket: "morning" | "afternoon" | "evening",
): boolean {
  if (!timeStr) return false;
  const [hours] = timeStr.split(":").map(Number);

  switch (bucket) {
    case "morning":
      return hours >= 5 && hours < 12;
    case "afternoon":
      return hours >= 12 && hours < 18;
    case "evening":
      return hours >= 18 || hours < 5;
    default:
      return false;
  }
}

export function getToday(timezone: string = config.timezone): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

export function getCurrentTime(timezone: string = config.timezone): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function getDayKey(date: Date = new Date(), timezone: string = config.timezone): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
}

export function getDateOffset(dateISO: string, days: number): string {
  const date = new Date(dateISO + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split("T")[0];
}

export function getTimezoneAbbreviation(timezone: string = config.timezone): string {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? "PT"
  );
}

export function formatDateTimeInTimezone(date: Date, timezone: string = config.timezone): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

export function parseISODateInTimezone(dateISO: string, timezone: string = config.timezone): Date {
  const [year, month, day] = dateISO.split("-").map(Number);

  const dateString = `${month}/${day}/${year}, 00:00:00`;

  const localDate = new Date(dateString);

  const tzString = localDate.toLocaleString("en-US", { timeZone: timezone });
  const tzDate = new Date(tzString);

  const offset = localDate.getTime() - tzDate.getTime();

  return new Date(localDate.getTime() + offset);
}

export function getDayBoundariesInTimezone(
  date: Date,
  timezone: string = config.timezone,
): { startOfDay: Date; endOfDay: Date } {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  const dateISO = formatter.format(date);

  const startOfDay = parseISODateInTimezone(dateISO, timezone);

  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

  return { startOfDay, endOfDay };
}

export function getNextBusinessDay(
  fromDate: Date = new Date(),
  timezone: string = config.timezone,
): Date {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  const currentDateISO = formatter.format(fromDate);

  const nextDate = new Date(currentDateISO + "T00:00:00Z");
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);

  while (true) {
    const dayOfWeek = nextDate.getUTCDay();
    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      const nextDateISO = nextDate.toISOString().split("T")[0];
      return parseISODateInTimezone(nextDateISO, timezone);
    }
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  }
}
