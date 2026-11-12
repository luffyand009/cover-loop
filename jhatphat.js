const { MongoClient } = require("mongodb");
const axios = require("axios");
const path = require("path");
const XLSX = require("xlsx");
require("dotenv").config();

// ================= 1. CONFIGURATION =================
const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "coverloop"; // Aapke template ke mutabik database name

const LEAD_COLLECTION = "payme";
const RESPONSE_COLLECTION = "jhatphat_response";

const BASE_URL = 'https://apilm.jhatpatcash.com/api/v1/marketplace/covermantra';
const AUTH_HEADER = 'cGtfMkQ0QkZBQzA2MUQwRUEwMUI1NTA0NjBFQjg5NUIxQTQ6c2tfMjNhYzBiZjI4OTEzYmMzZGY0OTliMjcxYzlhNGE2YTg5NWE3MmI2OTNhZTk1ZDI4NTkyNDA4ZWIwNWQ1MTdjZA==';
const LENDER_NAME = "covermantra_marketplace";

const PINCODE_FILE_PATH = path.join(__dirname, "xlsx", "jhatphat.xlsx");

// ------------ CONTROL ------------ //
const MAX_LEADS = 1000;
const BATCH_SIZE = 10;
const MAX_WORKERS = 7;
const REQUEST_TIMEOUT = 30000; // ms
const BATCH_DELAY = 1000; // ms

const PAN_REGEX = /^[A-Z]{3}P[A-Z][0-9]{4}[A-Z]$/;

