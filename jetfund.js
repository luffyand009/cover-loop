const { MongoClient } = require("mongodb");
const axios = require("axios");
require("dotenv").config();

// ------------ CONFIGURATION ------------ //
const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "coverloop";

const LEAD_COLLECTION = "py";
const RESPONSE_COLLECTION = "jetfund";

const API_BASE_URL = "https://dev-api-apply.jetfund.in";
const TENANT_DOMAIN = "dev-apply.jetfund.in";
const CLIENT_ID = "client_65dedb0b2003";
const CLIENT_SECRET = "60cd38c1840610c3f3b125f6df41bb67613ee78da7e612a8f0d68d730f1174a7";

const LEAD_VERIFY_URL = `${API_BASE_URL}/api/v1/vendor/lead-verify`;
const LEAD_PUSH_URL = `${API_BASE_URL}/api/v1/vendor/lead-push`;
const LENDER_NAME = "jetfund";

// ------------ CONTROL ------------ //
const MAX_LEADS = 500000;
const BATCH_SIZE = 50;
const MAX_WORKERS = 3;
const REQUEST_TIMEOUT = 30000; // ms
const BATCH_DELAY = 1000; // ms

// ---------------- LOGGING ---------------- //
function log(level, message) {
  const timestamp = new Date().toISOString();
  if (message.includes(CLIENT_SECRET) || message.toLowerCase().includes("accesstoken")) {
    console.log(`${timestamp} - ${level} - [REDACTED SENSITIVE DATA]`);
    return;
  }
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
  if (!dob) return "1998-05-15";
  if (dob instanceof Date && !isNaN(dob)) {
    return dob.toISOString().split("T")[0];
  }
  if (typeof dob === "string") {
    dob = dob.trim();
    if (dob.includes("T")) return dob.split("T")[0];
    const match = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return dob;
  }
  return "1998-05-15";
}

