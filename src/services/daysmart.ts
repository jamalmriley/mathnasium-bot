import axios from "axios";
import { format, formatInTimeZone } from "date-fns-tz";
import { config } from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getSpreadsheetData } from "./googleSheets.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, "../../.env.local") });

export const [username, password] = [
  process.env.DAYSMART_SITE_ID!,
  process.env.DAYSMART_API_KEY!,
];

const daySmartClient = axios.create({
  baseURL: "https://ws.appointment-plus.com",
  auth: { username, password },
  params: {
    response_type: "JSON",
  },
  headers: {
    Accept: "application/json",
  },
});

interface Child {
  child_id: string;
  c_id: string;
  customer_id: string;
  first_name: string;
  last_name: string;
  middle_name: string;
  birth_date: string;
  notes: string;
  age: string;
}

interface DaySmartAppointment {
  c_id: string;
  appt_id: string;
  globalId: string;
  customer_id: string;
  account: string;
  last_name: string;
  first_name: string;
  middle_name: string;
  email: string;
  employee_id: string;
  staff_screen_name: string;
  staff_type_id: string;
  pet_id: string;
  room_id: null;
  date: string;
  start_time: number;
  end_time: number;
  service_id: string;
  service: string;
  event_template_id: null;
  customer_notes: string;
  employee_notes: string;
  status_id: string;
  appt_status_description: string;
  rep_id: string;
  cost: string;
  tip: string;
  payment_type_id: string;
  coupon_id: string;
  coupon_code: string;
  type_id: string;
  spots: string;
  recur_id: string;
  reason: string;
  createTimestamp: string;
  creation_emp_id: string;
  lastUpdateTimestamp: string;
  last_emp_id: string;
  customer_package_id: string;
  duration_id: string;
  link_id: string;
  location_id: string;
  appt_status_type: string;
  lead_description: null;
  service_time_description: null;
  po_number: null;
  creation_timestamp: string;
  last_timestamp: string;
  action_link_url: string;
  time_zone: Object[];
}

interface ScheduleExceptionResponse {
  resource: string;
  action: string;
  request: string;
  result: "success" | "fail";
  count: number;
  errors?: string[];
  data: any;
}

