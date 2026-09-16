const { MongoClient } = require("mongodb");
const axios = require("axios");
require("dotenv").config();

// ------------ CONFIGURATION ------------ //
const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "coverloop";

const LEAD_COLLECTION = "keshvadb";
const RESPONSE_COLLECTION = "brightloans_responses";

const API_BASE_URL = "https://partner-api-uat.brightloans.in/api/v1";
const ELIGIBILITY_URL = `${API_BASE_URL}/leads/check-eligibility`;
const API_KEY = "98669d80e0e34ead997250c308311b0ca483269d";
const LENDER_NAME = "brightloans";

// ------------ CONTROL CONFIG (High-Speed) ------------ //
const MAX_LEADS = 500000;
const BATCH_SIZE = 500;
const MAX_WORKERS = 15;
const REQUEST_TIMEOUT = 30000;
const BATCH_DELAY = 500;

// ---------------- LOGGING ---------------- //
function log(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - ${level} - ${message}`);
}

// ---------------- MONGO ---------------- //
let client;
let leadCol;
let responseCol;

async function connectMongo() {
  if (!MONGO_URI) {
    throw new Error("MONGO_URI_COVER is not defined in environment variables!");
  }
  client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  leadCol = db.collection(LEAD_COLLECTION);
  responseCol = db.collection(RESPONSE_COLLECTION);
  log("INFO", "✅ MongoDB Connected Successfully");
}

// ---------------- HELPERS ---------------- //
function formatDob(dob) {
  if (!dob) return "1998-05-15T00:00:00Z";
  if (dob instanceof Date && !isNaN(dob)) {
    return dob.toISOString();
  }
  if (typeof dob === "string") {
    dob = dob.trim();
    if (dob.includes("T")) return dob;
    const match = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return `${dob}T00:00:00Z`;
  }
  return "1998-05-15T00:00:00Z";
}

function calculateAge(dob) {
  const formattedDobStr = formatDob(dob);
  const parts = formattedDobStr.split("T")[0].split("-");
  if (parts.length !== 3) return null;

  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);

  const birthDate = new Date(year, month, day);
  if (isNaN(birthDate.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }

  return age;
}

function shouldSkip(lead) {
  const required = ["phone", "pan", "dob", "income", "employment", "pincode", "name"];
  for (const field of required) {
    if (!lead[field]) return "MISSING_REQUIRED_FIELD";
  }

  // 1. Age Check (24 to 56 years as per BrightLoans policy)
  const age = calculateAge(lead.dob);
  if (age === null || age < 24 || age > 56) return "OUT_OF_AGE_RANGE";

  // 2. Employment Validation (Salaried only)
  const emp = (lead.employment || "").trim().toLowerCase();
  if (emp !== "salaried") {
    return "INVALID_EMPLOYMENT_NOT_SALARIED";
  }

  // 3. Income Validation (>= 25000)
  const incomeVal = parseFloat(String(lead.income || "0").replace(/,/g, "").trim());
  if (isNaN(incomeVal) || incomeVal < 25000) return "LOW_INCOME";

  // 4. Mobile & PAN & Pincode regex validation
  const mobileStr = String(lead.phone || "").trim();
  if (!/^[6-9]\d{9}$/.test(mobileStr)) return "INVALID_MOBILE";

  const panStr = String(lead.pan || "").trim();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panStr)) return "INVALID_PAN";

  const pinStr = String(lead.pincode || "").trim();
  if (!/^[1-9][0-9]{5}$/.test(pinStr)) return "INVALID_PINCODE";

  // 5. Already Processed Check
  if (lead.processed && Array.isArray(lead.processed)) {
    const hasAlreadyProcessed = lead.processed.some(
      (lender) => String(lender).toLowerCase().startsWith(LENDER_NAME.toLowerCase())
    );
    if (hasAlreadyProcessed) return "ALREADY_PROCESSED";
  }

  return false;
}

// ---------------- WORKER ---------------- //
async function processLead(lead, headers) {
  const mobile = String(lead.phone || "").trim();
  const pancard = String(lead.pan || "").trim();

  const skipReason = shouldSkip(lead);
  if (skipReason) {
    if (skipReason === "ALREADY_PROCESSED") return false;
    log("WARN", `Skipping lead ${mobile} due to: ${skipReason}`);
    await leadCol.updateOne(
      { _id: lead._id },
      { $addToSet: { processed: `${LENDER_NAME}: skipped_${skipReason}` } }
    );
    return false;
  }

  log("INFO", `Processing lead for BrightLoans: ${mobile} / ${pancard}`);

  // Name parsing (First name and Last name required, alphabets only)
  const nameParts = (lead.name || "Customer").trim().replace(/[^a-zA-Z ]/g, "").split(/\s+/);
  const firstName = nameParts[0] || "Customer";
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join("") : firstName;

  const payload = {
    mobile: mobile,
    pancard: pancard,
    first_name: firstName.substring(0, 100),
    last_name: lastName.substring(0, 100),
    emp_type: "SALARIED",
    gender: (lead.gender || "MALE").toUpperCase() === "FEMALE" ? "FEMALE" : "MALE",
    monthly_income: parseFloat(String(lead.income).replace(/,/g, "")),
    empName: lead.companyName || lead.company || "Salaried Employee",
    dob: formatDob(lead.dob),
    personal_email: lead.email || "customer@example.com",
    pincode: String(lead.pincode).trim()
  };

  try {
    const res = await axios.post(ELIGIBILITY_URL, payload, {
      headers,
      timeout: REQUEST_TIMEOUT,
      validateStatus: () => true
    });

    const apiResponse = res.data || {};
    const isSuccess = res.status === 200 && apiResponse.success === true;

    await responseCol.insertOne({
      name: "Brightloans",
      response: apiResponse,
      phone: mobile,
      pan: pancard,
      status: isSuccess ? "SUCCESS" : "FAILED",
      createdAt: new Date().toISOString()
    });

    await leadCol.updateOne(
      { _id: lead._id },
      { $addToSet: { processed: LENDER_NAME } }
    );

    log("INFO", `Lead ${mobile} processed | Status: ${isSuccess ? "SUCCESS" : "FAILED"}`);
    return isSuccess;

  } catch (axiosError) {
    log("ERROR", `API Error for ${mobile}: ${axiosError.message}`);
    return false;
  }
}

// ---------------- CONCURRENCY HELPER ---------------- //
async function runWithConcurrencyLimit(items, limit, fn, headers) {
  let successCount = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) break;

      const currentItem = items[currentIndex];
      try {
        const success = await fn(currentItem, headers);
        if (success) successCount++;
      } catch (e) {
        log("ERROR", `Worker failed: ${e.message}`);
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return successCount;
}

// ---------------- MAIN PROCESS ---------------- //
async function processLeads() {
  log("INFO", "🔍 Fetching unprocessed leads from MongoDB for BrightLoans...");

  const query = {
    $or: [
      { processed: { $exists: false } },
      { processed: { $not: { $regex: /brightloans/i } } }
    ]
  };

  const cursor = leadCol.find(query).limit(MAX_LEADS);
  let total = 0;
  let processed = 0;
  let skipped = 0;
  
  let batch = [];
  let skippedBulkOps = [];

  const headers = {
    "Content-Type": "application/json",
    "api-key": API_KEY,
    "username": API_KEY
  };

  for await (const lead of cursor) {
    total++;
    const skipReason = shouldSkip(lead);

    if (skipReason) {
      if (skipReason === "ALREADY_PROCESSED") continue;
      skipped++;
      skippedBulkOps.push({
        updateOne: {
          filter: { _id: lead._id },
          update: { $addToSet: { processed: `${LENDER_NAME}: skipped_${skipReason}` } }
        }
      });

      if (skippedBulkOps.length >= BATCH_SIZE) {
        await leadCol.bulkWrite(skippedBulkOps);
        skippedBulkOps = [];
      }
      continue;
    }

    batch.push(lead);
    if (batch.length === BATCH_SIZE) {
      processed += await runWithConcurrencyLimit(batch, MAX_WORKERS, processLead, headers);
      batch = [];
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  if (batch.length) {
    processed += await runWithConcurrencyLimit(batch, MAX_WORKERS, processLead, headers);
  }

  if (skippedBulkOps.length > 0) {
    await leadCol.bulkWrite(skippedBulkOps);
  }

  log("INFO", "----- SUMMARY -----");
  log("INFO", `TOTAL SCANNED : ${total}`);
  log("INFO", `PROCESSED API : ${processed}`);
  log("INFO", `SKIPPED     : ${skipped}`);
}

async function main() {
  try {
    await connectMongo();
    await processLeads();
  } catch (err) {
    log("ERROR", `Fatal error: ${err.message}`);
  } finally {
    if (client) await client.close();
  }
}

main();