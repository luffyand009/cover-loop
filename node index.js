const { MongoClient } = require("mongodb");
const axios = require("axios");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "coverloop";

const LEAD_COLLECTION = "keshvadb";
const RESPONSE_COLLECTION = "creditt_responses";

const LEAD_API_URL = "https://agency.ctpl.live/lead/ingest/cover_mantra";
const LENDER_NAME = "cover_mantra";

// ------------ CONTROL ------------ //

const MAX_LEADS = 5000000;
const BATCH_SIZE = 500;
const MAX_WORKERS = 7;
const REQUEST_TIMEOUT = 30000; // ms
const BATCH_DELAY = 1000; // ms

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
  client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  leadCol = db.collection(LEAD_COLLECTION);
  responseCol = db.collection(RESPONSE_COLLECTION);
  log("INFO", "✅ MongoDB Connected Successfully");
}

// ---------------- HELPERS ---------------- //

function formatDob(dob) {
  if (!dob) return null;

  if (dob instanceof Date && !isNaN(dob)) {
    return dob.toISOString().split("T")[0];
  }

  if (typeof dob === "string") {
    dob = dob.trim();

    if (dob.includes("T")) {
      return dob.split("T")[0];
    }

    const formats = [
      { regex: /^(\d{4})-(\d{2})-(\d{2})$/, order: ["y", "m", "d"] },
      { regex: /^(\d{2})-(\d{2})-(\d{4})$/, order: ["d", "m", "y"] },
      { regex: /^(\d{4})\/(\d{2})\/(\d{2})$/, order: ["y", "m", "d"] },
      { regex: /^(\d{2})\/(\d{2})\/(\d{4})$/, order: ["d", "m", "y"] },
    ];

    for (const fmt of formats) {
      const match = dob.match(fmt.regex);
      if (!match) continue;

      const parts = {};
      fmt.order.forEach((key, idx) => {
        parts[key] = match[idx + 1];
      });

      return `${parts.y}-${parts.m}-${parts.d}`;
    }
  }

  return null;
}

// Bulletproof shouldSkip logic
function shouldSkip(lead) {
  if (!lead) return "INVALID_LEAD";

  // 1. Basic required fields check
  if (!lead.phone) return "MISSING_REQUIRED_FIELD";
  
  // 2. Check if already processed (Strictly Safe)
  if (lead.processed) {
    if (Array.isArray(lead.processed)) {
      const hasAlreadyProcessed = lead.processed.some((lender) => {
        if (!lender) return false;
        if (typeof lender === 'string') {
          return lender.toLowerCase().startsWith(LENDER_NAME.toLowerCase());
        }
        return false;
      });
      if (hasAlreadyProcessed) return "ALREADY_PROCESSED";
    } else if (typeof lead.processed === 'string') {
      if (lead.processed.toLowerCase().includes(LENDER_NAME.toLowerCase())) {
        return "ALREADY_PROCESSED";
      }
    }
  }

  return false;
}

// ---------------- PAYLOAD ---------------- //

function buildPayload(doc) {
  const dobFormatted = formatDob(doc.dob);

  return {
    phoneNumber: doc.phone,
    panNumber: doc.pan || "",
    data: {
      email: doc.email || "",
      customer_name: doc.name || "",
      dob: dobFormatted || "",
      emp_type: doc.employment || "organic",
      salary: String(doc.income || "0"),
      addresss: doc.address || doc.addresss || "",
      city: doc.city || "",
      pincode: doc.pincode || ""
    }
  };
}

// ---------------- WORKER ---------------- //

async function sendLead(lead, headers) {
  const payload = buildPayload(lead);
  console.log("Sending payload for:", lead.name || lead.phone);

  let apiResponse;
  let isSuccess = false;

  try {
    const res = await axios.post(LEAD_API_URL, payload, {
      headers,
      timeout: REQUEST_TIMEOUT,
    });
    apiResponse = res.data;
    
    if (apiResponse && (apiResponse.message === "SUCCESS" || apiResponse.message === "DUPLICATE")) {
      isSuccess = true;
    }
  } catch (axiosError) {
    isSuccess = false;
    
    if (axiosError.response) {
      apiResponse = axiosError.response.data;
      log("WARN", `API Error [${axiosError.response.status}] for ${lead.phone}: ${JSON.stringify(apiResponse)}`);
    } else if (axiosError.request) {
      apiResponse = { error: "No response received from lender API (Timeout/Network)" };
      log("ERROR", `Network Timeout/No Response for ${lead.phone}`);
    } else {
      apiResponse = { error: axiosError.message };
      log("ERROR", `Request Setup Error for ${lead.phone}: ${axiosError.message}`);
    }
  }

  try {
    await responseCol.insertOne({
      phone: lead.phone,
      pan: lead.pan,
      name: lead.name,
      status: isSuccess ? "SUCCESS" : "FAILED",
      api_response: apiResponse,
      createdAt: new Date().toISOString().slice(0, 10),
    });
  } catch (dbError) {
    log("ERROR", `Failed to insert log in responseCol: ${dbError.message}`);
  }

  try {
    await leadCol.updateOne(
      { _id: lead._id },
      {
        $addToSet: {
          processed: LENDER_NAME,
        },
      }
    );
  } catch (dbError) {
    log("ERROR", `Failed to update processed status in leadCol: ${dbError.message}`);
  }
}

// ---------------- CONCURRENCY HELPER ---------------- //

async function runWithConcurrencyLimit(items, limit, fn) {
  let successCount = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      
      if (currentIndex >= items.length) {
        break;
      }

      const currentItem = items[currentIndex];
      try {
        await fn(currentItem);
        successCount++;
      } catch (e) {
        log("ERROR", `FAILED → ${e.message}`);
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());

  await Promise.all(workers);
  return successCount;
}

async function processBatch(batch) {
  const headers = {
    "Content-Type": "application/json",
  };

  return runWithConcurrencyLimit(batch, MAX_WORKERS, (lead) =>
    sendLead(lead, headers)
  );
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
      { processed: { $regex: "^((?!cover_mantra).)*$", $options: "i" } }
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

  if (batch.length) {
    log("INFO", `🚀 Processing final batch of ${batch.length} leads to API...`);
    processed += await processBatch(batch);
  }

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

main()