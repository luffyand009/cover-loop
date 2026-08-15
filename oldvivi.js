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
const SKIP = 1;
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
  
  // 💡 सुरक्षा घेरा: अगर सिंगल नाम है और कोई सरनेम नहीं मिला, तो "NA" भेजें
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

    // ISO string: 1985-02-28T00:00:00.000Z
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

function shouldSkip(lead) {
  // 1. Basic required fields check
  const required = ["phone", "pan", "dob", "gender", "name"];
  for (const field of required) {
    if (!lead[field]) return true;
  }
  if (formatDob(lead.dob) === null) return true;
  
  // 2. Check if already processed
  if (lead.processed && Array.isArray(lead.processed)) {
    const hasAlreadyProcessed = lead.processed.some(
      (lender) => String(lender).toLowerCase() === LENDER_NAME.toLowerCase()
    );
    if (hasAlreadyProcessed) return true;
  }

  // 3. New Validation: Employment must be "salaried" (Case-Insensitive)
  const emp = (lead.employment || "").trim().toLowerCase();
  if (emp !== "salaried") return true;

  // 4. New Validation: Income must be >= 25000 (Parses string correctly)
  const incomeVal = parseFloat(lead.income || 0);
  if (isNaN(incomeVal) || incomeVal < 25000) return true;

  // 5. New Validation: State Exclusions (Case-Insensitive)
  const state = (lead.state || "").trim().toLowerCase();
  
  // Exclude Jammu & Kashmir (Covering multiple variations)
  const isJK = state.includes("jammu") || state.includes("kashmir") || state === "j&k" || state === "j and k";
  
  // Exclude North East States (7 Sisters + Sikkim)
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

  if (isJK || isNorthEast) return true;
  
  return false;
}

// ---------------- TOKEN MANAGMENT WITH AUTO REFRESH ---------------- //

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
  // यहाँ अब doc.name की जगह पूरा doc पास करें
  const [first, last] = splitName(doc); 
  const dobFormatted = formatDob(doc.dob);

  return {
    Campaign: {
      CampaignId: CAMPAIGN_ID,
      IsMobile: false,
    },

    PersonerDetails: {
      FirstName: first,
      LastName: last, // अब यहाँ सही 'Chovatiya' चला जाएगा
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

// Dynamics headers injection inside batch injection to maintain updated tokens
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
  const cursor = leadCol
    .find({
      $or: [
        { processed: { $exists: false } },
        { processed: { $ne: LENDER_NAME } },
      ],
    })
    .skip(SKIP)
    .limit(MAX_LEADS);

  let total = 0;
  let processed = 0;
  let skipped = 0;
  let batch = [];

  for await (const lead of cursor) {
    total++;

    if (shouldSkip(lead)) {
      skipped++;
      continue;
    }

    batch.push(lead);

    if (batch.length === BATCH_SIZE) {
      processed += await processBatch(batch);
      batch = [];
      await sleep(BATCH_DELAY);
    }
  }

  if (batch.length) {
    processed += await processBatch(batch);
  }

  log("INFO", "----- SUMMARY -----");
  log("INFO", `TOTAL FETCHED : ${total}`);
  log("INFO", `PROCESSED     : ${processed}`);
  log("INFO", `SKIPPED       : ${skipped}`);
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