const fs = require("fs");
const axios = require("axios");
const axiosRetry = (() => {
  try {
    return require("axios-retry").default || require("axios-retry");
  } catch {
    return null; // optional dependency, see setupRetry()
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
const MAX_LEADS = 700000;
const SKIP = 0;
const BATCH_SIZE = 1000;
const MAX_THREADS = 40; // max concurrency per batch
const MAX_RETRIES = 3;
const RETRY_BACKOFF = 1.5;
const REQUEST_TIMEOUT = 15000; // ms

// Rate Limiting Configuration
const API_CALL_DELAY = 0; // ms
const BATCH_DELAY = 800; // ms
const THREAD_DELAY = 300; // ms - stagger between task starts, mirrors Python
const MAX_REQUESTS_PER_SECOND = 5000;

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
  } catch (e) {
    // ignore file logging failures
  }
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
  const db = mongoClient.db(); // db name comes from the URI path, matches mongoengine's connect(host=...)
  leadCol = db.collection("smcoll");
  responseCol = db.collection("fatakpayDCLResponse");
  logger.info("✅ Connected to MongoDB");
}

// ==================== SIMPLE ASYNC MUTEX ==================== //
// JS is single-threaded, but overlapping awaits between concurrent tasks
// can still interleave token reads/writes, so we keep an explicit lock
// just like the Python threading.Lock() usage.

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
// Token bucket rate limiter for API calls

class RateLimiter {
  constructor(maxRatePerSecond) {
    this.maxRate = maxRatePerSecond > 0 ? maxRatePerSecond : 1;
    this.minInterval = 1000 / this.maxRate; // ms
    this.lastCall = Date.now();
    this.mutex = new Mutex();
  }

  async acquire() {
    const unlock = await this.mutex.lock();
    try {
      const current = Date.now();
      const elapsed = current - this.lastCall;
      const waitTime = Math.max(0, this.minInterval - elapsed);
      if (waitTime > 0) {
        await sleep(waitTime);
      }
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
    this.successfulLeads = [];
    this.failedLeads = [];
  }

  startTiming() {
    this.startTime = Date.now();
  }

  incrementEligibility(count = 1) {
    this.eligibilitySuccess += count;
  }
  incrementTraversed(count = 1) {
    this.traversedLeads += count;
  }
  incrementRejected(count = 1) {
    this.rejectedLeads += count;
  }
  incrementApiErrors(count = 1) {
    this.apiErrors += count;
  }
  incrementTokenErrors(count = 1) {
    this.tokenErrors += count;
  }
  incrementTokenRegenerations(count = 1) {
    this.tokenRegenerations += count;
  }
  incrementDuplicate(count = 1) {
    this.duplicateLeads += count;
  }

  addSuccessfulLead(phone, status, details = "") {
    this.successfulLeads.push({
      phone,
      status,
      details,
      timestamp: new Date().toTimeString().slice(0, 8),
    });
    if (this.successfulLeads.length > 50) {
      this.successfulLeads = this.successfulLeads.slice(-50);
    }
  }

  addFailedLead(phone, status, errorDetails = "") {
    this.failedLeads.push({
      phone,
      status,
      error: errorDetails,
      timestamp: new Date().toTimeString().slice(0, 8),
    });
    if (this.failedLeads.length > 50) {
      this.failedLeads = this.failedLeads.slice(-50);
    }
  }

  getStats() {
    const totalTime = this.startTime ? (Date.now() - this.startTime) / 1000 : 0;
    return {
      traversedLeads: this.traversedLeads,
      eligibilitySuccess: this.eligibilitySuccess,
      rejectedLeads: this.rejectedLeads,
      apiErrors: this.apiErrors,
      duplicateLeads: this.duplicateLeads,
      tokenErrors: this.tokenErrors,
      tokenRegenerations: this.tokenRegenerations,
      totalTime,
      currentRate: totalTime > 0 ? this.traversedLeads / totalTime : 0,
      recentSuccessful: this.successfulLeads.slice(-10),
      recentFailed: this.failedLeads.slice(-10),
    };
  }
}

const counters = new Counters();

// ==================== DATA TRANSFER OBJECT ==================== //

function makeProcessResult({ leadId, phone, pan, status, responses, success, shouldSave = true }) {
  return { leadId, phone, pan, status, responses, success, shouldSave };
}

// ==================== API CLIENT ==================== //

class FatakPayAPIClient {
  constructor() {
    this.token = null;
    this.tokenExpiry = null;
    this.credentials = {
      username: FATAKPAY_USERNAME,
      password: FATAKPAY_PASSWORD,
    };
    this._tokenLock = new Mutex();
    this.axios = this._createAxiosInstance();
  }

  _createAxiosInstance() {
    const instance = axios.create();
    if (axiosRetry) {
      axiosRetry(instance, {
        retries: MAX_RETRIES,
        retryDelay: (retryCount) => Math.pow(RETRY_BACKOFF, retryCount) * 1000,
        retryCondition: (error) =>
          [429, 500, 502, 503, 504].includes(error.response?.status),
      });
    } else {
      logger.warning(
        "⚠️ axios-retry not installed — retries on 429/5xx are disabled. Run `npm install axios-retry` to enable them.",
      );
    }
    return instance;
  }

  async ensureToken() {
    const unlock = await this._tokenLock.lock();
    try {
      const now = new Date();
      if (this.token && this.tokenExpiry && now < this.tokenExpiry) {
        return; // still valid
      }
      logger.info("🔄 Generating new token...");
      for (let attempt = 0; attempt < 3; attempt++) {
        const token = await this.getToken();
        if (token) {
          this.token = token;
          this.tokenExpiry = new Date(Date.now() + 55 * 60 * 1000); // 55 min safe window
          logger.info("✅ New token generated successfully");
          return;
        } else {
          logger.warning(`⚠️ Token generation failed, attempt ${attempt + 1}/3`);
          if (attempt < 2) await sleep(2000);
        }
      }
      logger.error("❌ Failed to generate token after 3 attempts");
    } finally {
      unlock();
    }
  }

  async forceTokenRegeneration() {
    const unlock = await this._tokenLock.lock();
    try {
      logger.warning("🔄 Force regenerating token...");
      this.token = null;
      this.tokenExpiry = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const token = await this.getToken();
        if (token) {
          this.token = token;
          this.tokenExpiry = new Date(Date.now() + 55 * 60 * 1000);
          counters.incrementTokenRegenerations();
          logger.info("✅ Forced token regeneration successful");
          return true;
        } else {
          logger.warning(`⚠️ Forced regeneration attempt ${attempt + 1} failed`);
          await sleep(1000);
        }
      }
      counters.incrementTokenErrors();
      logger.error("❌ Forced token regeneration failed after attempts");
      return false;
    } finally {
      unlock();
    }
  }

  async getToken() {
    try {
      logger.info("🔑 Making token request...");

      const response = await this.axios.post(FATAKPAY_TOKEN_URL, this.credentials, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "CoverMantra/1.0",
        },
        timeout: 20000,
        validateStatus: () => true, // handle non-2xx ourselves, like requests without raise_for_status
      });

      logger.info(`🔑 Token response status: ${response.status}`);

      if (response.status !== 200) {
        logger.error(`🔑 Token API returned status: ${response.status}`);
        logger.error(`🔑 Token response text: ${JSON.stringify(response.data)}`);
        return null;
      }

      const data = response.data;
      logger.info(`🔑 Token API response: ${JSON.stringify(data)}`);

      const token = data?.data?.token;
      if (!token) {
        logger.error("❌ Token not found in response data");
        return null;
      }

      logger.info("✅ Token successfully extracted");
      return token;
    } catch (e) {
      logger.error(`❌ Error fetching token: ${e.message}`);
      return null;
    }
  }
}

