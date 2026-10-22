const fs = require("fs");
const axios = require("axios");
const XLSX = require("xlsx");
const axiosRetry = (() => {
  try {
    return require("axios-retry").default || require("axios-retry");
  } catch {
    return null;
  }
})();
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

// ==================== CONFIGURATION ==================== //

const MONEYJENIE_URL = "https://moneyjenie.com/api/leads";
const API_KEY = process.env.MONEYJENIE_API_KEY || "de7959cd67ef1f9a7a886c74eb5b547ee004ee4c";

const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "coverloop";

const LEAD_COLLECTION = "sm";
const RESPONSE_COLLECTION = "moneyjenie";

const LENDER_NAME = "moneyjenie";

const BATCH_SIZE = 5;
const MAX_THREADS = 500;
const MAX_RETRIES = 300;
const RETRY_BACKOFF = 1.5;
const REQUEST_TIMEOUT = 15000;

const API_CALL_DELAY = 250;
const BATCH_DELAY = 2000;
const THREAD_DELAY = 100;
const MAX_REQUESTS_PER_SECOND = 5;

// Validation Rules (Age 23-55, Min Income 50k, Salaried Only)
const MIN_AGE = 23;
const MAX_AGE = 55;
const MIN_INCOME = 50000;

// ==================== LOAD VALID PINCODES FROM EXCEL ==================== //
let validPincodesSet = new Set();
try {
  if (fs.existsSync("pincodes.xlsx")) {
    const workbook = XLSX.readFile("pincodes.xlsx");
    const sheetName = workbook.SheetNames[0];
    const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    sheetData.forEach(row => {
      const pin = String(row.pincode || row.PIN || Object.values(row)[0]).trim();
      if (pin) validPincodesSet.add(pin);
    });
    console.log(`📦 Loaded ${validPincodesSet.size} valid pincodes from pincodes.xlsx`);
  }
} catch (e) {
  console.log("⚠️ Could not load pincodes.xlsx, relying on standard 6-digit check.");
}

// ==================== LOGGING SETUP ==================== //

const LOG_FILE = "moneyjenie_processing.log";

