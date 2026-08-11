const { MongoClient } = require("mongodb");
const axios = require("axios");
const path = require("path");
const XLSX = require("xlsx");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "cover";

const LEAD_COLLECTION = "smcoll";
const RESPONSE_COLLECTION = "credittLeadResponses";

// --- CREDITT / CREDIFY API CONFIGURATION --- //
const AGENCY_ID = "abc_agency"; // अपनी अप्रूव्ड एजेंसी ID यहाँ डालें
const BASE_URL = `https://agency.ctpl.live/lead/ingest/${AGENCY_ID}`;

const LENDER_NAME = "creditt";

// ------------ LOAD PINCODES FROM EXCEL ------------ //
const PINCODE_FILE_PATH = path.join(__dirname, "xlsx", "creditplus.xlsx");

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

    console.log(`✅ Loaded ${pincodes.size} valid pincodes from Excel.`);
    return pincodes;
  } catch (error) {
    console.error(`❌ Error loading pincode file: ${error.message}`);
    return new Set();
  }
}

const allowedPincodes = loadValidPincodes();

// ------------ CONTROL ------------ //

const MAX_LEADS = 500000;
const SKIP = 1;
const BATCH_SIZE = 100;
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
    const yyyy = dob.getFullYear();
    const mm = String(dob.getMonth() + 1).padStart(2, "0");
    const dd = String(dob.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  if (typeof dob === "string") {
    dob = dob.trim();
    if (dob.includes("T")) {
      dob = dob.split("T")[0];
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      return dob;
    }

    const parts = dob.split(/[\/\-]/);
    if (parts.length === 3) {
      if (parts[0].length === 4) {
        return `${parts[0]}-${parts[1]}-${parts[2]}`;
      } else {
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
      }
    }
  }

  return null;
}

function shouldSkip(lead) {
  const required = ["phone", "pincode"];
  for (const field of required) {
    if (!lead[field]) return true;
  }
  
  if (lead.processed && Array.isArray(lead.processed)) {
    const hasAlreadyProcessed = lead.processed.some(
      (lender) => String(lender).toLowerCase() === LENDER_NAME.toLowerCase()
    );
    if (hasAlreadyProcessed) return true;
  }

  const leadPincode = String(lead.pincode || "").trim();
  if (allowedPincodes.size > 0 && !allowedPincodes.has(leadPincode)) {
    return true; 
  }
  
  return false;
}

// ---------------- PAYLOAD BUILDER ---------------- //

function buildPayload(doc) {
  const dobFormatted = formatDob(doc.dob);

  return {
    phoneNumber: String(doc.phone || "").trim(),
    panNumber: doc.pan ? String(doc.pan).trim().toUpperCase() : undefined,
    data: {
      email: doc.email || "NA",
      customer_name: doc.name ? String(doc.name).trim() : "NA",
      dob: dobFormatted || "1992-08-15",
      emp_type: doc.employment ? String(doc.employment).toLowerCase() : "organic",
      salary: String(doc.income || "25000"),
      addresss: doc.address || doc.addresss || "NA",
      city: doc.city || "NA",
      pincode: String(doc.pincode || "").trim()
    }
  };
}

// ---------------- WORKER ---------------- //

async function sendLead(lead) {
  const payload = buildPayload(lead);
  console.log("Sending payload for:", lead.name, "Phone:", lead.phoneNumber || lead.phone);

  let apiResponse;
  let isSuccess = false;

  const headers = {
    "Content-Type": "application/json"
  };

  try {
    const res = await axios.post(BASE_URL, payload, {
      headers,
      timeout: REQUEST_TIMEOUT,
    });
    apiResponse = res.data;
    
    if (apiResponse && (apiResponse.status === true || apiResponse.message === "SUCCESS")) {
      isSuccess = true;
    }
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
      pincode: lead.pincode,
      status: isSuccess ? "SUCCESS" : (apiResponse?.message || "FAILED"),
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
      if (currentIndex >= items.length) break;

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
  return runWithConcurrencyLimit(batch, MAX_WORKERS, (lead) =>
    sendLead(lead)
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
    if (allowedPincodes.size === 0) {
      log("ERROR", "❌ No pincodes loaded from Excel. Aborting execution.");
      return;
    }

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