// ==================== VALIDATION FUNCTIONS ==================== //

const INVALID_DATES = new Set([
  "0000-00-00",
  "01/01/1900",
  "01/01/0001",
  "1900-01-01",
  "01-01-1900",
  "1990-01-01",
]);

function isValidCalendarDate(year, month, day) {
  const dt = new Date(year, month - 1, day);
  return (
    dt.getFullYear() === year && dt.getMonth() === month - 1 && dt.getDate() === day
  );
}

/** Calculate age from DOB with enhanced validation for multiple formats */
function calculateAge(dobValue) {
  if (!dobValue) return 0;

  if (INVALID_DATES.has(String(dobValue).trim())) return 0;

  try {
    let dob = null;

    if (dobValue instanceof Date) {
      dob = dobValue;
    } else {
      let dobStr = String(dobValue).trim();
      if (dobStr.includes("T")) dobStr = dobStr.split("T")[0];
      if (!dobStr) return 0;

      // Format 1: MM/DD/YYYY or DD/MM/YYYY (like "3/18/1996")
      if (dobStr.includes("/") && dobStr.length <= 10) {
        const parts = dobStr.split("/");
        if (parts.length === 3 && parts[0].length <= 2 && parts[1].length <= 2 && parts[2].length === 4) {
          const month = parseInt(parts[0], 10);
          const day = parseInt(parts[1], 10);
          const year = parseInt(parts[2], 10);
          if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            dob = new Date(year, month - 1, day); // MM/DD/YYYY
          } else if (day >= 1 && day <= 12 && month >= 1 && month <= 31) {
            dob = new Date(year, day - 1, month); // DD/MM/YYYY, swapped
          }
        }
      }

      // Format 2: YYYY-MM-DD
      if (!dob && dobStr.length === 10 && dobStr[4] === "-" && dobStr[7] === "-") {
        const [year, month, day] = dobStr.split("-").map(Number);
        dob = new Date(year, month - 1, day);
      }

      // Format 3: DD-MM-YYYY
      if (!dob && dobStr.length === 10 && dobStr[2] === "-" && dobStr[5] === "-") {
        const parts = dobStr.split("-");
        if (parts[2].length === 4) {
          const [day, month, year] = parts.map(Number);
          dob = new Date(year, month - 1, day);
        }
      }

      // Format 4: single-digit months/days without leading zeros, MM/DD/YYYY fallback
      if (!dob && dobStr.includes("/")) {
        const parts = dobStr.split("/");
        if (parts.length === 3) {
          const month = parseInt(parts[0], 10);
          const day = parseInt(parts[1], 10);
          const year = parseInt(parts[2], 10);
          const currentYear = new Date().getFullYear();
          if (
            !isNaN(month) &&
            !isNaN(day) &&
            !isNaN(year) &&
            month >= 1 &&
            month <= 12 &&
            day >= 1 &&
            day <= 31 &&
            year >= 1900 &&
            year <= currentYear
          ) {
            dob = new Date(year, month - 1, day);
          }
        }
      }

      if (!dob) return 0;
    }

    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const beforeBirthday =
      today.getMonth() < dob.getMonth() ||
      (today.getMonth() === dob.getMonth() && today.getDate() < dob.getDate());
    if (beforeBirthday) age -= 1;

    return age > 0 && age < 120 ? age : 0;
  } catch (e) {
    logger.warning(`⚠️ DOB parsing error for '${dobValue}': ${e.message}`);
    return 0;
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function pad4(n) {
  return String(n).padStart(4, "0");
}

/** Format DOB for FatakPay API with multiple format support */
function formatDobForFatakpay(dobValue) {
  if (!dobValue) return "1990-01-01";

  try {
    if (dobValue instanceof Date) {
      return `${pad4(dobValue.getFullYear())}-${pad2(dobValue.getMonth() + 1)}-${pad2(dobValue.getDate())}`;
    }

    let dobStr = String(dobValue).trim();
    if (dobStr.includes("T")) dobStr = dobStr.split("T")[0];

    // Already YYYY-MM-DD
    if (dobStr.length === 10 && dobStr[4] === "-" && dobStr[7] === "-") {
      return dobStr;
    }

    const age = calculateAge(dobValue);
    if (age > 0) {
      if (dobStr.includes("/")) {
        const parts = dobStr.split("/");
        if (parts.length === 3) {
          const month = parseInt(parts[0], 10);
          const day = parseInt(parts[1], 10);
          const year = parseInt(parts[2], 10);
          if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            return `${pad4(year)}-${pad2(month)}-${pad2(day)}`; // MM/DD/YYYY
          } else if (day >= 1 && day <= 12 && month >= 1 && month <= 31) {
            return `${pad4(year)}-${pad2(day)}-${pad2(month)}`; // DD/MM/YYYY swapped
          }
        }
      }
      return "1990-01-01"; // fallback, matches Python's fallback behaviour
    }
    return "1990-01-01";
  } catch (e) {
    logger.warning(`⚠️ DOB formatting error for '${dobValue}': ${e.message}`);
    return "1990-01-01";
  }
}