// ---------------- LOGGING ---------------- //
function log(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} [${level}] ${message}`);
}

// ---------------- EXCEL PINCODE LOADER ---------------- //
function loadValidPincodes() {
  try {
    const workbook = XLSX.readFile(PINCODE_FILE_PATH);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    const data = XLSX.utils.sheet_to_json(worksheet);
    const pincodes = new Set();
    
    data.forEach((row) => {
      const pinKey = Object.keys(row).find(
        (key) => key.trim().toLowerCase() === 'pincode' || key.trim().toLowerCase() === 'pin'
      );

      if (pinKey && row[pinKey]) {
        const cleanPin = String(row[pinKey]).trim();
        if (cleanPin) {
          pincodes.add(cleanPin);
        }
      }
    });

    log("INFO", `✅ Loaded ${pincodes.size} valid pincodes from Excel.`);
    return pincodes;
  } catch (error) {
    log("ERROR", `❌ Error loading pincode file: ${error.message}`);
    return new Set();
  }
}

const allowedPincodes = loadValidPincodes();

// ---------------- MONGO ---------------- //
let client;
let leadCol;
let responseCol;

async function connectMongo() {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  leadCol = db.collection(LEAD_COLLECTION);
  responseCol = db.collection(RESPONSE_COLLECTION);
  log("INFO", "✅ MongoDB Connected Successfully");
}

// ---------------- HELPERS & ELIGIBILITY ---------------- //

function calculateAge(dobString) {
  if (!dobString) return 0;
  const birthDate = new Date(dobString);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

function shouldSkip(lead) {
  // 1. Basic Required Fields Check
  const required = ["phone", "pancard", "dob", "name"];
  for (const field of required) {
    if (!lead[field]) return "MISSING_REQUIRED_FIELD";
  }

  // 2. Check if already processed by this lender
  if (lead.processed && Array.isArray(lead.processed)) {
    const hasAlreadyProcessed = lead.processed.some(
      (lender) => String(lender).toLowerCase().startsWith(LENDER_NAME.toLowerCase())
    );
    if (hasAlreadyProcessed) return "ALREADY_PROCESSED";
  }

  // 3. PAN Regex Validation
  const pan = String(lead.pancard || lead.pan || "").toUpperCase().trim();
  if (!PAN_REGEX.test(pan)) {
    return "INVALID_PAN";
  }

  // 4. Employment Type Check (Salaried only)
  const empType = String(lead.employment_type || lead.employment || "").trim().toLowerCase();
  if (empType !== "salaried") {
    return "NOT_SALARIED";
  }

  // 5. Monthly Income Check (35k+)
  const income = Number(lead.monthly_income || lead.income || 0);
  if (isNaN(income) || income < 35000) {
    return "LOW_INCOME";
  }

  // 6. Age Check (21 to 55 years)
  const age = calculateAge(lead.dob);
  if (age < 21 || age > 55) {
    return "INVALID_AGE";
  }

  // 7. Pincode Validation from Excel
  const leadPincode = String(lead.pincode || "").trim();
  if (allowedPincodes.size > 0 && !allowedPincodes.has(leadPincode)) {
    return "EXCLUDED_PINCODE";
  }

  return false;
}

// ---------------- WORKER ---------------- //

async function sendLead(lead) {
  const mobile = String(lead.phone || lead.mobile || "").trim();
  const pan = String(lead.pancard || lead.pan || "").toUpperCase().trim();
  log("INFO", `Sending lead to Marketplace for: ${lead.name || mobile}`);

  let apiResponse;
  let isSuccess = false;

  try {
    // Step A: Dedupe Call
    const dedupeRes = await axios.post(`${BASE_URL}/dedupe`, {
      mobile: mobile,
      pancard: pan
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-credential': AUTH_HEADER
      },
      timeout: REQUEST_TIMEOUT
    });

    if (dedupeRes.data && dedupeRes.data.message === 'Dedup Fail') {
      log("WARN", `🛑 Dedupe Fail (Already existing customer): ${mobile}`);
      
      await responseCol.insertOne({
        phone: mobile,
        pan: pan,
        name: lead.name || "",
        status: "DEDUPE_FAILED",
        api_response: dedupeRes.data,
        createdAt: new Date().toISOString().slice(0, 10),
      });

      await leadCol.updateOne(
        { _id: lead._id },
        { $addToSet: { processed: `${LENDER_NAME}: dedupe_failed` } }
      );
      return false;
    }

    await new Promise(r => setTimeout(r, 300)); // Buffer delay

    // Step B: Lead Create Call
    const leadPayload = {
      customer_email: lead.email || 'customer@covermantra.com',
      mobile_number: mobile,
      pancard: pan,
      loan_purpose: 'Personal Loan',
      employee_type: lead.employment_type || lead.employment || 'Salaried',
      salary_mode: 'Bank Transfer',
      monthly_income: Number(lead.monthly_income || lead.income) || 35000,
      salary_date: Number(lead.salary_date) || 5,
      pincode: String(lead.pincode || "").trim(),
      consent: true,
      consent_date_time: new Date().toISOString()
    };

    const leadRes = await axios.post(`${BASE_URL}/lead_create`, leadPayload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-credential': AUTH_HEADER
      },
      timeout: REQUEST_TIMEOUT
    });

    apiResponse = leadRes.data;
    if (apiResponse && apiResponse.success) {
      isSuccess = true;
    }

  } catch (axiosError) {
    isSuccess = false;
    if (axiosError.response) {
      apiResponse = axiosError.response.data;
      log("WARN", `API Error [${axiosError.response.status}] for ${mobile}: ${JSON.stringify(apiResponse)}`);
    } else if (axiosError.request) {
      apiResponse = { error: "No response received from lender API (Timeout/Network)" };
      log("ERROR", `Network Timeout/No Response for ${mobile}`);
    } else {
      apiResponse = { error: axiosError.message };
      log("ERROR", `Request Setup Error for ${mobile}: ${axiosError.message}`);
    }
  }

  // Save Response Log
  try {
    const dataObj = isSuccess && apiResponse.data ? apiResponse.data : {};
    await responseCol.insertOne({
      userId: lead._id,
      phone: mobile,
      pan: pan,
      name: lead.name || "",
      status: isSuccess ? "SUCCESS" : "FAILED",
      leadID: dataObj.leadID || null,
      customerID: dataObj.customerID || null,
      breDecision: dataObj.breDecision || null,
      offeredAmount: dataObj.offeredAmount || 0,
      redirectUrl: dataObj.redirectUrl || null,
      api_response: apiResponse,
      createdAt: new Date().toISOString().slice(0, 10),
    });
  } catch (dbError) {
    log("ERROR", `Failed to insert log in responseCol: ${dbError.message}`);
  }

  // Update Lead Processed Flag
  try {
    const statusTag = isSuccess ? `${LENDER_NAME}: lead_created` : `${LENDER_NAME}: failed`;
    await leadCol.updateOne(
      { _id: lead._id },
      { 
        $set: { status: isSuccess ? 'lead_created' : 'failed' },
        $addToSet: { processed: statusTag } 
      }
    );
  } catch (dbError) {
    log("ERROR", `Failed to update processed status in leadCol: ${dbError.message}`);
  }

  return isSuccess;
}

// ---------------- CONCURRENCY HELPER ---------------- //

async function runWithConcurrencyLimit(items, limit, fn) {
  let successCount = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) break;

      const currentItem = items[currentIndex];
      try {
        const success = await fn(currentItem);
        if (success) successCount++;
      } catch (e) {
        log("ERROR", `WORKER FAILED → ${e.message}`);
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());

  await Promise.all(workers);
  return successCount;
}

async function processBatch(batch) {
  return runWithConcurrencyLimit(batch, MAX_WORKERS, (lead) => sendLead(lead));
}

// ---------------- MAIN PROCESS ---------------- //

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processLeads() {
  log("INFO", "🔍 Fetching unprocessed leads from MongoDB...");

  const query = {
    $or: [
      { processed: { $exists: false } },
      { processed: { $not: { $regex: new RegExp(LENDER_NAME, "i") } } }
    ]
  };

  const cursor = leadCol.find(query).limit(MAX_LEADS);

  let total = 0;
  let processed = 0;
  let skipped = 0;
  
  let batch = [];
  let skippedBulkOps = [];

  for await (const lead of cursor) {
    total++;

    if (total % 1000 === 0) {
      log("INFO", `Scanned ${total} records... (Queue for API: ${batch.length}, Total Skipped: ${skipped})`);
    }

    const skipReason = shouldSkip(lead);

    if (skipReason) {
      if (skipReason === "ALREADY_PROCESSED") continue;

      skipped++;
      const skipTag = `${LENDER_NAME}: skipped_${skipReason}`;

      skippedBulkOps.push({
        updateOne: {
          filter: { _id: lead._id },
          update: { $addToSet: { processed: skipTag } }
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
      log("INFO", `🚀 Processing batch of ${batch.length} leads to API...`);
      processed += await processBatch(batch);
      batch = [];
      await sleep(BATCH_DELAY);
    }
  }

  // Final remaining API batch
  if (batch.length) {
    log("INFO", `🚀 Processing final batch of ${batch.length} leads to API...`);
    processed += await processBatch(batch);
  }

  // Final remaining Skipped DB updates
  if (skippedBulkOps.length > 0) {
    await leadCol.bulkWrite(skippedBulkOps);
    skippedBulkOps = [];
  }

  log("INFO", "----- SUMMARY -----");
  log("INFO", `TOTAL UNPROCESSED FETCHED : ${total}`);
  log("INFO", `PROCESSED (SUCCESS/API)   : ${processed}`);
  log("INFO", `TOTAL SKIPPED (UPDATED DB)  : ${skipped}`);
}

// ---------------- RUN ---------------- //

async function main() {
  if (allowedPincodes.size === 0) {
    log("ERROR", "❌ No pincodes loaded from Excel. Aborting execution.");
    return;
  }

  try {
    await connectMongo();
    await processLeads();
  } catch (err) {
    log("ERROR", `Fatal error: ${err.message}`);
  } finally {
    if (client) {
      await client.close();
      log("INFO", "🔒 MongoDB connection closed");
    }
  }
}

main();