function log(level, message) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 23);
  const line = `${timestamp} [${level}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {}
}

const logger = {
  info: (msg) => log("INFO", msg),
  warning: (msg) => log("WARNING", msg),
  error: (msg) => log("ERROR", msg),
  debug: (msg) => log("DEBUG", msg),
};

// ==================== MONGO SETUP ==================== //

let mongoClient;
let leadCol;
let responseCol;

async function connectMongo() {
  if (!MONGO_URI) {
    throw new Error("MONGO_URI_COVER is not defined in environment variables!");
  }
  mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);
  leadCol = db.collection(LEAD_COLLECTION);
  responseCol = db.collection(RESPONSE_COLLECTION);
  logger.info("✅ Connected to MongoDB");
}

// ==================== MUTEX & RATE LIMITER ==================== //

class Mutex {
  constructor() {
    this._locking = Promise.resolve();
  }
  lock() {
    let unlockNext;
    const willLock = new Promise((resolve) => (unlockNext = resolve));
    const willUnlock = this._locking.then(() => unlockNext);
    this._locking = this._locking.then(() => willLock);
    return willUnlock;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RateLimiter {
  constructor(maxRatePerSecond) {
    this.maxRate = maxRatePerSecond > 0 ? maxRatePerSecond : 1;
    this.minInterval = 1000 / this.maxRate;
    this.lastCall = Date.now();
    this.mutex = new Mutex();
  }

  async acquire() {
    const unlock = await this.mutex.lock();
    try {
      const current = Date.now();
      const elapsed = current - this.lastCall;
      const waitTime = Math.max(0, this.minInterval - elapsed);
      if (waitTime > 0) await sleep(waitTime);
      this.lastCall = Date.now();
    } finally {
      unlock();
    }
  }
}

const rateLimiter = new RateLimiter(MAX_REQUESTS_PER_SECOND);

class Counters {
  constructor() {
    this.successCount = 0;
    this.traversedLeads = 0;
    this.rejectedLeads = 0;
    this.apiErrors = 0;
  }
  incrementSuccess(c = 1) { this.successCount += c; }
  incrementTraversed(c = 1) { this.traversedLeads += c; }
  incrementRejected(c = 1) { this.rejectedLeads += c; }
  incrementApiErrors(c = 1) { this.apiErrors += c; }
}

const counters = new Counters();

function makeProcessResult({ leadId, phone, pan, status, responses, success }) {
  return { leadId, phone, pan, status, responses, success };
}

const axiosInstance = axios.create();
if (axiosRetry) {
  axiosRetry(axiosInstance, {
    retries: MAX_RETRIES,
    retryDelay: (retryCount) => Math.pow(RETRY_BACKOFF, retryCount) * 1000,
    retryCondition: (error) => [429, 500, 502, 503, 504].includes(error.response?.status),
  });
}

// ==================== VALIDATION FUNCTIONS ==================== //

const INVALID_DATES = new Set(["0000-00-00", "01/01/1900", "01/01/0001", "1900-01-01", "01-01-1900", "1990-01-01"]);

function calculateAge(dobValue) {
  if (!dobValue || INVALID_DATES.has(String(dobValue).trim())) return 0;
  try {
    let dob = null;
    if (dobValue instanceof Date) {
      dob = dobValue;
    } else {
      let dobStr = String(dobValue).trim();
      if (dobStr.includes("T")) dobStr = dobStr.split("T")[0];
      if (!dobStr) return 0;

      if (dobStr.includes("/") && dobStr.length <= 10) {
        const parts = dobStr.split("/");
        if (parts.length === 3 && parts[2].length === 4) {
          const p0 = parseInt(parts[0], 10);
          const p1 = parseInt(parts[1], 10);
          const year = parseInt(parts[2], 10);
          if (p0 >= 1 && p0 <= 12 && p1 >= 1 && p1 <= 31) dob = new Date(year, p0 - 1, p1);
          else if (p1 >= 1 && p1 <= 12 && p0 >= 1 && p0 <= 31) dob = new Date(year, p1 - 1, p0);
        }
      }
      if (!dob && dobStr.length === 10 && dobStr[4] === "-" && dobStr[7] === "-") {
        const [year, month, day] = dobStr.split("-").map(Number);
        dob = new Date(year, month - 1, day);
      }
      if (!dob && dobStr.length === 10 && dobStr[2] === "-" && dobStr[5] === "-") {
        const parts = dobStr.split("-");
        if (parts[2].length === 4) {
          const [day, month, year] = parts.map(Number);
          dob = new Date(year, month - 1, day);
        }
      }
      if (!dob) return 0;
    }

    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const beforeBirthday = today.getMonth() < dob.getMonth() || (today.getMonth() === dob.getMonth() && today.getDate() < dob.getDate());
    if (beforeBirthday) age -= 1;
    return age > 0 && age < 120 ? age : 0;
  } catch (e) {
    return 0;
  }
}

function pad2(n) { return String(n).padStart(2, "0"); }
function pad4(n) { return String(n).padStart(4, "0"); }

function formatDob(dobValue) {
  if (!dobValue) return "1994-05-15";
  try {
    if (dobValue instanceof Date) {
      return `${pad4(dobValue.getFullYear())}-${pad2(dobValue.getMonth() + 1)}-${pad2(dobValue.getDate())}`;
    }
    let dobStr = String(dobValue).trim();
    if (dobStr.includes("T")) dobStr = dobStr.split("T")[0];
    if (dobStr.length === 10 && dobStr[4] === "-" && dobStr[7] === "-") return dobStr;
    const age = calculateAge(dobValue);
    if (age > 0) {
      if (dobStr.includes("/")) {
        const parts = dobStr.split("/");
        if (parts.length === 3) {
          const month = parseInt(parts[0], 10);
          const day = parseInt(parts[1], 10);
          const year = parseInt(parts[2], 10);
          if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
          else if (day >= 1 && day <= 12 && month >= 1 && month <= 31) return `${pad4(year)}-${pad2(day)}-${pad2(month)}`;
        }
      }
    }
    return "1994-05-15";
  } catch (e) {
    return "1994-05-15";
  }
}

function isDigitsOnly(str) { return /^\d+$/.test(String(str)); }

function validateLead(lead) {
  if (!lead.phone || !isDigitsOnly(lead.phone) || String(lead.phone).length !== 10) return [false, "invalid_phone", 0];
  if (!lead.pan || ![10, 12].includes(String(lead.pan).length)) return [false, "invalid_pan", 0];
  
  const pin = String(lead.pincode || "").trim();
  if (!pin || !isDigitsOnly(pin) || pin.length !== 6) return [false, "invalid_pincode", 0];
  if (validPincodesSet.size > 0 && !validPincodesSet.has(pin)) {
    return [false, "pincode_not_whitelisted", 0];
  }

  const empType = String(lead.employment || lead.employeeType || "").toLowerCase();
  if (!empType.includes("salaried")) {
    return [false, "not_salaried", 0];
  }

  const age = calculateAge(lead.dob);
  if (age === 0) return [false, "invalid_dob", age];
  if (age < MIN_AGE) return [false, "age_too_young", age];
  if (age > MAX_AGE) return [false, "age_too_old", age];

  let incomeValue;
  try {
    incomeValue = parseFloat(String(lead.income || lead.monthlyIncome || "0").replace(/,/g, "").trim());
    if (isNaN(incomeValue)) throw new Error("NaN");
  } catch (e) {
    return [false, "invalid_income", age];
  }
  if (incomeValue < MIN_INCOME) return [false, "low_income", age];

  return [true, null, age];
}

// ==================== API REQUEST HANDLING ==================== //

async function sendMoneyJenieRequest(lead) {
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`,
    "X-API-Key": API_KEY,
    "User-Agent": "CoverMantra/1.0"
  };

  const payload = {
    name: String(lead.name || "Rahul Kumar").trim(),
    mobile: String(lead.phone || "9876543210").trim(),
    email: String(lead.email || "rahul.test@example.com").trim(),
    employeeType: "Salaried",
    pancard: String(lead.pan || "ABCDE1234F").toUpperCase().trim(),
    pincode: String(lead.pincode || "110001").trim(),
    state: String(lead.state || "Delhi").trim(),
    city: String(lead.city || "New Delhi").trim(),
    monthlyIncome: parseFloat(lead.income || lead.monthlyIncome) || 50000,
    dob: formatDob(lead.dob),
    bureauPrivacyPolicyConsent: "YES",
    salaryMode: "Bank Transfer",
    loanAmount: parseInt(lead.loan_amount || 150000, 10),
    loanPurpose: "Personal Expenses",
    companyName: String(lead.companyName || "ABC Private Limited").trim(),
    companyAddress: String(lead.companyAddress || lead.city || "New Delhi").trim(),
    utmSource: "Partner API"
  };

  try {
    await rateLimiter.acquire();
    if (API_CALL_DELAY > 0) await sleep(API_CALL_DELAY);

    const response = await axiosInstance.post(MONEYJENIE_URL, payload, {
      headers,
      timeout: REQUEST_TIMEOUT,
      validateStatus: () => true,
    });

    return [response.data, response.status];
  } catch (e) {
    if (e.code === "ECONNABORTED") return [{ error: "Timeout" }, 408];
    if (e.response) return [e.response.data, e.response.status];
    return [{ error: e.message }, 500];
  }
}

