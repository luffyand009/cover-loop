const { MongoClient } = require("mongodb");
const axios = require("axios");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "coverloop";

const LEAD_COLLECTION = "keshvadb";
const RESPONSE_COLLECTION = "cover_vivi";

const ACCESS_TOKEN_URL = "https://api.flexsalary.com/apiv1/api/AccessToken/Post";
const LEAD_API_URL = "https://api.flexsalary.com/apiv1/api/LeadCustomer/Post";

const USERNAME = "CoverMantra";
const PASSWORD = "DvI}rMg]HyP[jXa[";
const CAMPAIGN_ID = 9192300;
const LENDER_NAME = "flexsalary";

// ------------ CONTROL ------------ //

const MAX_LEADS = 5000000;
const BATCH_SIZE = 500;
const MAX_WORKERS = 7;
const REQUEST_TIMEOUT = 30000; // ms
const BATCH_DELAY = 1000; // ms

// --- TOKEN REFRESH CONTROL STATE --- //
let cachedToken = null;
let tokenExpiryTime = null;
const REFRESH_INTERVAL_MS = 110 * 60 * 1000; // 110 minutes in milliseconds

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

function splitName(doc) {
  if (!doc) return ["NA", "NA"];

  const nameStr = (doc.name || "").trim();
  const dbLastName = (doc.last_name || "").trim();

  if (dbLastName) {
    return [nameStr || "NA", dbLastName];
  }

  const parts = nameStr.split(/\s+/);
  const first = parts[0] || "NA";
  let last = parts.length > 1 ? parts.slice(1).join(" ") : "";
  
  if (!last) {
    last = "NA"; 
  }

  return [first, last];
} 

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDob(dob) {
  if (!dob) return null;

  if (dob instanceof Date && !isNaN(dob)) {
    return `${pad2(dob.getDate())}/${pad2(dob.getMonth() + 1)}/${dob.getFullYear()}`;
  }

  if (typeof dob === "string") {
    dob = dob.trim();

    if (dob.includes("T")) {
      dob = dob.split("T")[0];
    }

    const formats = [
      { regex: /^(\d{4})-(\d{2})-(\d{2})$/, order: ["y", "m", "d"] },
      { regex: /^(\d{2})-(\d{2})-(\d{4})$/, order: ["d", "m", "y"] },
      { regex: /^(\d{4})\/(\d{2})\/(\d{2})$/, order: ["y", "m", "d"] },
      { regex: /^(\d{2})\/(\d{2})\/(\d{4})$/, order: ["d", "m", "y"] },
      { regex: /^(\d{2})\/(\d{2})\/(\d{4})$/, order: ["m", "d", "y"] },
    ];

    for (const fmt of formats) {
      const match = dob.match(fmt.regex);
      if (!match) continue;

      const parts = {};
      fmt.order.forEach((key, idx) => {
        parts[key] = match[idx + 1];
      });

      const year = +parts.y;
      const month = +parts.m;
      const day = +parts.d;

      return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
    }
  }

  return null;
}

function mapGender(gender) {
  const map = { male: 0, female: 1, other: 2 };
  return map[(gender || "").toLowerCase()] ?? 0;
}

function mapIncomeType(emp) {
  return emp && emp.toLowerCase() === "self employed" ? 2 : 6;
}

// Detailed shouldSkip logic
function shouldSkip(lead) {
  // 1. Basic required fields check
  const required = ["phone", "pan", "dob", "gender", "name"];
  for (const field of required) {
    if (!lead[field]) return "MISSING_REQUIRED_FIELD";
  }
  if (formatDob(lead.dob) === null) return "INVALID_DOB";
  
  // 2. Check if already processed
  if (lead.processed && Array.isArray(lead.processed)) {
    const hasAlreadyProcessed = lead.processed.some(
      (lender) => String(lender).toLowerCase().startsWith(LENDER_NAME.toLowerCase())
    );
    if (hasAlreadyProcessed) return "ALREADY_PROCESSED";
  }

  // 3. Employment Validation
  const emp = (lead.employment || "").trim().toLowerCase();
  if (emp === "self employed" || emp === "selfemployed" || emp === "self-employed") {
    return "SELF_EMPLOYED";
  }
  if (emp !== "salaried") return "INVALID_EMPLOYMENT";

  // 4. Income Validation
  const incomeVal = parseFloat(lead.income || 0);
  if (isNaN(incomeVal) || incomeVal < 25000) return "LOW_INCOME";

  // 5. State Exclusions
  const state = (lead.state || "").trim().toLowerCase();
  const isJK = state.includes("jammu") || state.includes("kashmir") || state === "j&k" || state === "j and k";
  
  const northEastStates = [
    "arunachal pradesh",
    "assam",
    "manipur",
    "meghalaya",
    "mizoram",
    "nagaland",
    "tripura",
    "sikkim"
  ];
  const isNorthEast = northEastStates.includes(state);

  if (isJK || isNorthEast) return "EXCLUDED_STATE";
  
  return false;
}

