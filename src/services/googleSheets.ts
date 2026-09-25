import { config } from "dotenv";
import { google } from "googleapis";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { sendErrorNotification } from "./discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, "../../.env.local") });

const spreadsheets = new Map([
  ["Instruction Scheduler", "1TKA8M9LQciU_NjYczRDpWzhBAYeVFEPPSvhs3UBY4tg"],
] as const);

type SpreadsheetName = Parameters<typeof spreadsheets.get>[0];

const credentials = JSON.parse(
  process.env.GOOGLE_CREDENTIALS ??
    (() => {
      throw new Error("GOOGLE_CREDENTIALS is not set");
    })(),
);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

export async function getSpreadsheetData(
  spreadsheetName: SpreadsheetName,
  range: string,
): Promise<string[][]> {
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = spreadsheets.get(spreadsheetName);
  if (!spreadsheetId) {
    throw new Error(`Spreadsheet with name "${spreadsheetName}" not found.`);
  }
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  if (!res.data.values) {
    throw new Error("No data found in the specified range.");
  }
  return res.data.values;
}

export async function writeSpreadsheetData(
  spreadsheetName: SpreadsheetName,
  range: string,
  values: string[][],
  displayLog: boolean = true,
): Promise<void> {
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = spreadsheets.get(spreadsheetName);
  if (!spreadsheetId) {
    throw new Error(`Spreadsheet with name "${spreadsheetName}" not found.`);
  }

  // Clear the existing contents
  await sheets.spreadsheets.values
    .clear({
      spreadsheetId,
      range,
    })
    .then(() => {
      if (displayLog)
        console.log(
          `${spreadsheetName} - ${range}: Range successfully cleared.`,
        );
    })
    .catch((err) => {
      console.error(err);
    });

  // Write the new values
  await sheets.spreadsheets.values
    .update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED", // or "RAW"
      requestBody: {
        values,
      },
    })
    .then(() => {
      if (displayLog)
        console.log(
          `${spreadsheetName} - ${range}: Range successfully updated.`,
        );
    })
    .catch((err) => {
      console.error(err);
      sendErrorNotification(err);
    });
}

export async function getStudentList(status: string): Promise<string> {
  const data = await getSpreadsheetData(
    "Instruction Scheduler",
    "Admin View!O2:AB77",
  );
  const headers = data[0];

  if (!headers) {
    throw new Error(
      "Expected the first row to contain headers, but it was empty.",
    );
  }

  const studentNameColNum = headers.indexOf("Student Name");
  const timeColNum = headers.indexOf("Time");
  const statusColNum = headers.indexOf("Status");

  const filteredData = data.filter(
    (row, i) =>
      i > 0 && row[studentNameColNum] !== "" && row[statusColNum] === status,
  );
  const studentList =
    `**${status} Students**\n` +
    filteredData
      .map(
        (row, i) =>
          `${i + 1}. ${[row[studentNameColNum], `*(${row[timeColNum]})*`].join(" ")}`,
      )
      .join("\n");

  return filteredData.length > 0
    ? studentList
    : `No ${status.toLowerCase()} students today!`;
}
