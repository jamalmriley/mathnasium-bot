import { format } from "date-fns-tz";
import { config } from "dotenv";
import { dirname, join } from "path";
import type { Page } from "puppeteer";
import { fileURLToPath } from "url";
import { dollarFormatter } from "../utils.js";
import { writeSpreadsheetData } from "./googleSheets.js";
import { launchPuppeteer, pressKeyNTimes } from "./puppeteer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, "../../.env.local") });

interface WeekBounds {
  sunday: Date;
  saturday: Date;
}

export async function logIntoRadius(page: Page) {
  const [username, password] = [
    process.env.RADIUS_USER,
    process.env.RADIUS_PWD,
  ];

  if (!username || !password) {
    throw new Error("RADIUS_USER and RADIUS_PWD must be set in .env.local");
  }

  await console.log("Logging into Radius...");
  await page.goto("https://radius.mathnasium.com/Account/Login");
  let url = page.url();
  while (url.includes("Login")) {
    await page.type("#UserName", username);
    await page.type("#Password", password);
    await Promise.all([page.click("#login"), page.waitForNavigation()]);
    url = page.url();
  }
  await console.log(`Logged into Radius as ${username}`);
}

export async function handleInstantRadiusOperations() {
  const { browser, page } = await launchPuppeteer();
  await logIntoRadius(page);
  const checkedInStudents = await getCheckedInStudents(page);
  const enrolledStudents = await getEnrolledStudents(page);

  // await clearSpreadsheetData(
  //   "Instruction Scheduler",
  //   "Radius Students - HELPER!A2:B",
  // );
  // await writeSpreadsheetData(
  //   "Instruction Scheduler",
  //   "Radius Students - HELPER!A2:B",
  //   enrolledStudents,
  // );

  const { payments, totalExpected } = await getPayments(page);
  await browser.close();

  return {
    checkedInStudents,
    enrolledStudents,
    payments,
    totalExpected,
  };
}

export async function handleDelayedRadiusOperations() {
  const { browser, page } = await launchPuppeteer();
  await logIntoRadius(page);
  const enrolledStudents = await getEnrolledStudents(page);
  await getAssessmentInfo(page, enrolledStudents);
  const successfulPaymentAttemptsList = await retryFailedPayments(page);
  await browser.close();
  return { successfulPaymentAttemptsList };
}

export async function handleWeeklyRadiusOperations() {
  const { browser, page } = await launchPuppeteer();
  await logIntoRadius(page);
  const birthdays = await getStudentBirthdays(page);
  const cardsExpiringList = await getExpiringCards(page);
  const nonAttendingStudents = await getAttendanceData(page);

  await browser.close();
  return { birthdays, cardsExpiringList, nonAttendingStudents };
}

// —————————————————————————————————————————————————— //

interface ProgressCheck {
  ProgressCheckId: number;
  StudentId: number;
  StudentName: string | null;
  IsGroup: boolean;
  DateTaken: string;
  DateEntered: string;
  StaticPercent: number;
  DateTakenString: string;
  DateEnteredString: string;
}

const LATE_FEE = 35;

