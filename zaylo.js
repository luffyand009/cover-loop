require("dotenv").config();
const crypto = require("crypto");
const path = require("path");
const XLSX = require("xlsx");
const { MongoClient } = require("mongodb");

// ==========================================
// 1. CONFIGURATION & CONSTANTS
// ==========================================
const MONGO_URI =
  process.env.MONGO_URI_COVER ||
  process.env.MONGO_URI ||
  "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "coverloop";
const LEAD_COLLECTION = process.env.LEAD_COLLECTION || "keshvadb";
const RESPONSE_COLLECTION =
  process.env.ZAYLO_RESPONSE_COLLECTION || "zaylo_responses";

// Excel / XLS Pincode File Config
const PINCODE_EXCEL_PATH =
  process.env.PINCODE_EXCEL_PATH || path.join(__dirname, "pincodes.xlsx");
const PINCODE_SHEET_NAME = process.env.PINCODE_SHEET_NAME || "";
const PINCODE_COLUMN_NAME = process.env.PINCODE_COLUMN_NAME || "pincode";

// Fallback Pincode List (agar Excel file na ho ya khali ho)
const ALLOWED_PINCODES = [
  // "110001",
  // "831004",
];

// Dummy / Test Data Blocklist
const BLOCKED_MOBILES = new Set(["9876543210", "9999999999", "1234567890", "0000000000"]);
const BLOCKED_PANS = new Set(["ABCDE1234F", "AAAAA0000A", "XXXXX0000X"]);

const BATCH_LIMIT = Number(process.env.BATCH_SIZE || 50);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60000);
const DAILY_LIMIT = parseInt(
  process.argv[2] || process.env.DAILY_LIMIT || "1000",
  10
);

const MIN_AGE = Number(process.env.ZAYLO_MIN_AGE || 22);
const MAX_AGE = Number(process.env.ZAYLO_MAX_AGE || 55);
const MIN_SALARY = Number(process.env.ZAYLO_MIN_SALARY || 35000);

const ZAYLO_CONFIG = {
  BRAND: "ZAYLO_LOAN",
  BASE_URL:
    process.env.ZAYLO_BASE_URL ||
    "https://backend.zayloloan.com/api/third-party/loan-aggregator",
  API_KEY:
    process.env.ZAYLO_API_KEY ||
    "rlwjw5c7s8qqvhwu5swi1pmqwmtblmuas7knsp4tnur8jlb837gqcyv15i",
  ENCRYPTION_KEY:
    process.env.ZAYLO_ENCRYPTION_KEY ||
    "jvvqQiXgmQo7IlyK8juRgQ64nWftsl8K8XqUrCxils-L6hKXRwBXo0IVv-fvDQC2",
  DEFAULT_CONSENT_IP: process.env.ZAYLO_DEFAULT_CONSENT_IP || "72.60.205.182",
  DELAY_BETWEEN_LEADS_MS: Number(process.env.DELAY_BETWEEN_LEADS_MS || 1500),
};

let isShuttingDown = false;
let allowedPincodeSet = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==========================================
// 2. LOAD PINCODES FROM EXCEL / XLS
// ==========================================
function loadPincodesFromExcel() {
  const pincodes = new Set();

  try {
    const workbook = XLSX.readFile(PINCODE_EXCEL_PATH);
    const sheetName = PINCODE_SHEET_NAME || workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    if (sheet) {
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const targetColLower = PINCODE_COLUMN_NAME.trim().toLowerCase();

      for (const row of rows) {
        let rawPin = "";

        for (const [key, val] of Object.entries(row)) {
          if (String(key).trim().toLowerCase() === targetColLower) {
            rawPin = val;
            break;
          }
        }

        if (!rawPin) {
          rawPin = Object.values(row)[0];
        }

        const cleaned = String(rawPin || "").replace(/\D/g, "").trim();
        if (/^\d{6}$/.test(cleaned)) {
          pincodes.add(cleaned);
        }
      }
    }

    if (pincodes.size > 0) {
      console.log(`📍 Loaded ${pincodes.size} pincodes from Excel: ${PINCODE_EXCEL_PATH}`);
      return pincodes;
    }
  } catch (err) {
    console.warn(`⚠️ Could not read Excel pincodes (${PINCODE_EXCEL_PATH}): ${err.message}`);
  }

  for (const p of ALLOWED_PINCODES) {
    const cleaned = String(p).replace(/\D/g, "").trim();
    if (/^\d{6}$/.test(cleaned)) {
      pincodes.add(cleaned);
    }
  }

  if (pincodes.size > 0) {
    console.log(`📍 Using ${pincodes.size} fallback pincodes from ALLOWED_PINCODES.`);
  } else {
    console.log("📍 No pincode filter active (ALL pincodes allowed).");
  }

  return pincodes;
}

