import { formatInTimeZone } from "date-fns-tz";
import { config } from "dotenv";
import cron from "node-cron";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getStudentAppointments } from "./services/daysmart.js";
import {
  discordClient,
  sendAssessmentReport,
  sendEODStudentReport,
  sendReconciliationReport,
} from "./services/discord.js";
import { writeSpreadsheetData } from "./services/googleSheets.js";
import { handleRadiusOperations } from "./services/radius.js";
import { isHolidayOrClosure } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, "../.env.local") });

discordClient.login(process.env.DISCORD_TOKEN);
discordClient.once("clientReady", async () => {
  if (!discordClient.user) {
    console.error("No user found in client.");
    return;
  }
  console.log(`Logged into Discord as ${discordClient.user.tag}`);

  if (isHolidayOrClosure()) {
    console.log("Skipping daily report due to center closure.");
    return;
  }

  // Sun-Thu at 9:00 AM
  // BOD Operations - Fetch student appointments, enrolled students, and payment issues.
  cron.schedule(
    "0 9 * * 0-4",
    async () => {
      const allAppointments = await getStudentAppointments();
      const dailyAppointments = allAppointments
        .filter(
          (appointment, i) =>
            i === 0 ||
            appointment[1] ===
              formatInTimeZone(new Date(), "America/Chicago", "MM/dd/yyyy"),
        )
        .map((appointment) => {
          const childName = appointment[0] as string;
          const duration = appointment[2] as string;
          const time = appointment[3] as string;
          const service = appointment[4] as string;
          const calendar = appointment[5] as string;
          const status = appointment[6] as string;

          const result: string[] = [
            childName,
            duration,
            time,
            service,
            calendar,
            status,
          ];

          return result;
        });

      await writeSpreadsheetData(
        "Instruction Scheduler",
        "'DaySmart (All Data)'!B2:H",
        allAppointments,
      );

      await writeSpreadsheetData(
        "Instruction Scheduler",
        "DaySmart!B2:G",
        dailyAppointments,
      );

      const { payments, totalExpected } = await handleRadiusOperations();
      await sendReconciliationReport(payments, totalExpected);
      await sendAssessmentReport();
    },
    { timezone: "America/Chicago" },
  );

  // Mon–Thu at 7:45 PM
  // EOD Operations - Run daily report
  cron.schedule(
    "45 19 * * 1-4",
    async () => {
      const { checkedInStudents } = await handleRadiusOperations();
      await sendEODStudentReport(checkedInStudents);
    },
    { timezone: "America/Chicago" },
  );

  // Sun at 5:15 PM
  // EOD Operations - Run daily report
  cron.schedule(
    "15 17 * * 0",
    async () => {
      const { checkedInStudents } = await handleRadiusOperations();
      await sendEODStudentReport(checkedInStudents);
    },
    { timezone: "America/Chicago" },
  );

  // Testing only
  // (async () => {
  //   // Insert code here.
  // })();
});