function isDigitsOnly(str) {
  return /^\d+$/.test(String(str));
}

/** Validate lead data before processing. Returns [isValid, rejectionReason, age] */
function validateLead(lead) {
  logger.info(`🔍 Validating lead: ${lead.phone}`);
  logger.info(`🔍 DOB ANALYSIS for ${lead.phone}:`);
  logger.info(`   📅 Original DOB: '${lead.dob}'`);
  logger.info(`   📅 DOB Type: ${typeof lead.dob}`);

  const age = calculateAge(lead.dob);
  const formattedDob = formatDobForFatakpay(lead.dob);

  logger.info(`   📅 Calculated Age: ${age}`);
  logger.info(`   📅 Formatted for API: ${formattedDob}`);

  // Phone validation
  if (!lead.phone || !isDigitsOnly(lead.phone) || String(lead.phone).length !== 10) {
    logger.warning(`❌ Invalid phone: ${lead.phone}`);
    return [false, "invalid_phone", age];
  }

  // PAN validation
  if (!lead.pan || ![10, 12].includes(String(lead.pan).length)) {
    logger.warning(`❌ Invalid PAN: ${lead.pan}`);
    return [false, "invalid_pan", age];
  }

  // Pincode validation
  if (!lead.pincode || !isDigitsOnly(lead.pincode)) {
    logger.warning(`❌ Invalid pincode: ${lead.pincode}`);
    return [false, "invalid_pincode", age];
  }

  logger.info(`🔍 Final age for validation: ${age}`);

  if (age === 0) {
    logger.warning(`❌ Invalid DOB: ${lead.dob}`);
    return [false, "invalid_dob", age];
  }
  if (age < MIN_AGE) {
    logger.warning(`❌ Age too young: ${age}`);
    return [false, "age_too_young", age];
  }
  if (age > MAX_AGE) {
    logger.warning(`❌ Age too old: ${age}`);
    return [false, "age_too_old", age];
  }

  // Income validation
  let incomeValue;
  try {
    incomeValue = lead.income ? parseFloat(lead.income) : 0;
    if (isNaN(incomeValue)) throw new Error("NaN");
    logger.info(`🔍 Income value: ${incomeValue}`);
  } catch (e) {
    logger.warning(`❌ Invalid income: ${lead.income}`);
    return [false, "invalid_income", age];
  }

  if (incomeValue < MIN_INCOME) {
    logger.warning(`❌ Income too low: ${incomeValue}`);
    return [false, "low_income", age];
  }

  logger.info(`✅ Lead validation passed: ${lead.phone}`);
  return [true, null, age];
}

