const fs = require("fs");
const axios = require("axios");
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

const FATAKPAY_BASE_URL = "https://onboardingapi.fatakpay.com";
const FATAKPAY_TOKEN_URL = `${FATAKPAY_BASE_URL}/external-api/v1/create-user-token`;
const FATAKPAY_ELIGIBILITY_URL = `${FATAKPAY_BASE_URL}/external-api/v1/emi-insurance-eligibility`;

const MONGO_URI_COVER = process.env.MONGO_URI_COVER;
const FATAKPAY_USERNAME = "CoverMantra";
const FATAKPAY_PASSWORD = "cdcbb765b95f0cf06d0f";
const LENDER_NAME = "fatakpayDCL";

// Processing Configuration
const MAX_LEADS_DAILY = 500000; // 🎯 Strict Daily Limit: 5 Lakhs
const SKIP = 0;
const BATCH_SIZE = 200;       
const MAX_THREADS = 5;        // 429 एरर से बचने के लिए थ्रेड्स कम रखे गए हैं
const MAX_RETRIES = 3;
const RETRY_BACKOFF = 1.5;
const REQUEST_TIMEOUT = 15000; // ms

// Rate Limiting Configuration
const API_CALL_DELAY = 250;   // ms
const BATCH_DELAY = 2000;     // ms
const THREAD_DELAY = 150;     // ms
const MAX_REQUESTS_PER_SECOND = 20;

// Validation Configuration
const MIN_AGE = 18;
const MAX_AGE = 65;
const MIN_INCOME = 15000;

// ==================== LOGGING SETUP ==================== //

const LOG_FILE = "fatakpay_processingDCL.log";

function log(level, message) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 23);
  const line = `${timestamp} - ${level} - ${message}`;
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
  mongoClient = new MongoClient(MONGO_URI_COVER);
  await mongoClient.connect();
  const db = mongoClient.db();
  leadCol = db.collection("keshvadb");
  responseCol = db.collection("fatakdcl");
  logger.info("✅ Connected to MongoDB");
}

// ==================== SIMPLE ASYNC MUTEX ==================== //

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

// ==================== RATE LIMITER ==================== //

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

// ==================== STATISTICS COUNTERS ==================== //

class Counters {
  constructor() {
    this.eligibilitySuccess = 0;
    this.traversedLeads = 0;
    this.rejectedLeads = 0;
    this.apiErrors = 0;
    this.duplicateLeads = 0;
    this.tokenErrors = 0;
    this.tokenRegenerations = 0;
    this.startTime = null;
  }

  startTiming() { this.startTime = Date.now(); }
  incrementEligibility(count = 1) { this.eligibilitySuccess += count; }
  incrementTraversed(count = 1) { this.traversedLeads += count; }
  incrementRejected(count = 1) { this.rejectedLeads += count; }
  incrementApiErrors(count = 1) { this.apiErrors += count; }
  incrementTokenErrors(count = 1) { this.tokenErrors += count; }
  incrementTokenRegenerations(count = 1) { this.tokenRegenerations += count; }
  incrementDuplicate(count = 1) { this.duplicateLeads += count; }
}

const counters = new Counters();

function makeProcessResult({ leadId, phone, pan, status, responses, success, shouldSave = true }) {
  return { leadId, phone, pan, status, responses, success, shouldSave };
}

// ==================== API CLIENT ==================== //

class FatakPayAPIClient {
  constructor() {
    this.token = null;
    this.tokenExpiry = null;
    this.credentials = { username: FATAKPAY_USERNAME, password: FATAKPAY_PASSWORD };
    this._tokenLock = new Mutex();
    this.axios = this._createAxiosInstance();
  }

  _createAxiosInstance() {
    const instance = axios.create();
    if (axiosRetry) {
      axiosRetry(instance, {
        retries: MAX_RETRIES,
        retryDelay: (retryCount) => Math.pow(RETRY_BACKOFF, retryCount) * 1000,
        retryCondition: (error) => [429, 500, 502, 503, 504].includes(error.response?.status),
      });
    }
    return instance;
  }

