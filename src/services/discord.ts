import { formatInTimeZone } from "date-fns-tz";
import { Client, GatewayIntentBits } from "discord.js";
import { getSpreadsheetData, getStudentList } from "./googleSheets.js";

const discordChannels = new Map([
  ["admin-team", "1476779118006763703"],
  ["automated-reminders", "1489433511470436403"],
  ["lead-team", "1457443742842753148"],
  ["test-channel", "1481388054148284569"],
] as const);

type DiscordChannelName = Parameters<typeof discordChannels.get>[0];

export const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function fetchChannel(channelName: DiscordChannelName) {
  return await discordClient.channels.fetch(discordChannels.get(channelName)!);
}

export async function sendEODStudentReport(checkedInStudents: string) {
  console.log("Running daily report...");
  const channel = await fetchChannel("lead-team");

  // Check if the channel exists AND is a text-based channel
  if (!channel) {
    console.error("Channel not found.");
    return;
  }
  if (!channel.isTextBased() || !("send" in channel)) {
    console.error("Channel cannot send messages.");
    return;
  }

  const today = new Date();
  const timezone = "America/Chicago";

  const lastMinuteStudents = await getStudentList("Last-Minute");
  const cancelledStudents = await getStudentList("Cancelled");
  const noShowStudents = await getStudentList("No Show");

  await channel.send(
    `# 📋 EOD Report - ${formatInTimeZone(today, timezone, "eee, MMM d")}\n-# Below is an auto-generated student sessions report for today (${formatInTimeZone(today, timezone, "MM/dd/yyyy")}). [Click here](https://docs.google.com/spreadsheets/d/1TKA8M9LQciU_NjYczRDpWzhBAYeVFEPPSvhs3UBY4tg/edit?gid=0#gid=0) to navigate to the Instruction Scheduler. For any questions or concerns, please reach out to the admin team.\n\n` +
      [
        lastMinuteStudents,
        cancelledStudents,
        noShowStudents,
        checkedInStudents,
      ].join("\n—————————————————————————\n"),
  );
}