async function processSingleLead(lead) {
  try {
    const [isValid, rejectionReason, age] = validateLead(lead);
    if (!isValid) {
      counters.incrementTraversed();
      counters.incrementRejected();
      return makeProcessResult({
        leadId: String(lead._id),
        phone: String(lead.phone),
        pan: lead.pan || "",
        status: `skipped_${rejectionReason}`,
        responses: { validation_error: rejectionReason, age },
        success: false,
      });
    }

    const [respData, respStatus] = await sendMoneyJenieRequest(lead);
    counters.incrementTraversed();

    // Fixed success condition based on actual MoneyJenie response structure (leadID or success message)
    const isSuccess = respStatus >= 200 && respStatus < 300 && respData && 
      (respData.leadID || respData.success === true || respData.status === true || 
       (respData.message && respData.message.toLowerCase().includes("successfully")));

    if (isSuccess) {
      counters.incrementSuccess();
      return makeProcessResult({
        leadId: String(lead._id),
        phone: String(lead.phone),
        pan: lead.pan || "",
        status: "success",
        responses: respData,
        success: true,
      });
    } else {
      return makeProcessResult({
        leadId: String(lead._id),
        phone: String(lead.phone),
        pan: lead.pan || "",
        status: "failed",
        responses: respData,
        success: false,
      });
    }
  } catch (e) {
    counters.incrementTraversed();
    counters.incrementApiErrors();
    return makeProcessResult({
      leadId: String(lead._id),
      phone: String(lead.phone),
      pan: lead.pan || "",
      status: "processing_error",
      responses: { error: e.message },
      success: false,
    });
  }
}

