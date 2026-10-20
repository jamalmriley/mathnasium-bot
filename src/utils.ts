const HOLIDAYS_AND_CLOSURES = [
  "2026-01-01", // New Year's Day
  "2026-05-10", // Mother's Day
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-04", // 4th of July
  "2026-09-07", // Labor Day
  "2026-10-12", // Indigenous Peoples' Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
];

export function isHolidayOrClosure(): boolean {
  // Get current date string in America/Chicago timezone
  const todayStr = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  // Convert MM/DD/YYYY to YYYY-MM-DD
  const [month, day, year] = todayStr.split("/");
  const formattedDate = `${year}-${month}-${day}`;

  return HOLIDAYS_AND_CLOSURES.includes(formattedDate);
}

export const dollarFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  trailingZeroDisplay: "stripIfInteger",
});