export async function sendReconciliationReport(
  payments: (string | number | string[] | Date | undefined)[][],
  totalExpected: number,
) {
  const adminTeamChannel = await fetchChannel("admin-team");
  const leadTeamChannel = await fetchChannel("lead-team");

  // Check if the channels exists AND are text-based channels
  if (!adminTeamChannel) {
    console.error("Admin team channel not found.");
    return;
  }
  if (!adminTeamChannel.isTextBased() || !("send" in adminTeamChannel)) {
    console.error("Admin team channel cannot send messages.");
    return;
  }
  if (!leadTeamChannel) {
    console.error("Lead team channel not found.");
    return;
  }
  if (!leadTeamChannel.isTextBased() || !("send" in leadTeamChannel)) {
    console.error("Lead team channel cannot send messages.");
    return;
  }

  const today = new Date();
  const timezone = "America/Chicago";

  const dollarFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
    currencySign: "accounting",
  });

  function formatPayments(): string[] {
    const months = new Map([
      [0, "January"],
      [1, "February"],
      [2, "March"],
      [3, "April"],
      [4, "May"],
      [5, "June"],
      [6, "July"],
      [7, "August"],
      [8, "September"],
      [9, "October"],
      [10, "November"],
      [11, "December"],
    ]);
    const result = [];

    const listify = (list: string[]) => {
      if (list.length === 0) return "";
      if (list.length === 1) return list[0];
      if (list.length === 2) return list.join(" and ");

      const result = [];
      for (let i = 0; i < list.length; i++) {
        const listItem = list[i];
        const isLastListItem = i === list.length - 1;

        if (isLastListItem) result.push(`and ${listItem}`);
        else result.push(listItem);
      }

      return result.join(", ");
    };

    for (const [monthIndex, month] of months) {
      const filteredPayments = payments.filter((payment) => {
        const billingDate = payment[4] as Date;
        const billingMonth = billingDate.getMonth();
        return billingMonth === monthIndex;
      });

      if (filteredPayments.length > 0) {
        const totalMonthlyExpected = filteredPayments.reduce((total, row) => {
          const amtExpected = row[5] as number; //
          return total + amtExpected;
        }, 0);
        const monthlyBlockText =
          `**${month}${totalMonthlyExpected === 0 ? "" : ` — ${dollarFormatter.format(totalMonthlyExpected)}`}**\n` +
          filteredPayments
            .map((payment, i) => {
              const accountStatus = payment[0] as string;
              const accountName = (payment[1] as string).trim();
              const students = payment[2] as string[];
              const paymentStatus = payment[3] as string;
              const billingDate = payment[4] as Date;
              const amtExpected = payment[5] as number;
              const amtPaid = payment[6] as number;

              const statusPrefix =
                accountStatus === "Inactive" ? " (Inactive)" : "";
              const formattedBillingDate = formatInTimeZone(
                billingDate,
                timezone,
                "M/d/yy",
              );

              const balance = amtExpected - amtPaid;
              const lateFee = 35;

              const formattedAmtExpected = dollarFormatter.format(amtExpected);
              const formattedAmtPaid = dollarFormatter.format(amtPaid);
              const formattedBalance = dollarFormatter.format(balance);
              const formattedLateFee = dollarFormatter.format(lateFee);
              const formattedTotalOwed = dollarFormatter.format(
                balance + lateFee,
              );

              const paymentDesc =
                amtExpected < 0
                  ? `: ${formattedAmtExpected} - Unreconciled Credit`
                  : amtExpected === amtPaid
                    ? `: ${formattedAmtPaid} - ${paymentStatus}`
                    : `\n  * ${students.length === 1 ? "Student" : "Students"}: ${listify(students)}\n  * Paid ${formattedAmtPaid} out of ${formattedAmtExpected} as of ${formattedBillingDate}\n  * Balance: ${formattedTotalOwed} (${formattedBalance} + ${formattedLateFee} fee)`;

              return `${i + 1}. ${accountName}${statusPrefix}${paymentDesc}`;
            })
            .join("\n");

        result.push(monthlyBlockText);
      }
    }

    const messageBuckets: string[] = [];
    let currentBucket = "";
    const delimiter = "\n—————————————————————————\n";
    const maxCharLimit = 1700;

    for (const monthText of result) {
      // If a single month is somehow huge on its own, push it to its own bucket
      if (monthText.length >= maxCharLimit) {
        if (currentBucket) {
          messageBuckets.push(currentBucket);
          currentBucket = "";
        }
        messageBuckets.push(monthText);
        continue;
      }

      // Determine what the bucket would look like if we add this month
      const prospectiveText = currentBucket
        ? currentBucket + delimiter + monthText
        : monthText;

      if (prospectiveText.length > maxCharLimit) {
        // It exceeds the limit, so save the old bucket and start a new one with this month
        messageBuckets.push(currentBucket);
        currentBucket = monthText;
      } else {
        // It fits, so keep building the current bucket
        currentBucket = prospectiveText;
      }
    }

    // Push the final leftover bucket if it has data
    if (currentBucket) {
      messageBuckets.push(currentBucket);
    }

    return messageBuckets; // Returns an array of grouped data.
  }

  function formatStudents(): string {
    const allStudents = new Set();

    for (const payment of payments) {
      const accountStatus = payment[0] as string;
      const students = payment[2] as string[];
      const amtExpected = payment[5] as number;

      if (accountStatus === "Active" && amtExpected >= 0) {
        students.forEach((student) => allStudents.add(student));
      }
    }

    const message =
      "Hello team! Please review this list before conducting any sessions today.\n * **Action Required:** If a student on this list arrives, do not start their session.\n * **Next Steps:** Immediately and __discreetly__ notify an admin team member to handle the check-in, and have the student wait at the front.\n * **Discretion:** Ensure a smooth, private experience for our families, and please avoid discussing any account details aloud in the instruction zones or near other students.\n\n";
    const studentsList = [...allStudents]
      .sort()
      .map((student, i) => `${i + 1}. ${student}`);

    return message + studentsList.join("\n");
  }

  if (payments.length > 0) {
    const formattedPaymentInfo = formatPayments();
    const formattedFlaggedStudentsInfo = formatStudents();

    console.log(formattedPaymentInfo);
    console.log(formattedFlaggedStudentsInfo);

    for (let i = 0; i < formattedPaymentInfo.length; i++) {
      const header = `# 💰 Payments Report - ${formatInTimeZone(today, timezone, "eee, MMM d")} | ${dollarFormatter.format(totalExpected)} in unreconciled revenue\n-# Below is an auto-generated payments report for today (${formatInTimeZone(today, timezone, "MM/dd/yyyy")}). [Click here](https://radius.mathnasium.com/Payment) to navigate to the Payment Reconciliation dashboard in Radius.\n\n`;
      const message = (
        i === 0 ? header + formattedPaymentInfo[i] : formattedPaymentInfo[i]
      ) as string;
      await adminTeamChannel.send(message);
    }

    await leadTeamChannel.send(
      `# 🚩 Flagged Students Report - ${formatInTimeZone(today, timezone, "eee, MMM d")}\n-# Below is an auto-generated students report for today (${formatInTimeZone(today, timezone, "MM/dd/yyyy")}). For any questions or concerns, please reach out to the admin team.\n\n` +
        formattedFlaggedStudentsInfo,
    );
  } else {
    console.log("All payments have been reconciled in Radius!");
  }
}

