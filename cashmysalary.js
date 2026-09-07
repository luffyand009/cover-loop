require('dotenv').config();
const { MongoClient } = require("mongodb");
const axios = require("axios");

// ------------ CONFIGURATION ------------ //
const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "coverloop";

const LEAD_COLLECTION = "keshvadb";
const RESPONSE_COLLECTION = "cashmysalary";

const API_BASE_URL = "https://loanapply-api.cashmysalary.com";
const TENANT_DOMAIN = "loanapply.cashmysalary.com";
const CLIENT_ID = "client_b250dd25898d";
const CLIENT_SECRET = "a29f64c641551f7e3cd029ba07b181a29d2dd3c3066c2afc82c446e89995d944";

const LEAD_VERIFY_URL = `${API_BASE_URL}/api/v1/vendor/lead-verify`;
const LEAD_PUSH_URL = `${API_BASE_URL}/api/v1/vendor/lead-push`;
const LENDER_NAME = "cashmysalary";

const MAX_LEADS = 500;
const BATCH_SIZE = 50;
const REQUEST_TIMEOUT = 30000;
const BATCH_DELAY = 1000;

function log(level, message) {
  const timestamp = new Date().toISOString();
  if (message.includes(CLIENT_SECRET) || message.toLowerCase().includes("accesstoken") || message.toLowerCase().includes("refreshtoken")) {
    console.log(`${timestamp} - ${level} - [REDACTED SENSITIVE DATA]`);
    return;
  }
  console.log(`${timestamp} - ${level} - ${message}`);
}

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

function shouldSkip(lead) {
  const required = ["phone", "pan"];
  for (const field of required) {
    if (!lead[field]) return "MISSING_REQUIRED_FIELD";
  }

  if (lead.processed && Array.isArray(lead.processed)) {
    const hasAlreadyProcessed = lead.processed.some(
      (lender) => String(lender).toLowerCase().startsWith(LENDER_NAME.toLowerCase())
    );
    if (hasAlreadyProcessed) return "ALREADY_PROCESSED";
  }

  return false;
}

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

    const customerExists = verifyData.exists === true || (verifyData.message && verifyData.message.toLowerCase().includes("exist"));

    if (customerExists) {
      log("WARN", `Customer already exists for ${mobile}. Skipping Lead Push.`);
      
      await responseCol.insertOne({
        phone: mobile,
        pan: pancard,
        name: lead.name || "",
        status: "EXISTS",
        api_response: verifyData,
        createdAt: new Date().toISOString().slice(0, 10),
      });

      await leadCol.updateOne(
        { _id: lead._id },
        { $addToSet: { processed: `${LENDER_NAME}_EXISTS` } }
      );
      return false;
    }

    const nameParts = (lead.name || "Customer NA").trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "NA";

    const pushPayload = {
      mobile: mobile,
      pancard: pancard,
      firstName: firstName,
      lastName: lastName,
      dob: formatDob(lead.dob),
      empSalary: String(lead.income || "50000"),
      pinCode: String(lead.pincode || "201301"),
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
    const decision = responseData.Decision || apiResponse.message || "SUCCESS";
    
    const loanAmount = typeof responseData.LoanAmount === 'number' ? responseData.LoanAmount : Number(responseData.LoanAmount) || 0;
    const score = typeof responseData.score === 'number' ? responseData.score : Number(responseData.score) || 0;

    const isSuccess = decision === "Approve" || decision === "Review" || apiResponse.success === true;

    await responseCol.insertOne({
      phone: mobile,
      pan: pancard,
      name: lead.name || "",
      status: isSuccess ? "SUCCESS" : "FAILED",
      loanAmount: loanAmount,
      score: score,
      api_response: apiResponse,
      createdAt: new Date().toISOString().slice(0, 10),
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
      phone: mobile,
      pan: pancard,
      name: lead.name || "",
      status: "FAILED",
      api_response: errResponse,
      createdAt: new Date().toISOString().slice(0, 10),
    });

    return false;
  }
}

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
  return runWithConcurrencyLimit(batch, 3, processLead, headers);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processLeads() {
  log("INFO", "🔍 Fetching unprocessed leads from MongoDB...");

  const query = {
    $or: [
      { processed: { $exists: false } },
      { processed: { $not: { $regex: /cashmysalary/i } } }
    ]
  };

  const cursor = leadCol.find(query).limit(MAX_LEADS);

  let total = 0;
  let processed = 0;
  let batch = [];

  const headers = {
    "Content-Type": "application/json",
    "client-id": CLIENT_ID,
    "client-secret": CLIENT_SECRET,
    "x-tenant-domain": TENANT_DOMAIN,
  };

  for await (const lead of cursor) {
    total++;
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

  log("INFO", "----- SUMMARY -----");
  log("INFO", `TOTAL UNPROCESSED FETCHED : ${total}`);
  log("INFO", `PROCESSED (SUCCESS/API)   : ${processed}`);
}

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