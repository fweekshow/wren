export interface ParsedReviewTime {
  localTime: string;
  timezone: string | null;
}

const TIME_RE = /\b(?:at\s+|@\s*)?([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\b/i;
const IANA_TZ_RE = /\b([A-Za-z_]+\/[A-Za-z0-9_+\-\/]+|UTC)\b/;

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function parseReviewTime(text: string): ParsedReviewTime | null {
  const match = text.match(TIME_RE);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  const tz = text.match(IANA_TZ_RE)?.[1] ?? null;
  return {
    localTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    timezone: tz && isValidTimezone(tz) ? tz : null,
  };
}

function zonedParts(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = zonedParts(date, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

function zonedLocalToUtc(args: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone: string;
}): Date {
  const localAsUtc = Date.UTC(
    args.year,
    args.month - 1,
    args.day,
    args.hour,
    args.minute,
    0,
    0,
  );
  let utc = localAsUtc - timezoneOffsetMs(new Date(localAsUtc), args.timezone);
  // Re-evaluate after the first offset guess to handle DST transitions.
  utc = localAsUtc - timezoneOffsetMs(new Date(utc), args.timezone);
  return new Date(utc);
}

export function nextDailyRunAt(localTime: string, timezone: string, from = new Date()): Date {
  if (!isValidTimezone(timezone)) {
    throw new Error(`invalid timezone: ${timezone}`);
  }
  const [hourText, minuteText] = localTime.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(`invalid local time: ${localTime}`);
  }

  const today = zonedParts(from, timezone);
  let candidate = zonedLocalToUtc({
    year: today.year,
    month: today.month,
    day: today.day,
    hour,
    minute,
    timezone,
  });

  if (candidate.getTime() <= from.getTime()) {
    const nextDayAsUtc = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
    const tomorrow = zonedParts(nextDayAsUtc, timezone);
    candidate = zonedLocalToUtc({
      year: tomorrow.year,
      month: tomorrow.month,
      day: tomorrow.day,
      hour,
      minute,
      timezone,
    });
  }

  return candidate;
}

export function formatReviewSchedule(localTime: string, timezone: string): string {
  const [hourText, minuteText] = localTime.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const suffix = hour >= 12 ? "pm" : "am";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")}${suffix} ${timezone}`;
}