export async function sendAssessmentReport() {
  const headers = await getSpreadsheetData(
    "Instruction Scheduler",
    "'Radius Students - HELPER'!A1:F1",
  );

  const assessmentInfo = await getSpreadsheetData(
    "Instruction Scheduler",
    "'Radius Students - HELPER'!A2:F",
  );

  const studentNameCol = headers.flat().indexOf("Student Name");
  const radiusLinkCol = headers.flat().indexOf("Radius Link");
  const lastDateCol = headers.flat().indexOf("Last Date");
  const needsReassessmentCol = headers.flat().indexOf("Needs Reassessment");

  if (
    Math.min(
      studentNameCol,
      radiusLinkCol,
      lastDateCol,
      needsReassessmentCol,
    ) === -1
  ) {
    return;
  }

  const reassessingStudents = assessmentInfo
    .filter((row) => row[needsReassessmentCol] === "TRUE")
    .map(
      (row, i) =>
        `${i + 1}. [${row[studentNameCol]}](${row[radiusLinkCol]}) - ${row[lastDateCol]}`,
    );

  if (reassessingStudents.length === 0) return;

  function formatMessage(students: string[]) {
    const messageBuckets: string[] = [];
    let currentBucket = "";
    const delimiter = "\n";
    const maxCharLimit = 1700;

    for (const student of students) {
      // If a single month is somehow huge on its own, push it to its own bucket
      if (student.length >= maxCharLimit) {
        if (currentBucket) {
          messageBuckets.push(currentBucket);
          currentBucket = "";
        }
        messageBuckets.push(student);
        continue;
      }

      // Determine what the bucket would look like if we add this month
      const prospectiveText = currentBucket
        ? currentBucket + delimiter + student
        : student;

      if (prospectiveText.length > maxCharLimit) {
        // It exceeds the limit, so save the old bucket and start a new one with this month
        messageBuckets.push(currentBucket);
        currentBucket = student;
      } else {
        // It fits, so keep building the current bucket
        currentBucket = prospectiveText;
      }
    }

    // Push the final leftover bucket if it has data
    if (currentBucket) {
      messageBuckets.push(currentBucket);
    }

    return messageBuckets; // Returns an array of grouped data.
  }

  const leadTeamChannel = await fetchChannel("lead-team");

  // Check if the channels exists AND are text-based channels
  if (!leadTeamChannel) {
    console.error("Lead team channel not found.");
    return;
  }
  if (!leadTeamChannel.isTextBased() || !("send" in leadTeamChannel)) {
    console.error("Lead team channel cannot send messages.");
    return;
  }

  const today = new Date();
  const timezone = "America/Chicago";

  const formattedAssessmentInfo = formatMessage(reassessingStudents);

  for (let i = 0; i < formattedAssessmentInfo.length; i++) {
    const header = `# 📚 Assessment Report - ${formatInTimeZone(today, timezone, "eee, MMM d")} | ${reassessingStudents.length} ${reassessingStudents.length === 1 ? "student" : "students"}\n-# Below is an auto-generated assessments report for today (${formatInTimeZone(today, timezone, "MM/dd/yyyy")}).\n\n`;
    const message = (
      i === 0 ? header + formattedAssessmentInfo[i] : formattedAssessmentInfo[i]
    ) as string;
    await leadTeamChannel.send(message);
  }

  console.log(reassessingStudents);
}

export async function sendErrorNotification(message: string) {
  const adminTeamChannel = await fetchChannel("admin-team");

  // Check if the channels exists AND are text-based channels
  if (!adminTeamChannel) {
    console.error("Admin team channel not found.");
    return;
  }
  if (!adminTeamChannel.isTextBased() || !("send" in adminTeamChannel)) {
    console.error("Admin team channel cannot send messages.");
    return;
  }

  const today = new Date();
  const timezone = "America/Chicago";

  await adminTeamChannel.send(
    `**⚠️ Automation Error Notification - ${formatInTimeZone(today, timezone, "eee, MMM d")}**\n\n` +
      message,
  );
}