  async ensureToken() {
    const unlock = await this._tokenLock.lock();
    try {
      if (this.token && this.tokenExpiry && new Date() < this.tokenExpiry) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        const token = await this.getToken();
        if (token) {
          this.token = token;
          this.tokenExpiry = new Date(Date.now() + 55 * 60 * 1000);
          return;
        }
        if (attempt < 2) await sleep(2000);
      }
    } finally {
      unlock();
    }
  }

  async forceTokenRegeneration() {
    const unlock = await this._tokenLock.lock();
    try {
      this.token = null;
      this.tokenExpiry = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const token = await this.getToken();
        if (token) {
          this.token = token;
          this.tokenExpiry = new Date(Date.now() + 55 * 60 * 1000);
          counters.incrementTokenRegenerations();
          return true;
        }
        await sleep(1000);
      }
      counters.incrementTokenErrors();
      return false;
    } finally {
      unlock();
    }
  }

  async getToken() {
    try {
      const response = await this.axios.post(FATAKPAY_TOKEN_URL, this.credentials, {
        headers: { "Content-Type": "application/json", "User-Agent": "CoverMantra/1.0" },
        timeout: 20000,
        validateStatus: () => true,
      });
      if (response.status !== 200) return null;
      return response.data?.data?.token || null;
    } catch (e) {
      return null;
    }
  }
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

function formatDobForFatakpay(dobValue) {
  if (!dobValue) return "1990-01-01";
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
    return "1990-01-01";
  } catch (e) {
    return "1990-01-01";
  }
}

function isDigitsOnly(str) { return /^\d+$/.test(String(str)); }

function validateLead(lead) {
  if (!lead.phone || !isDigitsOnly(lead.phone) || String(lead.phone).length !== 10) return [false, "invalid_phone", 0];
  if (!lead.pan || ![10, 12].includes(String(lead.pan).length)) return [false, "invalid_pan", 0];
  if (!lead.pincode || !isDigitsOnly(lead.pincode)) return [false, "invalid_pincode", 0];

  const age = calculateAge(lead.dob);
  if (age === 0) return [false, "invalid_dob", age];
  if (age < MIN_AGE) return [false, "age_too_young", age];
  if (age > MAX_AGE) return [false, "age_too_old", age];

  let incomeValue;
  try {
    incomeValue = parseFloat(String(lead.income || "0").replace(/,/g, "").trim());
    if (isNaN(incomeValue)) throw new Error("NaN");
  } catch (e) {
    return [false, "invalid_income", age];
  }
  if (incomeValue < MIN_INCOME) return [false, "low_income", age];

  return [true, null, age];
}

function getConsentTimestamp() { return new Date().toISOString().slice(0, 19); }
function getCurrentDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ==================== API REQUEST HANDLING ==================== //

async function makeFatakpayRequest(client, token, payload) {
  const headers = { "Content-Type": "application/json", Authorization: token ? `Token ${token}` : "", "User-Agent": "CoverMantra/1.0" };
  try {
    await rateLimiter.acquire();
    if (API_CALL_DELAY > 0) await sleep(API_CALL_DELAY);
    const response = await client.axios.post(FATAKPAY_ELIGIBILITY_URL, payload, { headers, timeout: REQUEST_TIMEOUT, validateStatus: () => true });
    if (response.status === 401) return [response.data ?? { error: "Unauthorized" }, "token_expired"];
    if (response.status !== 200) return [response.data ?? { error: `HTTP ${response.status}` }, `http_error_${response.status}`];
    return [response.data, "success"];
  } catch (e) {
    if (e.code === "ECONNABORTED") return [null, "timeout"];
    if (e.response) {
      if (e.response.status === 401) return [e.response.data, "token_expired"];
      return [e.response.data, `http_error_${e.response.status}`];
    }
    return [null, "network_error"];
  }
}