// ---------------- TOKEN MANAGEMENT WITH AUTO REFRESH ---------------- //

async function getAccessToken() {
  const currentTime = Date.now();
  
  if (cachedToken && tokenExpiryTime && currentTime < tokenExpiryTime) {
    return cachedToken;
  }

  log("INFO", cachedToken ? "🔄 Token expired (110 mins reached). Refreshing Access Token..." : "🔑 Fetching Initial Access Token...");
  
  const res = await axios.post(
    ACCESS_TOKEN_URL,
    { UserName: USERNAME, Password: PASSWORD },
    { headers: { "Content-Type": "application/json" } }
  );
  
  cachedToken = res.data?.Message;
  tokenExpiryTime = Date.now() + REFRESH_INTERVAL_MS; 
  
  log("INFO", "✅ New Access Token generated and cached successfully.");
  return cachedToken;
}

// ---------------- PAYLOAD ---------------- //

function buildPayload(doc) {
  const [first, last] = splitName(doc); 
  const dobFormatted = formatDob(doc.dob);

  return {
    Campaign: {
      CampaignId: CAMPAIGN_ID,
      IsMobile: false,
    },

    PersonerDetails: {
      FirstName: first,
      LastName: last,
      Email: doc.email || "NA",
      PhoneNumber: doc.phone,
      DateOfBirth: dobFormatted,
      Gender: mapGender(doc.gender),
      PanNumber: doc.pan,
    },

    CustomerAddressDetails: {
      ResidenceType: 1,
      PinCode: doc.pincode,
    },

    CustomerIncomeDetails: {
      IncomeType: mapIncomeType(doc.employment),
      GrossIncome: parseFloat(doc.income || 0),
    },

    CustomerBankDetails: {
      AccountType: 10,
    },
  };
}

// ---------------- WORKER ---------------- //

async function sendLead(lead, headers) {
  const payload = buildPayload(lead);
  console.log("Sending payload for:", lead.name);

  let apiResponse;
  let isSuccess = false;

  try {
    const res = await axios.post(LEAD_API_URL, payload, {
      headers,
      timeout: REQUEST_TIMEOUT,
    });
    apiResponse = res.data;
    isSuccess = true;
  } catch (axiosError) {
    isSuccess = false;
    
    if (axiosError.response) {
      apiResponse = axiosError.response.data;
      log("WARN", `API Error [${axiosError.response.status}] for ${lead.name}: ${JSON.stringify(apiResponse)}`);
    } else if (axiosError.request) {
      apiResponse = { error: "No response received from lender API (Timeout/Network)" };
      log("ERROR", `Network Timeout/No Response for ${lead.name}`);
    } else {
      apiResponse = { error: axiosError.message };
      log("ERROR", `Request Setup Error for ${lead.name}: ${axiosError.message}`);
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
  const token = await getAccessToken(); 
  const headers = {
    "Content-Type": "application/json",
    AccessToken: token,
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

  // Query jo 'flexsalary' se start hone wale kisi bhi status ko skip karegi
  const query = {
    $or: [
      { processed: { $exists: false } },
      { processed: { $regex: "^((?!flexsalary).)*$", $options: "i" } }
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

    // Scan Heartbeat Log (har 1,000 leads par)
    if (total % 1000 === 0) {
      log("INFO", `Scanned ${total} records... (Queue for API: ${batch.length}, Total Skipped: ${skipped})`);
    }

    const skipReason = shouldSkip(lead);

    if (skipReason) {
      // Agar pehle se processed hai, to wapas DB write nahi karenge
      if (skipReason === "ALREADY_PROCESSED") continue;

      skipped++;

      // 🎯 HAR REASON KO DEDICATED SKIP TAG SATH MONGO ME UPDATE KARENGE
      const skipTag = `${LENDER_NAME}: skipped_${skipReason}`;

      skippedBulkOps.push({
        updateOne: {
          filter: { _id: lead._id },
          update: { $addToSet: { processed: skipTag } }
        }
      });

      // Bulk write batch size ke according execute hoga
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