export async function getAssessmentInfo(
  page: Page,
  students: [string, string][],
) {
  await console.log(
    "Gathering student assessment info. This will take a while...",
  );
  for (let i = 0; i < students.length; i++) {
    const student = students[i];
    if (!student) continue;

    const name = student[0];
    const href = student[1];

    try {
      await page.goto(`${href}#assessmentGrid`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForSelector("#assessmentGrid tr.k-master-row", {
        timeout: 30000,
      });

      const mostRecentAssessment = await page.$$eval(
        "tr.k-master-row",
        (rows) => {
          return (
            rows
              .map((row) => {
                const dateText = row.cells[3]?.innerText.trim() || "";
                const date = new Date(dateText);

                return {
                  title: row.cells[1]?.innerText.trim() || "",
                  date: dateText,
                  dateValue: date.getTime(),
                  level: row.cells[4]?.innerText.trim() || "",
                  score: row.cells[11]?.innerText.trim() || "",
                  resultsHref: row.cells[12]?.querySelector("a")?.href || "",
                };
              })
              .filter((assessment) => !isNaN(assessment.dateValue))
              .sort((a, b) => b.dateValue - a.dateValue)[0] || null
          );
        },
      );

      const mostRecentAssessmentDate = mostRecentAssessment?.date || "";
      const row = [name, href, mostRecentAssessmentDate];
      const rowNum = i + 2;
      console.log(
        `${name}${name[name.length - 1] === "s" ? "'" : "'s"} Most Recent Assessment: ${mostRecentAssessmentDate}`,
      );

      await writeSpreadsheetData(
        "Instruction Scheduler",
        `Radius Students - HELPER!A${rowNum}:C${rowNum}`,
        [row],
        false,
      );

      await page.goto(href, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForSelector("#gridLearningPlan tr.k-master-row", {
        timeout: 30000,
      });

      await pressKeyNTimes(page, "Tab", 7);
      await page.keyboard.press("Enter");

      const latestActivePlanRowIndex = await page.$$eval(
        "#gridLearningPlan tr.k-master-row",
        (rows) => {
          const plans = rows
            .map((row, rowIndex) => {
              const createdDateText = row.cells[1]?.innerText.trim() || "";
              const createdDate = new Date(createdDateText);

              const activeCheckbox = row.cells[3]?.querySelector(
                'input[type="checkbox"]',
              ) as HTMLInputElement | null;

              return {
                rowIndex,
                createdDateValue: createdDate.getTime(),
                active: activeCheckbox?.checked ?? false,
                hasViewButton: !!row.querySelector("a.k-grid-View"),
              };
            })
            .filter(
              (plan) =>
                plan.active &&
                !isNaN(plan.createdDateValue) &&
                plan.hasViewButton,
            )
            .sort((a, b) => b.createdDateValue - a.createdDateValue);

          return plans[0]?.rowIndex ?? -1;
        },
      );

      if (latestActivePlanRowIndex !== -1) {
        const rows = await page.$$("#gridLearningPlan tr.k-master-row");

        const viewButton = rows[latestActivePlanRowIndex]
          ? await rows[latestActivePlanRowIndex].$("a.k-grid-View")
          : null;

        if (!viewButton) {
          console.log(`${name} - Could not find the "View" button.`);
          continue;
        }

        // Start listening BEFORE clicking to avoid missing the response.
        const progressCheckResponsePromise = page.waitForResponse(
          (response) => {
            const url = new URL(response.url());

            return (
              url.pathname === "/ProgressCheck/ProgressCheck_Read" &&
              url.searchParams.has("learningPlanId") &&
              response.request().method() === "POST" &&
              response.status() === 200
            );
          },
          { timeout: 10000 },
        );

        await viewButton.click();

        try {
          const response = await progressCheckResponsePromise;

          const result = (await response.json()) as {
            Data?: ProgressCheck[];
            Total?: number;
            Errors?: unknown;
          };

          if (result.Errors) {
            console.error(
              `${name} - Error retrieving progress checks:`,
              result.Errors,
            );
          } else {
            const progressCheckCount = result.Data?.length ?? 0;

            if (result.Data && progressCheckCount > 0) {
              const progressCheckData = result.Data[0];
              const mostRecentAssessmentDate =
                progressCheckData?.DateTakenString || "";

              console.log(
                `${name}${name[name.length - 1] === "s" ? "'" : "'s"} Most Recent Progress Check: ${mostRecentAssessmentDate}`,
              );

              await writeSpreadsheetData(
                "Instruction Scheduler",
                `Radius Students - HELPER!D${rowNum}`,
                [[mostRecentAssessmentDate]],
                false,
              );
            } else {
              console.log(`${name} - No progress checks found.`);
            }
          }
        } catch (error) {
          console.error(
            `${name} - Progress checks failed to load or timed out.`,
            error,
          );
        }
      } else {
        console.log(`${name} - No active learning plan found.`);
      }
    } catch (error) {
      console.error(`Failed to get assessment data for ${name}`);
      continue; // Continue to the next student
    }
  }
}

export async function getCheckedInStudents(page: Page): Promise<string> {
  await console.log("Searching checked-in students...");
  await page.goto("https://radius.mathnasium.com/Attendance/Roster");
  await page.waitForSelector("tr.k-master-row");
  await page.click("#btnsearch");

  const checkedInStudents = await page
    .$$eval("tr.k-master-row", (rows) => {
      return rows.map((row) => {
        const cells = Array.from(row.cells);
        return cells.map((cell) => cell.innerText);
      });
    })
    .then(
      (students) =>
        students
          .filter((row) => row[4] === "true") // Filter for checked-in students
          .map((row, i) => `${i + 1}. ${[row[7], row[8]].join(" ")}`.trim()), // Display only first and last name
    );

  const studentList =
    checkedInStudents.length > 0
      ? `**The following students are not checked out in Radius:**\n` +
        checkedInStudents.join("\n")
      : "All students have been checked out in Radius!";

  // await console.log(studentList);
  return studentList;
}

export async function getEnrolledStudents(
  page: Page,
): Promise<[string, string][]> {
  await console.log("Searching enrolled students...");
  await page.goto("https://radius.mathnasium.com/Student");

  await pressKeyNTimes(page, "Tab", 2);
  await page.keyboard.type("Enrolled", { delay: 100 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("tr.k-master-row");

  const clicksPerRow = 3;
  const studentCountText = await page.$$eval(
    "span.k-pager-info.k-label",
    (spans) => spans.at(-1)?.textContent?.trim() ?? "",
  );
  const studentCount = parseInt(studentCountText.split(" of ")[1] ?? "100"); // "1 - 84 of 84" -> 84

  if (studentCount > 100) {
    await pressKeyNTimes(
      page,
      "Tab",
      Math.min(studentCount, 100) * clicksPerRow + 19,
    );

    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    await pressKeyNTimes(page, "ArrowDown", 3);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelectorAll("tr.k-master-row").length > 100,
    );
  }

  const enrolledStudents = await page
    .$$eval("tr.k-master-row", (rows) => {
      return rows.map((row) => {
        const cells = Array.from(row.cells);

        return cells.map((cell) => {
          const link = cell.querySelector("a");

          return {
            text: cell.innerText.trim(),
            href: link?.href || "",
          };
        });
      });
    })
    .then((students) =>
      students
        .map((row): [string, string] => {
          const firstName = row[0]?.text || "";
          const lastName = row[1]?.text || "";

          // Use the href from whichever cell contains it
          const href = row[0]?.href || row[1]?.href || "";

          const name = `${firstName} ${lastName}`.trim();

          return [name, href];
        })
        .sort((a, b) => a[0].localeCompare(b[0]))
        .filter(([name]) => name !== ""),
    );

  console.log(
    `${enrolledStudents.length} ${enrolledStudents.length === 1 ? "student" : "students"} found.`,
  );
  return enrolledStudents;
}

export async function getExpiringCards(page: Page): Promise<string> {
  await console.log("Gathering expiring cards...");
  await page.goto("https://radius.mathnasium.com/BillingExceptionsReport");

  const currYear = new Date().getFullYear();

  await pressKeyNTimes(page, "Tab", 8);
  await page.keyboard.type("Expiring cards", { delay: 100 });
  await page.keyboard.press("Enter");
  await pressKeyNTimes(page, "Tab", 2);
  await page.keyboard.type(`January ${currYear}`, { delay: 100 });
  await pressKeyNTimes(page, "Tab", 2);
  await page.keyboard.type("Active", { delay: 100 });
  await pressKeyNTimes(page, "Tab", 2);
  await page.keyboard.press("Enter");
  await page.waitForSelector("tr.k-master-row");

  const cardsExpiring = await page.$$eval("tr.k-master-row", (rows) => {
    return rows.map((row, i) => {
      const cardDetails: string[] = row.cells[2]?.innerText.split("\n") || [];
      const accountLink = row.cells[3]?.querySelector("a")?.href;

      const [cardholder, last4Digits, expiration] = [
        cardDetails[0],
        cardDetails[1] ? cardDetails[1].replace(/\D/g, "") : "0000",
        cardDetails[2] ? cardDetails[2].replace(/Expiration: /i, "") : "MM/DD",
      ];
      return `${i + 1}. [${cardholder}](${accountLink}): Card ending in ${last4Digits} expires on ${expiration}`.trim();
    });
  });

  const cardsExpiringList =
    cardsExpiring.length > 0
      ? `**The following credit/debit cards have upcoming or past expiration dates:**\n` +
        cardsExpiring.join("\n") +
        `\n\nPlease contact these guardians ASAP to capture new payment information.`
      : "There are no credit/debit cards with upcoming or past expiration dates.";

  console.log(cardsExpiringList);
  return cardsExpiringList;
}

export async function getPayments(page: Page) {
  await console.log("Gathering payment information...");
  await page.goto("https://radius.mathnasium.com/Payment");

  const currYear = new Date().getFullYear();

  await pressKeyNTimes(page, "Tab", 10);
  await page.keyboard.type(`01/01/${currYear}`, { delay: 100 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("tr.k-master-row");

  const payments = await page
    .$$eval("tr.k-master-row", (rows) => {
      return rows.map((row) => {
        const cells = Array.from(row.cells);
        return cells.map((cell) => cell.innerText);
      });
    })
    .then((payments) =>
      payments
        .map((row) => {
          const rawAmtExpected = row[15] ?? "0";
          const rawAmtPaid = row[16] ?? "0";

          // Check for parentheses, strip them, and add a minus sign if found
          const normalizedAmtExpected = /^\(.*\)$/.test(rawAmtExpected)
            ? `-${rawAmtExpected.replace(/[()]/g, "")}`
            : rawAmtExpected;
          const normalizedAmtPaid = /^\(.*\)$/.test(rawAmtPaid)
            ? `-${rawAmtPaid.replace(/[()]/g, "")}`
            : rawAmtPaid;

          return [
            row[2], // Account status
            row[3]?.split(", ").reverse().join(" "), // Account name
            row[5]?.split("\n").filter((str) => str !== ""), // Student name(s)
            row[9], // Payment status
            new Date(row[10] ?? ""), // Billing date
            parseFloat(normalizedAmtExpected.replace(/[^0-9.-]/g, "")), // Amount expected
            parseFloat(normalizedAmtPaid.replace(/[^0-9.-]/g, "")), // Amount paid
          ];
        })
        .filter(
          (row) =>
            row[3] !== "Unpaid" &&
            row[3] !== "Paid in Full" &&
            row[3] !== "Failed Then Paid In Full" &&
            row[3] !== "Payment Pending",
        ) // Filter out paid and future invoices
        .sort((a, b) => {
          const timeA =
            a[4] instanceof Date && !isNaN(a[4].getTime()) ? a[4].getTime() : 0;
          const timeB =
            b[4] instanceof Date && !isNaN(b[4].getTime()) ? b[4].getTime() : 0;

          return timeA - timeB;
        }),
    );

  const totalExpected = payments.reduce((total, row) => {
    const amtExpected = row[5] as number; //
    return total + amtExpected;
  }, 0);

  console.log(
    `${payments.length - 1} ${payments.length - 1 === 1 ? "payment" : "payments"} found.`,
  );
  return { payments, totalExpected };
}

export async function getStudentBirthdays(page: Page): Promise<string> {
  function getCurrentWeekBounds(today: Date = new Date()): WeekBounds {
    // Get the current day of the week (0 for Sunday, 6 for Saturday)
    const currentDayIndex = today.getDay();

    // Calculate Sunday by subtracting the current day index from today's date
    const sunday = new Date(today);
    sunday.setDate(today.getDate() - currentDayIndex);
    sunday.setHours(0, 0, 0, 0);

    // Calculate Saturday by adding the remaining days of the week
    const saturday = new Date(sunday);
    saturday.setDate(sunday.getDate() + 6);
    saturday.setHours(23, 59, 59, 999);

    return { sunday, saturday };
  }
  const today = new Date();

  await console.log("Searching student birthdays...");
  await page.goto("https://radius.mathnasium.com/BirthdayReport");
  await pressKeyNTimes(page, "Tab", 9);
  await page.keyboard.type("Accounts", { delay: 100 }); // Type "Accounts" instead of "Accounts Only" to avoid the space
  await page.keyboard.press("Tab");
  await page.keyboard.type("Enrolled", { delay: 100 });
  await pressKeyNTimes(page, "Tab", 3);
  await page.keyboard.press("Enter");
  await page.waitForSelector("tr.k-master-row");

  const studentBirthdays = await page
    .$$eval("tr.k-master-row", (rows) => {
      return rows.map((row) => {
        const cells = Array.from(row.cells);
        return cells.map((cell) => cell.innerText);
      });
    })
    .then((students) =>
      students
        .sort((a, b) => {
          const birthdayA = new Date(a[2] || "");
          birthdayA.setFullYear(today.getFullYear());

          const birthdayB = new Date(b[2] || "");
          birthdayB.setFullYear(today.getFullYear());

          return birthdayA.getTime() - birthdayB.getTime();
        })
        .filter((row) => {
          const birthday = new Date(row[2] || "");
          birthday.setFullYear(today.getFullYear());
          const { sunday, saturday } = getCurrentWeekBounds(today);
          return birthday >= sunday && birthday <= saturday;
        }) // Filter for only students with birthdays this week
        .map((row, i) => {
          const dob = new Date(row[2] || "");
          const birthday = new Date(row[2] || "");
          birthday.setFullYear(today.getFullYear());
          const age = birthday.getFullYear() - dob.getFullYear();
          return `${i + 1}. ${[row[0], row[1]].join(" ")} turns ${age} on ${format(birthday, "eee, MMM d")}!`.trim();
        }),
    );

  const studentList =
    studentBirthdays.length > 0
      ? `**The following students have birthdays this week:**\n` +
        studentBirthdays.join("\n") +
        `\n\nIf you see these students, please wish them a birthday that's as sweet as π, even > than the last, and filled with ∞ possibilities!`
      : "There are no upcoming student birthdays this week.";

  console.log(studentList);
  return studentList;
}

export async function getAttendanceData(page: Page) {
  await console.log("Gathering attendance information...");

  let timeRange = 14;
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - timeRange);
  const startDateFormatted = format(startDate, "MM/dd/yyyy");

  await page.goto(
    "https://radius.mathnasium.com/StudentAttendanceMonthlyReport",
  );
  await page.click("#switch_right");
  await pressKeyNTimes(page, "Tab", 4);
  await page.keyboard.type(startDateFormatted, { delay: 100 });
  await pressKeyNTimes(page, "Tab", 8);
  await page.keyboard.press("Enter");
  await page.waitForSelector("tr.k-master-row");

  const clicksPerRow = 2;
  const studentCountText = await page.$$eval(
    "span.k-pager-info.k-label",
    (spans) => spans.at(-1)?.textContent?.trim() ?? "",
  );
  const studentCount = parseInt(studentCountText.split(" of ")[1] ?? "100"); // "1 - 84 of 84" -> 84

  if (studentCount > 100) {
    await pressKeyNTimes(
      page,
      "Tab",
      Math.min(studentCount, 100) * clicksPerRow + 9,
    );

    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    await pressKeyNTimes(page, "ArrowDown", 3);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelectorAll("tr.k-master-row").length > 100,
    );
  }

  const students = await page
    .$$eval("tr.k-master-row", (rows) => {
      return rows.map((row) => {
        const cells = Array.from(row.cells);
        return cells.map((cell) => cell.innerText);
      });
    })
    .then(
      (students) =>
        students
          .filter((row) => {
            const studentExceptions = ["KING HS"];
            const fullName = [row[1], row[2]].join(" ").trim();
            const sessionCount = parseInt(row[6] ?? "");

            return sessionCount === 0 && !studentExceptions.includes(fullName);
          }) // Filter out fake students and students who've attended at least once.
          .map((row, i) => {
            const link = `https://radius.mathnasium.com/Student/Details/${row[0]}`;
            const fullName = [row[1], row[2]].join(" ").trim();
            return `${i + 1}. [${fullName}](${link})`;
          }), // Display only first and last name
    );

  console.log(
    `${students.length} ${students.length === 1 ? "student" : "students"} have not attended in the last ${timeRange} day${timeRange === 1 ? "" : "s"}.`,
  );
  return students;
}

export async function retryFailedPayments(page: Page): Promise<string> {
  await console.log("Retrying failed card payments...");

  const paymentAttempts: string[] = [];

  await page.goto("https://radius.mathnasium.com/BillingExceptionsReport");
  await pressKeyNTimes(page, "Tab", 8);
  await page.keyboard.type("Accounts with past due invoices", { delay: 100 });
  await page.keyboard.press("Enter");
  await pressKeyNTimes(page, "Tab", 4);
  await page.keyboard.type("Active", { delay: 100 });
  await pressKeyNTimes(page, "Tab", 2);
  await page.keyboard.press("Enter");
  await page.waitForSelector("tr.k-master-row");

  // Get all failed payment methods this month
  const failedPayments = await page.$$eval("tr.k-master-row", (rows) => {
    return rows.map((row, i) => {
      const paymentDetails: string[] =
        row.cells[2]?.innerText.split("\n") || [];
      const accountName = row.cells[3]?.innerText;
      const accountLink = row.cells[3]?.querySelector("a")?.href;
      const invoicesLink = accountLink?.replace(
        /Details\//,
        "ManageInvoices?accountId=",
      );
      const paymentMethodLink = accountLink?.replace(
        /Details/,
        "PaymentMethods",
      );

      const [invoice, date, amount, status] = [
        paymentDetails[0]
          ? paymentDetails[0].replace(/Invoice: /i, "")
          : "########",
        paymentDetails[1] ? paymentDetails[1].replace(/Date: /i, "") : "M/D/YY",
        paymentDetails[2]
          ? parseInt(paymentDetails[2].replace(/\D/g, "")) / 100
          : 0,
        paymentDetails[3] ? paymentDetails[3].replace(/Status: /i, "") : "N/A",
      ];
      return {
        invoice,
        date,
        amount,
        status,
        accountName,
        accountLink,
        invoicesLink,
        paymentMethodLink,
      };
    });
  });

  // Go through each failed payment
  for (let i = 0; i < failedPayments.length; i++) {
    const payment = failedPayments[i];
    if (!payment) continue;

    const { accountName, amount, invoicesLink, paymentMethodLink } = payment;
    if (!paymentMethodLink || !invoicesLink) continue;

    await page.goto(paymentMethodLink);
    await page.waitForSelector("tr.k-master-row");

    // Determine if the active payment method is a card.
    const activePaymentMethodRow = await page.$(
      '#gridCPM tr.k-master-row:has(img[src*="Check_mark.png"])',
    );

    if (activePaymentMethodRow) {
      // Get the payment method.
      const paymentMethod = await activePaymentMethodRow.evaluate(
        (row) => row.cells[2]?.innerText.trim() || "",
      );

      // If it is a card, do something. Otherwise, continue.
      if (
        paymentMethod.toLowerCase().includes("credit") ||
        paymentMethod.toLowerCase().includes("debit")
      ) {
        // Run a one-time payment
        console.log(
          `${accountName}: Retrying payment of ${dollarFormatter.format(amount + LATE_FEE)} (${dollarFormatter.format(amount)} + ${dollarFormatter.format(LATE_FEE)} late fee) with card ending in ${paymentMethod.replace(/\D/g, "")}`,
        );

        await page.goto(invoicesLink);
        await pressKeyNTimes(page, "Tab", 9);
        await page.keyboard.press("Enter");
        await page.waitForSelector("#miscPmntRadio", {
          timeout: 30000,
        });
        await page.click("#miscPmntRadio");
        await pressKeyNTimes(page, "Tab", 2);
        await page.keyboard.press("Delete");
        await page.keyboard.type(String(amount), { delay: 100 });
        await page.keyboard.press("Tab");
        await page.keyboard.type(
          `Past due balance with ${dollarFormatter.format(LATE_FEE)} late fee`,
          { delay: 100 },
        );
        // await page.keyboard.press("Tab");
        // await page.keyboard.press("Enter");

        const successMessage =
          `${i + 1}. ${accountName}` +
          `\n  * ${dollarFormatter.format(amount + LATE_FEE)} (${dollarFormatter.format(amount)} + ${dollarFormatter.format(LATE_FEE)} late fee)` +
          `\n  * Card ending in ${paymentMethod.replace(/\D/g, "")}`;
        // console.log(successMessage);
        paymentAttempts.push(successMessage);
      } else {
        console.log(
          `${accountName}: Active payment method — ${paymentMethod} — is not a card. Continuing...`,
        );
      }
    } else {
      console.log("No active payment method found.");
    }
  }

  const successfulPaymentAttemptsList =
    paymentAttempts.length > 0
      ? `**The following failed payments have been re-attempted:**\n` +
        paymentAttempts.join("\n") +
        `\n\nAccount invoices and the Payment Reconciliation dashboard can be used to check the status of the payment attempt.`
      : "There are no failed payments to re-attempt.";

  console.log(successfulPaymentAttemptsList);
  return successfulPaymentAttemptsList;
}