function analyzeFatakpayResponse(responseData) {
  const analysis = { success: false, eligibilityStatus: false, message: "Unknown", reason: "Not analyzed" };
  if (!responseData) return analysis;
  try {
    if (responseData.success === true) {
      analysis.success = true;
      const data = responseData.data || {};
      analysis.eligibilityStatus = Boolean(data.eligibility_status);
      analysis.message = responseData.message || "No message";
      analysis.reason = data.reason || "No reason provided";
    } else {
      analysis.success = false;
      analysis.message = responseData.message || "API returned failure";
      analysis.reason = responseData.error || "No error details";
    }
  } catch (e) {
    analysis.message = `Analysis error: ${e.message}`;
  }
  return analysis;
}

// ==================== CORE PROCESSING FUNCTIONS ==================== //

async function checkFatakpayEligibility(lead, client) {
  const responses = { eligibility: null, error: null, createdDate: getCurrentDate() };
  try {
    const nameParts = (lead.name || "").split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "kumar";

    const payload = {
      mobile: parseInt(lead.phone, 10),
      partnerId: "Covermantra",
      first_name: firstName,
      last_name: lastName,
      email: lead.email || "test@example.com",
      employment_type_id: lead.employment || "Salaried",
      pan: (lead.pan || "").toUpperCase(),
      dob: formatDobForFatakpay(lead.dob),
      pincode: parseInt(lead.pincode, 10),
      consent: true,
      consent_timestamp: getConsentTimestamp(),
    };

    let [eligibilityResp, status] = await makeFatakpayRequest(client, client.token, payload);
    responses.eligibility = eligibilityResp;

    if (status === "token_expired" || (typeof status === "string" && status.startsWith("http_error_401"))) {
      counters.incrementTokenErrors();
      const regenerated = await client.forceTokenRegeneration();
      if (regenerated) {
        [eligibilityResp, status] = await makeFatakpayRequest(client, client.token, payload);
        responses.eligibility = eligibilityResp;
      } else {
        return makeProcessResult({ leadId: String(lead._id), phone: String(lead.phone), pan: lead.pan || "", status: "token_expired", responses, success: false });
      }
    }

    const analysis = analyzeFatakpayResponse(eligibilityResp);

    if (analysis.success && analysis.eligibilityStatus) {
      counters.incrementEligibility();
      return makeProcessResult({ leadId: String(lead._id), phone: String(lead.phone), pan: lead.pan || "", status: "eligible", responses, success: true });
    } else if (analysis.success && !analysis.eligibilityStatus) {
      return makeProcessResult({ leadId: String(lead._id), phone: String(lead.phone), pan: lead.pan || "", status: "not_eligible", responses, success: false });
    } else if (String(analysis.message).toLowerCase().includes("already exists")) {
      counters.incrementDuplicate();
      return makeProcessResult({ leadId: String(lead._id), phone: String(lead.phone), pan: lead.pan || "", status: "duplicate", responses, success: false });
    } else {
      return makeProcessResult({ leadId: String(lead._id), phone: String(lead.phone), pan: lead.pan || "", status: "not_eligible", responses, success: false });
    }
  } catch (e) {
    counters.incrementApiErrors();
    responses.error = { message: e.message };
    return makeProcessResult({ leadId: String(lead._id), phone: String(lead.phone), pan: lead.pan || "", status: "api_error", responses, success: false });
  }
}

async function processSingleLead(client, lead) {
  try {
    const [isValid, rejectionReason, age] = validateLead(lead);
    if (!isValid) {
      counters.incrementTraversed();
      counters.incrementRejected();
      return makeProcessResult({ leadId: String(lead._id), phone: String(lead.phone), pan: lead.pan || "", status: "validation_failed", responses: { validation_error: rejectionReason, age }, success: false });
    }

    await client.ensureToken();
    const result = await checkFatakpayEligibility(lead, client);
    counters.incrementTraversed();
    return result;
  } catch (e) {
    counters.incrementTraversed();
    counters.incrementApiErrors();
    return makeProcessResult({ leadId: String(lead._id), phone: String(lead.phone), pan: lead.pan || "", status: "processing_error", responses: { error: e.message }, success: false });
  }
}

// ==================== BATCH PROCESSING ==================== //