// ==================== UTILITY FUNCTIONS ==================== //

function getConsentTimestamp() {
  return new Date().toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
}

function getCurrentDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ==================== API REQUEST HANDLING ==================== //

/**
 * Make API request to FatakPay with rate limiting and error handling.
 * Returns [responseDataOrErrorObj, statusString]
 */
async function makeFatakpayRequest(client, token, payload) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: token ? `Token ${token}` : "",
    "User-Agent": "CoverMantra/1.0",
  };

  const phone = payload.mobile || "unknown";

  try {
    logger.info(`⏳ Rate limiting for ${phone}...`);
    await rateLimiter.acquire();
    if (API_CALL_DELAY > 0) await sleep(API_CALL_DELAY);

    logger.info(`📤 Making API request for ${phone}...`);
    logger.debug(`📤 Request payload for ${phone}: ${JSON.stringify(payload)}`);

    const start = Date.now();
    const response = await client.axios.post(FATAKPAY_ELIGIBILITY_URL, payload, {
      headers,
      timeout: REQUEST_TIMEOUT,
      validateStatus: () => true,
    });
    const responseTime = (Date.now() - start) / 1000;

    logger.info(
      `📥 API response for ${phone} - Status: ${response.status}, Time: ${responseTime.toFixed(2)}s`,
    );
    logger.debug(`📥 Response headers for ${phone}: ${JSON.stringify(response.headers)}`);

    if (response.status === 401) {
      const errorData = response.data ?? { error: "Unauthorized" };
      logger.warning(`⚠️ 401 Unauthorized for ${phone}: ${JSON.stringify(errorData)}`);
      return [errorData, "token_expired"];
    }

    if (response.status !== 200) {
      logger.warning(`⚠️ Non-200 response for ${phone}: ${response.status}`);
      logger.warning(`⚠️ Response text: ${JSON.stringify(response.data).slice(0, 500)}`);
      const errorData = response.data ?? { error: `HTTP ${response.status}` };
      return [errorData, `http_error_${response.status}`];
    }

    logger.info(`✅ API success for ${phone}`);
    logger.debug(`✅ Full response for ${phone}: ${JSON.stringify(response.data)}`);

    return [response.data, "success"];
  } catch (e) {
    if (e.code === "ECONNABORTED") {
      logger.error(`⏰ TIMEOUT for ${phone} after ${REQUEST_TIMEOUT / 1000}s`);
      return [null, "timeout"];
    }
    if (e.response) {
      const statusCode = e.response.status;
      const errorData = e.response.data ?? { error: e.message };
      logger.error(`🌐 HTTP ${statusCode} for ${phone}`);
      logger.error(`🌐 Error response: ${JSON.stringify(errorData)}`);
      if (statusCode === 401) return [errorData, "token_expired"];
      return [errorData, `http_error_${statusCode}`];
    }
    if (e.request) {
      logger.error(`🌐 NETWORK ERROR for ${phone}: ${e.message}`);
      return [null, "network_error"];
    }
    logger.error(`💥 UNEXPECTED ERROR for ${phone}: ${e.message}`);
    return [null, "unexpected_error"];
  }
}