function calculateAge(dob) {
  const formattedDobStr = formatDob(dob);
  const parts = formattedDobStr.split("-");
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

function isValidPincode(pincode) {
  if (!pincode) return false;
  const pinStr = String(pincode).trim();
  return /^[1-9][0-9]{5}$/.test(pinStr);
}

// Exclude J&K (18, 19) and Seven Sisters / North-East states (78, 79)
function isExcludedPincode(pincode) {
  const pinStr = String(pincode).trim();
  return /^(18|19|78|79)/.test(pinStr);
}

function shouldSkip(lead) {
  const required = ["phone", "pan", "dob", "income", "employment", "pincode"];
  for (const field of required) {
    if (!lead[field]) return "MISSING_REQUIRED_FIELD";
  }

  // 1. Age Check (Updated to 22 to 50 years)
  const age = calculateAge(lead.dob);
  if (age === null || age < 22 || age > 50) return "OUT_OF_AGE_RANGE";

  // 2. Employment Validation (Salaried only)
  const emp = (lead.employment || "").trim().toLowerCase();
  if (emp !== "salaried") return "INVALID_EMPLOYMENT";

  // 3. Income Validation (Updated to >= 22000)
  const incomeVal = parseFloat(String(lead.income || "0").replace(/,/g, "").trim());
  if (isNaN(incomeVal) || incomeVal < 22000) return "LOW_INCOME";

  // 4. Pincode Validation & Regional Exclusion (All India except J&K & Seven Sisters)
  const leadPincode = String(lead.pincode || "").trim();
  if (!isValidPincode(leadPincode)) return "INVALID_PINCODE";
  if (isExcludedPincode(leadPincode)) return "EXCLUDED_PINCODE";

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

  log("INFO", `Processing lead: ${mobile} / ${pancard}`);

  try {
    // 1. Lead Verify - Dedupe API
    const verifyPayload = { mobile, pancard };
    const verifyRes = await axios.post(LEAD_VERIFY_URL, verifyPayload, {
      headers,
      timeout: REQUEST_TIMEOUT,
      validateStatus: () => true
    });

    if (typeof verifyRes.data === "string" && verifyRes.data.includes("<!DOCTYPE html>")) {
      log("ERROR", `API returned HTML instead of JSON for ${mobile}. Check if API base domain is correct.`);
      return false;
    }

    const verifyData = verifyRes.data || {};
    log("INFO", `Lead Verify Response for ${mobile}: ${JSON.stringify(verifyData)}`);

    const customerExists = verifyData.success === false || verifyData.exists === true || (verifyData.message && verifyData.message.toLowerCase().includes("exist"));

    if (customerExists) {
      log("WARN", `Customer already exists for ${mobile}. Skipping Lead Push.`);
      
      await responseCol.insertOne({
        name: "Jetfund",
        response: {
          Leadcredit: {
            dedupe: {
              success: verifyData.success || false,
              message: verifyData.message || "Customer already exists",
              fullResponse: verifyData,
              createdAt: new Date().toISOString()
            }
          }
        },
        phone: mobile,
        pan: pancard,
        status: "EXISTS"
      });

      await leadCol.updateOne(
        { _id: lead._id },
        { $addToSet: { processed: `${LENDER_NAME}_EXISTS` } }
      );
      return false;
    }

    // 2. Lead Push API
    const nameParts = (lead.name || "Customer NA").trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "NA";

    const pushPayload = {
      mobile: mobile,
      pancard: pancard,
      firstName: firstName,
      lastName: lastName,
      dob: formatDob(lead.dob),
      empSalary: String(lead.income || "22000"),
      pinCode: String(lead.pincode).trim(),
    };

    const pushRes = await axios.post(LEAD_PUSH_URL, pushPayload, {
      headers,
      timeout: REQUEST_TIMEOUT,
      validateStatus: () => true
    });

    if (typeof pushRes.data === "string" && pushRes.data.includes("<!DOCTYPE html>")) {
      log("ERROR", `Lead Push API returned HTML instead of JSON for ${mobile}.`);
      return false;
    }

    const apiResponse = pushRes.data || {};
    const responseData = apiResponse.data || {};
    const decision = responseData.Decision || "Reject";
    
    const loanAmount = typeof responseData.LoanAmount === 'number' ? responseData.LoanAmount : Number(responseData.LoanAmount) || 0;
    const score = typeof responseData.score === 'number' ? responseData.score : Number(responseData.score) || 0;

    const isSuccess = decision === "Approve" || decision === "Review" || apiResponse.success === true;

    // Nested Structure Saving
    await responseCol.insertOne({
      name: "Jetfund",
      response: {
        Leadcredit: {
          dedupe: {
            success: verifyData.success || true,
            message: verifyData.message || "Lead accepted for further processing",
            fullResponse: verifyData,
            createdAt: new Date().toISOString()
          },
          leadCreate: {
            success: apiResponse.success || false,
            message: apiResponse.message || "",
            fullResponse: {
              success: apiResponse.success,
              message: apiResponse.message,
              data: responseData
            },
            createdAt: new Date().toISOString()
          }
        }
      },
      phone: mobile,
      pan: pancard,
      status: isSuccess ? "SUCCESS" : "FAILED",
      loanAmount: loanAmount,
      score: score
    });

    await leadCol.updateOne(
      { _id: lead._id },
      { $addToSet: { processed: LENDER_NAME } }
    );

    log("INFO", `Successfully pushed lead ${mobile} | Decision: ${decision} | LoanAmount: ${loanAmount} | Score: ${score}`);
    return true;

  } catch (axiosError) {
    let errResponse = { error: axiosError.message };
    if (axiosError.response) {
      errResponse = axiosError.response.data;
      log("WARN", `API Error [${axiosError.response.status}] for ${mobile}: ${JSON.stringify(errResponse)}`);
    } else {
      log("ERROR", `Network/Setup Error for ${mobile}: ${axiosError.message}`);
    }

    await responseCol.insertOne({
      name: "Jetfund",
      response: {
        Leadcredit: {
          leadCreate: {
            success: false,
            message: "API Error",
            fullResponse: errResponse,
            createdAt: new Date().toISOString()
          }
        }
      },
      phone: mobile,
      pan: pancard,
      status: "FAILED"
    });

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
        log("ERROR", `FAILED Worker → ${e.message}`);
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());

  await Promise.all(workers);
  return successCount;
}

async function processBatch(batch, headers) {
  return runWithConcurrencyLimit(batch, MAX_WORKERS, processLead, headers);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------- MAIN PROCESS ---------------- //
async function processLeads() {
  log("INFO", "🔍 Fetching unprocessed leads from MongoDB...");

  const query = {
    $or: [
      { processed: { $exists: false } },
      { processed: { $not: { $regex: /jetfund/i } } }
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
    "client-id": CLIENT_ID,
    "client-secret": CLIENT_SECRET,
    "x-tenant-domain": TENANT_DOMAIN,
  };

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
      processed += await processBatch(batch, headers);
      batch = [];
      await sleep(BATCH_DELAY);
    }
  }

  if (batch.length) {
    log("INFO", `🚀 Processing final batch of ${batch.length} leads to API...`);
    processed += await processBatch(batch, headers);
  }

  if (skippedBulkOps.length > 0) {
    await leadCol.bulkWrite(skippedBulkOps);
    skippedBulkOps = [];
  }

  log("INFO", "----- SUMMARY -----");
  log("INFO", `TOTAL UNPROCESSED FETCHED : ${total}`);
  log("INFO", `PROCESSED (SUCCESS/API)   : ${processed}`);
  log("INFO", `TOTAL SKIPPED (UPDATED DB): ${skipped}`);
}

// ---------------- RUN ---------------- //
async function main() {
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