async function getLeadsBatch(skip, limit) {
  return leadCol
    .find(
      {
        $or: [
          { processed: { $exists: false } },
          { processed: { $regex: `^((?!${LENDER_NAME}).)*$`, $options: "i" } },
        ],
      },
      { projection: { name: 1, gender: 1, phone: 1, pan: 1, dob: 1, employment: 1, income: 1, pincode: 1, city: 1, state: 1, email: 1 } },
    )
    .skip(skip)
    .limit(limit)
    .toArray();
}

async function runBatchConcurrently(client, leadsBatch) {
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
          processSingleLead(client, currentLead),
          sleep(45000).then(() => { throw new Error("processSingleLead timed out after 45s"); }),
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

async function processBatch(client, leadsBatch, batchNumber) {
  await client.ensureToken();
  if (!client.token) return 0;
  const results = await runBatchConcurrently(client, leadsBatch);
  await saveResults(results);
  const successfulCount = results.filter((r) => r.success).length;
  logger.info(`✅ BATCH ${batchNumber} COMPLETE (Success: ${successfulCount}/${leadsBatch.length})`);
  return results.length;
}

async function saveResults(results) {
  if (!results.length) return;
  try {
    const apiDocuments = results
      .filter((r) => r.status !== "validation_failed")
      .map((result) => ({
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

    // 🎯 पुराना टैग हटाकर केवल एक सिंगल टैग रखने का लॉजिक
    for (const result of results) {
      let tag = LENDER_NAME;
      if (result.status === "validation_failed" && result.responses?.validation_error) {
        tag = `${LENDER_NAME}: skipped_${result.responses.validation_error}`;
      } else if (result.status === "duplicate") {
        tag = `${LENDER_NAME}: skipped_duplicate`;
      }

      await leadCol.updateOne(
        { _id: new ObjectId(result.leadId) },
        { 
          $pull: { processed: { $regex: `^${LENDER_NAME}`, $options: "i" } } 
        }
      );
      await leadCol.updateOne(
        { _id: new ObjectId(result.leadId) },
        { 
          $addToSet: { processed: tag } 
        }
      );
    }
  } catch (e) {
    logger.error(`❌ Database save error: ${e.message}`);
  }
}

// ==================== MAIN EXECUTION ==================== //

async function main() {
  const startTime = Date.now();
  await connectMongo();

  logger.info("⚡ HIGH-PERFORMANCE PROCESSING STARTED (Strict Daily Limit: 5 Lakhs)");
  counters.startTiming();
  const client = new FatakPayAPIClient();

  try {
    await client.ensureToken();
    if (!client.token) {
      logger.error("❌ FatakPay API client failed to initialize - no token");
      return;
    }

    let totalProcessedToday = 0;
    let batchNum = 1;

    while (totalProcessedToday < MAX_LEADS_DAILY) {
      if (totalProcessedToday >= MAX_LEADS_DAILY) {
        logger.info("🛑 Daily limit of 5,00,000 reached. Stopping execution.");
        break;
      }

      const remainingLimit = MAX_LEADS_DAILY - totalProcessedToday;
      const currentLimit = Math.min(BATCH_SIZE, remainingLimit);

      const leadsBatch = await getLeadsBatch(SKIP, currentLimit);
      if (leadsBatch.length === 0) {
        logger.info("🏁 No more unprocessed leads found in the database. Exiting loop.");
        break;
      }

      const processedCountInBatch = await processBatch(client, leadsBatch, batchNum);
      totalProcessedToday += processedCountInBatch;

      logger.info(`📊 DAILY PROGRESS: ${totalProcessedToday}/${MAX_LEADS_DAILY} leads processed today.`);

      if (totalProcessedToday >= MAX_LEADS_DAILY) {
        logger.info("🛑 Daily limit of 5,00,000 hits reached. Stopping script for today!");
        break;
      }

      batchNum++;
      await sleep(BATCH_DELAY);
    }

    const totalTime = (Date.now() - startTime) / 1000;
    logger.info("🎯 DAILY PROCESSING COMPLETE!");
    logger.info(`   • Total Processed Today: ${totalProcessedToday}`);
    logger.info(`   • Total Time Taken: ${totalTime.toFixed(1)}s`);
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