export async function getStudentAppointments() {
  const header = [
    "Child",
    "Appointment Date",
    "Duration",
    "Start Time",
    "Service",
    "Calendar (screen name)",
    "Appointment Status",
  ];

  const now = new Date();
  const startOfMonth = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 7,
  );
  const endOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 0);

  const start_date = formatInTimeZone(
    startOfMonth,
    "America/Chicago",
    "yyyyMMdd",
  );
  const end_date = formatInTimeZone(
    endOfNextMonth,
    "America/Chicago",
    "yyyyMMdd",
  );

  console.log("Gathering student appointments...");

  const request = await daySmartClient.request({
    method: "POST",
    url: "/Appointments/GetAppointments",
    params: { start_date, end_date },
  });

  const response = request.data;
  const appointments = (await response.data) as DaySmartAppointment[];

  if (appointments.length === 0) {
    console.log("No scheduled sessions in this time range.");
    return [header];
  } else
    await console.log(
      appointments.length,
      appointments.length === 1 ? "appointment found." : "appointments found.",
    );

  function formatDate(dateStr: string) {
    if (!dateStr || dateStr.length !== 8) return "Invalid Date";

    const year = dateStr.slice(0, 4);
    const month = dateStr.slice(4, 6);
    const day = dateStr.slice(6, 8);

    return `${month}/${day}/${year}`;
  }

  function formatDuration(start: number, end: number): string {
    const totalMinutes = end - start;

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours === 0) {
      return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }

    if (minutes === 0) {
      return `${hours} hour${hours === 1 ? "" : "s"}`;
    }

    return `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  function formatTime(minutesSinceMidnight: number): string {
    const hours = Math.floor(minutesSinceMidnight / 60);
    const minutes = minutesSinceMidnight % 60;

    return new Date(0, 0, 0, hours, minutes).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  async function formatAppointments(appointments: DaySmartAppointment[]) {
    const result = [header];

    for (const appointment of appointments) {
      const {
        customer_id,
        date,
        pet_id,
        start_time,
        end_time,
        service,
        staff_screen_name,
        appt_status_description,
      } = appointment;

      const request = await daySmartClient.request({
        method: "POST",
        url: "/Customers/GetChildren",
        params: {
          customer_id,
          child_id: pet_id,
        },
      });

      const response = request.data;
      const child = (await response.data[0]) as Child;

      const formattedAppointment = [
        `${child.first_name} ${child.last_name}`.trim(),
        formatDate(date),
        formatDuration(start_time, end_time),
        formatTime(start_time),
        service,
        staff_screen_name,
        appt_status_description,
      ];

      result.push(formattedAppointment);
    }

    return result;
  }

  const result = await formatAppointments(appointments);
  console.log(
    `${result.length - 1} ${result.length - 1 === 1 ? "appointment" : "appointments"} successfully formatted.`,
  );
  return result;
}

export async function createScheduleExceptions() {
  const [c_id, employee_id] = [
    parseInt(process.env.DAYSMART_C_ID!),
    parseInt(process.env.DAYSMART_IN_CENTER_EMPLOYEE_ID!),
  ];

  function timeToMinutes(timeStr: string): number {
    // Regex to extract hours, minutes, and the AM/PM modifier
    const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);

    if (!match) {
      throw new Error("Invalid time format. Expected 'HH:MM AM/PM'");
    }

    const hoursStr = match[1] as string;
    const minutesStr = match[2] as string;
    const periodStr = match[3] as string;

    let hours = parseInt(hoursStr);
    const minutes = parseInt(minutesStr);
    const period = periodStr.toUpperCase();

    // Validate range bounds
    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) {
      throw new Error("Invalid hours or minutes range");
    }

    // Convert 12-hour format to 24-hour underlying hours
    if (period === "AM" && hours === 12) {
      hours = 0; // 12:00 AM is midnight (0 hours)
    } else if (period === "PM" && hours !== 12) {
      hours += 12; // Add 12 hours for PM times, except 12:00 PM
    }

    return hours * 60 + minutes;
  }

  // Read Google spreadsheet
  try {
    const scheduleExceptionsListData = await getSpreadsheetData(
      "Instruction Scheduler",
      "'DaySmart (Schedule Exceptions) - HELPER 2'!E2:H",
    );

    await console.log("um", scheduleExceptionsListData);

    if (scheduleExceptionsListData.length > 0) {
      // Iterate through each row
      for (const row of scheduleExceptionsListData) {
        const [date, start_time, end_time, spots] = [
          format(row[0] as string, "yyyyMMdd"),
          timeToMinutes(row[1] as string),
          timeToMinutes(row[2] as string),
          parseInt(row[3] || ""),
        ];

        // Delete past schedule exception (if any)
        const deleteReq = await daySmartClient.request({
          method: "POST",
          url: "/Staff/DeleteScheduleExceptions",
          params: {
            c_id,
            date,
            employee_id,
            end_time,
            response_type: "json",
            start_time,
          },
        });
        const deleteRes = (await deleteReq.data) as ScheduleExceptionResponse;
        // console.log(deleteRes);
        if (deleteRes.errors) {
          if (
            deleteRes.errors[0] ===
            "Specified schedule exception does not exist or has already been deleted."
          )
            console.log(`${row[0]} at ${row[1]}: No spots to delete`);
          else if (deleteRes.result === "fail")
            console.log("Error deleting schedule exception", deleteRes);
        } else console.log(`${row[0]} at ${row[1]}: Spots deleted`);

        // Create schedule exception
        const createReq = await daySmartClient.request({
          method: "POST",
          url: "/Staff/CreateScheduleExceptions",
          params: {
            c_id,
            date,
            employee_id,
            end_time,
            response_type: "json",
            spots,
            start_time,
          },
        });

        // Log response
        const createRes = (await createReq.data) as ScheduleExceptionResponse;
        if (createRes.result === "fail")
          console.log("Error creating schedule exception", createRes);
        else console.log(`${row[0]} at ${row[1]}: Spots updated to ${spots}`);
      }
    } else {
      console.log("Success: No spots to update in DaySmart.");
    }
  } catch (err: any) {
    console.log(`Error: ${err.message}`);
  }
}