/** Comprehensive analysis of FatakPay API response */
function analyzeFatakpayResponse(responseData) {
  const analysis = {
    success: false,
    eligibilityStatus: false,
    message: "Unknown",
    reason: "Not analyzed",
    hasLoanApp: false,
    productType: null,
    amount: 0,
  };

  if (!responseData) {
    analysis.message = "Null response";
    return analysis;
  }

  try {
    if (responseData.success === true) {
      analysis.success = true;
      const data = responseData.data || {};

      analysis.eligibilityStatus = Boolean(data.eligibility_status);
      analysis.message = responseData.message || "No message";
      analysis.reason = data.reason || "No reason provided";
      analysis.hasLoanApp = Boolean(data.loan_application_id);
      analysis.productType = data.product_type ?? null;
      analysis.amount = data.max_eligibility_amount || 0;
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
    console.log(payload);

    logger.info(`🎯 PROCESSING LEAD: ${lead.phone}`);
    logger.info(`   📝 Name: ${firstName} ${lastName}`);
    logger.info(`   📝 PAN: ${lead.pan}`);
    logger.info(`   📝 DOB: ${formatDobForFatakpay(lead.dob)}`);
    logger.info(`   📝 Pincode: ${lead.pincode}`);
    logger.info(`   📝 Income: ${lead.income}`);

    let [eligibilityResp, status] = await makeFatakpayRequest(client, client.token, payload);
    responses.eligibility = eligibilityResp;

    if (status === "token_expired" || (typeof status === "string" && status.startsWith("http_error_401"))) {
      logger.warning(`🔑 Token expired / unauthorized for ${lead.phone}. Attempting regeneration...`);
      counters.incrementTokenErrors();
      const regenerated = await client.forceTokenRegeneration();
      if (regenerated) {
        logger.info(`🔄 Retrying with new token for ${lead.phone}...`);
        [eligibilityResp, status] = await makeFatakpayRequest(client, client.token, payload);
        responses.eligibility = eligibilityResp;
      } else {
        logger.error(`❌ Token regeneration failed for ${lead.phone}`);
        counters.addFailedLead(lead.phone, "token_expired", "Token regeneration failed");
        return makeProcessResult({
          leadId: String(lead._id),
          phone: String(lead.phone),
          pan: lead.pan || "",
          status: "token_expired",
          responses,
          success: false,
        });
      }
    }

    const analysis = analyzeFatakpayResponse(eligibilityResp);

    logger.info(`📊 RESPONSE ANALYSIS for ${lead.phone}:`);
    logger.info(`   ✅ Success: ${analysis.success}`);
    logger.info(`   ✅ Eligibility: ${analysis.eligibilityStatus}`);
    logger.info(`   ✅ Message: ${analysis.message}`);
    logger.info(`   ✅ Reason: ${analysis.reason}`);

    if (analysis.success && analysis.eligibilityStatus) {
      logger.info(`🎉 ELIGIBLE: ${lead.phone} - ${analysis.message}`);
      counters.incrementEligibility();
      counters.addSuccessfulLead(lead.phone, "eligible", analysis.message);
      return makeProcessResult({
        leadId: String(lead._id),
        phone: String(lead.phone),
        pan: lead.pan || "",
        status: "eligible",
        responses,
        success: true,
      });
    } else if (analysis.success && !analysis.eligibilityStatus) {
      logger.info(`❌ NOT ELIGIBLE: ${lead.phone} - ${analysis.reason}`);
      counters.addFailedLead(lead.phone, "not_eligible", analysis.reason);
      return makeProcessResult({
        leadId: String(lead._id),
        phone: String(lead.phone),
        pan: lead.pan || "",
        status: "not_eligible",
        responses,
        success: false,
      });
    } else if (String(analysis.message).toLowerCase().includes("already exists")) {
      logger.info(`🔄 DUPLICATE: ${lead.phone} - ${analysis.message}`);
      counters.incrementDuplicate();
      counters.addFailedLead(lead.phone, "duplicate", analysis.message);
      return makeProcessResult({
        leadId: String(lead._id),
        phone: String(lead.phone),
        pan: lead.pan || "",
        status: "duplicate",
        responses,
        success: false,
      });
    } else {
      logger.warning(`⚠️ API REJECTION: ${lead.phone} - ${analysis.message}`);
      counters.addFailedLead(lead.phone, "api_rejected", analysis.message);
      return makeProcessResult({
        leadId: String(lead._id),
        phone: String(lead.phone),
        pan: lead.pan || "",
        status: "not_eligible",
        responses,
        success: false,
      });
    }
  } catch (e) {
    logger.error(`💥 PROCESSING ERROR: ${lead.phone} - ${e.message}`);
    counters.incrementApiErrors();
    counters.addFailedLead(lead.phone, "processing_error", e.message);
    responses.error = { message: e.message };
    return makeProcessResult({
      leadId: String(lead._id),
      phone: String(lead.phone),
      pan: lead.pan || "",
      status: "api_error",
      responses,
      success: false,
    });
  }
}

async function processSingleLead(client, lead) {
  try {
    logger.info(`🔍 STARTING VALIDATION: ${lead.phone}`);

    const [isValid, rejectionReason, age] = validateLead(lead);

    if (!isValid) {
      logger.info(`🚫 VALIDATION FAILED: ${lead.phone} - ${rejectionReason}`);
      counters.incrementTraversed();
      counters.incrementRejected();
      counters.addFailedLead(lead.phone, "validation_failed", rejectionReason);
      return makeProcessResult({
        leadId: String(lead._id),
        phone: String(lead.phone),
        pan: lead.pan || "",
        status: "validation_failed",
        responses: { validation_error: rejectionReason, age },
        success: false,
      });
    }

    await client.ensureToken();
    const result = await checkFatakpayEligibility(lead, client);
    counters.incrementTraversed();
    return result;
  } catch (e) {
    logger.error(`💥 THREAD ERROR: ${lead.phone} - ${e.message}`);
    counters.incrementTraversed();
    counters.incrementApiErrors();
    counters.addFailedLead(lead.phone, "thread_error", e.message);
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

// ==================== BATCH PROCESSING ==================== //

async function getLeadsBatch(skip, limit) {
  return leadCol
    .find(
      {
        $or: [
          { processed: { $exists: false } },
          { processed: { $ne: LENDER_NAME } },
        ],
      },
      {
        projection: {
          name: 1,
          gender: 1,
          phone: 1,
          pan: 1,
          dob: 1,
          employment: 1,
          income: 1,
          pincode: 1,
          city: 1,
          state: 1,
          email: 1,
        },
      },
    )
    .skip(skip)
    .limit(limit)
    .toArray();
}

/**
 * Mirrors ThreadPoolExecutor(max_workers=min(MAX_THREADS, len(batch))):
 * runs leads with bounded concurrency, staggering task starts by
 * THREAD_DELAY just like the Python submit loop.
 */
async function runBatchConcurrently(client, leadsBatch) {
  const results = [];
  const concurrency = Math.min(MAX_THREADS, leadsBatch.length);
  let nextIndex = 0; // Har worker ke pick karne ke liye next pointer index
  let started = 0;   // Processed leads counter tracker

  // Worker loop jo tab tak chalega jab tak batch ke saare leads khatam nahi ho jaate
  async function worker() {
    while (true) {
      const currentIndex = nextIndex++;
      // Agar batch ke saare leads process ho gaye hain, toh exit karein
      if (currentIndex >= leadsBatch.length) {
        return;
      }

      const currentLead = leadsBatch[currentIndex];
      try {
        // processSingleLead aur 45s timeout ke beech race karwate hain
        const result = await Promise.race([
          processSingleLead(client, currentLead),
          sleep(45000).then(() => {
            throw new Error("processSingleLead timed out after 45s");
          }),
        ]);
        if (result) {
          results.push(result);
        }
      } catch (e) {
        logger.error(`⚠️ Future error: ${e.message}`);
        counters.incrementApiErrors();
      }

      started++;
      if (started % 10 === 0) {
        logger.info(`📦 Batch progress: ${started}/${leadsBatch.length} completed`);
      }
    }
  }

  // Stagger workers start (har worker ke shuru hone me thoda delay dete hain)
  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(worker());
    if (w < concurrency - 1) {
      await sleep(THREAD_DELAY);
    }
  }
  await Promise.all(workers);

  return results;
}

async function processBatch(client, leadsBatch, batchNumber) {
  const batchStart = Date.now();
  logger.info(`🚀 STARTING BATCH ${batchNumber} with ${leadsBatch.length} leads`);
  logger.info(`📋 Lead phones: ${leadsBatch.slice(0, 5).map((l) => l.phone).join(", ")}...`);

  await client.ensureToken();
  if (!client.token) {
    logger.error("❌ Cannot process batch - no valid token");
    return 0;
  }

  const results = await runBatchConcurrently(client, leadsBatch);

  await saveResults(results);

  const batchTime = (Date.now() - batchStart) / 1000;
  const successfulCount = results.filter((r) => r.success).length;

  logger.info(`✅ BATCH ${batchNumber} COMPLETE`);
  logger.info(`   📊 Success: ${successfulCount}/${leadsBatch.length}`);
  logger.info(`   ⏱️  Time: ${batchTime.toFixed(1)}s`);
  if (batchTime > 0) {
    logger.info(`   🚀 Rate: ${(leadsBatch.length / batchTime).toFixed(1)} leads/sec`);
  }

  return successfulCount;
}

async function saveResults(results) {
  if (!results.length) return;

  try {
    const documents = results.map((result) => ({
      leadId: result.leadId,
      phone: result.phone,
      pan: result.pan,
      status: result.status,
      responses: result.responses,
     createdAt: new Date().toISOString().split('T')[0]
    }));

    await responseCol.insertMany(documents, { ordered: false });
    logger.info(`💾 Saved ${documents.length} results to response collection`);

    // Bulk update the source leads in leadCol (api_user) to mark them as processed
    const bulkOps = results.map((result) => ({
      updateOne: {
        filter: { _id: new ObjectId(result.leadId) },
        update: {
          $addToSet: {
            processed: LENDER_NAME,
          },
        },
      },
    }));

    if (bulkOps.length > 0) {
      await leadCol.bulkWrite(bulkOps, { ordered: false });
      logger.info(`💾 Updated ${bulkOps.length} leads in api_user with processed flag: ${LENDER_NAME}`);
    }
  } catch (e) {
    logger.error(`❌ Database save error: ${e.message}`);
  }
}

// ==================== MAIN EXECUTION ==================== //

async function main() {
  const startTime = Date.now();

  await connectMongo();

  logger.info("⚡ HIGH-PERFORMANCE PROCESSING STARTED");
  logger.info(`   • Max Leads: ${MAX_LEADS}`);
  logger.info(`   • Batch Size: ${BATCH_SIZE} (larger)`);
  logger.info(`   • Max Threads: ${MAX_THREADS} (more)`);
  logger.info(`   • API Delay: ${API_CALL_DELAY}ms (faster)`);
  logger.info(`   • Target: ~80-100 leads/sec (high throughput)`);

  counters.startTiming();
  const client = new FatakPayAPIClient();

  try {
    logger.info("🔄 Initializing FatakPay token...");
    await client.ensureToken();

    if (!client.token) {
      logger.error("❌ FatakPay API client failed to initialize - no token");
      return;
    }

    logger.info("✅ FatakPay API client ready");

    const totalLeads = Math.min(
      await leadCol.countDocuments(
        {
          $or: [
            { processed: { $exists: false } },
            { processed: { $ne: LENDER_NAME } },
          ],
        },
        { skip: SKIP }
      ),
      MAX_LEADS
    );
    const totalBatches = Math.ceil(Math.min(totalLeads, MAX_LEADS) / BATCH_SIZE);
    logger.info(`📊 Processing: ${totalLeads} leads in ${totalBatches} batches`);

    let successfulProcessing = 0;
    let processedLeadsCount = 0;
    let batchNum = 1;

    // Har batch ko sequentially process karenge jab tak max leads reach na ho jayein
    while (processedLeadsCount < totalLeads) {
      // Is batch ke liye kitne leads fetch karne hain use limit calculate karenge
      const limit = Math.min(BATCH_SIZE, totalLeads - processedLeadsCount);
      if (limit <= 0) {
        break;
      }

      // We pass SKIP since processed leads are already filtered out dynamically
      const leadsBatch = await getLeadsBatch(SKIP, limit);
      if (leadsBatch.length === 0) {
        logger.info("🏁 No more leads found in the database. Exiting loop.");
        break;
      }

      const batchSuccess = await processBatch(client, leadsBatch, batchNum);
      successfulProcessing += batchSuccess;

      // Stats aur progress metrics display karenge
      const stats = counters.getStats();
      const progressPct = totalBatches > 0 ? (batchNum / totalBatches) * 100 : 100;

      logger.info(`📈 OVERALL PROGRESS: ${batchNum}/${totalBatches} (${progressPct.toFixed(1)}%)`);
      logger.info(`   🚀 Current Rate: ${stats.currentRate.toFixed(1)} leads/sec`);
      logger.info(`   ✅ Eligible: ${stats.eligibilitySuccess}`);
      logger.info(`   ❌ Failed: ${stats.rejectedLeads + stats.apiErrors}`);

      if (stats.recentSuccessful.length || stats.recentFailed.length) {
        logger.info("   📝 Recent Activity:");
        stats.recentSuccessful.slice(-3).forEach((s) => logger.info(`      ✅ ${s.phone}: ${s.status}`));
        stats.recentFailed.slice(-3).forEach((f) => logger.info(`      ❌ ${f.phone}: ${f.status}`));
      }

      // Next batch indexes update karenge
      processedLeadsCount += leadsBatch.length;
      batchNum++;

      // Next batch se pehle delay denge, par aakhri batch ke baad delay nahi denge
      if (processedLeadsCount < totalLeads) {
        logger.info(`⏳ Waiting ${BATCH_DELAY / 1000}s before next batch...`);
        await sleep(BATCH_DELAY);
      }
    }

    const totalTime = (Date.now() - startTime) / 1000;
    const finalStats = counters.getStats();

    logger.info("🎯 PROCESSING COMPLETE!");
    logger.info("=".repeat(60));
    logger.info("📊 FINAL STATISTICS:");
    logger.info(`   • Total Leads: ${finalStats.traversedLeads}`);
    logger.info(`   • Total Time: ${totalTime.toFixed(1)}s (${(totalTime / 60).toFixed(1)}m)`);
    logger.info(`   • Average Rate: ${finalStats.currentRate.toFixed(1)} leads/sec`);
    logger.info(`   • Eligible: ${finalStats.eligibilitySuccess}`);
    logger.info(`   • Rejected: ${finalStats.rejectedLeads}`);
    logger.info(`   • Duplicates: ${finalStats.duplicateLeads}`);
    logger.info(`   • API Errors: ${finalStats.apiErrors}`);
    logger.info("=".repeat(60));
  } catch (e) {
    logger.error(`❌ Main execution error: ${e.message}`);
    logger.error(e.stack);
  } finally {
    if (mongoClient) {
      await mongoClient.close();
    }
    logger.info("🔚 Processing finished");
  }
}

main();