// ==========================================
// 3. AES-256-CBC ENCRYPTION & DECRYPTION
// ==========================================
const getDerivedKey = () =>
  crypto.createHash("sha256").update(ZAYLO_CONFIG.ENCRYPTION_KEY, "utf8").digest();

function encryptPayload(payload) {
  const iv = crypto.randomBytes(16);
  const plaintext = JSON.stringify({
    ...payload,
    timestamp: Date.now(),
  });
  const cipher = crypto.createCipheriv("aes-256-cbc", getDerivedKey(), iv);
  const encryptedHex =
    cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
  return Buffer.from(`${iv.toString("hex")}:${encryptedHex}`).toString("base64url");
}

function decryptPayload(base64urlData) {
  const decoded = Buffer.from(base64urlData, "base64url").toString("utf8");
  const [ivHex, encHex] = decoded.split(":");
  if (!ivHex || !encHex) {
    throw new Error("Malformed encrypted wire format from server");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    getDerivedKey(),
    Buffer.from(ivHex, "hex")
  );
  const decryptedUtf8 =
    decipher.update(encHex, "hex", "utf8") + decipher.final("utf8");
  return JSON.parse(decryptedUtf8);
}

// ==========================================
// 4. API CALL HELPER
// ==========================================
async function postEncrypted(endpoint, payload) {
  const encryptedData = encryptPayload(payload);

  const response = await fetch(`${ZAYLO_CONFIG.BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ZAYLO_CONFIG.API_KEY,
    },
    body: JSON.stringify({ data: encryptedData }),
  });

  const rawJson = await response.json();
  let body = rawJson;

  if (rawJson && typeof rawJson.data === "string") {
    body = decryptPayload(rawJson.data);
  }

  return {
    httpStatus: response.status,
    ok: response.ok,
    body,
  };
}

// ==========================================
// 5. DB FIELD MAPPING, AGE, PINCODE & VALIDATION
// ==========================================
function parseDobDate(rawDob) {
  if (!rawDob) return null;
  if (rawDob instanceof Date && !Number.isNaN(rawDob.getTime())) {
    return rawDob;
  }

  const str = String(rawDob).trim();

  // YYYY-MM-DD or YYYY/MM/DD
  let match = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }

  // DD-MM-YYYY or DD/MM/YYYY
  match = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  }

  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDob(rawDob) {
  const dt = parseDobDate(rawDob);
  if (!dt) return "";
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function calculateAge(rawDob, refDate = new Date()) {
  const dob = parseDobDate(rawDob);
  if (!dob) return null;

  let age = refDate.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = refDate.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && refDate.getUTCDate() < dob.getUTCDate())) {
    age--;
  }
  return age;
}

function extractFullName(doc) {
  const direct = String(doc.name || doc.fullName || doc.full_name || "").trim();
  if (direct) return direct;

  const first = String(doc.first_name || doc.firstName || "").trim();
  const last = String(doc.last_name || doc.lastName || "").trim();
  return [first, last].filter(Boolean).join(" ").trim();
}

function normalizeAndValidateLead(doc) {
  const fullName = extractFullName(doc).split(/\s+/).filter(Boolean);
  const first_name = String(
    doc.first_name || doc.firstName || fullName[0] || ""
  ).trim();
  const last_name = String(
    doc.last_name ||
      doc.lastName ||
      (fullName.length > 1 ? fullName.slice(1).join(" ") : "Kumar")
  ).trim();

  const pan = String(doc.pan || doc.panNumber || doc.pan_number || "")
    .trim()
    .toUpperCase();
  const mobile = String(doc.mobile || doc.phone || doc.phoneNumber || "")
    .replace(/\D/g, "")
    .slice(-10);
  const personal_email = String(doc.personal_email || doc.email || "").trim();
  const rawDobValue = doc.dob || doc.dateOfBirth || doc.date_of_birth;
  const dob = formatDob(rawDobValue);
  const age = calculateAge(rawDobValue);

  const salary = Number(
    String(
      doc.salary || doc.monthlyIncome || doc.monthly_income || doc.income || "0"
    ).replace(/[^0-9.]/g, "")
  );

  const empRaw = String(
    doc.employment_type || doc.employmentType || doc.employment || "SALARIED"
  ).toUpperCase();
  const employment_type = empRaw.includes("SELF") ? "SELF_EMPLOYED" : "SALARIED";

  const modeRaw = String(doc.salary_mode || doc.salaryMode || "BANK").toUpperCase();
  const salary_mode = modeRaw === "CASH" ? "CASH" : "BANK";

  const pincode = String(doc.pincode || doc.pinCode || doc.pin || "")
    .replace(/\D/g, "")
    .slice(0, 6);

  if (BLOCKED_MOBILES.has(mobile) || BLOCKED_PANS.has(pan)) {
    return { valid: false, reason: `Blocked dummy test data (${mobile} / ${pan})` };
  }

  if (!first_name || !last_name) return { valid: false, reason: "Missing name" };
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan))
    return { valid: false, reason: `Invalid PAN: ${pan}` };
  if (!/^[6-9]\d{9}$/.test(mobile))
    return { valid: false, reason: `Invalid Mobile: ${mobile}` };
  if (!personal_email.includes("@"))
    return { valid: false, reason: `Invalid Email: ${personal_email}` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob))
    return { valid: false, reason: `Invalid DOB: ${dob}` };
  if (age === null || age < MIN_AGE || age > MAX_AGE)
    return { valid: false, reason: `Age out of range (${MIN_AGE}-${MAX_AGE}): ${age}` };
  if (!Number.isFinite(salary) || salary < MIN_SALARY)
    return { valid: false, reason: `Salary < ${MIN_SALARY}: ${salary}` };

  if (allowedPincodeSet.size > 0) {
    if (!/^\d{6}$/.test(pincode) || !allowedPincodeSet.has(pincode)) {
      return { valid: false, reason: `Unserviceable Pincode: ${pincode || "MISSING"}` };
    }
  }

  const cleanPayload = {
    first_name,
    last_name,
    pan,
    mobile,
    consent: true,
    consent_ip: doc.consent_ip || doc.ipAddress || ZAYLO_CONFIG.DEFAULT_CONSENT_IP,
    consent_timestamp: doc.consent_timestamp ? Number(doc.consent_timestamp) : Date.now(),
    personal_email,
    dob,
    employment_type,
    salary,
    salary_mode,
  };

  if (pincode.length === 6) {
    cleanPayload.pincode = pincode;
  }

  return { valid: true, payload: cleanPayload };
}

function buildPendingQuery() {
  const conditions = [
    { "lenders.zaylo.processed": { $ne: true } },
    {
      phone: { $nin: Array.from(BLOCKED_MOBILES) },
      mobile: { $nin: Array.from(BLOCKED_MOBILES) },
      pan: { $nin: Array.from(BLOCKED_PANS) },
    },
    {
      $expr: {
        $gte: [
          {
            $convert: {
              input: {
                $replaceAll: {
                  input: {
                    $toString: {
                      $ifNull: [
                        "$salary",
                        {
                          $ifNull: [
                            "$monthlyIncome",
                            { $ifNull: ["$monthly_income", { $ifNull: ["$income", "0"] }] },
                          ],
                        },
                      ],
                    },
                  },
                  find: ",",
                  replacement: "",
                },
              },
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          MIN_SALARY,
        ],
      },
    },
  ];

  if (allowedPincodeSet.size > 0) {
    const pinArray = Array.from(allowedPincodeSet);
    const pinNumericArray = pinArray.map(Number).filter((n) => !Number.isNaN(n));
    const allPins = [...pinArray, ...pinNumericArray];

    conditions.push({
      $or: [
        { pincode: { $in: allPins } },
        { pinCode: { $in: allPins } },
        { pin: { $in: allPins } },
      ],
    });
  }

  return { $and: conditions };
}

// ==========================================
// 6. SINGLE LEAD PROCESSOR (Create Lead -> Offer -> SSO)
// ==========================================
async function processSingleLead(doc) {
  const validation = normalizeAndValidateLead(doc);
  if (!validation.valid) {
    return {
      status: "SKIPPED_INVALID",
      success: false,
      reason: validation.reason,
    };
  }

  const leadData = validation.payload;

  // Step 1: Create Lead
  const createRes = await postEncrypted("/create-lead", leadData);

  if (createRes.httpStatus === 401 || createRes.httpStatus === 403) {
    throw new Error(
      `CRITICAL_AUTH_ERROR (${createRes.httpStatus}): ${JSON.stringify(createRes.body)}`
    );
  }

  if (!createRes.ok || !createRes.body?.success || !createRes.body?.unique_id) {
    return {
      status: "CREATE_LEAD_FAILED",
      success: false,
      httpStatus: createRes.httpStatus,
      response: createRes.body,
    };
  }

  const unique_id = createRes.body.unique_id;
  const leadStatus = createRes.body.status;

  // Step 2: Get Offer
  const offerRes = await postEncrypted("/offer", { unique_id });

  if (!offerRes.ok || !offerRes.body?.success) {
    return {
      status: "OFFER_API_FAILED",
      success: false,
      unique_id,
      leadStatus,
      httpStatus: offerRes.httpStatus,
      response: offerRes.body,
    };
  }

  if (!offerRes.body.eligible) {
    return {
      status: "OFFER_REJECTED",
      success: true,
      unique_id,
      leadStatus,
      eligible: false,
      eligibleAmount: 0,
      reason: offerRes.body.message || "Not eligible",
    };
  }

  const eligibleAmount = offerRes.body.eligibleAmount;

  // Step 3: SSO Login
  const ssoRes = await postEncrypted("/sso-login", { unique_id });

  if (!ssoRes.ok || !ssoRes.body?.success || !ssoRes.body?.redirectUrl) {
    return {
      status: "SSO_LOGIN_FAILED",
      success: false,
      unique_id,
      leadStatus,
      eligible: true,
      eligibleAmount,
      httpStatus: ssoRes.httpStatus,
      response: ssoRes.body,
    };
  }

  return {
    status: "COMPLETED",
    success: true,
    unique_id,
    leadStatus,
    eligible: true,
    eligibleAmount,
    redirectUrl: ssoRes.body.redirectUrl,
  };
}

// ==========================================
// 7. CONTINUOUS DATABASE WORKER LOOP
// ==========================================
async function startWorker() {
  allowedPincodeSet = loadPincodesFromExcel();

  console.log("====================================================");
  console.log("🚀 Zaylo Lead Sync Worker Initiated");
  console.log(`🎯 Today's Quota: ${DAILY_LIMIT} leads`);
  console.log(`💼 Filter: Age ${MIN_AGE}-${MAX_AGE} | Net Monthly Salary >= ₹${MIN_SALARY}`);
  console.log(
    `📄 Pincode File: ${PINCODE_EXCEL_PATH} (${allowedPincodeSet.size} active pincodes)`
  );
  console.log(
    `📂 Database: ${DB_NAME} | Leads: ${LEAD_COLLECTION} | Logs: ${RESPONSE_COLLECTION}`
  );
  console.log("====================================================\n");

  const client = new MongoClient(MONGO_URI);
  let totalProcessedToday = 0;

  try {
    await client.connect();
    console.log("✅ Connected to MongoDB.\n");

    const db = client.db(DB_NAME);
    const collection = db.collection(LEAD_COLLECTION);
    const responseCollection = db.collection(RESPONSE_COLLECTION);

    await collection.createIndex({ "lenders.zaylo.processed": 1, createdAt: -1 });
    await responseCollection.createIndex({ userId: 1, createdAt: -1 });

    const pendingQuery = buildPendingQuery();

    while (!isShuttingDown && totalProcessedToday < DAILY_LIMIT) {
      const remaining = DAILY_LIMIT - totalProcessedToday;
      const limit = Math.min(BATCH_LIMIT, remaining);

      const pendingLeads = await collection
        .find(pendingQuery)
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      if (!pendingLeads || pendingLeads.length === 0) {
        console.log(
          `[${new Date().toISOString()}] No new pending leads matching criteria (Age ${MIN_AGE}-${MAX_AGE}, Salary >= ₹${MIN_SALARY}, Pincode list). Waiting ${
            POLL_INTERVAL_MS / 1000
          }s...`
        );
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log(
        `\n[${new Date().toISOString()}] Found ${
          pendingLeads.length
        } pending leads for Zaylo (${totalProcessedToday}/${DAILY_LIMIT}).`
      );

      for (let i = 0; i < pendingLeads.length; i++) {
        if (isShuttingDown || totalProcessedToday >= DAILY_LIMIT) break;

        const doc = pendingLeads[i];
        const mobileLog = doc.mobile || doc.phone || "N/A";
        const nameLog = extractFullName(doc) || "N/A";
        console.log(
          `[${i + 1}/${pendingLeads.length}] Processing ID: ${doc._id} | Name: ${nameLog} | Mobile: ${mobileLog}`
        );

        try {
          const result = await processSingleLead(doc);
          const now = new Date();

          console.log(
            `   -> Status: ${result.status} | Eligible: ${
              result.eligible || false
            } | Amount: ${result.eligibleAmount || 0}`
          );

          await collection.updateOne(
            { _id: doc._id },
            {
              $set: {
                "lenders.zaylo": {
                  processed: true,
                  processedAt: now,
                  ...result,
                },
              },
            }
          );

          await responseCollection.insertOne({
            userId: doc._id,
            name: nameLog,
            mobile: mobileLog,
            brand: ZAYLO_CONFIG.BRAND,
            status: result.status,
            success: result.success,
            result,
            createdAt: now,
          });

          totalProcessedToday++;
        } catch (err) {
          console.error(`   -> Error on ${doc._id}:`, err.message);
          if (err.message.startsWith("CRITICAL_AUTH_ERROR")) {
            console.error("CRITICAL: Auth/IP error. Pausing worker for 5 minutes...");
            await sleep(5 * 60 * 1000);
            break;
          }
        }

        if (!isShuttingDown && totalProcessedToday < DAILY_LIMIT) {
          await sleep(ZAYLO_CONFIG.DELAY_BETWEEN_LEADS_MS);
        }
      }
    }

    console.log(`\n🎉 Zaylo Worker Finished! Total ${totalProcessedToday} leads processed.`);
  } catch (fatalErr) {
    console.error("MongoDB Connection / Fatal Error:", fatalErr);
    process.exitCode = 1;
  } finally {
    await client.close();
    console.log("🔌 Disconnected from MongoDB.");
    process.exit(process.exitCode || 0);
  }
}

process.on("SIGINT", () => {
  isShuttingDown = true;
});

process.on("SIGTERM", () => {
  isShuttingDown = true;
});

startWorker();