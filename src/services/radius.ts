import { config } from "dotenv";
import { dirname, join } from "path";
import type { Page } from "puppeteer";
import { fileURLToPath } from "url";
import { launchPuppeteer, pressKeyNTimes } from "./puppeteer.js";
import { writeSpreadsheetData } from "./googleSheets.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, "../../.env.local") });

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

export async function handleRadiusOperations() {
  const { browser, page } = await launchPuppeteer();
  await logIntoRadius(page);
  const checkedInStudents = await getCheckedInStudents(page);
  const enrolledStudents = await getEnrolledStudents(page);
  const assessmentInfo = await getAssessmentInfo(page, enrolledStudents);
  const { payments, totalExpected } = await getPayments(page);
  await browser.close();

  return {
    assessmentInfo,
    checkedInStudents,
    enrolledStudents,
    payments,
    totalExpected,
  };
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

      const isActiveLearningPlanFound = await page.$$eval(
        "#gridLearningPlan tr.k-master-row",
        (rows) => {
          const plans = rows
            .map((row) => {
              const createdDateText = row.cells[1]?.innerText.trim() || "";
              const createdDate = new Date(createdDateText);

              const activeCheckbox = row.cells[3]?.querySelector(
                'input[type="checkbox"]',
              ) as HTMLInputElement | null;

              return {
                row,
                name: row.cells[0]?.innerText.trim() || "",
                createdDate: createdDateText,
                createdDateValue: createdDate.getTime(),
                active: activeCheckbox?.checked ?? false,
              };
            })
            .filter((plan) => plan.active && !isNaN(plan.createdDateValue))
            .sort((a, b) => b.createdDateValue - a.createdDateValue);

          const latest = plans[0];

          if (!latest) {
            return false;
          }

          const viewButton = latest.row.querySelector(
            "a.k-grid-View",
          ) as HTMLElement | null;

          if (!viewButton) {
            return false;
          }

          viewButton.click();
          return true;
        },
      );

      if (isActiveLearningPlanFound) {
        // Wait for the Progress Check grid itself to appear
        await page.waitForSelector("#gridProgressChecks", {
          timeout: 30000,
        });

        // Then wait for the Progress Check rows to populate
        await page.waitForSelector("#gridProgressChecks tr.k-master-row", {
          timeout: 10000,
        });

        const mostRecentProgressCheck = await page.$$eval(
          "#gridProgressChecks tr.k-master-row",
          (rows) => {
            return (
              rows
                .map((row) => {
                  const dateText = row.cells[1]?.innerText.trim() || "";
                  const date = new Date(dateText);

                  return {
                    assessment: row.cells[0]?.innerText.trim() || "",
                    date: dateText,
                    dateValue: date.getTime(),
                    score: row.cells[3]?.innerText.trim() || "",
                  };
                })
                .filter((check) => !isNaN(check.dateValue))
                .sort((a, b) => b.dateValue - a.dateValue)[0] || null
            );
          },
        );

        if (mostRecentProgressCheck) {
          const mostRecentProgressCheckDate =
            mostRecentProgressCheck?.date || "";
          console.log(
            `${name}${name[name.length - 1] === "s" ? "'" : "'s"} Most Recent Assessment: ${mostRecentAssessmentDate}`,
          );
          await writeSpreadsheetData(
            "Instruction Scheduler",
            `Radius Students - HELPER!D${rowNum}`,
            [[mostRecentProgressCheckDate]],
            false,
          );
          console.log(
            `${name}${name[name.length - 1] === "s" ? "'" : "'s"} Most Recent Progress Check:`,
            mostRecentProgressCheck.date,
          );
        } else {
          console.log(`${name} - No progress checks found.`);
        }
      }
    } catch (error) {
      console.error(`Failed to get assessment data for ${name}`);
      continue; // Continue to the next student
    }
  }
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