async function runBatchConcurrently(leadsBatch) {
  const results = [];
  const concurrency = Math.min(MAX_THREADS, leadsBatch.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= leadsBatch.length) return;
      const currentLead = leadsBatch[currentIndex];
      try {
        const result = await Promise.race([
          processSingleLead(currentLead),
          sleep(30000).then(() => { throw new Error("Timeout"); }),
        ]);
        if (result) results.push(result);
      } catch (e) {
        counters.incrementApiErrors();
      }
    }
  }

  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(worker());
    if (w < concurrency - 1) await sleep(THREAD_DELAY);
  }
  await Promise.all(workers);
  return results;
}

async function processBatch(leadsBatch, batchNumber) {
  const results = await runBatchConcurrently(leadsBatch);
  await saveResults(results);

  const successfulCount = results.filter((r) => r.success).length;
  logger.info(`✅ BATCH ${batchNumber} COMPLETE (Success: ${successfulCount}/${leadsBatch.length})`);
  return results.length;
}

async function saveResults(results) {
  if (!results.length) return;
  try {
    const apiDocuments = results.map((result) => ({
      leadId: result.leadId,
      phone: result.phone,
      pan: result.pan,
      status: result.status,
      responses: result.responses,
      createdAt: new Date().toISOString().split("T")[0],
    }));

    if (apiDocuments.length > 0) {
      await responseCol.insertMany(apiDocuments, { ordered: false });
    }

    for (const result of results) {
      let tag = LENDER_NAME;
      if (result.status.startsWith("skipped_")) {
        const skipReason = result.status.replace("skipped_", "");
        tag = `${LENDER_NAME}: skipped_${skipReason}`;
      }

      await leadCol.updateOne(
        { _id: new ObjectId(result.leadId) },
        { $pull: { processed: {$regex: `^${LENDER_NAME}`, $options: "i" } } }
      );
      await leadCol.updateOne(
        { _id: new ObjectId(result.leadId) },
        { $addToSet: { processed: tag } }
      );
    }
  } catch (e) {
    logger.error(`❌ Database save error: ${e.message}`);
  }
}

async function main() {
  await connectMongo();
  logger.info("⚡ MONEYJENIE BATCH PROCESSING STARTED");

  try {
    const query = {
      $or: [
        { processed: { $exists: false } },
        { processed: { $regex: `^((?!${LENDER_NAME}).)*$`, $options: "i" } },
      ],
    };

    logger.info("Fetching unprocessed leads from MongoDB...");
    const leads = await leadCol.find(query, { projection: { name: 1, gender: 1, phone: 1, pan: 1, dob: 1, employment: 1, income: 1, pincode: 1, city: 1, state: 1, email: 1, loan_amount: 1, companyName: 1, companyAddress: 1 } }).toArray();
    logger.info(`📊 Total Unprocessed Leads Found: ${leads.length}`);

    let totalProcessedOverall = 0;
    let batchNum = 1;
    let batch = [];

    for (let i = 0; i < leads.length; i++) {
      batch.push(leads[i]);

      if (batch.length === BATCH_SIZE || i === leads.length - 1) {
        logger.info(`🚀 Processing batch ${batchNum} (${batch.length} leads)... Progress: ${i + 1}/${leads.length}`);
        
        const processedCountInBatch = await processBatch(batch, batchNum);
        totalProcessedOverall += processedCountInBatch;

        logger.info(`📊 TOTAL PROCESSED SO FAR: ${totalProcessedOverall}`);

        batch = [];
        batchNum++;
        if (i < leads.length - 1) {
          await sleep(BATCH_DELAY);
        }
      }
    }

    logger.info("🎯 PROCESSING COMPLETE!");
    logger.info(`   • Total Processed: ${totalProcessedOverall}`);
  } catch (e) {
    logger.error(`❌ Main execution error: ${e.message}`);
  } finally {
    if (mongoClient) {
      await mongoClient.close();
    }
    logger.info("🔚 Processing finished");
  }
}

main();